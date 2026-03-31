import { getInstallationToken, getPullRequestFiles, getFileContent, commitAndOpenPR } from './github';
import { translateMarkdown } from './translate';
import { getTranslationRecord, setTranslationRecord } from './idempotency';
import type { Env, QueueMessage } from './types';

const HANDLED_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

export default {
  // -------------------------------------------------------------------------
  // Webhook handler — receives GitHub PR events, validates, enqueues
  // -------------------------------------------------------------------------
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const body = await request.text();

    if (!(await verifySignature(body, request.headers.get('x-hub-signature-256') ?? '', env.GITHUB_WEBHOOK_SECRET))) {
      return new Response('Unauthorized', { status: 401 });
    }

    const event = request.headers.get('x-github-event');
    if (event !== 'pull_request') {
      return new Response('OK', { status: 200 });
    }

    const payload = JSON.parse(body) as {
      action: string;
      pull_request: {
        number: number;
        title: string;
        head: { sha: string; ref: string };
        base: { ref: string };
      };
      repository: { name: string; owner: { login: string } };
      installation?: { id: number };
    };

    if (!HANDLED_ACTIONS.has(payload.action)) {
      return new Response('OK', { status: 200 });
    }

    // Skip PRs opened by this bot to prevent infinite translation loops
    if (payload.pull_request.head.ref.startsWith('translate/')) {
      return new Response('OK', { status: 200 });
    }

    if (!payload.installation) {
      return new Response('Missing installation', { status: 400 });
    }

    const message: QueueMessage = {
      prNumber: payload.pull_request.number,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      headSha: payload.pull_request.head.sha,
      baseBranch: payload.pull_request.base.ref,
      installationId: payload.installation.id,
      prTitle: payload.pull_request.title,
    };

    await env.PR_QUEUE.send(message);

    return new Response('OK', { status: 200 });
  },

  // -------------------------------------------------------------------------
  // Queue consumer — processes translation jobs asynchronously
  // -------------------------------------------------------------------------
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processJob(msg.body, env);
        msg.ack();
      } catch (err) {
        console.error('Translation job failed:', err);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, QueueMessage>;

// ---------------------------------------------------------------------------
// Webhook signature verification (HMAC-SHA256, constant-time comparison)
// ---------------------------------------------------------------------------

async function verifySignature(body: string, signatureHeader: string, secret: string): Promise<boolean> {
  if (!signatureHeader.startsWith('sha256=')) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = 'sha256=' + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  if (expected.length !== signatureHeader.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// Queue job processor
// ---------------------------------------------------------------------------

async function processJob(job: QueueMessage, env: Env): Promise<void> {
  const { prNumber, owner, repo, headSha, baseBranch, installationId, prTitle } = job;

  // 1. Idempotency check — skip if already translated
  const existing = await getTranslationRecord(env.IDEMPOTENCY_KV, owner, repo, prNumber);
  if (existing) {
    console.log(`PR #${prNumber} already translated: ${existing}`);
    return;
  }

  // 2. Authenticate with GitHub
  const token = await getInstallationToken(
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY,
    installationId,
  );

  // 3. List changed markdown files
  const files = await getPullRequestFiles(owner, repo, prNumber, token);
  if (files.length === 0) {
    console.log(`PR #${prNumber}: no markdown files changed, skipping`);
    return;
  }

  console.log(`PR #${prNumber}: translating ${files.length} file(s) into ${env.TARGET_LANG}`);

  // 4. Fetch and translate each file sequentially (avoids API rate limit spikes)
  const translatedFiles: Array<{ path: string; content: string }> = [];
  for (const file of files) {
    const original = await getFileContent(owner, repo, file.filename, headSha, token);
    if (original === null) continue; // skip symlinks
    const translated = await translateMarkdown(original, env.TARGET_LANG, env);
    translatedFiles.push({ path: file.filename, content: translated });
  }

  if (translatedFiles.length === 0) {
    console.log(`PR #${prNumber}: all markdown files were symlinks, skipping`);
    return;
  }

  // 5. Commit translations and open a new PR
  const prUrl = await commitAndOpenPR(
    { owner, repo, baseBranch, prNumber, files: translatedFiles, token },
    prTitle,
    env.TARGET_LANG,
  );

  // 6. Record success so queue redeliveries are no-ops
  await setTranslationRecord(env.IDEMPOTENCY_KV, owner, repo, prNumber, prUrl);

  console.log(`PR #${prNumber}: translation PR opened at ${prUrl}`);
}
