# gh-translate-app — GitHub App Ray

GitHub App に webhook リクエストで markdown ドキュメントを自動翻訳し、翻訳済みファイルを含む新しい PR を開く。OpenAI と Cloudflare Workers で実装。

---

## アーキテクチャ概要

```
GitHub PR opened/updated
        ↓
        ↓
──────────────────────────
│  Cloudflare Worker   │  │ webhook ハンドラー（署名検証、200 高速応答）
│  (src/index.ts)      │
─────────────────┬──────────
           ↓  ジョブ エンキュー（メタデータのみ）
           ↓
──────────────────────────
│  Cloudflare Queue    │  │ HTTP 応答から外れた後処理
│  (pr-translation-    │    実装 1 回信頼，3 回オーバーレイ + DLQ
│   jobs)              │
─────────────────┬──────────
           ↓  consume
           ↓
──────────────────────────
│  Queue Consumer      │  │ GitHub API で markdown ファイル取得、
│  (src/queue.ts)      │    OpenAI 呼び出し（gpt-4o-mini）、
──────────────────────────    翻訳済みコンテンツで新しい PR を開く
```

**使用する Cloudflare サービス：**
- **Workers** — HTTP webhook ハンドラー + キュー コンシューマー
- **Queues** — 非同期ジョブ キュー（webhook 応答から長時間実行の翻訳を分離）
- **Workers KV** — 短期ストア（キュー 再試信時に重複翻訳 PR を防ぐ）
- **Workers Secrets** — `GITHUB_APP_PRIVATE_KEY`、`OPENAI_API_KEY`、`GITHUB_WEBHOOK_SECRET` を保存

詳細な設計とデプロイについては [ARCHITECTURE.md](ARCHITECTURE.md) を参照。

---

## プロジェクト レイアウト

```
gh-translate-app/
├── src/
│   ├── index.ts          # Worker エントリ（webhook 検証、ジョブ エンキュー）
│   ├── queue.ts          # キュー コンシューマー（翻訳 → PR コード調整）
│   ├── github.ts         # GitHub API クライアント（認証、ファイル一覧、Git DB API、PR 開く）
│   ├── openai.ts         # OpenAI 翻訳ヘルパー（gpt-4o-mini のリファイン ロジック）
│   ├── idempotency.ts    # Workers KV ヘルパー（重複除外チェック）
│   ├── types.ts          # 共有 TypeScript 型（QueueMessage など）
├── test/
│   ├── *.test.ts         # Vitest ユニット テスト
├── wrangler.jsonc         # Cloudflare Workers + Queues + KV 構成
├── .dev.vars             # ローカル シークレット（git 除外）
├── .dev.vars.example     # 必須 シークレット用テンプレート
├── .gitignore
├── package.json
├── tsconfig.json
```

---

## ビルド・テスト

```bash
# 依存関係のインストール
npm install

# ローカル開発（Worker が http://localhost:8787 で実行）
npm run dev

# 型をチェック
npm run typecheck

# テスト実行
npm test

# リント
npm run lint

# Cloudflare にデプロイ
npm run deploy
```

**タスクを完了する前に、必ず `npm run typecheck` と `npm test` を実行してください。**

---

## 主要パターン

### Webhook 検証
Web Crypto API を使用して HMAC-SHA256 で `X-Hub-Signature-256` ヘッダーを検証、JSON を解析。**前に**本体をプレーンテキストとして読み込む — ストリームは 1 回しか使用できない。

```ts
// HMAC-SHA256 を使用して X-Hub-Signature-256 ヘッダーを検証
const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
// hex(sig) でバイナリ比較で予想値と比較
```

### Webhook → キュー メッセージング
Webhook ハンドラーは GitHub の 10 秒タイムアウト前に `200 OK` を返す必要があります。すべての実際の処理はキュー コンシューマーで行われます。

```ts
// index.ts：メタデータのみをエンキューして素早く返す
await env.PR_QUEUE.send({ prNumber, repo, owner, headSha, baseBranch, installationId });
return new Response('OK', { status: 200 });
```

### GitHub App 認証
`jose` ライブラリを使用（PKCS#8 + RS256）。キュー コンシューマー呼び出しの開始時に毎回生成（トークンの有効期限は 1 時間）。

1. App の秘密鍵で JWT に署名（`jose` (`SignJWT`, `importPKCS8`) を使用）
2. JWT → インスタンス固有アクセス トークン交換（`POST /app/installations/{id}/access_tokens`）
3. すべての GitHub API 呼び出しにインスタンス固有トークン（`Authorization: Bearer <token>`）を使用

