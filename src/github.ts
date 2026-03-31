import { importPKCS8, SignJWT } from 'jose';
import type { PullRequestFile } from './types';

const GITHUB_API = 'https://api.github.com';

/** Branch name prefix used for all translation PRs. Must match the skip-check in the webhook handler. */
export const TRANSLATION_BRANCH_PREFIX = 'translate/';
const GITHUB_ACCEPT = 'application/vnd.github+json';
const GITHUB_API_VERSION = '2022-11-28';

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export async function getInstallationToken(
  appId: string,
  privateKeyPem: string,
  installationId: number,
): Promise<string> {
  const pem = privateKeyPem.replace(/\\n/g, '\n');
  const privateKey = await importPKCS8(pem, 'RS256');

  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(appId)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 600)
    .sign(privateKey);

  const res = await ghFetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    { method: 'POST' },
    jwt,
  );

  const data = await res.json<{ token: string }>();
  return data.token;
}

// ---------------------------------------------------------------------------
// Pull request
// ---------------------------------------------------------------------------

export async function getPullRequestFiles(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  let page = 1;

  while (true) {
    const res = await ghFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      {},
      token,
    );
    const batch = await res.json<PullRequestFile[]>();
    files.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  return files.filter(f => f.status !== 'removed' && /\.mdx?$/.test(f.filename));
}

/**
 * Returns markdown files that changed between two commits (used for incremental
 * updates when new commits are pushed to an open PR).
 * The GitHub compare API caps results at 300 files; pagination is not supported,
 * but that is well above any realistic docs PR.
 */
export async function getCompareFiles(
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  token: string,
): Promise<PullRequestFile[]> {
  const res = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`,
    {},
    token,
  );
  const { files = [] } = await res.json<{ files?: PullRequestFile[] }>();
  return files.filter(f => f.status !== 'removed' && /\.mdx?$/.test(f.filename));
}

// ---------------------------------------------------------------------------
// File content
// ---------------------------------------------------------------------------

export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token: string,
): Promise<string | null> {
  const res = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIPath(path)}?ref=${ref}`,
    {},
    token,
  );
  const data = await res.json<{ type: string; content: string; encoding: string }>();
  // Skip symlinks — committing them as regular blobs would destroy the symlink
  if (data.type === 'symlink') return null;
  if (data.encoding !== 'base64') {
    throw new Error(`Unexpected encoding: ${data.encoding}`);
  }
  // GitHub wraps base64 at 60 chars; strip those newlines before decoding.
  // Use TextDecoder to correctly handle multi-byte UTF-8 characters (e.g. CJK,
  // Arabic, emoji) that atob() alone would silently corrupt via Latin-1 mapping.
  const binary = atob(data.content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Commit translations and open PR (Git Database API)
// ---------------------------------------------------------------------------

export interface CommitOptions {
  owner: string;
  repo: string;
  baseBranch: string;
  prNumber: number;
  files: Array<{ path: string; content: string }>;
  token: string;
}

export async function commitAndOpenPR(
  opts: CommitOptions,
  prTitle: string,
  targetLang: string,
): Promise<string> {
  const { owner, repo, baseBranch, prNumber, files, token } = opts;
  const branch = `${TRANSLATION_BRANCH_PREFIX}pr-${prNumber}`;

  // 1. Get HEAD commit SHA of base branch (fall back to repo default if branch was deleted)
  const refRes = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`,
    {},
    token,
    /* allowNotFound */ true,
  );

  let headSha: string;
  if (refRes.status === 404) {
    console.warn(`Base branch '${baseBranch}' not found; falling back to repo default branch`);
    const repoRes = await ghFetch(`${GITHUB_API}/repos/${owner}/${repo}`, {}, token);
    const { default_branch } = await repoRes.json<{ default_branch: string }>();
    const defaultRefRes = await ghFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${default_branch}`,
      {},
      token,
    );
    ({ object: { sha: headSha } } = await defaultRefRes.json<{ object: { sha: string } }>());
  } else {
    ({ object: { sha: headSha } } = await refRes.json<{ object: { sha: string } }>());
  }

  // 2. Get tree SHA of that commit
  const commitRes = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${headSha}`,
    {},
    token,
  );
  const { tree: { sha: treeSha } } = await commitRes.json<{ tree: { sha: string } }>();

  // 3. Create a blob for each translated file
  const treeEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
  for (const file of files) {
    const blobRes = await ghFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/blobs`,
      {
        method: 'POST',
        body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
      },
      token,
    );
    const { sha: blobSha } = await blobRes.json<{ sha: string }>();
    treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blobSha });
  }

  // 4. Create new tree
  const newTreeRes = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees`,
    {
      method: 'POST',
      body: JSON.stringify({ base_tree: treeSha, tree: treeEntries }),
    },
    token,
  );
  const { sha: newTreeSha } = await newTreeRes.json<{ sha: string }>();

  // 5. Create commit
  const newCommitRes = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits`,
    {
      method: 'POST',
      body: JSON.stringify({
        message: `chore: add ${targetLang} translations for PR #${prNumber}`,
        tree: newTreeSha,
        parents: [headSha],
      }),
    },
    token,
  );
  const { sha: newCommitSha } = await newCommitRes.json<{ sha: string }>();

  // 6. Create branch (or update if it already exists)
  const branchRef = `refs/heads/${branch}`;
  const existsRes = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
    {},
    token,
    /* allowNotFound */ true,
  );

  if (existsRes.status === 404) {
    await ghFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/refs`,
      { method: 'POST', body: JSON.stringify({ ref: branchRef, sha: newCommitSha }) },
      token,
    );
  } else {
    await ghFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      { method: 'PATCH', body: JSON.stringify({ sha: newCommitSha, force: true }) },
      token,
    );
  }

  // 7. Open PR (skip if one already exists for this branch)
  const existingPRs = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`,
    {},
    token,
  );
  const prs = await existingPRs.json<Array<{ html_url: string }>>();
  if (prs.length > 0) {
    return prs[0]!.html_url;
  }

  const prRes = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: `[Translation] ${targetLang}: PR #${prNumber} — ${prTitle}`,
        head: branch,
        base: baseBranch,
        body: `Auto-translated markdown files from PR #${prNumber} into ${targetLang}.\n\n> Generated by gh-translate-app`,
      }),
    },
    token,
  );
  const { html_url } = await prRes.json<{ html_url: string }>();
  return html_url;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function ghFetch(
  url: string,
  init: RequestInit,
  token: string,
  allowNotFound = false,
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: GITHUB_ACCEPT,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'Content-Type': 'application/json',
      'User-Agent': 'gh-translate-app/1.0',
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok && !(allowNotFound && res.status === 404)) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status} ${url}: ${body.slice(0, 500)}`);
  }

  return res;
}

function encodeURIPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
