# Architecture â gh-translate-app

> **Status: Design Review — Implementation Complete**

---

## 1. System Overview

A fully serverless GitHub App that detects changes to Markdown files in pull requests, translates them via OpenAI, and opens new translation PRs. Both the webhook handler and queue consumer run entirely on Cloudflare Workers.

```
â
â
ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
â  GitHub                                                         â
â                                                                 â
â  [PR opened / synchronize / reopened]                           â
â           â                                                     â
â           â  POST /webhook  (X-Hub-Signature-256)               â
â           â                                                     â
ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ¤
â  Cloudflare Workers                                             â
â                                                                 â
â  âââââââââââââââââââââââââââ  enqueue  ââââââââââââââââââ   â
â  â  Webhook Handler     â âââââââââââââââ â  CF Queue      â  â
â  â  (src/index.ts)      â                 â  (pr-jobs)     â  â
â  â  - verify HMAC-SHA256â                 âââââââ¬ââââââââââ   â
â  â  - return 200 fast   â                        â consume     â
â  ââââââââââââââââââââââââââ                      â             â
â                                           ââââââââââââââââââ   â
â                                           â Queue Consumer â   â
â                                           â (src/queue.ts) â   â
â                                           âââââââ¬ââââââââââ   â
â                                                  â              â
â                              âââââââââââââââââââââ¼ââââââââââââ  â
â                              â                   â           â  â
â                              â                   â           â  â
â                    [GitHub REST API]     [OpenAI API]        â  â
â                    - list PR files      - translate .md      â  â
â                    - create branch      - gpt-4o-mini        â  â
â                    - commit files                            â  â
â                    - open new PR        [CF Workers KV]      â  â
â                                         - idempotency store  â  â
ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
```

---

## 2. Cloudflare Services Used

| Service | Role | Reason |
|---|---|---|
| **Workers** | Webhook handler + queue consumer | Serverless HTTP + event-driven architecture |
| **Queues** | Decouple handler and consumer; handle long-running jobs | Survives GitHub's 10s webhook timeout; translation work is async; at-least-once delivery |
| **Workers Secrets** | Store API keys and secrets | Encrypted at rest; injected to `env` at runtime |
| **Workers KV** *optional* | Idempotency store; track translated PRs | Prevent duplicate translation PRs from retried queue messages |

**Why Queues, not `ctx.waitUntil()` + background fetch:** `waitUntil()` offers no retries. If translation fails mid-stream, the job is lost. Queues provide configurable retries and a dead-letter queue (DLQ) for permanent failures; consumer has up to 15 minutes to complete.

---

## 3. GitHub App Setup

### 3.1 Required Permissions

| Permission | Level | Use Case |
|---|---|---|
| Pull requests | Read & write | List PR files; open translation PR |
| Contents | Read & write | Read Markdown files; commit translated content |
| Metadata | Read | Repository info (auto-granted) |

### 3.2 Subscribed Webhook Events

| Event | Actions |
|---|---|
| `pull_request` | `opened`, `synchronize`, `reopened` |

### 3.3 Authentication Flow

The queue consumer must:

