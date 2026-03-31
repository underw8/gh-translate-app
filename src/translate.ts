import { translateChunk as translateOpenAI } from './openai';
import { translateChunk as translateClaude } from './claude';
import { CHUNK_THRESHOLD, splitOnHeadings } from './translate-utils';
import type { Env } from './types';

type TranslateChunkFn = (chunk: string, targetLang: string, apiKey: string) => Promise<string>;

export async function translateMarkdown(
  content: string,
  targetLang: string,
  env: Pick<Env, 'TRANSLATION_PROVIDER' | 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY'>,
): Promise<string> {
  const provider = env.TRANSLATION_PROVIDER ?? 'openai';

  let chunkFn: TranslateChunkFn;
  let apiKey: string;

  switch (provider) {
    case 'openai':
      if (!env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is required when TRANSLATION_PROVIDER=openai');
      }
      chunkFn = translateOpenAI;
      apiKey = env.OPENAI_API_KEY;
      break;
    case 'claude':
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is required when TRANSLATION_PROVIDER=claude');
      }
      chunkFn = translateClaude;
      apiKey = env.ANTHROPIC_API_KEY;
      break;
    default:
      throw new Error(`Unknown TRANSLATION_PROVIDER: ${provider}`);
  }

  if (content.length <= CHUNK_THRESHOLD) {
    return chunkFn(content, targetLang, apiKey);
  }

  return translateInChunks(content, targetLang, apiKey, chunkFn);
}

async function translateInChunks(
  content: string,
  targetLang: string,
  apiKey: string,
  chunkFn: TranslateChunkFn,
): Promise<string> {
  const chunks = splitOnHeadings(content);
  const results: string[] = [];
  for (const chunk of chunks) {
    results.push(await chunkFn(chunk, targetLang, apiKey));
  }
  return results.join('\n\n');
}
