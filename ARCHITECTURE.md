# Architecture — gh-translate-app

> **Status: Reviewed design — ready for implementation.**

---

## 1. System Overview

A GitHub App that listens for pull request events, detects changed markdown files, translates them via OpenAI, and opens a new PR with the translations. The backend runs entirely on Cloudflare Workers.

```
┌─────────────────────────────────────────────────────────────────┐
│  GitHub                                                         │
│                                                                 │
│  [PR opened / synchronize / reopened]                           │
│           │                                                     │
│           │  POST /webhook  (X-Hub-Signature-256)               │
│           ▼                                                     │
├─────────────────────────────────────────────────────────────────┤
│  Cloudflare Workers                                             │
│                                                                 │
│  ┌──────────────────────┐     enqueue      ┌────────────────┐  │
│  │  Webhook Handler     │ ─────────────►  │  CF Queue      │  │
│  │  (src/index.ts)      │                  │  (pr-jobs)     │  │
│  │  - verify HMAC-SHA256│                  └───────┬────────┘  │
│  │  - return 200 fast   │                          │ consume   │
│  └──────────────────────┘                          ▼           │
│                                           ┌────────────────┐   │
│                                           │ Queue Consumer │   │
│                                           │ (src/queue.ts) │   │
│                                           └───────┬────────┘   │
│                                                   │            │
│                              ┌────────────────────┼──────────┐ │
│                              │                    │          │ │
│                              ▼                    ▼          │ │
│                    [GitHub REST API]     [OpenAI API]        │ │
│                    - list PR files      - translate .md      │ │
│                    - create branch      - gpt-4o-mini        │ │
│                    - commit files                            │ │
│                    - open new PR        [CF Workers KV]      │ │
│                                         - idempotency store  │ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Cloudflare Services Used

| Service | Role | Why |
|---|---|---|
| **Workers** | Webhook handler + queue consumer | Serverless HTTP + event-driven compute |
| **Queues** | Async job queue between handler and consumer | Decouples GitHub's 10s webhook timeout from slow translation work; at-least-once delivery with retries |
| **Workers Secrets** | Stores API keys and private key | Encrypted at rest; injected into `env` at runtime |
| **Workers KV** *(optional)* | Idempotency store: tracks which PRs have been translated | Prevents duplicate translation PRs on queue redelivery |

**Why Queues and not `ctx.waitUntil()`:** `waitUntil` is fire-and-forget with no retry — if translation fails mid-job, the work is silently lost. Queues provide configurable retries, a dead-letter queue, and up to 15 minutes wall-clock time per consumer invocation.

---

## 3. GitHub App Setup

### 3.1 Required Permissions

| Permission | Level | Required for |
|---|---|---|
| Pull requests | Read & Write | List PR files; open translation PR |
| Contents | Read & Write | Read markdown files; create branch + commit |
| Metadata | Read | Repository info (auto-granted) |

### 3.2 Webhook Events to Subscribe

| Event | Actions |
|---|---|
| `pull_request` | `opened`, `synchronize`, `reopened` |

### 3.3 Authentication Flow

Every queue consumer invocation must:

1. **Generate a GitHub App JWT** (RS256, signed with the App's private key)
   - `iss` = GitHub App ID
   - `iat` = `now - 60s` (clock drift tolerance)
   - `exp` = `now + 600s` (10 min max)
   - Library: [`jose`](https://github.com/panva/jose) — zero-dependency, Web Crypto API compatible

2. **Exchange JWT for an installation access token**
   ```
   POST /app/installations/{installation_id}/access_tokens
   Authorization: Bearer <JWT>
   ```
   Token expires in **1 hour**. Re-generate at the start of each consumer invocation.

3. **Use the installation token** for all GitHub REST API calls
   ```
   Authorization: Bearer <installation_access_token>
   ```

> **Critical:** GitHub App private keys are downloaded in **PKCS#1 format** (`-----BEGIN RSA PRIVATE KEY-----`). The `jose` library requires **PKCS#8 format** (`-----BEGIN PRIVATE KEY-----`). Convert before storing:
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
>   -in private-key.pem -out private-key-pkcs8.pem
> ```

