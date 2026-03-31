import { buildSystemPrompt, withBackoff, ProviderError } from './translate-utils';

const OPENAI_API = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

export async function translateChunk(
  chunk: string,
  targetLang: string,
  apiKey: string,
): Promise<string> {
  return withBackoff(async () => {
    const res = await fetch(OPENAI_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        max_tokens: 16000,
        messages: [
          { role: 'system', content: buildSystemPrompt(targetLang) },
          { role: 'user', content: chunk },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ProviderError(`OpenAI API error ${res.status}: ${err}`, res.status);
    }

    const data = await res.json<{
      choices: Array<{ message: { content: string } }>;
    }>();

    const translated = data.choices[0]?.message.content;
    if (!translated) throw new Error('Empty response from OpenAI');
    return translated;
  });
}
