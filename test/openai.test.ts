import { describe, it, expect, vi, afterEach } from 'vitest';
import { translateChunk } from '../src/openai';

function mockFetch(response: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(response), { status }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('translateChunk (OpenAI provider)', () => {
  it('returns the translated content from OpenAI', async () => {
    mockFetch({
      choices: [{ message: { content: '# こんにちは' } }],
    });

    const result = await translateChunk('# Hello', 'Japanese', 'sk-test');
    expect(result).toBe('# こんにちは');
  });

  it('sends the correct model, temperature, and system prompt', async () => {
    const spy = mockFetch({ choices: [{ message: { content: 'translated' } }] });

    await translateChunk('content', 'French', 'sk-test');

    const call = spy.mock.calls[0];
    expect(call).toBeDefined();
    const body = JSON.parse(call![1]!.body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.temperature).toBe(0.1);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('French');
    expect(body.messages[1].content).toBe('content');
  });

  it('throws on non-429 API errors without retrying', async () => {
    mockFetch({ error: { message: 'Invalid API key' } }, 401);

    await expect(translateChunk('test', 'Japanese', 'bad-key')).rejects.toThrow('401');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
      );

    vi.useFakeTimers();
    const promise = translateChunk('test', 'Japanese', 'sk-test');
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result).toBe('ok');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
