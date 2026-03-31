# gh-translate-app – Agent Guide

GitHub App that automatically translates markdown documents found in a pull request and opens a new PR containing the translated files, powered by OpenAI or Claude and hosted on Cloudflare Workers.

What the heck is this?

---

## Architecture Overview

```
GitHub PR opened/updated
        ↓
        ↓
──────────────────────────
│  Cloudflare Worker   │  │ webhook handler (validates signature, responds 200 fast)
│  (src/index.ts)      │
──────────────┬─────────────
           │  enqueue job (metadata only)
           ↓
──────────────────────────
│  Cloudflare Queue    │  │ decouples slow work from the HTTP response
│  (pr-translation-    │    at-least-once delivery, 3 retries + DLQ
│   jobs)              │
──────────────┬─────────────
           │  consume
           ↓
──────────────────────────
│  Queue Consumer      │  │ fetches markdown files via GitHub API,
│  (src/index.ts)      │    translates (OpenAI or Claude), commits
──────────────────────────    translations, opens new PR
```

**使用される Cloudflare サービス:**

- **Workers** – HTTP webhook ハンドラー + キュー コンシューマー
- **Queues** – 非同期ジョブ キュー (webhook レスポンスと長時間実行される翻訳を分離)
- **Workers KV** – べき等性ストア (キューの再配信時の重複翻訳 PR を防止)
- **Workers Secrets** – `GITHUB_APP_PRIVATE_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_WEBHOOK_SECRET` を保存

詳細な設計とトレードオフについては、[ARCHITECTURE.md](ARCHITECTURE.md) を参照してください。

---

## Project Layout

```
gh-translate-app/
├── src/
│   ├── index.ts             # Worker エントリーポイント: fetch ハンドラー (webhook) + キュー ハンドラー (コンシューマー)
│   ├── translate.ts         # プロバイダー ファサード: TRANSLATION_PROVIDER に基づいて OpenAI または Claude にルーティング
│   ├── translate-utils.ts   # 共有: ProviderError, buildSystemPrompt, withBackoff, チャンク分割
│   ├── openai.ts            # OpenAI プロバイダー (gpt-4o-mini)
│   ├── claude.ts            # Claude プロバイダー (claude-haiku-4-5-20251001)
│   ├── github.ts            # GitHub API クライアント (認証, ファイル一覧, Git DB API, PR オープン)
│   ├── idempotency.ts       # Workers KV ヘルパー (重複排除チェック)
│   ├── types.ts             # 共有 TypeScript 型 (QueueMessage, Env など)
├── test/
│   ├── *.test.ts         # Vitest ユニット テスト
├── wrangler.jsonc         # Cloudflare Workers + Queues + KV コンフィギュレーション
├── .dev.vars             # ローカル シークレット (git 無視)
├── .dev.vars.example     # 必須シークレットのテンプレート
├── .gitignore
├── package.json
├── tsconfig.json
```

---

## Build & Test

```bash
# 依存関係をインストール
npm install

# ローカル開発 (Worker を http://localhost:8787 で実行)
npm run dev

# 型チェック
npm run typecheck

# テストを実行
npm test

# Lint
npm run lint

# Cloudflare にデプロイ
npm run deploy
```

**タスクが完了したと見なす前に、必ず `npm run typecheck` と `npm test` を実行してください。**

---

## Key Patterns

### Webhook 検証

`X-Hub-Signature-256` ヘッダーを HMAC-SHA256 で検証します (Web Crypto API の `crypto.subtle` を使用)。JSON を解析する**前に**ボディをテキストとして読み取ります。ストリームは 1 回だけしか使用できません。

```ts
// HMAC-SHA256 を使用して X-Hub-Signature-256 ヘッダーを検証
const key = await crypto.subtle.importKey(
  "raw",
  encoder.encode(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
// タイミング安全な比較を使用して hex(sig) をヘッダー値と比較
```

