import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = 'test-secret';

async function signBody(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return 'sha256=' + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function makeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: 'key',
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    OPENAI_API_KEY: 'sk-test',
    TARGET_LANG: 'Japanese',
    PR_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    IDEMPOTENCY_KV: {},
    ...overrides,
  };
}

function makePRPayload(action = 'opened') {
  return JSON.stringify({
    action,
    number: 42,
    pull_request: {
      number: 42,
      title: 'My PR',
      head: { sha: 'abc123', ref: 'feature' },
      base: { ref: 'main' },
    },
    repository: { name: 'my-repo', owner: { login: 'my-org' } },
    installation: { id: 999 },
  });
}

async function makeRequest(body: string, event = 'pull_request', secret = WEBHOOK_SECRET) {
  const signature = await signBody(body, secret);
  return new Request('http://localhost/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-hub-signature-256': signature,
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Webhook handler', () => {
  it('returns 405 for non-POST requests', async () => {
    const req = new Request('http://localhost/webhook', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv() as never);
    expect(res.status).toBe(405);
  });

  it('returns 401 for an invalid (tampered) signature', async () => {
    const body = makePRPayload();
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=badhash',
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv() as never);
    expect(res.status).toBe(401);
  });

  it('returns 401 when signature header is missing', async () => {
    const body = makePRPayload();
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request' },
      body,
    });
    const res = await worker.fetch(req, makeEnv() as never);
    expect(res.status).toBe(401);
  });

  it('returns 401 when signature is signed with wrong secret', async () => {
    const body = makePRPayload();
    const signature = await signBody(body, 'wrong-secret');
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature,
      },
      body,
    });
    const res = await worker.fetch(req, makeEnv() as never);
    expect(res.status).toBe(401);
  });

  it('returns 200 and does not enqueue for non-pull_request events', async () => {
    const body = JSON.stringify({ zen: 'hello' });
    const req = await makeRequest(body, 'ping');
    const env = makeEnv();
    const res = await worker.fetch(req, env as never);
    expect(res.status).toBe(200);
    expect(env.PR_QUEUE.send).not.toHaveBeenCalled();
  });

  it('returns 200 and does not enqueue for ignored actions (closed)', async () => {
    const body = makePRPayload('closed');
    const req = await makeRequest(body);
    const env = makeEnv();
    const res = await worker.fetch(req, env as never);
    expect(res.status).toBe(200);
    expect(env.PR_QUEUE.send).not.toHaveBeenCalled();
  });

  it.each(['opened', 'synchronize', 'reopened'])(
    'enqueues a job for pull_request action: %s',
    async (action) => {
      const body = makePRPayload(action);
      const req = await makeRequest(body);
      const env = makeEnv();
      const res = await worker.fetch(req, env as never);
      expect(res.status).toBe(200);
      expect(env.PR_QUEUE.send).toHaveBeenCalledOnce();
      expect(env.PR_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
        prNumber: 42,
        owner: 'my-org',
        repo: 'my-repo',
        headSha: 'abc123',
        baseBranch: 'main',
        installationId: 999,
        prTitle: 'My PR',
      }));
    },
  );
});
