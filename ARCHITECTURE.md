# アーキテクチャ — gh-translate-app

> **ステータス: レビュー済みデザイン — 実装準備完了。**

---

## 1. システム概要

プルリクエストイベントをリッスンし、変更されたMarkdownファイルを検出し、OpenAIで翻訳し、翻訳を含む新しいPRを開くGitHub App。バックエンドはCloudflare Workers上で完全に実行されます。

```
─────────────────────────────────────────────────────────────────
│  GitHub                                                         │
│                                                                 │
│  [PR opened / synchronize / reopened]                           │
│           │                                                     │
│           │  POST /webhook  (X-Hub-Signature-256)               │
│           ↓                                                     │
─────────────────────────────────────────────────────────────────┤
│  Cloudflare Workers                                             │
│                                                                 │
│  ─────────────────────────────  enqueue  ──────────────────   │
│  │  Webhook Handler     │ ──────────────→ │  CF Queue      │  │
│  │  (src/index.ts)      │                 │  (pr-jobs)     │  │
│  │  - verify HMAC-SHA256│                 ──────┬──────────   │
│  │  - return 200 fast   │                        │ consume     │
│  ──────────────────────────                      ↓             │
│                                           ──────────────────   │
│                                           │ Queue Consumer │   │
│                                           │ (src/queue.ts) │   │
│                                           ──────┬──────────   │
│                                                  │              │
│                              ────────────────────┼────────────  │
│                              │                   │           │  │
│                              ↓                   ↓           │  │
│                    [GitHub REST API]     [OpenAI API]        │  │
│                    - list PR files      - translate .md      │  │
│                    - create branch      - gpt-4o-mini        │  │
│                    - commit files                            │  │
│                    - open new PR        [CF Workers KV]      │  │
│                                         - idempotency store  │  │
─────────────────────────────────────────────────────────────────
```

---

## 2. 使用するCloudflareサービス

| サービス | 役割 | 理由 |
|---|---|---|
| **Workers** | Webhookハンドラー + キューコンシューマー | サーバーレスHTTP + イベント駆動のコンピュート |
| **Queues** | ハンドラーとコンシューマー間の非同期ジョブキュー | GitHubの10秒webhookタイムアウトから遅い翻訳作業を分離。少なくとも1回の配信と再試行 |
| **Workers Secrets** | APIキーと秘密鍵を保存 | 保存時に暗号化。ランタイムに`env`に注入 |
| **Workers KV** *（オプション）* | べき等性ストア：翻訳済みPRを追跡 | キューの再配信による重複翻訳PRを防止 |

**キューを使用する理由と`ctx.waitUntil()`ではない理由:** `waitUntil`は再試行なしのファイア・アンド・フォーゲット型です。翻訳が途中で失敗すると、作業は静かに失われます。キューは設定可能な再試行、デッドレターキュー、コンシューマー呼び出しごとに最大15分の実経過時間を提供します。

---

## 3. GitHub Appセットアップ

### 3.1 必要なパーミッション

| パーミッション | レベル | 必要な用途 |
|---|---|---|
| Pull requests | 読み取り & 書き込み | PRファイルの一覧表示。翻訳PRの開始 |
| Contents | 読み取り & 書き込み | Markdownファイルの読み取り。ブランチ + コミットの作成 |
| Metadata | 読み取り | リポジトリ情報（自動付与） |

### 3.2 購読するWebhookイベント

| イベント | アクション |
|---|---|
| `pull_request` | `opened`、`synchronize`、`reopened` |

### 3.3 認証フロー

キューコンシューマーの各呼び出しは以下を実行する必要があります：

