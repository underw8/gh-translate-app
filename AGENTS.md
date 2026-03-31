# gh-translate-app — Agent Guide

A GitHub App that automatically translates markdown documents found in a pull request and opens a new PR containing the translated files, powered by OpenAI and hosted on Cloudflare Workers.

---

## Architecture Overview

```
GitHub PR opened/updated
        │
        ▼
┌──────────────────────┐
│  Cloudflare Worker   │  ← webhook handler (validates signature, responds 200 fast)
│  (src/index.ts)      │
└──────────┬───────────┘
           │  enqueue job (metadata only)
           ▼
┌──────────────────────┐
│  Cloudflare Queue    │  ← decouples slow work from the HTTP response
│  (pr-translation-    │    at-least-once delivery, 3 retries + DLQ
│   jobs)              │
└──────────┬───────────┘
           │  consume
           ▼
┌──────────────────────┐
│  Queue Consumer      │  ← fetches markdown files via GitHub API,
│  (src/queue.ts)      │    calls OpenAI (gpt-4o-mini), commits
└──────────────────────┘    translations, opens new PR
```

**Cloudflare services used:**
- **Workers** — HTTP webhook handler + queue consumer
- **Queues** — async job queue (decouples webhook response from long-running translation)
- **Workers KV** — idempotency store (prevents duplicate translation PRs on queue redelivery)
- **Workers Secrets** — stores `GITHUB_APP_PRIVATE_KEY`, `OPENAI_API_KEY`, `GITHUB_WEBHOOK_SECRET`

See [ARCHITECTURE.md](ARCHITECTURE.md) for full design details and tradeoffs.

---

## Project Layout

```
gh-translate-app/
├── src/
│   ├── index.ts          # Worker entry: validates webhook, enqueues job
│   ├── queue.ts          # Queue consumer: orchestrates translate → PR flow
│   ├── github.ts         # GitHub API client (auth, list files, Git DB API, open PR)
│   ├── openai.ts         # OpenAI translation helper (gpt-4o-mini, retry logic)
│   ├── idempotency.ts    # Workers KV helpers for dedup checks
│   └── types.ts          # Shared TypeScript types (QueueMessage, etc.)
├── test/
│   └── *.test.ts         # Vitest unit tests
├── wrangler.jsonc         # Cloudflare Workers + Queues + KV config
├── .dev.vars             # Local secrets (git-ignored)
├── .dev.vars.example     # Template for required secrets
├── .gitignore
├── package.json
└── tsconfig.json
```

---

## Build & Test

```bash
# Install dependencies
npm install

# Local development (runs Worker at http://localhost:8787)
npm run dev

# Type-check
npm run typecheck

# Run tests
npm test

# Lint
npm run lint

# Deploy to Cloudflare
npm run deploy
```

**Always run `npm run typecheck` and `npm test` before considering a task complete.**

---

## Key Patterns

### Webhook validation
Verify the `X-Hub-Signature-256` header using HMAC-SHA256 via `crypto.subtle` (Web Crypto API). Read the body as raw text **before** parsing JSON — the stream can only be consumed once.

```ts
// Verify X-Hub-Signature-256 header using HMAC-SHA256
const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
// compare hex(sig) with header value using timing-safe comparison
```

### Webhook → Queue handoff
The webhook handler must return `200 OK` within GitHub's 10-second timeout. All actual work happens in the queue consumer.

```ts
// index.ts: enqueue metadata only, return immediately
await env.PR_QUEUE.send({ prNumber, repo, owner, headSha, baseBranch, installationId });
return new Response('OK', { status: 200 });
```

