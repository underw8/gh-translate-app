# gh-translate-app

A GitHub App that automatically translates markdown documents in a pull request and opens a new PR with the translations, powered by OpenAI or Claude and hosted on Cloudflare Workers.

## How It Works

1. A PR is opened or updated in a repository where the app is installed
2. The app detects changed `.md` / `.mdx` files
3. Each file is translated via the configured provider (OpenAI `gpt-4o-mini` or Claude `claude-haiku-4-5-20251001`)
4. A new PR is opened on the same repo with all translated files

## Tech Stack

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/)
- **Async processing**: [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- **Translation**: [OpenAI](https://platform.openai.com/docs/api-reference/chat) (`gpt-4o-mini`) or [Anthropic Claude](https://docs.anthropic.com/en/api/messages) (`claude-haiku-4-5-20251001`)
- **Language**: TypeScript

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account (Workers Paid plan required for Queues)
- A GitHub App registered under your account/org
- An OpenAI API key (or Anthropic API key if using Claude)

## Setup

### 1. Register a GitHub App

Go to **GitHub Settings → Developer settings → GitHub Apps → New GitHub App** and configure:

| Field                       | Value                                       |
| --------------------------- | ------------------------------------------- |
| Webhook URL                 | `https://<your-worker>.workers.dev/webhook` |
| Webhook secret              | A random secret string (save it)            |
| Permissions — Contents      | Read & Write                                |
| Permissions — Pull requests | Read & Write                                |
| Subscribe to events         | `pull_request`                              |

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

For `GITHUB_APP_PRIVATE_KEY`, use Python to reliably convert the PEM file to a single-line `\n`-escaped string (`tr` is unreliable for this):

```bash
python3 -c "
key = open('private-key-pkcs8.pem').read().strip().replace('\n', r'\n')
print(f'GITHUB_APP_PRIVATE_KEY=\"{key}\"')
" >> .dev.vars
```

Verify the result is a single line starting with `-----BEGIN PRIVATE KEY-----`:

```bash
grep GITHUB_APP_PRIVATE_KEY .dev.vars | cut -c1-60
```

Start the local dev server:

```bash
npm run dev
```

Use a tool like [smee.io](https://smee.io/), [ngrok](https://ngrok.com/), or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) to forward GitHub webhooks to `http://localhost:8787/webhook`:

```bash
cloudflared tunnel --url http://localhost:8787
```

Set the printed URL (e.g. `https://xyz.trycloudflare.com/webhook`) as the **Webhook URL** in your GitHub App settings.

#### Simulate a webhook with curl

To test without opening a real PR, send a signed payload manually:

```bash
BODY='{"action":"opened","pull_request":{"number":1,"title":"Test","head":{"sha":"abc123"},"base":{"ref":"main"}},"repository":{"name":"YOUR_REPO","owner":{"login":"YOUR_ORG"}},"installation":{"id":YOUR_INSTALLATION_ID}}'

SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "YOUR_WEBHOOK_SECRET" | awk '{print "sha256="$2}')

curl -X POST http://localhost:8787/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$BODY"
```

Replace `YOUR_REPO`, `YOUR_ORG`, `YOUR_INSTALLATION_ID`, and `YOUR_WEBHOOK_SECRET` with your actual values. A `200 OK` confirms the signature and enqueue logic works. The queue consumer will then attempt to authenticate with GitHub and process the job — use a real commit SHA and repo for the full flow to succeed.

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
├── index.ts             # Webhook handler (fetch) + queue consumer (queue) — single entry point
├── translate.ts         # Provider facade: routes to OpenAI or Claude based on TRANSLATION_PROVIDER
├── translate-utils.ts   # Shared: ProviderError, system prompt, backoff, chunking
├── openai.ts            # OpenAI provider (gpt-4o-mini)
├── claude.ts            # Claude provider (claude-haiku-4-5-20251001)
├── github.ts            # GitHub API client (auth, file listing, Git DB API, PR creation)
├── idempotency.ts       # Workers KV helpers for deduplication
└── types.ts             # Shared TypeScript types
```

## Environment Variables

| Variable                 | Required | Description                                                              |
| ------------------------ | -------- | ------------------------------------------------------------------------ |
| `GITHUB_APP_ID`          | Yes      | Numeric GitHub App ID                                                    |
| `GITHUB_APP_PRIVATE_KEY` | Yes      | PKCS#8 PEM private key (newlines as `\n`)                                |
| `GITHUB_WEBHOOK_SECRET`  | Yes      | Webhook HMAC secret from GitHub App settings                             |
| `TARGET_LANG`            | Yes      | Translation target language (e.g. `"Japanese"`)                          |
| `OPENAI_API_KEY`         | Yes*     | OpenAI API key (`sk-...`) — required when `TRANSLATION_PROVIDER=openai`  |
| `TRANSLATION_PROVIDER`   | No       | `"openai"` (default) or `"claude"`                                       |
| `ANTHROPIC_API_KEY`      | No*      | Anthropic API key (`sk-ant-...`) — required when `TRANSLATION_PROVIDER=claude` |

## Further Reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — full design details, API flows, rate limits, and tradeoff decisions
- [AGENTS.md](AGENTS.md) — developer and agent guide (patterns, pitfalls, testing conventions)

## License

MIT