1. **GitHub App JWTを生成** (RS256、Appの秘密鍵で署名)
   - `iss` = GitHub App ID
   - `iat` = `now - 60s`（クロックドリフト許容度）
   - `exp` = `now + 600s`（最大10分）
   - ライブラリ：[`jose`](https://github.com/panva/jose) — ゼロ依存、Web Crypto API互換

2. **JWTをインストーション アクセストークンに交換**
   ```
   POST /app/installations/{installation_id}/access_tokens
   Authorization: Bearer <JWT>
   ```
   トークンは**1時間**で期限切れ。コンシューマー呼び出しの開始時に再生成してください。

3. **すべてのGitHub REST APIコール用にインストーション トークンを使用**
   ```
   Authorization: Bearer <installation_access_token>
   ```

> **重要:** GitHub Appの秘密鍵は**PKCS#1形式**（`-----BEGIN RSA PRIVATE KEY-----`）でダウンロードされます。`jose`ライブラリは**PKCS#8形式**（`-----BEGIN PRIVATE KEY-----`）を必要とします。保存前に変換してください：
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
>   -in private-key.pem -out private-key-pkcs8.pem
> ```

---

## 4. データフロー — ステップバイステップ

### ステップ1: Webhookを受け取る（Webhook Handler Worker）

```
GitHub → POST /webhook
```

1. 本体をテキストとして読み取ります（ストリームは1回のみ読み取り可能）
2. Web Crypto API（`crypto.subtle`）を使用してHMAC-SHA256で`X-Hub-Signature-256`を検証
3. JSONペイロードを解析。`action`、`pull_request.number`、`repository.owner.login`、`repository.name`、`installation.id`を抽出
4. `action`が`["opened", "synchronize", "reopened"]`に含まれていない場合、`200 OK`を返す（ノーオペレーション）
5. **小さいメタデータメッセージ**（ファイルコンテンツなし）をCloudflare Queueにエンキュー
6. 即座に`200 OK`を返す — 翻訳を待たない

**キューメッセージスキーマ：**
```typescript
{
  prNumber: number;
  owner: string;        // リポジトリ所有者ログイン
  repo: string;         // リポジトリ名
  headSha: string;      // PRヘッドコミットSHA
  baseBranch: string;   // PRベースブランチ（例："main"）
  installationId: number;
}
```

> キューメッセージの制限は128 KB です — 常にメタデータのみをエンキュー。ファイルコンテンツは決して含めない。

### ステップ2: キューコンシューマーがジョブを処理

1. **べき等性チェック**: KVで`{owner}/{repo}#${prNumber}`を検索。すでに翻訳されている場合、`msg.ack()`して返す。
2. **認証**: App JWTを生成 → インストーション アクセストークンに交換
3. **変更ファイルを一覧表示**: `GET /repos/{owner}/{repo}/pulls/{prNumber}/files`
   - `.md`と`.mdx`ファイルを`status !== "removed"`でフィルタリング
   - Markdownファイルがない場合、ackして返す
4. **ファイルコンテンツを取得**: 各ファイルの`GET /repos/{owner}/{repo}/contents/{path}?ref={headSha}`
5. **各ファイルをOpenAI経由で翻訳**（§5参照）
6. **GitHub Git Database API経由で翻訳をコミット**（§6参照）
7. **翻訳PRをソースPRのベースブランチをターゲットとして開く**
8. **KVにべき等性レコードを書き込む**: `{owner}/{repo}#${prNumber}` → `{translationPrUrl}`
9. `msg.ack()`

### ステップ3: 失敗時

- コンシューマーがスロー → キューが再試行（`max_retries: 3`、`retry_delay: 30s`）
- 最大再試行後 → メッセージはデッドレターキューに移動して検査

---

## 5. OpenAI経由の翻訳

### モデル

**デフォルト: `gpt-4o-mini`** — 128Kコンテキストウィンドウ、16,384最大出力トークン。

| | gpt-4o-mini | gpt-4o |
|---|---|---|
| 入力コスト | $0.15 / 100万トークン | $2.50 / 100万トークン |
| 出力コスト | $0.60 / 100万トークン | $10.00 / 100万トークン |
| 品質 | 技術文書に適切 | より高い微妙さ |

推定コスト（10Kトークンファイル当たり）: **約$0.007** (gpt-4o-mini)。

### プロンプト設計

**システムプロンプト:**
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

**APIパラメータ:**
```json
{
  "model": "gpt-4o-mini",
  "temperature": 0.1,
  "max_tokens": 16000
}
```

### チャンキング（大規模ファイルのみ）

ほとんどのMarkdownファイルは10Kトークン未満です — チャンキング不要。約110Kトークン超のファイルの場合：
1. トップレベルの見出し（`\n# `または`\n## `）で分割
2. 最初のチャンクにのみフロントマターを保持
3. 各チャンクを個別に翻訳
4. 順序に従って再組立

### レート制限の処理

HTTP 429で指数バックオフを使用：
- 遅延: 1s → 2s → 4s → 8s → 16s → 32s（60sでキャップ）
- ±25%のランダムジッターを追加して並列リクエストを非同期化
- ファイルごとに最大6回の再試行してからエラーを伝播（キューは全ジョブを再試行）

---

## 6. GitHub Git Database API — 翻訳のコミット

ブランチの作成とファイルのコミットには7つの連続したAPIコール（ローカルGit不要）が必要です：

```
1. GET  /repos/{owner}/{repo}/git/ref/heads/{baseBranch}
        → 現在のHEADコミットSHAを取得

2. GET  /repos/{owner}/{repo}/git/commits/{commitSha}
        → 現在のツリーSHAを取得

3. POST /repos/{owner}/{repo}/git/blobs          (翻訳ファイルごと)
        本体: { content, encoding: "utf-8" }
        → ファイルごとのblobSHAを取得

4. POST /repos/{owner}/{repo}/git/trees
        本体: { base_tree: <treeSha>, tree: [{ path, mode: "100644", type: "blob", sha }] }
        → 新しいツリーSHAを取得

5. POST /repos/{owner}/{repo}/git/commits
        本体: { message, tree: <newTreeSha>, parents: [<parentCommitSha>] }
        → 新しいコミットSHAを取得

6. POST /repos/{owner}/{repo}/git/refs
        本体: { ref: "refs/heads/translate/pr-{prNumber}", sha: <newCommitSha> }
        → 翻訳ブランチを作成

7. POST /repos/{owner}/{repo}/pulls
        本体: { title, head: "translate/pr-{prNumber}", base: {baseBranch}, body }
        → 翻訳PRを開く
```

**ブランチ命名規則:** `translate/pr-{prNumber}`

**PR タイトル規則:** `[Translation] {TARGET_LANG}: PR #{prNumber} — {original PR title}`

---

## 7. `wrangler.jsonc` 設定

```jsonc
{
  "name": "gh-translate-worker",
  "main": "src/index.ts",
  "compatibility_date": "2024-11-01",
  "compatibility_flags": ["nodejs_compat"],

  // コンシューマーの5分CPU制限をオプトイン（I/O待機はカウントされません）
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
        "max_batch_size": 1,          // 予測可能なコスト用に一度に1つのPRを処理
        "max_batch_timeout": 30,
        "max_retries": 3,
        "retry_delay": 30,            // 再試行間隔30秒
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

## 8. シークレット

すべて`wrangler secret put`経由で保存。ソースまたは`wrangler.jsonc`には絶対に含めない。

| シークレット | 説明 |
|---|---|
| `GITHUB_APP_ID` | 数値GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | PKCS#8 PEM秘密鍵（改行は`\n`）|
| `GITHUB_WEBHOOK_SECRET` | GitHub App設定からのWebhook HMACシークレット |
| `OPENAI_API_KEY` | OpenAI APIキー（`sk-...`） |
| `TARGET_LANG` | 翻訳対象言語、例：`"Japanese"`（環境変数でも可） |

**シークレット設定:**
```bash
cat private-key-pkcs8.pem | npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put OPENAI_API_KEY
```

**ローカル開発** (`.dev.vars`):
```ini
GITHUB_APP_ID="123456"
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET="your-local-test-secret"
OPENAI_API_KEY="sk-..."
TARGET_LANG="Japanese"
```

---

## 9. 主要な設計上の決定とトレードオフ

| 決定 | 選択 | 代替案 | 理由 |
|---|---|---|---|
| 非同期メカニズム | Cloudflare **Queues** | `ctx.waitUntil()` | キューには再試行 + DLQがある。`waitUntil`は静かに失敗を削除 |
| 翻訳モデル | **gpt-4o-mini** | gpt-4o | 約16倍安い。ほとんどの技術文書で十分な品質 |
| JWTライブラリ | **`jose`** | 生Web Crypto API | PKCS#8インポート処理、標準対応JWT、最小限コード |
| べき等性ストア | **Workers KV** | なし | キューは少なくとも1回配信。KVが重複翻訳PRを防止 |
| PR ファイルコミット戦略 | **Git Database API** (7コール) | Octokit高レベルAPI | Node.js依存なし。Workers ランタイムでネイティブに動作 |
| Webhookハンドラー速度 | エンキュー + 即座に`200` | インライン処理 | GitHubはwebhookを約10秒でタイムアウト。翻訳は数分要 |

---

## 10. 既知の制約と制限

| 制限 | 値 | 影響 |
|---|---|---|
| GitHub webhookタイムアウト | 10秒 | ハンドラーは翻訳開始前に返す必要 → キュー必須 |
| キューメッセージサイズ | 128 KB | メタデータのみをエンキュー。コンシューマーでファイルコンテンツを取得 |
| Workers KV書き込みスループット | キーごと1秒当たり1書き込み | べき等性書き込みは頻繁でない → 問題なし |
| GitHub APIレート制限 | 5,000リクエスト/時（インストーション トークン） | PRごと約7 APIコール。上限は約700 PR/時 |
| OpenAI TPM (Tier 1) | 約200Kトークン/分（gpt-4o-mini） | 指数バックオフがバースト処理。通常、文書翻訳では到達しない |
| GitHub コンテンツ作成 | 80リクエスト/分、500/時 | PRごと7コール → 上限約70 PR/時。ほとんどのリポジトリで安全 |
| キュー再試行 | 3（デフォルト）で30秒遅延 | 一時的なOpenAI/GitHubエラーは自己修復。永続的エラーはDLQへ |