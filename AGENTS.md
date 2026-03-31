# gh-translate-app — エージェント ガイド

GitHub App により、プルリクエストにある markdown ドキュメントを自動的に翻訳し、翻訳されたファイルを含む新しい PR を開く。OpenAI と Cloudflare Workers で実装。

---

## アーキテクチャ概要

```
GitHub PR opened/updated
        ↓
        ↓
──────────────────────────
│  Cloudflare Worker   │  → webhook ハンドラー（署名検証、200 高速応答）
│  (src/index.ts)      │
────────────┬──────────────
           ↓  ジョブをエンキュー（メタデータのみ）
           ↓
──────────────────────────
│  Cloudflare Queue    │  → HTTP 応答から遅い処理を分離
│  (pr-translation-    │    最低 1 回配信、3 回リトライ + DLQ
│   jobs)              │
────────────┬──────────────
           ↓  consume
           ↓
──────────────────────────
│  Queue Consumer      │  → GitHub API で markdown ファイル取得、
│  (src/queue.ts)      │    OpenAI を呼び出し（gpt-4o-mini）、
──────────────────────────    翻訳をコミット、新しい PR を開く
```

**使用する Cloudflare サービス：**
- **Workers** — HTTP webhook ハンドラー + キュー コンシューマー
- **Queues** — 非同期ジョブ キュー（webhook 応答から長時間実行の翻訳を分離）
- **Workers KV** — 冪等性ストア（キュー 再配信時に重複翻訳 PR を防ぐ）
- **Workers Secrets** — `GITHUB_APP_PRIVATE_KEY`、`OPENAI_API_KEY`、`GITHUB_WEBHOOK_SECRET` を保存

詳細な設計とトレードオフについては [ARCHITECTURE.md](ARCHITECTURE.md) を参照。

---

## プロジェクト レイアウト

```
gh-translate-app/
├── src/
│   ├── index.ts          # Worker エントリ：webhook 検証、ジョブ エンキュー
│   ├── queue.ts          # キュー コンシューマー：翻訳 → PR フロー を調整
│   ├── github.ts         # GitHub API クライアント（認証、ファイル一覧、Git DB API、PR 開く）
│   ├── openai.ts         # OpenAI 翻訳ヘルパー（gpt-4o-mini、リトライ ロジック）
│   ├── idempotency.ts    # Workers KV ヘルパー（重複排除チェック）
│   ├── types.ts          # 共有 TypeScript 型（QueueMessage など）
├── test/
│   ├── *.test.ts         # Vitest ユニット テスト
├── wrangler.jsonc         # Cloudflare Workers + Queues + KV 構成
├── .dev.vars             # ローカル シークレット（git 除外）
├── .dev.vars.example     # 必須シークレット用テンプレート
├── .gitignore
├── package.json
├── tsconfig.json
```

---

## ビルド＆テスト

```bash
# 依存関係のインストール
npm install

# ローカル開発（Worker を http://localhost:8787 で実行）
npm run dev

# 型チェック
npm run typecheck

# テスト実行
npm test

# リント
npm run lint

# Cloudflare にデプロイ
npm run deploy
```

**タスクが完了したと判断する前に、必ず `npm run typecheck` と `npm test` を実行してください。**

---

## 主要パターン

### Webhook 検証
Web Crypto API を使用して HMAC-SHA256 で `X-Hub-Signature-256` ヘッダーを検証。JSON を解析する**前に**本体をテキストとして読み込み — ストリームは 1 回しか使用できない。

```ts
// HMAC-SHA256 を使用して X-Hub-Signature-256 ヘッダーを検証
const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
// hex(sig) をタイミング安全比較でヘッダー値と比較
```

### Webhook → キュー ハンドオフ
Webhook ハンドラーは GitHub の 10 秒タイムアウト内に `200 OK` を返す必要があります。すべての実際の処理はキュー コンシューマーで行われます。

```ts
// index.ts：メタデータのみをエンキュー、すぐに返す
await env.PR_QUEUE.send({ prNumber, repo, owner, headSha, baseBranch, installationId });
return new Response('OK', { status: 200 });
```

### GitHub App 認証
`jose` ライブラリを使用（PKCS#8 + RS256）。キュー コンシューマー呼び出しの開始時に再生成（トークンの有効期限は 1 時間）。

1. App の秘密鍵で JWT に署名：`jose` (`SignJWT`, `importPKCS8`) を使用
2. JWT → インストレーション アクセス トークン交換：`POST /app/installations/{id}/access_tokens`
3. すべての GitHub API 呼び出しにインストレーション トークン（`Authorization: Bearer <token>`）を使用

