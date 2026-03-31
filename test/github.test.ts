import { describe, it, expect, vi, afterEach } from 'vitest';
import { getPullRequestFiles, getFileContent } from '../src/github';

afterEach(() => vi.restoreAllMocks());

// Helper: mock a single fetch response
function mockFetch(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status }),
  );
}

describe('getPullRequestFiles', () => {
  it('returns only non-removed markdown files', async () => {
    mockFetch([
      { filename: 'docs/guide.md', status: 'modified', sha: 'aaa' },
      { filename: 'docs/ref.mdx', status: 'added', sha: 'bbb' },
      { filename: 'src/index.ts', status: 'modified', sha: 'ccc' },
      { filename: 'docs/old.md', status: 'removed', sha: 'ddd' },
    ]);

    const files = await getPullRequestFiles('org', 'repo', 1, 'token');
    expect(files).toHaveLength(2);
    expect(files.map(f => f.filename)).toEqual(['docs/guide.md', 'docs/ref.mdx']);
  });

  it('paginates when a full page (100 items) is returned', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: `docs/file${i}.md`,
      status: 'modified',
      sha: `sha${i}`,
    }));
    const page2 = [{ filename: 'docs/last.md', status: 'added', sha: 'last' }];

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }));

    const files = await getPullRequestFiles('org', 'repo', 1, 'token');
    expect(files).toHaveLength(101);
  });

  it('throws on GitHub API error', async () => {
    mockFetch({ message: 'Not Found' }, 404);
    await expect(getPullRequestFiles('org', 'repo', 99, 'token')).rejects.toThrow('404');
  });
});

describe('getFileContent', () => {
  it('decodes base64 file content', async () => {
    const original = '# Hello World';
    const encoded = btoa(original);
    mockFetch({ content: encoded, encoding: 'base64' });

    const result = await getFileContent('org', 'repo', 'docs/guide.md', 'abc123', 'token');
    expect(result).toBe(original);
  });

  it('throws for unexpected encoding', async () => {
    mockFetch({ content: 'raw', encoding: 'utf-8' });
    await expect(
      getFileContent('org', 'repo', 'docs/guide.md', 'abc123', 'token'),
    ).rejects.toThrow('Unexpected encoding');
  });
});