### Webhook – キュー ハンドオフ

Webhook ハンドラーは GitHub の 10 秒のタイムアウト内に `200 OK` を返す必要があります。すべての実際の作業はキュー コンシューマーで行われます。

```ts
// index.ts: メタデータのみをエンキューし、すぐに返す
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

### GitHub App 認証

`jose` ライブラリを使用します (PKCS#8 + RS256)。各キュー コンシューマー呼び出しの開始時に再生成します (トークンは 1 時間で期限切れ)。

1. `jose` (`SignJWT`, `importPKCS8`) を使用してアプリのプライベート キーで JWT に署名します
2. JWT を交換 → インストール アクセス トークン: `POST /app/installations/{id}/access_tokens`
3. すべての GitHub API 呼び出しにインストール トークン (`Authorization: Bearer <token>`) を使用します

> **PKCS#1 → PKCS#8 が必須:** GitHub はキーを PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`) としてダウンロードします。保存する前に変換します:
>
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
>   -in private-key.pem -out private-key-pkcs8.pem
> ```

### 翻訳プロバイダー

プロバイダーは `TRANSLATION_PROVIDER` (デフォルト: `openai`) で選択されます。ルーティングは `src/translate.ts` に、共有ユーティリティ (システム プロンプト、リトライ ロジック、チャンク分割) は `src/translate-utils.ts` に存在します。

| プロバイダー       | 環境変数             | モデル                      | 注記                                                                              |
| ------------------ | ------------------- | --------------------------- | --------------------------------------------------------------------------------- |
| `openai` (デフォルト) | `OPENAI_API_KEY`    | `gpt-4o-mini`               | `temperature: 0.1`, `messages[]` 内のシステム メッセージ                           |
| `claude`           | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` | トップレベルの `system` フィールドのシステム プロンプト, `anthropic-version: 2023-06-01` ヘッダー |

両方のプロバイダーは同じシステム プロンプト、チャンク分割戦略 (ファイル > 300KB の場合は見出しで分割)、429 エラー用の指数バックオフ (6 回のリトライ, 1秒–2秒–4秒…60秒キャップ, ±25% ジッター) を共有します。

### PR 作成フロー (Git Database API – 7 呼び出し)

1. `GET /git/ref/heads/{base}` – HEAD コミット SHA
2. `GET /git/commits/{sha}` – tree SHA
3. `POST /git/blobs` (翻訳ファイルごと) – blob SHA
4. `POST /git/trees` (すべての blob を含む) – 新しい tree SHA
5. `POST /git/commits` – 新しいコミット SHA
6. `POST /git/refs` – ブランチ `translate/pr-{prNumber}` を作成
7. `POST /pulls` – `[Translation] {LANG}: PR #{prNumber} – {title}` というタイトルで PR をオープン

### べき等性

任意の作業を行う前に、コンシューマーは KV でキー `{owner}/{repo}#{prNumber}` をチェックします。見つかった場合、`msg.ack()` を実行して返ります – ジョブは前の配信で既に完了しています。翻訳 PR を正常にオープンした後、PR URL を KV に書き込みます。

---

## Environment & Configuration

必須シークレット (本番環境では `wrangler secret put` で設定、ローカルでは `.dev.vars`):

```
GITHUB_APP_ID=           # 数値の GitHub App ID
GITHUB_APP_PRIVATE_KEY=  # PKCS#8 PEM プライベート キー (改行は \n として保存)
GITHUB_WEBHOOK_SECRET=   # GitHub App 設定からの Webhook HMAC シークレット
OPENAI_API_KEY=          # OpenAI API キー (sk-...) – TRANSLATION_PROVIDER=openai (デフォルト) の場合は必須
TARGET_LANG=             # 翻訳対象言語, 例: "日本語"
TRANSLATION_PROVIDER=    # オプション: "openai" (デフォルト) または "claude"
ANTHROPIC_API_KEY=       # Anthropic API キー (sk-ant-...) – TRANSLATION_PROVIDER=claude の場合は必須
```