### GitHub App authentication
Use the `jose` library (PKCS#8 + RS256). Re-generate at the start of each queue consumer invocation (tokens expire in 1 hour).

1. Sign a JWT with the App's private key using `jose` (`SignJWT`, `importPKCS8`)
2. Exchange JWT → installation access token: `POST /app/installations/{id}/access_tokens`
3. Use the installation token (`Authorization: Bearer <token>`) for all GitHub API calls

> **PKCS#1 → PKCS#8 required:** GitHub downloads keys as PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`). Convert before storing:
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
>   -in private-key.pem -out private-key-pkcs8.pem
> ```

### Translation via OpenAI
Default model: **`gpt-4o-mini`** (128K context, ~16x cheaper than gpt-4o). Use `temperature: 0.1` to keep translations consistent. Instruct the model explicitly to preserve all markdown syntax, frontmatter, and code block content unchanged. Wrap calls with exponential backoff (6 retries, 1s→2s→4s…60s cap, ±25% jitter) for 429 errors.

### PR creation flow (Git Database API — 7 calls)
1. `GET /git/ref/heads/{base}` → HEAD commit SHA
2. `GET /git/commits/{sha}` → tree SHA
3. `POST /git/blobs` per translated file → blob SHAs
4. `POST /git/trees` with all blobs → new tree SHA
5. `POST /git/commits` → new commit SHA
6. `POST /git/refs` → create branch `translate/pr-{prNumber}`
7. `POST /pulls` → open PR titled `[Translation] {LANG}: PR #{prNumber} — {title}`

### Idempotency
Before doing any work, the consumer checks KV for key `{owner}/{repo}#{prNumber}`. If found, `msg.ack()` and return — the job was already completed on a previous delivery. After successfully opening the translation PR, write the PR URL to KV.

---

## Environment & Configuration

Required secrets (set via `wrangler secret put` in production; `.dev.vars` locally):

```
GITHUB_APP_ID=           # Numeric GitHub App ID
GITHUB_APP_PRIVATE_KEY=  # PKCS#8 PEM private key (newlines stored as \n)
GITHUB_WEBHOOK_SECRET=   # Webhook HMAC secret from GitHub App settings
OPENAI_API_KEY=          # OpenAI API key (sk-...)
TARGET_LANG=             # Translation target language, e.g. "Japanese"
```

`.dev.vars` is git-ignored. Copy `.dev.vars.example` to get started.

`wrangler.jsonc` configuration:

```jsonc
{
  "name": "gh-translate-worker",
  "main": "src/index.ts",
  "compatibility_date": "2024-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "limits": { "cpu_ms": 300000 },

  "queues": {
    "producers": [{ "binding": "PR_QUEUE", "queue": "pr-translation-jobs" }],
    "consumers": [
      {
        "queue": "pr-translation-jobs",
        "max_batch_size": 1,
        "max_batch_timeout": 30,
        "max_retries": 3,
        "retry_delay": 30,
        "dead_letter_queue": "pr-translation-dlq",
        "max_concurrency": 2
      }
    ]
  },

  "kv_namespaces": [
    { "binding": "IDEMPOTENCY_KV", "id": "<KV_NAMESPACE_ID>" }
  ]
}
```

---

## Testing

Framework: **Vitest** with `@cloudflare/vitest-pool-workers` for Workers-runtime fidelity.

```bash
# Run all tests
npm test

# Run a single test file
npx vitest run test/github.test.ts

# Watch mode
npx vitest
```

- Unit-test `github.ts` and `openai.ts` by mocking `fetch` with `vi.fn()`
- Test webhook signature validation with known test vectors
- Do **not** make real network calls in tests

---

## Common Pitfalls

- **PKCS#1 vs PKCS#8**: GitHub App private keys are PKCS#1. `jose` requires PKCS#8. Convert with `openssl pkcs8` before storing. `jose` will throw a clear error if you pass the wrong format.
- **Private key newlines**: Store with `\n` literals (pipe the file via `cat | wrangler secret put`). Restore at runtime: `.replace(/\\n/g, '\n')`.
- **Queue binding name**: The binding is `PR_QUEUE` and queue name is `pr-translation-jobs`. Do not use the old names `TRANSLATION_QUEUE` / `translation-jobs`.
- **Queue message size**: 128 KB limit — enqueue metadata only (PR number, owner, repo, SHAs). Never enqueue file content.
- **CPU limit**: Set `"limits": { "cpu_ms": 300000 }` in `wrangler.jsonc` for the consumer (300,000 ms = 5 minutes). I/O wait (API calls) does not count against CPU time.
- **Idempotency**: Queues deliver at-least-once. Always check `IDEMPOTENCY_KV` before creating a translation branch/PR to avoid duplicates.
- **Token expiry**: Installation access tokens expire in 1 hour. Always re-generate the JWT and token at the start of each `queue` handler invocation.
- **OpenAI rate limits**: Use exponential backoff on 429. Parallel file translations can hit TPM limits — process files sequentially within a job.
