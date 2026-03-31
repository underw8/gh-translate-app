# Architecture — gh-translate-app

> **Status: Design Review — Implementation Complete**

---

## 1. System Overview

完全にサーバーレスなGitHub Appで、プルリクエスト時のMarkdownファイルの変更を検出し、OpenAIで翻訳し、新しい翻訳PRを開きます。WebhookハンドラとキューコンシューマーはCloudflare Workers上で完全に実行されます。

```
─────────────────────────────────────────────────────────────────
  GitHub

  [PR opened / synchronize / reopened]
           │
           │  POST /webhook  (X-Hub-Signature-256)
           │
─────────────────────────────────────────────────────────────────
           │
           │
─────────────────────────────────────────────────────────────────
  Cloudflare Workers

  ───────────────────────────       enqueue    ──────────────  
  │  Webhook Handler        │  ──────────────> │  CF Queue  │  
  │  (src/index.ts)         │                 │ (pr-jobs)  │  
  │  - verify HMAC-SHA256   │                 ──────┬────────  
  │  - return 200 fast      │                        │ consume  
  ───────────────────────────                        │          
                                                     ▼          
                                           ──────────────────── 
                                           │ Queue Consumer   │ 
                                           │ (src/queue.ts)   │ 
                                           ──────────┬───────── 
                                                    │
                              ──────────────────────┼────────── 
                              │                     │        │  
                              ▼                     ▼        ▼  
                    [GitHub REST API]     [OpenAI API]    [CF 
                    - list PR files      - translate .md  Workers
                    - create branch      - gpt-4o-mini    KV]  
                    - commit files                        - ido- 
                    - open new PR                         potency
                                                          store  
─────────────────────────────────────────────────────────────────
```

---

## 2. Cloudflareサービス

| サービス | 役割 | 理由 |
|---|---|---|
| **Workers** | Webhookハンドラ、キューコンシューマー | サーバーレスHTTP、イベント駆動アーキテクチャ |
| **Queues** | ハンドラとコンシューマーを分離、長時間実行ジョブ処理 | GitHubの10秒webhookタイムアウト回避、翻訳作業は非同期、最低1回配信保証 |
| **Workers Secrets** | APIキーとシークレット保存 | 保存時に暗号化、実行時に`env`に挿入 |
| **Workers KV** *オプション* | スケート短期ストア、翻訳済みPRを追跡 | 再試行されたドキュメント・メッセージを、重複翻訳PR防止 |

**なぜQueuesなのか(`ctx.waitUntil()`ではなく)** `waitUntil()`は再試行をサポートしていません。翻訳が途中で失敗すると、ジョブ失われます。Queuesは設定可能な再試行と、デッドレターキュー(DLQ)を提供。コンシューマーは最大15分で完了できます。

---

## 3. GitHub Appセットアップ

### 3.1 必須権限

| 権限 | レベル | ユースケース |
|---|---|---|
| Pull requests | 読み込み、書き込み | PRファイルリスト、翻訳PRを開く |
| Contents | 読み込み、書き込み | Markdownファイル読み込み、翻訳コンテンツコミット |
| Metadata | 読み込み | リポジトリ情報、自動作成 |

### 3.2 購読するWebhookイベント

| イベント | アクション |
|---|---|
| `pull_request` | `opened`, `synchronize`, `reopened` |

### 3.3 認証フロー

キューコンシューマーは以下を実行する必要があります:

