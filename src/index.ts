import { getInstallationToken, getPullRequestFiles, getCompareFiles, getFileContent, commitAndOpenPR, TRANSLATION_BRANCH_PREFIX } from './github';
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
    if (payload.pull_request.head.ref.startsWith(TRANSLATION_BRANCH_PREFIX)) {
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

  // 1. Idempotency / incremental-update check.
  // Note: KV does not provide atomic compare-and-set, so two simultaneous queue
  // deliveries for the same PR could both pass this check. GitHub's branch/PR
  // deduplication in commitAndOpenPR prevents duplicate PRs from persisting, but
  // a brief window of duplicate work is possible.
  const existing = await getTranslationRecord(env.IDEMPOTENCY_KV, owner, repo, prNumber);

  if (existing) {
    if (existing.headSha === headSha) {
      // Exact same SHA already processed — this is a queue redelivery, nothing to do
      console.log(`PR #${prNumber} already translated at ${headSha}, skipping`);
      return;
    }
    // New commits were pushed to the PR — translate only the incremental diff
    console.log(`PR #${prNumber}: update detected (${existing.headSha.slice(0, 7)}→${headSha.slice(0, 7)}), translating incremental diff`);
    await processUpdate(job, existing.headSha, existing.prUrl, env);
    return;
  }

  // 2. First-time translation — authenticate with GitHub
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
    const translated = await translateMarkdown(original, env.TARGET_LANG, env, file.patch);
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
  await setTranslationRecord(env.IDEMPOTENCY_KV, owner, repo, prNumber, { prUrl, headSha });

  console.log(`PR #${prNumber}: translation PR opened at ${prUrl}`);
}

async function processUpdate(job: QueueMessage, prevSha: string, prUrl: string, env: Env): Promise<void> {
  const { prNumber, owner, repo, headSha, baseBranch, installationId, prTitle } = job;

  const token = await getInstallationToken(
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY,
    installationId,
  );

  // Diff between the last processed commit and the new HEAD
  const files = await getCompareFiles(owner, repo, prevSha, headSha, token);
  if (files.length === 0) {
    console.log(`PR #${prNumber}: no markdown changes since ${prevSha.slice(0, 7)}, skipping`);
    await setTranslationRecord(env.IDEMPOTENCY_KV, owner, repo, prNumber, { prUrl, headSha });
    return;
  }

  console.log(`PR #${prNumber}: ${files.length} file(s) changed since last translation`);

  const translatedFiles: Array<{ path: string; content: string }> = [];
  for (const file of files) {
    const original = await getFileContent(owner, repo, file.filename, headSha, token);
    if (original === null) continue;
    const translated = await translateMarkdown(original, env.TARGET_LANG, env, file.patch);
    translatedFiles.push({ path: file.filename, content: translated });
  }

  if (translatedFiles.length === 0) {
    console.log(`PR #${prNumber}: all changed markdown files were symlinks, skipping`);
    await setTranslationRecord(env.IDEMPOTENCY_KV, owner, repo, prNumber, { prUrl, headSha });
    return;
  }

  // Push a new commit to the existing translation branch (commitAndOpenPR force-updates the ref)
  await commitAndOpenPR(
    { owner, repo, baseBranch, prNumber, files: translatedFiles, token },
    prTitle,
    env.TARGET_LANG,
  );

  await setTranslationRecord(env.IDEMPOTENCY_KV, owner, repo, prNumber, { prUrl, headSha });

  console.log(`PR #${prNumber}: translation branch updated for ${headSha.slice(0, 7)}`);
}
