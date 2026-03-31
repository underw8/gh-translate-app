export interface TranslationRecord {
  /** URL of the translation PR */
  prUrl: string;
  /** HEAD SHA of the source PR when this translation was last completed */
  headSha: string;
}

/** KV key for a given PR */
function key(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

/** Returns the existing translation record, or null if this PR has never been translated */
export async function getTranslationRecord(
  kv: KVNamespace,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<TranslationRecord | null> {
  const raw = await kv.get(key(owner, repo, prNumber));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TranslationRecord;
  } catch {
    // Legacy plain-string value (just a URL) or corrupted KV entry — treat as if
    // no record exists so the job is re-processed and the record is migrated to
    // the new format. Note: KV corruption will also reach this branch and trigger
    // a re-translation rather than silently skipping; acceptable trade-off.
    console.warn(`idempotency: failed to parse KV value for key '${key(owner, repo, prNumber)}', treating as missing`);
    return null;
  }
}

/** Persists the translation record after a successful job */
export async function setTranslationRecord(
  kv: KVNamespace,
  owner: string,
  repo: string,
  prNumber: number,
  record: TranslationRecord,
): Promise<void> {
  // Keep the record for 90 days; PRs don't need indefinite tracking
  await kv.put(key(owner, repo, prNumber), JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 90,
  });
}
