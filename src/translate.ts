import { translateChunk as translateOpenAI } from './openai';
import { translateChunk as translateClaude } from './claude';
import { CHUNK_THRESHOLD, splitOnHeadings, getAddedLineRanges } from './translate-utils';
import type { LineRange } from './translate-utils';
import type { Env } from './types';

type TranslateChunkFn = (chunk: string, targetLang: string, apiKey: string) => Promise<string>;
type EnvSubset = Pick<Env, 'TRANSLATION_PROVIDER' | 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY'>;

/**
 * Translate `content` into `targetLang`.
 *
 * When `patch` is supplied (unified diff from the GitHub PR files API) only the
 * lines that were *added* in the PR are translated; unchanged lines are preserved
 * verbatim.  This avoids re-translating the entire file for small documentation
 * updates.  Falls back to full-file translation when `patch` is absent (binary
 * files, very large diffs) or when every hunk is a pure deletion.
 */
export async function translateMarkdown(
  content: string,
  targetLang: string,
  env: EnvSubset,
  patch?: string,
): Promise<string> {
  if (patch) {
    const ranges = getAddedLineRanges(patch);
    if (ranges.length > 0) {
      return translateAddedRanges(content, ranges, targetLang, env);
    }
  }
  return translateFull(content, targetLang, env);
}

// ---------------------------------------------------------------------------
// Diff-aware translation — only translate the added line ranges
// ---------------------------------------------------------------------------

async function translateAddedRanges(
  content: string,
  ranges: LineRange[],
  targetLang: string,
  env: EnvSubset,
): Promise<string> {
  const lines = content.split('\n');
  // Process bottom-up so that line-count changes in one range don't shift
  // the indices of ranges above it.
  const sorted = [...ranges].sort((a, b) => b.start - a.start);
  for (const { start, end } of sorted) {
    const block = lines.slice(start - 1, end).join('\n');
    const translated = await translateFull(block, targetLang, env);
    lines.splice(start - 1, end - start + 1, ...translated.split('\n'));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Full-content translation (with heading-based chunking for large files)
// ---------------------------------------------------------------------------

async function translateFull(
  content: string,
  targetLang: string,
  env: EnvSubset,
): Promise<string> {
  const { chunkFn, apiKey } = resolveProvider(env);
  if (content.length <= CHUNK_THRESHOLD) {
    return chunkFn(content, targetLang, apiKey);
  }
  const chunks = splitOnHeadings(content);
  const results: string[] = [];
  for (const chunk of chunks) {
    results.push(await chunkFn(chunk, targetLang, apiKey));
  }
  return results.join('\n\n');
}

function resolveProvider(env: EnvSubset): { chunkFn: TranslateChunkFn; apiKey: string } {
  const provider = env.TRANSLATION_PROVIDER ?? 'openai';
  switch (provider) {
    case 'openai':
      if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required when TRANSLATION_PROVIDER=openai');
      return { chunkFn: translateOpenAI, apiKey: env.OPENAI_API_KEY };
    case 'claude':
      if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required when TRANSLATION_PROVIDER=claude');
      return { chunkFn: translateClaude, apiKey: env.ANTHROPIC_API_KEY };
    default:
      throw new Error(`Unknown TRANSLATION_PROVIDER: ${provider}`);
  }
}
