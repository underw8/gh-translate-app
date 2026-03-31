import { describe, it, expect, vi, afterEach } from 'vitest';
import { translateMarkdown } from '../src/translate';

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
