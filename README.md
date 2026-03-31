# gh-translate-app

A GitHub App that automatically translates markdown documents in a pull request and opens a new PR with the translations, powered by OpenAI and hosted on Cloudflare Workers.

## How It Works

1. A PR is opened or updated in a repository where the app is installed
2. The app detects changed `.md` / `.mdx` files
3. Each file is translated via OpenAI (`gpt-4o-mini`)
4. A new PR is opened on the same repo with all translated files

## Tech Stack

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/)
- **Async processing**: [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- **Translation**: [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat) (`gpt-4o-mini`)
- **Language**: TypeScript

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account (Workers Paid plan required for Queues)
- A GitHub App registered under your account/org
- An OpenAI API key

## Setup

### 1. Register a GitHub App

Go to **GitHub Settings → Developer settings → GitHub Apps → New GitHub App** and configure:

| Field | Value |
|---|---|
| Webhook URL | `https://<your-worker>.workers.dev/webhook` |
| Webhook secret | A random secret string (save it) |
| Permissions — Contents | Read & Write |
| Permissions — Pull requests | Read & Write |
| Subscribe to events | `pull_request` |

After creation:
- Note your **App ID**
- Generate and download a **private key** (`.pem` file)
- Convert to PKCS#8 (required by the JWT library):
  ```bash
  openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
    -in private-key.pem -out private-key-pkcs8.pem
  ```

### 2. Install dependencies

```bash
npm install
```

### 3. Create Cloudflare resources

```bash
# Create the translation queue
npx wrangler queues create pr-translation-jobs

# Create the dead-letter queue
npx wrangler queues create pr-translation-dlq

# Create the KV namespace for idempotency
npx wrangler kv namespace create IDEMPOTENCY_KV
```

Copy the KV namespace ID printed by the last command into `wrangler.jsonc`.

### 4. Configure secrets

```bash
cat private-key-pkcs8.pem | npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put TARGET_LANG   # e.g. "Japanese"
```

### 5. Local development

Copy the example env file and fill in values:

```bash
cp .dev.vars.example .dev.vars
```

Start the local dev server:

```bash
npm run dev
```

Use a tool like [smee.io](https://smee.io/) or [ngrok](https://ngrok.com/) to forward GitHub webhooks to `http://localhost:8787/webhook`.

### 6. Deploy

```bash
npm run deploy
```

Update the **Webhook URL** in your GitHub App settings to point to your deployed Worker URL.

## Development

```bash
npm run dev        # Local dev server at http://localhost:8787
npm run typecheck  # TypeScript type-check
npm test           # Run tests
npm run lint       # Lint
npm run deploy     # Deploy to Cloudflare
```

## Project Structure

```
src/
├── index.ts          # Webhook handler: validates signature, enqueues job
├── queue.ts          # Queue consumer: orchestrates the full translation flow
├── github.ts         # GitHub API client (auth, file listing, Git DB API, PR creation)
├── openai.ts         # OpenAI translation (gpt-4o-mini, chunking, retry logic)
├── idempotency.ts    # Workers KV helpers for deduplication
└── types.ts          # Shared TypeScript types
```

## Environment Variables

| Variable | Description |
|---|---|
| `GITHUB_APP_ID` | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | PKCS#8 PEM private key (newlines as `\n`) |
| `GITHUB_WEBHOOK_SECRET` | Webhook HMAC secret from GitHub App settings |
| `OPENAI_API_KEY` | OpenAI API key (`sk-...`) |
| `TARGET_LANG` | Translation target language (e.g. `"Japanese"`) |

## Further Reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — full design details, API flows, rate limits, and tradeoff decisions
- [AGENTS.md](AGENTS.md) — developer and agent guide (patterns, pitfalls, testing conventions)

## License

MIT
