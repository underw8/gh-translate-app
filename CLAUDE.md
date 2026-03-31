# gh-translate-app — エージェントプレイ

GitHub App であるリクエスト前のマークダウンドキュメントを自動翻訳し、翻訳済みファイルを含む新しい PR を開きます。OpenAI による駆動。Cloudflare Workers でテストされています。

---

## アーキテクチャ概要

```
GitHub PR opened/updated
        ↓
        ↓
─────────────────────────────
│  Cloudflare Worker   │  │ webhook handler (validates signature, responds 200 fast)
│  (src/index.ts)      │
─────────────────┬──────────
             │  enqueue job (metadata only)
             │
─────────────────────────────
│  Cloudflare Queue    │  │ decouples slow work from the HTTP response
│  (pr-translation-    │    at-least-once delivery, 3 retries + DLQ
│   jobs)              │
─────────────────┬──────────
             │  consume
             │
─────────────────────────────
│  Queue Consumer      │  │ fetches markdown files via GitHub API,
│  (src/queue.ts)      │    calls OpenAI (gpt-4o-mini), commits
─────────────────────────────    translations, opens new PR
```

**使用する Cloudflare サービス:**
- **Workers** — HTTP webhook ハンドラ + キューコンシューマ
- **Queues** — 非同期ジョブキュー (webhook レスポンスを長時間実行する翻訳から分離)
- **Workers KV** — スト短期ストア (キューメッセージ内の重複する翻訳 PR を防止)
- **Workers Secrets** — `GITHUB_APP_PRIVATE_KEY`, `OPENAI_API_KEY`, `GITHUB_WEBHOOK_SECRET` を保存

詳細な設計と プレイブックについては [ARCHITECTURE.md](ARCHITECTURE.md) を参照してください。

---

## プロジェクトレイアウト

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

## ビルドとテスト

```bash
# 依存関係をインストール
npm install

# ローカル開発 (Worker が http://localhost:8787 で実行)
npm run dev

# 型をチェック
npm run typecheck

# テスト実行
npm test

# Lint
npm run lint

# Cloudflare にデプロイ
npm run deploy
```

**タスクを完了する前に、常に `npm run typecheck` と `npm test` を実行してください。**

---

## 主なパターン

### Webhook 検証
Web Crypto API を使用して HMAC-SHA256 で `X-Hub-Signature-256` ヘッダを検証します。JSON を解析する**前に** 本体をテキストとして読み込みます — ストリーム は 1 回だけ消費できます。

```ts
// HMAC-SHA256 を使用して X-Hub-Signature-256 ヘッダを検証
const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
// タイミングセーフな比較を使用してリクエスト値と hex(sig) を比較
```

### Webhook → キューのエンキュー
webhook ハンドラは GitHub の 10 秒 タイムアウト前に `200 OK` を返す必要があります。すべての実際の作業はキューコンシューマで行われます。

```ts
// index.ts: メタデータのみをエンキューして、すぐに返す
await env.PR_QUEUE.send({ prNumber, repo, owner, headSha, baseBranch, installationId });
return new Response('OK', { status: 200 });
```