1. **Generate GitHub App JWT** (RS256, signed with App's private key)
   - `iss` = GitHub App ID
   - `iat` = `now - 60s` (clock tolerance)
   - `exp` = `now + 600s` (max 10 min)
   - Library: [`jose`](https://github.com/panva/jose) — zero-dependency, Web Crypto API

2. **Exchange JWT for installation access token**
   ```
   POST /app/installations/{installation_id}/access_tokens
   Authorization: Bearer <JWT>
   ```
   Token expires in **1 hour**; regenerate at consumer startup.

3. **Use installation access token for all GitHub REST API calls**
   ```
   Authorization: Bearer <installation_access_token>
   ```

> **Important:** GitHub App private keys download as **PKCS#1 format** (`-----BEGIN RSA PRIVATE KEY-----`), but `jose` requires **PKCS#8** (`-----BEGIN PRIVATE KEY-----`). Convert before storing:
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
>   -in private-key.pem -out private-key-pkcs8.pem
> ```

---

## 4. Data Flow — Step by Step

### Step 1: Receive Webhook (Webhook Handler Worker)

```
GitHub â POST /webhook
```

1. Read body as text (streams can only be read once)
2. Verify `X-Hub-Signature-256` with Web Crypto API (`crypto.subtle`) using HMAC-SHA256
3. Parse JSON payload; extract `action`, `pull_request.number`, `repository.owner.login`, `repository.name`, `installation.id`
4. Return `200 OK` if `action` not in `["opened", "synchronize", "reopened"]` (benign)
5. **Enqueue small metadata message** (no file contents) to Cloudflare Queue
6. Return `200 OK` immediately — don't wait for translation

**Queue Message Schema:**
```typescript
{
  prNumber: number;
  owner: string;        // repository owner login
  repo: string;         // repository name
  headSha: string;      // PR head commit SHA
  baseBranch: string;   // PR base branch (e.g., "main")
  installationId: number;
}
```

> Queue messages are limited to 128 KB — always enqueue metadata only; fetch file contents in the consumer.

### Step 2: Process Queue Job (Queue Consumer Worker)

1. **Idempotency check**: Search KV for `{owner}/{repo}#${prNumber}`. If found (translation already posted), `msg.ack()` and return.
2. **Authenticate**: Generate App JWT → exchange for installation access token
3. **List changed files**: `GET /repos/{owner}/{repo}/pulls/{prNumber}/files`
   - Filter to `.md` and `.mdx` files with `status !== "removed"`
   - If no Markdown files, ack and return
4. **Fetch file contents**: For each file, `GET /repos/{owner}/{repo}/contents/{path}?ref={headSha}`
5. **Translate each file via OpenAI** (see § 5)
6. **Commit translated files** (see § 6)
7. **Open translation PR** targeting the source PR's base branch
8. **Record success**: Write to KV `{owner}/{repo}#${prNumber}` → `{translationPrUrl}`
9. `msg.ack()`

### Step 3: Failures

- Consumer crashes → Queue auto-retries (`max_retries: 3`, `retry_delay: 30s`)
- After max retries → Message moves to dead-letter queue (DLQ) for manual review

---

## 5. Translation via OpenAI

### Model

**Default: `gpt-4o-mini`** — 128K context window, 16,384 max output tokens

| | gpt-4o-mini | gpt-4o |
|---|---|---|
| Input cost | $0.15 per 100K tokens | $2.50 per 100K tokens |
| Output cost | $0.60 per 100K tokens | $10.00 per 100K tokens |
| Quality | Excellent for technical docs | Higher precision for nuance |

Estimated cost (10K tokens per file): **~$0.007** (gpt-4o-mini).

### Prompt Design

**System prompt:**
```
You are a professional technical translator. Translate the following markdown document
from {SOURCE_LANG} to {TARGET_LANG}.

Rules:
1. Preserve ALL markdown syntax exactly: headings, bold, italic, lists, tables, blockquotes.
2. Preserve YAML/TOML frontmatter delimiters (---). Translate frontmatter values
   (title, description) but NOT keys.
3. Do NOT translate content inside fenced code blocks (```...```) or inline code (`...`).
4. Do NOT translate URLs, file paths, HTML tags, or variable names.
5. Preserve all blank lines and spacing exactly.
6. Return ONLY the translated document — no commentary.
```

**API parameters:**
```json
{
  "model": "gpt-4o-mini",
  "temperature": 0.1,
  "max_tokens": 16000
}
```

### Chunking (Large Files Only)

Most Markdown files fit in ~10K tokens — no chunking needed. For files exceeding ~110K tokens:
1. Split on heading boundaries (`\n# ` or `\n## `)
2. Preserve only the first heading per chunk
3. Translate each chunk separately
4. Concatenate in order

### Rate Limit Handling

On HTTP 429 (too many requests):
- Backoff: 1s → 2s → 4s → 8s → 16s → 32s (capped at 60s)
- Add ±25% random jitter; parallelize separate file requests
- Max 6 retries per file; if exceeded, fail the job (queue will retry the entire message)

---

## 6. GitHub Git Database API — Commit Translation

Creating a branch and committing files requires 7 sequential Git API calls (low-level Git operations):

```
1. GET  /repos/{owner}/{repo}/git/ref/heads/{baseBranch}
        → current base branch HEAD commit SHA

2. GET  /repos/{owner}/{repo}/git/commits/{commitSha}
        → tree SHA of HEAD commit

3. POST /repos/{owner}/{repo}/git/blobs          (for each translated file)
        Body: { content, encoding: "utf-8" }
        → blob SHA for each file

4. POST /repos/{owner}/{repo}/git/trees
        Body: { base_tree: <treeSha>, tree: [{ path, mode: "100644", type: "blob", sha }] }
        → new tree SHA

5. POST /repos/{owner}/{repo}/git/commits
        Body: { message, tree: <newTreeSha>, parents: [<parentCommitSha>] }
        → new commit SHA

6. POST /repos/{owner}/{repo}/git/refs
        Body: { ref: "refs/heads/translate/pr-{prNumber}", sha: <newCommitSha> }
        → create translation branch

7. POST /repos/{owner}/{repo}/pulls
        Body: { title, head: "translate/pr-{prNumber}", base: {baseBranch}, body }
        → open translation PR
```

**Branch name:** `translate/pr-{prNumber}`

**PR title template:** `[Translation] {TARGET_LANG}: PR #{prNumber} — {original PR title}`

---

## 7. `wrangler.jsonc` Configuration

```jsonc
{
  "name": "gh-translate-worker",
  "main": "src/index.ts",
  "compatibility_date": "2024-11-01",
  "compatibility_flags": ["nodejs_compat"],

  // Consumer has 5-minute CPU limit (I/O waits don't count against it)
  "limits": {
    "cpu_ms": 300000
  },

  "queues": {
    "producers": [
      {
        "binding": "PR_QUEUE",
        "queue": "pr-translation-jobs"
      }
    ],
    "consumers": [
      {
        "queue": "pr-translation-jobs",
        "max_batch_size": 1,          // process one PR at a time (predictable for quota estimates)
        "max_batch_timeout": 30,
        "max_retries": 3,
        "retry_delay": 30,            // 30s between retries
        "dead_letter_queue": "pr-translation-dlq",
        "max_concurrency": 2
      }
    ]
  },

  "kv_namespaces": [
    {
      "binding": "IDEMPOTENCY_KV",
      "id": "<KV_NAMESPACE_ID>"
    }
  ]
}
```

---

## 8. Secrets

Store all via `wrangler secret put` or in `.dev.vars` for local development. Never commit secrets.

| Secret | Description |
|---|---|
| `GITHUB_APP_ID` | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | PKCS#8 PEM private key (newlines as `\n`) |
| `GITHUB_WEBHOOK_SECRET` | Webhook HMAC secret from GitHub App settings |
| `OPENAI_API_KEY` | OpenAI API key (`sk-...`) |
| `TARGET_LANG` | Target language name (e.g., `"Japanese"`); can be environment variable |

**Set secrets:**
```bash
cat private-key-pkcs8.pem | npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put OPENAI_API_KEY
```

**Local development (`.dev.vars`):**
```ini
GITHUB_APP_ID="123456"
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET="your-local-test-secret"
OPENAI_API_KEY="sk-..."
TARGET_LANG="Japanese"
```

---

## 9. Key Design Decisions & Trade-offs

| Decision | Choice | Alternative | Rationale |
|---|---|---|---|
| Async method | Cloudflare **Queues** | `ctx.waitUntil()` | Queues provide retries + DLQ; `waitUntil` fails silently |
| Translation model | **gpt-4o-mini** | gpt-4o | 16x cheaper; excellent quality for technical docs |
| JWT library | **`jose`** | native Web Crypto | PKCS#8 parsing + standards-compliant JWT with minimal code |
| Idempotency store | **Workers KV** | none | Queues guarantee ≥1 delivery; KV prevents duplicate translation PRs |
| File commit strategy | **Git Database API** (7 calls) | Octokit REST | No Node.js deps; works in Workers runtime |
| Webhook handler latency | Enqueue + return `200` immediately | inline processing | GitHub times out webhooks at 10s; translation takes minutes |
| PR file metadata | List in consumer, not webhook | pass in queue message | Reduces initial message size; file metadata is stable within a PR |

---

## 10. Known Constraints & Quotas

| Constraint | Value | Impact |
|---|---|---|
| GitHub webhook timeout | 10s | Handler must return `200` before translation starts → Queues required |
| Queue message max size | 128 KB | Store metadata only; fetch file contents in consumer |
| Workers KV write rate | ≤1 write/sec per key | Idempotency write is infrequent → no issue |
| GitHub API rate limit | 5,000 requests/hour (app token) | ~7 API calls per PR → ~700 PRs/hour; usually not hit |
| OpenAI TPM (Tier 1) | ~200K tokens/min (gpt-4o-mini) | Latest batches help; standard streaming processes typical doc translations |
| GitHub commit API rate | 80 requests/min; 500/hour | 7 calls per PR → ~70 PRs/hour; nearly all repos stay within |
| Queue retries | 3 (default) with 30s delay | Temporary OpenAI/GitHub errors self-heal; permanent errors → DLQ |