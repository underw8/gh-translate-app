export const MAX_RETRIES = 6;
export const CHUNK_THRESHOLD = 300_000;

export class ProviderError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export function buildSystemPrompt(targetLang: string): string {
  return `You are a professional technical translator. Translate the following markdown document into ${targetLang}.

Rules:
1. Preserve ALL markdown syntax exactly: headings (#), bold (**), italic (*), lists (-, *, 1.), tables, blockquotes (>), horizontal rules (---).
2. Preserve YAML/TOML frontmatter delimiters (---). Translate frontmatter values (title, description) but NOT keys.
3. Do NOT translate content inside fenced code blocks (\`\`\`...\`\`\`) or inline code (\`...\`).
4. Do NOT translate URLs, file paths, HTML tags, or variable names.
5. Preserve all blank lines and spacing exactly as in the original.
6. Return ONLY the translated document — no commentary, no preamble.`;
}

/** 1-based inclusive line range in the HEAD (new) file. */
export interface LineRange { start: number; end: number }

/**
 * Parses a unified diff patch and returns the line ranges (1-based, inclusive) in
 * the HEAD file that correspond to added (`+`) lines.  Contiguous additions within
 * the same hunk are merged into a single range.
 *
 * Returns an empty array when the patch has no additions (e.g. pure deletion).
 * Falls back to full-file translation when patch is undefined.
 */
export function getAddedLineRanges(patch: string): LineRange[] {
  const ranges: LineRange[] = [];
  const lines = patch.split('\n');
  let headLine = 0;
  let addStart: number | null = null;

  const flush = () => {
    if (addStart !== null) {
      ranges.push({ start: addStart, end: headLine - 1 });
      addStart = null;
    }
  };

  for (const line of lines) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { flush(); headLine = parseInt(m[1]!, 10); continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      if (addStart === null) addStart = headLine;
      headLine++;
    } else if (line.startsWith('-')) {
      flush();
    } else {
      flush();
      headLine++;
    }
  }
  flush();
  return ranges;
}

export function splitOnHeadings(content: string): string[] {
  const parts = content.split(/(?=\n#{1,2} )/);
  if (parts.length <= 1) return [content];
  return parts.map(p => p.trim()).filter(Boolean);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!(err instanceof ProviderError) || err.status !== 429) throw err;
      if (attempt === MAX_RETRIES) break;

      const baseDelay = Math.min(Math.pow(2, attempt) * 1000, 60_000);
      const jitter = baseDelay * (0.75 + Math.random() * 0.5);
      await sleep(jitter);
    }
  }

  throw lastError;
}