1. **GitHub App JWT を生成** (RS256、Appの秘密鍵で署名)
   - `iss` = GitHub App ID
   - `iat` = `now - 60s` (クロック許容度)
   - `exp` = `now + 600s` (最大10分)
   - ライブラリ：[`jose`](https://github.com/panva/jose) — ゼロ依存、Web Crypto API

2. **JWTをインストールアクセストークンと交換**
   ```
   POST /app/installations/{installation_id}/access_tokens
   Authorization: Bearer <JWT>
   ```
   トークンは**1時間**で有効期限切れ。コンシューマー起動時に再生成します。

3. **すべてのGitHub REST APIコールにインストールアクセストークンを使用**
   ```
   Authorization: Bearer <installation_access_token>
   ```

> **重要：** GitHub Appの秘密鍵は**PKCS#1形式**（`-----BEGIN RSA PRIVATE KEY-----`）でダウンロードされます。`jose`は**PKCS#8**（`-----BEGIN PRIVATE KEY-----`）を必要です。保存前に変換してください：
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
>   -in private-key.pem -out private-key-pkcs8.pem
> ```

---

## 4. データフロー — ステップバイステップ

### ステップ1：Webhookを受信 (Webhookハンドラワーカー)

```
GitHub → POST /webhook
```

1. ボディをテキストとして読み込み（ストリームは1回だけ読み込み可能）
2. Web Crypto API（`crypto.subtle`）を使用してHMAC-SHA256で`X-Hub-Signature-256`を検証
3. JSONペイロードを解析。`action`、`pull_request.number`、`repository.owner.login`、`repository.name`、`installation.id`を抽出
4. `action`が`["opened", "synchronize", "reopened"]`に含まれていない場合は`200 OK`を返す（無害）
5. **小さなメタデータメッセージ**（ファイルコンテンツなし）をCloudflare Queueにエンキュー
6. `200 OK`を即座に返す — 翻訳完了を待たない

**キューメッセージスキーマ：**
```typescript
{
  prNumber: number;
  owner: string;        // リポジトリ所有者ログイン
  repo: string;         // リポジトリ名
  headSha: string;      // PRの頭コミットSHA
  baseBranch: string;   // PRベースブランチ（例："main"）
  installationId: number;
}
```

> キューメッセージは128KBに制限されます — 常にメタデータのみをエンキュー（ファイルコンテンツはコンシューマーで取得してください）。

### ステップ2：キュージョブ処理 (キューコンシューマーワーカー)

1. **スケット短期チェック**（KVで`{owner}/{repo}#${prNumber}`を検索。見つかった場合、翻訳済みPRが提出済み）`msg.ack()`して返す
2. **認証**（App JWTを生成 — インストールアクセストークンと交換）
3. **変更されたファイルリスト**：`GET /repos/{owner}/{repo}/pulls/{prNumber}/files`
   - `.md`と`.mdx`ファイルで`status !== "removed"`でフィルタリング
   - Markdownファイルがない場合はackして返す
4. **ファイルコンテンツを取得**：各ファイルについて、`GET /repos/{owner}/{repo}/contents/{path}?ref={headSha}`
5. **OpenAIで各ファイルを翻訳** (§ 5参照)
6. **翻訳されたファイルをコミット** (§ 6参照)
7. **翻訳PRを開く**（ソースPRのベースブランチをターゲット）
8. **成功を記録**（KVに`{owner}/{repo}#${prNumber}` → `{translationPrUrl}`を書き込み）
9. `msg.ack()`

### ステップ3：失敗

- コンシューマーがクラッシュ — ジョブを自動的に再試行（`max_retries: 3`、`retry_delay: 30s`）
- 最大再試行後 — メッセージはデッドレターキュー(DLQ)に移動（手動レビュー用）

---

## 5. OpenAIを使用した翻訳

### モデル

**デフォルト：`gpt-4o-mini`** — 128Kコンテキストウィンドウで16,384最大出力トークン

| | gpt-4o-mini | gpt-4o |
|---|---|---|
| 入力コスト | 100Kトークンあたり$0.15 | 100Kトークンあたり$2.50 |
| 出力コスト | 100Kトークンあたり$0.60 | 100Kトークンあたり$10.00 |
| 品質 | 技術文書に最適 | ヒューマンスキルに対してより高い精度 |

推定コスト（ファイル約10Kトークン）：**~$0.007**（gpt-4o-mini）

### プロンプト設計

**システムプロンプト：**
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

**APIパラメータ：**
```json
{
  "model": "gpt-4o-mini",
  "temperature": 0.1,
  "max_tokens": 16000
}
```

### チャンキング（大規模ファイルのみ）

ほとんどのMarkdownファイルは~10Kトークン内に収まります。~110Kトークンを超えるファイルの場合：
1. 見出し境界で分割（`\n# `または`\n## `）
2. チャンクごとに最初の見出しのみ保持
3. 各チャンクを別に翻訳
4. 元の順序どおりに連結

### レート制限処理

HTTP 429（リクエスト数が多すぎる）の場合：
- バックオフ（1s → 2s → 4s → 8s → 16s → 32s、60sで上限）
- ±25%のランダムジッターを追加（別のファイルリクエストと並行）
- ファイルごとに最大6回の再試行（超過した場合、ジョブ失敗。キューメッセージ全体が再試行）

---

## 6. GitHub Git Database API — 翻訳をコミット

ブランチを作成してファイルをコミットするために、7つの順序付きGit APIコール（低レベルのGit操作）が必要です：

```
1. GET  /repos/{owner}/{repo}/git/ref/heads/{baseBranch}
        → ベースブランチのHEADコミットSHA

2. GET  /repos/{owner}/{repo}/git/commits/{commitSha}
        → HEADコミットのツリーSHA

3. POST /repos/{owner}/{repo}/git/blobs          (各翻訳ファイルについて)
        Body: { content, encoding: "utf-8" }
        → 新ファイルのblobSHA

4. POST /repos/{owner}/{repo}/git/trees
        Body: { base_tree: <treeSha>, tree: [{ path, mode: "100644", type: "blob", sha }] }
        → 新しいツリーSHA

5. POST /repos/{owner}/{repo}/git/commits
        Body: { message, tree: <newTreeSha>, parents: [<parentCommitSha>] }
        → 新しいコミットSHA

6. POST /repos/{owner}/{repo}/git/refs
        Body: { ref: "refs/heads/translate/pr-{prNumber}", sha: <newCommitSha> }
        → 翻訳ブランチ作成

7. POST /repos/{owner}/{repo}/pulls
        Body: { title, head: "translate/pr-{prNumber}", base: {baseBranch}, body }
        → 翻訳PRを開く
```

**ブランチ名：** `translate/pr-{prNumber}`

**PRタイトルテンプレート：** `[Translation] {TARGET_LANG}: PR #{prNumber} — {original PR title}`

---

## 7. `wrangler.jsonc`設定

```jsonc
{
  "name": "gh-translate-worker",
  "main": "src/index.ts",
  "compatibility_date": "2024-11-01",
  "compatibility_flags": ["nodejs_compat"],

  // コンシューマーは5分のCPU制限（I/Oの待機時間はカウントされません）
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
        "max_batch_size": 1,          // 一度に1つのPRを処理（クローラー推定可能）
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

すべて`wrangler secret put`経由で、またはローカル開発用に`.dev.vars`で保存します。シークレットをコミットしないでください。

| シークレット | 説明 |
|---|---|
| `GITHUB_APP_ID` | 数字のGitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | PKCS#8 PEM秘密鍵（改行は`\n`） |
| `GITHUB_WEBHOOK_SECRET` | GitHub Appの設定からのWebhook HMACシークレット |
| `OPENAI_API_KEY` | OpenAI APIキー（`sk-...`） |
| `TARGET_LANG` | ターゲット言語名（例：`"Japanese"`）、環境変数も可 |

**シークレットを設定：**
```bash
cat private-key-pkcs8.pem | npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put OPENAI_API_KEY
```

**ローカル開発（`.dev.vars`）：**
```ini
GITHUB_APP_ID="123456"
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET="your-local-test-secret"
OPENAI_API_KEY="sk-..."
TARGET_LANG="Japanese"
```

---

## 9. 主要な設計決定とトレードオフ

| 決定 | 選択 | 代替案 | 根拠 |
|---|---|---|---|
| 非同期処理方法 | Cloudflare **Queues** | `ctx.waitUntil()` | Queuesは再試行、DLQを提供。`waitUntil`はサイレント失敗 |
| 翻訳モデル | **gpt-4o-mini** | gpt-4o | 16倍安い。技術文書の品質は優秀 |
| JWT ライブラリ | **`jose`** | ネイティブ、Web Crypto | PKCS#8ベース。最小限のコードで標準準拠 JWT |
| スケット短期ストア | **Workers KV** | なし | Queuesは≥1配信を保証。KVは重複翻訳PRを防止 |
| ファイルコミット戦略 | **Git Database API**（7コール） | Octokit REST | Node.js依存なし。Workersランタイムで動作 |
| Webhookハンドラレイテンシ | エンキュー（`200`を即座に返す） | インライン処理 | GitHubは webhookを10sでタイムアウト。翻訳に足りない |
| PRファイルメタ | コンシューマーでリスト取得、webhookではなし | ジューエイメッセージで渡す | キューメッセージサイズ制限。ファイルメタデータはPRごとに安定 |

---

## 10. 既知の制約と割り当て

| 制約 | 値 | 影響 |
|---|---|---|
| Githubウェブフック タイムアウト | 10秒 | ハンドラは翻訳開始前に`200`を返す必要 — Queuesが必須 |
| キューメッセージ最大サイズ | 128 KB | メタデータのみ保存。ファイルコンテンツはコンシューマーで取得 |
| Workers KV書き込み速度 | キーごとに最大1書き込み/秒 | スケット短期書き込みは問題ない |
| GitHub API レート制限 | アクセストークンあたり5,000リクエスト/時間 | PRごと~7APIコール — ~700PR/時間。通常は遠い |
| OpenAI TPM（Tier 1） | ~200Kトークン/分（gpt-4o-mini） | 最新の登録役立つ。標準ストリーミング処理は一般的なドキュメント翻訳実行 |
| GitHubコミット API速度 | 80リクエスト/分（500/時間） | PRごと7コール — ~70PR/時間。ほぼすべてのリポジトリは制限外 |
| キュー再試行 | デフォルト3回、30秒延遅 | 一時的なOpenAI/GitHub エラーは自己修復。永続的エラー — DLQ |