> **PKCS#1 → PKCS#8 が必須：** GitHub はキーを PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`) として ダウンロード。保存する前に変換：
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
>   -in private-key.pem -out private-key-pkcs8.pem
> ```

### OpenAI による翻訳
デフォルト モデル：**`gpt-4o-mini`**（128K コンテキスト、gpt-4o より約 16 倍安い）。翻訳の一貫性を保つため `temperature: 0.1` を使用。すべての markdown 構文、frontmatter、コード ブロック コンテンツを変更せずに保つよう明示的にモデルに指示。429 エラーに指数バックオフでラップ（6 回リトライ、1 秒→2 秒→4 秒…60 秒上限、±25% ジッター）。

### PR 作成フロー（Git Database API — 7 呼び出し）
1. `GET /git/ref/heads/{base}` → HEAD コミット SHA
2. `GET /git/commits/{sha}` → ツリー SHA
3. `POST /git/blobs`（翻訳ファイルごと） → blob SHA
4. `POST /git/trees`（すべての blob） → 新しいツリー SHA
5. `POST /git/commits` → 新しいコミット SHA
6. `POST /git/refs` → ブランチ `translate/pr-{prNumber}` を作成
7. `POST /pulls` → PR を開く。タイトル `[Translation] {LANG}: PR #{prNumber} — {title}`

### 冪等性
作業を開始する前に、コンシューマーは KV でキー `{owner}/{repo}#{prNumber}` をチェック。見つかった場合、`msg.ack()` して返す — 前の配信でジョブは既に完了。翻訳 PR を正常に開いた後、PR URL を KV に書き込み。

---

## 環境と構成

必須シークレット（本番環境は `wrangler secret put` で設定；ローカルは `.dev.vars`）：

```
GITHUB_APP_ID=           # GitHub App ID（数値）
GITHUB_APP_PRIVATE_KEY=  # PKCS#8 PEM 秘密鍵（改行を \n として保存）
GITHUB_WEBHOOK_SECRET=   # GitHub App 設定から Webhook HMAC シークレット
OPENAI_API_KEY=          # OpenAI API キー（sk-...）
TARGET_LANG=             # 翻訳対象言語、例「Japanese」
```

`.dev.vars` は git 除外。`.dev.vars.example` をコピーして開始。

`wrangler.jsonc` 構成：

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

フレームワーク：**Vitest** with `@cloudflare/vitest-pool-workers`（Workers ランタイム 忠実性）。

```bash
# すべてのテストを実行
npm test

# 単一テスト ファイルを実行
npx vitest run test/github.test.ts

# ウォッチ モード
npx vitest
```

- `github.ts` と `openai.ts` を `vi.fn()` で `fetch` をモックしてユニット テスト
- 既知のテスト ベクトルで webhook 署名検証をテスト
- テストで実ネットワーク呼び出しを行わない

---

## 一般的な落とし穴

- **PKCS#1 vs PKCS#8**：GitHub App 秘密鍵は PKCS#1。`jose` には PKCS#8 が必要。保存する前に `openssl pkcs8` で変換。間違った形式を渡すと `jose` は明確なエラーを投げます。
- **秘密鍵の改行**：`\n` リテラルで保存（ファイルを `cat` で pipe して `wrangler secret put` で）。ランタイムで復元：`.replace(/\\n/g, '\n')`。
- **キュー バインド名**：バインドは `PR_QUEUE`、キュー名は `pr-translation-jobs`。古い名前 `TRANSLATION_QUEUE` / `translation-jobs` を使用しないでください。
- **キュー メッセージ サイズ**：128 KB 制限 — メタデータのみをエンキュー（PR 番号、owner、repo、SHA）。ファイル コンテンツをエンキューしないでください。
- **CPU 制限**：`wrangler.jsonc` のコンシューマーに `"limits": { "cpu_ms": 300000 }` を設定（300,000 ミリ秒 = 5 分）。I/O 待機（API 呼び出し）は CPU 時間にカウントされません。
- **冪等性**：キューは最低 1 回配信。重複翻訳ブランチ/PR を避けるため、翻訳ブランチ/PR を作成する前に常に `IDEMPOTENCY_KV` をチェック。
- **トークン有効期限**：インストレーション アクセス トークンの有効期限は 1 時間。各 `queue` ハンドラー呼び出しの開始時に常に JWT とトークンを再生成。
- **OpenAI レート制限**：429 に指数バックオフを使用。並列ファイル翻訳は TPM 制限に達する可能性 — ジョブ内でファイルを順序立てて処理。