### GitHub App 認証
`jose` ライブラリ (PKCS#8 + RS256) を使用します。各キューコンシューマの起動前に新しく生成します (トークンの有効期限は 1 時間)。

1. `jose` (`SignJWT`, `importPKCS8`) を使用してアプリのシークレットキーで JWT に署名
2. JWT を交換してインストール アクセストークン: `POST /app/installations/{id}/access_tokens`
3. すべての GitHub API 呼び出しにインストール トークン (`Authorization: Bearer <token>`) を使用

> **PKCS#1 → PKCS#8 が必要:** GitHub はキー PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`) でダウンロードされます。保存前に変換します:
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
>   -in private-key.pem -out private-key-pkcs8.pem
> ```

### OpenAI 経由の翻訳
デフォルトモデル: **`gpt-4o-mini`** (128K コンテキスト、gpt-4o より約 16 倍安価)。`temperature: 0.1` を使用して翻訳の一貫性を保ちます。モデルに対してすべてのマークダウン構文、frontmatter、コードブロック内容を変更されないままで保存するよう明示的に指示します。429 エラーに対してはエクスポーネンシャルバックオフ (6 回試行、1s→2s→4s→...60s キャップ ±25% ジッター) で呼び出し됩니다。

### PR 作成フロー (Git Database API — 7 呼び出し)
1. `GET /git/ref/heads/{base}` — HEAD コミット SHA
2. `GET /git/commits/{sha}` — ツリー SHA
3. `POST /git/blobs` 翻訳済みファイルごと — blob SHA
4. `POST /git/trees` すべての blob で — 新しいツリー SHA
5. `POST /git/commits` — 新しいコミット SHA
6. `POST /git/refs` — ブランチを作成 `translate/pr-{prNumber}`
7. `POST /pulls` — タイトル `[Translation] {LANG}: PR #{prNumber} — {title}` で PR を開く

### スト差別化
作業を開始する前に、コンシューマは KV でキー `{owner}/{repo}#{prNumber}` をチェックします。見つかった場合、`msg.ack()` を実行して返します — ジョブ再キューの送信で既に完了します。翻訳 PR が正常に開かれた後、PR URL を KV に書き込みます。

---

## 環境と設定

必要なシークレット (本番環境では `wrangler secret put` で設定; ローカルでは `.dev.vars`):

```
GITHUB_APP_ID=           # 数値の GitHub App ID
GITHUB_APP_PRIVATE_KEY=  # PKCS#8 PEM シークレットキー (改行は \n として保存)
GITHUB_WEBHOOK_SECRET=   # GitHub App 設定の Webhook HMAC シークレット
OPENAI_API_KEY=          # OpenAI API キー (sk-...)
TARGET_LANG=             # 翻訳対象言語、例: "Japanese"
```

`.dev.vars` は git-ignore です。`.dev.vars.example` をコピーして開始してください。

`wrangler.jsonc` 設定:

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

## テスト

テスト フレームワーク: **Vitest** と Workers ランタイム用の `@cloudflare/vitest-pool-workers`。

```bash
# すべてのテストを実行
npm test

# 単一のテスト ファイルを実行
npx vitest run test/github.test.ts

# ウォッチ モード
npx vitest
```

- `vi.fn()` で `fetch` をモックして `github.ts` と `openai.ts` をテスト
- 既知のテスト ケースでキューの webhook 署名検証をテスト
- テストで実際のネットワーク呼び出しを実行してはいけ**ません**

---

## ハマりやすい落とし穴

- **PKCS#1 vs PKCS#8**: GitHub App シークレットキーは PKCS#1 です。`jose` には PKCS#8 が必要です。保存する前に `openssl pkcs8` で変換してください。形式が間違っていると、`jose` は正確なエラーをスキップします。
- **シークレットキーの改行**: `\n` がリテラルで保存されています (`cat | wrangler secret put` でファイルを使用)。実行時に復元: `.replace(/\\n/g, '\n')`。
- **キュー バインディング**: バインディング名は `PR_QUEUE` でキュー名は `pr-translation-jobs` です。異なる名前の `TRANSLATION_QUEUE` / `translation-jobs` を使用しないでください。
- **キュー メッセージ サイズ**: 128 KB 制限 — メタデータのみをエンキューします (PR 番号、owner、repo、SHA)。ファイル内容をエンキューしません。
- **CPU 制限**: `wrangler.jsonc` で `"limits": { "cpu_ms": 300000 }` をコンシューマ用に設定します (300,000 ms = 5 分)。I/O 待機 (API 呼び出し) は CPU 時間にはカウントされません。
- **スト差別化**: キューは最大 1 回配信します。重複を避けるため、常に翻訳やブランチ/PR を作成する前に `IDEMPOTENCY_KV` をチェックしてください。
- **トークンの有効期限**: インストール アクセス トークンの有効期限は 1 時間です。常に各 `queue` ハンドラ呼び出しの開始時に JWT とトークンを再生成してください。
- **OpenAI レート制限**: 429 でエクスポーネンシャル バックオフを使用してください。並列ファイル翻訳は TPM 制限に当たることがあります — ジョブごとにファイルを順番に処理します。