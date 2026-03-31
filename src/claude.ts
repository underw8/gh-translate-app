import { buildSystemPrompt, withBackoff, ProviderError } from './translate-utils';

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

export async function translateChunk(
  chunk: string,
  targetLang: string,
  apiKey: string,
): Promise<string> {
  return withBackoff(async () => {
    const res = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        system: buildSystemPrompt(targetLang),
        messages: [{ role: 'user', content: chunk }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ProviderError(`Claude API error ${res.status}: ${err}`, res.status);
    }

    const data = await res.json<{
      content: Array<{ type: string; text: string }>;
    }>();

    const translated = data.content.find(b => b.type === 'text')?.text;
    if (!translated) throw new Error('Empty response from Claude');
    return translated;
  });
}
