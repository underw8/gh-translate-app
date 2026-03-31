/** KV key for a given PR */
function key(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

/** Returns the translation PR URL if this job was already completed, otherwise null */
export async function getTranslationRecord(
  kv: KVNamespace,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string | null> {
  return kv.get(key(owner, repo, prNumber));
}

/** Persists the translation PR URL after a successful job */
export async function setTranslationRecord(
  kv: KVNamespace,
  owner: string,
  repo: string,
  prNumber: number,
  translationPrUrl: string,
): Promise<void> {
  // Keep the record for 90 days; PRs don't need indefinite tracking
  await kv.put(key(owner, repo, prNumber), translationPrUrl, { expirationTtl: 60 * 60 * 24 * 90 });
}
