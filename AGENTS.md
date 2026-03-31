# gh-translate-app â Agent Guide

A GitHub App that automatically translates markdown documents found in a pull request and opens a new PR containing the translated files, powered by OpenAI or Claude and hosted on Cloudflare Workers.

I'd be happy to help translate a markdown document, but I don't see one in your message. 

Could you please provide the markdown document you'd like me to translate to Japanese? Once you share it, I'll apply all the translation rules you've outlined.
---

## Architecture Overview

```
GitHub PR opened/updated
        â
        â¼
ââââââââââââââââââââââââ
â  Cloudflare Worker   â  â webhook handler (validates signature, responds 200 fast)
â  (src/index.ts)      â
ââââââââââââ¬ââââââââââââ
           â  enqueue job (metadata only)
           â¼
ââââââââââââââââââââââââ
â  Cloudflare Queue    â  â decouples slow work from the HTTP response
â  (pr-translation-    â    at-least-once delivery, 3 retries + DLQ
â   jobs)              â
ââââââââââââ¬ââââââââââââ
           â  consume
           â¼
ââââââââââââââââââââââââ
â  Queue Consumer      â  â fetches markdown files via GitHub API,
â  (src/index.ts)      â    translates (OpenAI or Claude), commits
ââââââââââââââââââââââââ    translations, opens new PR
```

**Cloudflare services used:**

- **Workers** â HTTP webhook handler + queue consumer
- **Queues** â async job queue (decouples webhook response from long-running translation)
- **Workers KV** â idempotency store (prevents duplicate translation PRs on queue redelivery)
- **Workers Secrets** â stores `GITHUB_APP_PRIVATE_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_WEBHOOK_SECRET`

See [ARCHITECTURE.md](ARCHITECTURE.md) for full design details and tradeoffs.

---

## Project Layout

