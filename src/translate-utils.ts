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