---

## 4. Data Flow — Step by Step

### Step 1: Webhook received (Webhook Handler Worker)

```
GitHub → POST /webhook
```

1. Read body as raw text (stream can only be read once)
2. Verify `X-Hub-Signature-256` using HMAC-SHA256 via Web Crypto API (`crypto.subtle`)
3. Parse JSON payload; extract `action`, `pull_request.number`, `repository.owner.login`, `repository.name`, `installation.id`
4. If `action` not in `["opened", "synchronize", "reopened"]`, return `200 OK` (no-op)
5. Enqueue a **small metadata message** (no file content) to Cloudflare Queue
6. Return `200 OK` immediately — do not wait for translation

**Queue message schema:**
```typescript
{
  prNumber: number;
  owner: string;        // repo owner login
  repo: string;         // repo name
  headSha: string;      // PR head commit SHA
  baseBranch: string;   // PR base branch (e.g. "main")
  installationId: number;
}
```

> Queue message limit is 128 KB — always enqueue metadata only, never file content.

### Step 2: Queue consumer processes the job

1. **Idempotency check**: look up `{owner}/{repo}#${prNumber}` in KV. If already translated, `msg.ack()` and return.
2. **Authenticate**: generate App JWT → exchange for installation access token
3. **List changed files**: `GET /repos/{owner}/{repo}/pulls/{prNumber}/files`
   - Filter for `.md` and `.mdx` files with `status !== "removed"`
   - If no markdown files, ack and return
4. **Fetch file contents**: `GET /repos/{owner}/{repo}/contents/{path}?ref={headSha}` for each file
5. **Translate each file** via OpenAI (see §5)
6. **Commit translations** via GitHub Git Database API (see §6)
7. **Open translation PR** targeting the source PR's base branch
8. **Write idempotency record** to KV: `{owner}/{repo}#${prNumber}` → `{translationPrUrl}`
9. `msg.ack()`

### Step 3: On failure

- Consumer throws → Queue retries (up to `max_retries: 3` with `retry_delay: 30s`)
- After max retries → message moves to dead-letter queue for inspection

---

## 5. Translation via OpenAI

### Model

**Default: `gpt-4o-mini`** — 128K context window, 16,384 max output tokens.

| | gpt-4o-mini | gpt-4o |
|---|---|---|
| Input cost | $0.15 / 1M tokens | $2.50 / 1M tokens |
| Output cost | $0.60 / 1M tokens | $10.00 / 1M tokens |
| Quality | Adequate for technical docs | Higher nuance |

Estimated cost per 10K-token file: **~$0.007** (gpt-4o-mini).

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

### Chunking (large files only)

Most markdown files are under 10K tokens — no chunking needed. For files exceeding ~110K tokens:
1. Split on top-level headings (`\n# ` or `\n## `)
2. Keep frontmatter only in the first chunk
3. Translate each chunk independently
4. Reassemble in order

### Rate Limit Handling

Use exponential backoff on HTTP 429:
- Delays: 1s → 2s → 4s → 8s → 16s → 32s (capped at 60s)
- Add ±25% random jitter to desynchronize parallel requests
- Max 6 retries per file before propagating the error (Queue will retry the whole job)

---

## 6. GitHub Git Database API — Committing Translations

Creating a branch and committing files requires 7 sequential API calls (no local Git needed):

