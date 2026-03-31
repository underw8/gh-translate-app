import { describe, it, expect, vi, afterEach } from 'vitest';
import { translateChunk } from '../src/claude';

function mockFetch(response: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(response), { status }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('translateChunk (Claude provider)', () => {
  it('returns the translated content from Claude', async () => {
    mockFetch({
      content: [{ type: 'text', text: '# こんにちは' }],
    });

    const result = await translateChunk('# Hello', 'Japanese', 'sk-ant-test');
    expect(result).toBe('# こんにちは');
  });

  it('sends the correct model, version header, and system field', async () => {
    const spy = mockFetch({ content: [{ type: 'text', text: 'translated' }] });

    await translateChunk('content', 'French', 'sk-ant-test');

    const call = spy.mock.calls[0];
    expect(call).toBeDefined();
    const [_url, init] = call!;
    const headers = init!.headers as Record<string, string>;
    const body = JSON.parse(init!.body as string);

    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.max_tokens).toBe(16000);
    expect(typeof body.system).toBe('string');
    expect(body.system).toContain('French');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toBe('content');
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('throws on non-429 API errors without retrying', async () => {
    mockFetch({ error: { message: 'Unauthorized' } }, 401);

    await expect(translateChunk('test', 'Japanese', 'bad-key')).rejects.toThrow('401');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
          { status: 200 },
        ),
      );

    vi.useFakeTimers();
    const promise = translateChunk('test', 'Japanese', 'sk-ant-test');
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result).toBe('ok');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