`.dev.vars` は git 無視です。`.dev.vars.example` をコピーして開始します。

`wrangler.jsonc` コンフィギュレーション:

```jsonc
{
  "name": "gh-translate-worker",
  "main": "src/index.ts",
  "compatibility_date": "2024-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "limits": { "cpu_ms": 300000 }, // 有料プランのみ

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

フレームワーク: **Vitest** (Workers ランタイムの忠実さのための `@cloudflare/vitest-pool-workers`)

```bash
# すべてのテストを実行
npm test

# 単一のテスト ファイルを実行
npx vitest run test/github.test.ts

# ウォッチ モード
npx vitest
```

- `vi.spyOn(globalThis, 'fetch')` を使用した `fetch` のモックによって `openai.ts` と `claude.ts` をユニット テストします
- `vi.mock` を使用して両方のプロバイダーをモックすることで `translate.test.ts` でファサード ルーティングをテストします
- 既知のテスト ベクトルで webhook 署名検証をテストします
- テストで実際のネットワーク呼び出しを**しない**でください

---

## Common Pitfalls

- **PKCS#1 vs PKCS#8**: GitHub App プライベート キーは PKCS#1 です。`jose` は PKCS#8 が必要です。保存する前に `openssl pkcs8` で変換してください。間違った形式を渡すと `jose` は明確なエラーをスローします。
- **プライベート キーの改行**: Python を使用してキーを `.dev.vars` に書き込みます – `tr` は信頼性が低く、不正な形式の出力を生成します。本番環境シークレットの場合、`cat file | wrangler secret put` は正しく動作します (wrangler は実際の改行を保持)。実行時、コードは `.replace(/\\n/g, '\n')` を実行してどちらかの形式に対応します。
  ```bash
  python3 -c "
  key = open('private-key-pkcs8.pem').read().strip().replace('\n', r'\n')
  print(f'GITHUB_APP_PRIVATE_KEY=\"{key}\"')
  " >> .dev.vars
  ```
- **キュー バインディング名**: バインディングは `PR_QUEUE` で、キュー名は `pr-translation-jobs` です。古い名前 `TRANSLATION_QUEUE` / `translation-jobs` は使用しないでください。
- **キュー メッセージ サイズ**: 128 KB 制限 – メタデータのみをエンキューします (PR 番号, owner, repo, SHA)。ファイル コンテンツをエンキューしないでください。
- **CPU 制限**: `wrangler.jsonc` のコンシューマーに `"limits": { "cpu_ms": 300000 }` を設定します (300,000 ms = 5 分)。I/O 待機 (API 呼び出し) は CPU 時間にカウントされません。注: 有料プランのみ。
- **べき等性**: キューは最低 1 回配信します。重複を避けるために、翻訳ブランチ/PR を作成する前に常に `IDEMPOTENCY_KV` をチェックしてください。
- **トークンの有効期限**: インストール アクセス トークンは 1 時間で期限切れになります。各 `queue` ハンドラー呼び出しの開始時に常に JWT とトークンを再生成してください。
- **API レート制限**: 両方のプロバイダーは 429 時に指数バックオフを使用します。ファイルは順番に翻訳され、TPM/RPM スパイクを回避します。
- **Claude キーなし**: `TRANSLATION_PROVIDER=claude` だが `ANTHROPIC_API_KEY` がない場合、コンシューマーは `"ANTHROPIC_API_KEY is required..."` ですぐにスローします。キューは 3 回リトライしてから DLQ に送信します – シークレットを修正し、DLQ から再処理してください。
- **プロバイダー ルーティング**: `src/translate.ts` は静的に `openai.ts` と `claude.ts` の両方をインポートします。プロバイダー選択ロジックを `src/index.ts` に追加しないでください – それはファサードに属しています。