```
1. GET  /repos/{owner}/{repo}/git/ref/heads/{baseBranch}
        → get current HEAD commit SHA

2. GET  /repos/{owner}/{repo}/git/commits/{commitSha}
        → get current tree SHA

3. POST /repos/{owner}/{repo}/git/blobs          (one per translated file)
        body: { content, encoding: "utf-8" }
        → get blob SHA per file

4. POST /repos/{owner}/{repo}/git/trees
        body: { base_tree: <treeSha>, tree: [{ path, mode: "100644", type: "blob", sha }] }
        → get new tree SHA

5. POST /repos/{owner}/{repo}/git/commits
        body: { message, tree: <newTreeSha>, parents: [<parentCommitSha>] }
        → get new commit SHA

6. POST /repos/{owner}/{repo}/git/refs
        body: { ref: "refs/heads/translate/pr-{prNumber}", sha: <newCommitSha> }
        → create translation branch

7. POST /repos/{owner}/{repo}/pulls
        body: { title, head: "translate/pr-{prNumber}", base: {baseBranch}, body }
        → open translation PR
```

**Branch naming convention:** `translate/pr-{prNumber}`

**PR title convention:** `[Translation] {TARGET_LANG}: PR #{prNumber} — {original PR title}`

---

## 7. `wrangler.jsonc` Configuration

```jsonc
{
  "name": "gh-translate-worker",
  "main": "src/index.ts",
  "compatibility_date": "2024-11-01",
  "compatibility_flags": ["nodejs_compat"],

  // Opt into 5-minute CPU limit for the consumer (I/O wait doesn't count)
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
        "max_batch_size": 1,          // process one PR at a time for predictable cost
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

All stored via `wrangler secret put`. Never in source or `wrangler.jsonc`.

| Secret | Description |
|---|---|
| `GITHUB_APP_ID` | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | PKCS#8 PEM private key (newlines as `\n`) |
| `GITHUB_WEBHOOK_SECRET` | Webhook HMAC secret from GitHub App settings |
| `OPENAI_API_KEY` | OpenAI API key (`sk-...`) |
| `TARGET_LANG` | Translation target, e.g. `"Japanese"` (can be an env var instead) |

**Setting secrets:**
```bash
cat private-key-pkcs8.pem | npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put OPENAI_API_KEY
```

**Local development** (`.dev.vars`):
```ini
GITHUB_APP_ID="123456"
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET="your-local-test-secret"
OPENAI_API_KEY="sk-..."
TARGET_LANG="Japanese"
```

---

## 9. Key Design Decisions & Tradeoffs

| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Async mechanism | Cloudflare **Queues** | `ctx.waitUntil()` | Queues have retries + DLQ; `waitUntil` silently drops failures |
| Translation model | **gpt-4o-mini** | gpt-4o | ~16x cheaper; quality sufficient for most technical docs |
| JWT library | **`jose`** | Raw Web Crypto API | Handles PKCS#8 import, standard-compliant JWT, minimal code |
| Idempotency store | **Workers KV** | None | Queues deliver at-least-once; KV prevents duplicate translation PRs |
| PR file commit strategy | **Git Database API** (7 calls) | Octokit high-level API | No Node.js dependencies; works natively in Workers runtime |
| Webhook handler speed | Enqueue + immediate `200` | Process inline | GitHub times out webhooks at ~10s; translation can take minutes |

---

## 10. Known Constraints & Limits

| Limit | Value | Impact |
|---|---|---|
| GitHub webhook timeout | 10s | Handler must return before translation starts → Queues required |
| Queue message size | 128 KB | Enqueue metadata only; fetch file content in consumer |
| Workers KV write throughput | 1 write/s per key | Idempotency writes are infrequent — no issue |
| GitHub API rate limit | 5,000 req/hr (installation token) | ~7 API calls per PR; cap is ~700 PRs/hr |
| OpenAI TPM (Tier 1) | ~200K tokens/min (gpt-4o-mini) | Exponential backoff handles burst; usually not hit for doc translation |
| GitHub content creation | 80 req/min, 500/hr | 7 calls per PR → cap ~70 PRs/hr; safe for most repos |
| Queue retries | 3 (default) with 30s delay | Transient OpenAI/GitHub errors will self-heal; persistent failures go to DLQ |
