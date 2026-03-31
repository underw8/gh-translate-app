import { describe, it, expect, vi, afterEach } from 'vitest';
import { translateMarkdown } from '../src/translate';
import { getAddedLineRanges } from '../src/translate-utils';

vi.mock('../src/openai', () => ({
  translateChunk: vi.fn().mockResolvedValue('openai-result'),
}));

vi.mock('../src/claude', () => ({
  translateChunk: vi.fn().mockResolvedValue('claude-result'),
}));

afterEach(() => vi.clearAllMocks());

describe('translateMarkdown (provider facade)', () => {
  it('defaults to OpenAI when TRANSLATION_PROVIDER is absent', async () => {
    const { translateChunk } = await import('../src/openai');
    const result = await translateMarkdown('hello', 'Japanese', {
      OPENAI_API_KEY: 'sk-test',
    });
    expect(result).toBe('openai-result');
    expect(translateChunk).toHaveBeenCalledWith('hello', 'Japanese', 'sk-test');
  });

  it('uses OpenAI when TRANSLATION_PROVIDER is "openai"', async () => {
    const { translateChunk } = await import('../src/openai');
    const result = await translateMarkdown('hello', 'Japanese', {
      TRANSLATION_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(result).toBe('openai-result');
    expect(translateChunk).toHaveBeenCalledWith('hello', 'Japanese', 'sk-test');
  });

  it('uses Claude when TRANSLATION_PROVIDER is "claude"', async () => {
    const { translateChunk } = await import('../src/claude');
    const result = await translateMarkdown('hello', 'Japanese', {
      TRANSLATION_PROVIDER: 'claude',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
    expect(result).toBe('claude-result');
    expect(translateChunk).toHaveBeenCalledWith('hello', 'Japanese', 'sk-ant-test');
  });

  it('throws a descriptive error when claude is selected but ANTHROPIC_API_KEY is missing', async () => {
    await expect(
      translateMarkdown('hello', 'Japanese', {
        TRANSLATION_PROVIDER: 'claude',
      }),
    ).rejects.toThrow('ANTHROPIC_API_KEY is required when TRANSLATION_PROVIDER=claude');
  });

  it('throws on unknown TRANSLATION_PROVIDER value', async () => {
    await expect(
      translateMarkdown('hello', 'Japanese', {
        // @ts-expect-error intentional unknown provider for test
        TRANSLATION_PROVIDER: 'gemini',
        OPENAI_API_KEY: 'sk-test',
      }),
    ).rejects.toThrow('Unknown TRANSLATION_PROVIDER: gemini');
  });
});

// ---------------------------------------------------------------------------
// getAddedLineRanges — patch parsing
// ---------------------------------------------------------------------------

describe('getAddedLineRanges', () => {
  it('returns empty array for a pure deletion patch', () => {
    const patch = `@@ -1,3 +1,2 @@
 unchanged
-removed line
 unchanged`;
    expect(getAddedLineRanges(patch)).toEqual([]);
  });

  it('returns the correct range for a simple addition', () => {
    const patch = `@@ -1,2 +1,3 @@
 unchanged
+added line
 unchanged`;
    expect(getAddedLineRanges(patch)).toEqual([{ start: 2, end: 2 }]);
  });

  it('merges contiguous additions into one range', () => {
    const patch = `@@ -1,1 +1,3 @@
 unchanged
+first added
+second added`;
    expect(getAddedLineRanges(patch)).toEqual([{ start: 2, end: 3 }]);
  });

  it('returns separate ranges for non-contiguous additions', () => {
    const patch = `@@ -1,5 +1,7 @@
 line1
+added1
 line2
 line3
+added2
+added3
 line4`;
    expect(getAddedLineRanges(patch)).toEqual([
      { start: 2, end: 2 },
      { start: 5, end: 6 },
    ]);
  });

  it('handles multiple hunks', () => {
    const patch = `@@ -1,2 +1,3 @@
 line1
+added in hunk1
 line2
@@ -10,2 +11,3 @@
 line10
+added in hunk2
 line11`;
    expect(getAddedLineRanges(patch)).toEqual([
      { start: 2, end: 2 },
      { start: 12, end: 12 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// translateMarkdown — diff-aware mode
// ---------------------------------------------------------------------------

describe('translateMarkdown (patch-aware)', () => {
  it('translates only added lines when patch is provided', async () => {
    const { translateChunk } = await import('../src/openai');
    vi.mocked(translateChunk).mockImplementation(async (text) => `[translated: ${text}]`);

    const content = 'line1\nline2\nline3';
    // patch: line2 is added
    const patch = `@@ -1,2 +1,3 @@
 line1
+line2
 line3`;

    const result = await translateMarkdown(content, 'Japanese', { OPENAI_API_KEY: 'sk-test' }, patch);

    expect(result).toBe('line1\n[translated: line2]\nline3');
    // Only the added block was passed to the translation provider
    expect(translateChunk).toHaveBeenCalledOnce();
    expect(translateChunk).toHaveBeenCalledWith('line2', 'Japanese', 'sk-test');
  });

  it('falls back to full translation when patch has no additions', async () => {
    const { translateChunk } = await import('../src/openai');
    vi.mocked(translateChunk).mockResolvedValue('full-result');

    const patch = `@@ -1,2 +1,1 @@
 unchanged
-removed`;

    const result = await translateMarkdown('unchanged\nremoved', 'Japanese', { OPENAI_API_KEY: 'sk-test' }, patch);

    expect(result).toBe('full-result');
    expect(translateChunk).toHaveBeenCalledOnce();
  });

  it('falls back to full translation when patch is undefined', async () => {
    const { translateChunk } = await import('../src/openai');
    vi.mocked(translateChunk).mockResolvedValue('full-result');

    const result = await translateMarkdown('hello', 'Japanese', { OPENAI_API_KEY: 'sk-test' });

    expect(result).toBe('full-result');
    expect(translateChunk).toHaveBeenCalledWith('hello', 'Japanese', 'sk-test');
  });
});
