export interface Env {
  // Secrets
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  OPENAI_API_KEY: string;
  TARGET_LANG: string;

  // Optional: 'openai' (default) or 'claude'
  TRANSLATION_PROVIDER?: 'openai' | 'claude';
  // Required when TRANSLATION_PROVIDER='claude'
  ANTHROPIC_API_KEY?: string;

  // Bindings
  PR_QUEUE: Queue<QueueMessage>;
  IDEMPOTENCY_KV: KVNamespace;
}

/** Message enqueued by the webhook handler and consumed by the queue consumer */
export interface QueueMessage {
  prNumber: number;
  owner: string;
  repo: string;
  headSha: string;
  baseBranch: string;
  installationId: number;
  prTitle: string;
}

/** A single changed file returned by the GitHub PR files API */
export interface PullRequestFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  sha: string;
}

/** Minimal GitHub API error shape */
export interface GitHubApiError {
  message: string;
  documentation_url?: string;
}