```
gh-translate-app/
âââ src/
â   âââ index.ts             # Worker entry: fetch handler (webhook) + queue handler (consumer)
â   âââ translate.ts         # Provider facade: routes to OpenAI or Claude based on TRANSLATION_PROVIDER
â   âââ translate-utils.ts   # Shared: ProviderError, buildSystemPrompt, withBackoff, chunking
â   âââ openai.ts            # OpenAI provider (gpt-4o-mini)
â   âââ claude.ts            # Claude provider (claude-haiku-4-5-20251001)
â   âââ github.ts            # GitHub API client (auth, list files, Git DB API, open PR)
â   âââ idempotency.ts       # Workers KV helpers for dedup checks
â   âââ types.ts             # Shared TypeScript types (QueueMessage, Env, etc.)
âââ test/
â   âââ *.test.ts         # Vitest unit tests
âââ wrangler.jsonc         # Cloudflare Workers + Queues + KV config
âââ .dev.vars             # Local secrets (git-ignored)
âââ .dev.vars.example     # Template for required secrets
âââ .gitignore
âââ package.json
âââ tsconfig.json
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

Verify the `X-Hub-Signature-256` header using HMAC-SHA256 via `crypto.subtle` (Web Crypto API). Read the body as raw text **before** parsing JSON â the stream can only be consumed once.

```ts
// Verify X-Hub-Signature-256 header using HMAC-SHA256
const key = await crypto.subtle.importKey(
  "raw",
  encoder.encode(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
// compare hex(sig) with header value using timing-safe comparison
```

### Webhook â Queue handoff

The webhook handler must return `200 OK` within GitHub's 10-second timeout. All actual work happens in the queue consumer.

```ts
// index.ts: enqueue metadata only, return immediately
await env.PR_QUEUE.send({
  prNumber,
  repo,
  owner,
  headSha,
  baseBranch,
  installationId,
});
return new Response("OK", { status: 200 });
```

### GitHub App authentication

Use the `jose` library (PKCS#8 + RS256). Re-generate at the start of each queue consumer invocation (tokens expire in 1 hour).

1. Sign a JWT with the App's private key using `jose` (`SignJWT`, `importPKCS8`)
2. Exchange JWT â installation access token: `POST /app/installations/{id}/access_tokens`
3. Use the installation token (`Authorization: Bearer <token>`) for all GitHub API calls

> **PKCS#1 â PKCS#8 required:** GitHub downloads keys as PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`). Convert before storing:
>
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
>   -in private-key.pem -out private-key-pkcs8.pem
> ```

### Translation Providers

The provider is selected via `TRANSLATION_PROVIDER` (default: `openai`). Routing lives in `src/translate.ts`; shared utilities (system prompt, retry logic, chunking) live in `src/translate-utils.ts`.

| Provider           | Env var             | Model                       | Notes                                                                             |
| ------------------ | ------------------- | --------------------------- | --------------------------------------------------------------------------------- |
| `openai` (default) | `OPENAI_API_KEY`    | `gpt-4o-mini`               | `temperature: 0.1`、`messages[]`内のシステムメッセージ                                |
| `claude`           | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` | トップレベルの`system`フィールド内のシステムプロンプト、`anthropic-version: 2023-06-01`ヘッダー |

Both providers share the same system prompt, chunking strategy (split on headings for files >300KB), and exponential backoff (6 retries, 1sâ2sâ4sâ¦60s cap, Â±25% jitter) for 429 errors.

### PR creation flow (Git Database API â 7 calls)

1. `GET /git/ref/heads/{base}` â HEAD commit SHA
2. `GET /git/commits/{sha}` â tree SHA
3. `POST /git/blobs` per translated file â blob SHAs
4. `POST /git/trees` with all blobs â new tree SHA
5. `POST /git/commits` â new commit SHA
6. `POST /git/refs` â create branch `translate/pr-{prNumber}`
7. `POST /pulls` â open PR titled `[Translation] {LANG}: PR #{prNumber} â {title}`

### Idempotency

Before doing any work, the consumer checks KV for key `{owner}/{repo}#{prNumber}`. If found, `msg.ack()` and return â the job was already completed on a previous delivery. After successfully opening the translation PR, write the PR URL to KV.

---

## Environment & Configuration

Required secrets (set via `wrangler secret put` in production; `.dev.vars` locally):

```
GITHUB_APP_ID=           # Numeric GitHub App ID
GITHUB_APP_PRIVATE_KEY=  # PKCS#8 PEM private key (newlines stored as \n)
GITHUB_WEBHOOK_SECRET=   # Webhook HMAC secret from GitHub App settings
OPENAI_API_KEY=          # OpenAI API key (sk-...) â required when TRANSLATION_PROVIDER=openai (default)
TARGET_LANG=             # Translation target language, e.g. "Japanese"
TRANSLATION_PROVIDER=    # Optional: "openai" (default) or "claude"
ANTHROPIC_API_KEY=       # Anthropic API key (sk-ant-...) â required when TRANSLATION_PROVIDER=claude
```

`.dev.vars` is git-ignored. Copy `.dev.vars.example` to get started.

`wrangler.jsonc` configuration:

```jsonc
{
  "name": "gh-translate-worker",
  "main": "src/index.ts",
  "compatibility_date": "2024-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "limits": { "cpu_ms": 300000 }, // Only for paid plan

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
        "max_concurrency": 2,
      },
    ],
  },

  "kv_namespaces": [{ "binding": "IDEMPOTENCY_KV", "id": "<KV_NAMESPACE_ID>" }],
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

- Unit-test `openai.ts` and `claude.ts` by mocking `fetch` with `vi.spyOn(globalThis, 'fetch')`
- Test facade routing in `translate.test.ts` by `vi.mock`-ing both providers
- Test webhook signature validation with known test vectors
- Do **not** make real network calls in tests

---

## Common Pitfalls

- **PKCS#1 vs PKCS#8**: GitHub App private keys are PKCS#1. `jose` requires PKCS#8. Convert with `openssl pkcs8` before storing. `jose` will throw a clear error if you pass the wrong format.
- **Private key newlines**: Use Python to write the key to `.dev.vars` â `tr` is unreliable and produces malformed output. For production secrets, `cat file | wrangler secret put` works correctly (wrangler preserves real newlines). At runtime the code does `.replace(/\\n/g, '\n')` to handle either format.
  ```bash
  python3 -c "
  key = open('private-key-pkcs8.pem').read().strip().replace('\n', r'\n')
  print(f'GITHUB_APP_PRIVATE_KEY=\"{key}\"')
  " >> .dev.vars
  ```
- **Queue binding name**: The binding is `PR_QUEUE` and queue name is `pr-translation-jobs`. Do not use the old names `TRANSLATION_QUEUE` / `translation-jobs`.
- **Queue message size**: 128 KB limit â enqueue metadata only (PR number, owner, repo, SHAs). Never enqueue file content.
- **CPU limit**: Set `"limits": { "cpu_ms": 300000 }` in `wrangler.jsonc` for the consumer (300,000 ms = 5 minutes). I/O wait (API calls) does not count against CPU time. NOTE: Only for Paid plan.
- **Idempotency**: Queues deliver at-least-once. Always check `IDEMPOTENCY_KV` before creating a translation branch/PR to avoid duplicates.
- **Token expiry**: Installation access tokens expire in 1 hour. Always re-generate the JWT and token at the start of each `queue` handler invocation.
- **API rate limits**: Both providers use exponential backoff on 429. Files are translated sequentially to avoid TPM/RPM spikes.
- **Missing Claude key**: If `TRANSLATION_PROVIDER=claude` but `ANTHROPIC_API_KEY` is absent, the consumer throws immediately with `"ANTHROPIC_API_KEY is required..."`. The queue will retry 3 times then send to DLQ â fix the secret and re-process from DLQ.
- **Provider routing**: `src/translate.ts` statically imports both `openai.ts` and `claude.ts`. Do not add provider selection logic to `src/index.ts` â it belongs in the facade.