> **PKCS#1 → PKCS#8 は必須。** GitHub キーに PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`) としてダウンロード・保存されます。前に変換：
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
>   -in private-key.pem -out private-key-pkcs8.pem
> ```

### OpenAI による翻訳
デフォルト モデル：**`gpt-4o-mini`**（128K コンテキスト、gpt-4o より約 16 倍安い）。翻訳の一貫性を保つ `temperature: 0.1` を使用。すべての markdown 構造、frontmatter、コード ブロック コンテンツを変更しないよう保つ。明示的にモデルに指示。429 エラーに最新のリファイン（6 回のリトライで 1 秒・2 秒・4 秒・…60 秒以降 ±25% ジッター）。

### PR 作成フロー（Git Database API — 7 呼び出し）
1. `GET /git/ref/heads/{base}` — HEAD コミット SHA
2. `GET /git/commits/{sha}` — ツリー SHA
3. `POST /git/blobs`（翻訳済みファイルごと） — blob SHA
4. `POST /git/trees`（すべての blob） — 新しいツリー SHA
5. `POST /git/commits` — 新しいコミット SHA
6. `POST /git/refs` — ブランチ `translate/pr-{prNumber}` を作成
7. `POST /pulls` — PR を開く。タイトル `[Translation] {LANG}: PR #{prNumber} — {title}`

### 冪等性
作業を開始する前に、コンシューマーは KV でキー `{owner}/{repo}#{prNumber}` をチェック。見つかった場合は `msg.ack()` して戻る — 次の再試信でジョブをチェック済みになる。翻訳 PR が正常に開かれた後、PR URL を KV に書き込み。

---

## 環境と構成

必須シークレット（本番環境は `wrangler secret put` で設定。ローカルは `.dev.vars`）：

```
GITHUB_APP_ID=           # GitHub App ID（数字）
GITHUB_APP_PRIVATE_KEY=  # PKCS#8 PEM 秘密鍵（改行を \n として保存）
GITHUB_WEBHOOK_SECRET=   # GitHub App 設定の Webhook HMAC シークレット
OPENAI_API_KEY=          # OpenAI API キー（sk-...）
TARGET_LANG=             # 翻訳対象言語。例：Japanese
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

テスト フレームワーク：**Vitest** with `@cloudflare/vitest-pool-workers`（Workers ランタイム 互換性）。

```bash
# すべてのテストを実行
npm test

# 別個テスト ファイルを実行
npx vitest run test/github.test.ts

# ウォッチ モード
npx vitest
```

- `github.ts` と `openai.ts` の `vi.fn()` で `fetch` をモックしてテスト
- 既知のテスト ブロックで webhook 署名検証をテスト
- テストで実際のキュー呼び出しを行わない

---

## 一般的なトラップと穴

- **PKCS#1 vs PKCS#8**：GitHub App 秘密鍵は PKCS#1。`jose` には PKCS#8 が必須。保存する前に `openssl pkcs8` で変換。間違った形式を渡すと `jose` は不正確なエラーを出します。
- **秘密鍵の改行**：`\n` のリテラルで保存。ファイルを `cat` で pipe して `wrangler secret put` でランタイムで復元（`.replace(/\\n/g, '\n')`）。
- **キュー バインド名**：バインド は `PR_QUEUE`。キュー名は `pr-translation-jobs`。別の名前 `TRANSLATION_QUEUE` / `translation-jobs` を使用しないでください。
- **キュー メッセージ サイズ**：128 KB 制限 — メタデータのみをエンキュー（PR 番号、owner、repo、SHA）。ファイル コンテンツをエンキューしないでください。
- **CPU 制限**：`wrangler.jsonc` のコンシューマーに `"limits": { "cpu_ms": 300000 }` を設定（300,000 ミリ秒 = 5 分）。I/O 待機（API 呼び出し）は CPU 時間にカウント されません。
- **冪等性**：キュー は最低 1 回配信。重複翻訳・ブランチ/PR を避けるため、翻訳ブランチ/PR を作成する前に常に `IDEMPOTENCY_KV` をチェック。
- **トークン有効期限**：インスタンス固有アクセス トークンの有効期限は 1 時間。各 `queue` ハンドラー呼び出しの開始時に常に JWT とトークンを再生成。
- **OpenAI レート制限**：429 になるリファイン があります。並列ファイル翻訳は TPM 制限に触れる可能性あり — ジョブ ごと、ファイルを 順序立てて処理。