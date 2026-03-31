# gh-translate-app

GitHub Appで提携リクエスト前のマークダウンファイルを自動翻訳し、翻訳済みファイルを含む新しいPRを開きます。OpenAIを使用したCloudflare Workersでテストされています。

## 動作方法

1. アプリがインストールされているリポジトリでPRが開かれたまたは更新される
2. アプリが変更された `.md` / `.mdx` ファイルを検出する
3. 各ファイルはOpenAI（`gpt-4o-mini`）を通して翻訳される
4. 翻訳されたすべてのファイルを含む新しいPRが開かれます

## Tech Stack

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/)
- **キューシステム**: [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- **翻訳**: [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)（`gpt-4o-mini`）
- **言語**: TypeScript

## 前提条件

- [Node.js](https://nodejs.org/) 18以上
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)（`npm install -g wrangler`）
- Cloudflareアカウント（Queuesに必要なWorkers Paid プラン）
- アカウント/組織に登録されたGitHub App
- OpenAI APIキー

## セットアップ

### 1. GitHub Appを登録する

**GitHub Settings → Developer settings → GitHub Apps → New GitHub App** に移動して以下を設定します：

| フィールド | 値 |
|---|---|
| Webhook URL | `https://<your-worker>.workers.dev/webhook` |
| Webhook secret | ランダムなシークレット文字列（保存してください） |
| Permissions → Contents | Read & Write |
| Permissions → Pull requests | Read & Write |
| Subscribe to events | `pull_request` |

作成後：
- **App ID** をメモします
- **秘密鍵**（`.pem`ファイル）を生成してダウンロードします
- PKCS#8に変換します（JWTライブラリで必須）：
  ```bash
  openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
    -in private-key.pem -out private-key-pkcs8.pem
  ```

### 2. 依存関係をインストールする

```bash
npm install
```

### 3. Cloudflareリソースを作成する

```bash
# 翻訳ジョブキューを作成
npx wrangler queues create pr-translation-jobs

# デッドレターキューを作成
npx wrangler queues create pr-translation-dlq

# テスト済み優先度処理のKVネームスペースを作成
npx wrangler kv namespace create IDEMPOTENCY_KV
```

最後のコマンドで出力されたKVネームスペースIDを `wrangler.jsonc` にコピーします。

### 4. シークレットを設定する

```bash
cat private-key-pkcs8.pem | npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put TARGET_LANG   # 例: "Japanese"
```

### 5. ローカル開発

例の環境ファイルをコピーして値を入力します：

```bash
cp .dev.vars.example .dev.vars
```

ローカル開発サーバーを起動します：

```bash
npm run dev
```

[smee.io](https://smee.io/) や [ngrok](https://ngrok.com/) などのツールを使用して、GitHubウェブフック `http://localhost:8787/webhook` に転送します。

### 6. デプロイ

```bash
npm run deploy
```

GitHub Appの設定で **Webhook URL** をデプロイされたWorker URLに更新します。

## 開発

```bash
npm run dev        # ローカル開発サーバー（http://localhost:8787）
npm run typecheck  # TypeScriptの型チェック
npm test           # テスト実行
npm run lint       # リント
npm run deploy     # Cloudflareにデプロイ
```

## プロジェクト構成

```
src/
├── index.ts          # Webhookハンドラー（署名の検証、ジョブのエンキュー）
├── queue.ts          # キューコンシューマー（翻訳プロセス全体の調整）
├── github.ts         # GitHub APIクライアント（認証、ファイルリスト、Git DB API、PR作成）
├── openai.ts         # OpenAI翻訳（gpt-4o-miniチャンコンプリートAPIロジック）
├── idempotency.ts    # Workers KVバックアップ（重複排除）
└── types.ts          # 共有TypeScript型
```

## 環境変数

| 変数 | 説明 |
|---|---|
| `GITHUB_APP_ID` | GitHub App IDの数値 |
| `GITHUB_APP_PRIVATE_KEY` | PKCS#8 PEM秘密鍵（改行は `\n` として） |
| `GITHUB_WEBHOOK_SECRET` | GitHub App設定からのWebhook HMACシークレット |
| `OPENAI_API_KEY` | OpenAI APIキー（`sk-...`） |
| `TARGET_LANG` | 翻訳対象言語（例：`"Japanese"`） |

## 詳細

- [ARCHITECTURE.md](ARCHITECTURE.md) — 完全な設計詳細、APIフロー、レート制限、スケーリング決定
- [AGENTS.md](AGENTS.md) — 開発者レイダンス、ガイドコンセプト、レイアウトパターン、落とし穴とテスト概要

## ライセンス

MIT