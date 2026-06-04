/**
 * Cron secret guard — pure, dependency-free (no DB import) so it's unit-testable.
 */

/**
 * Constant-time-ish secret comparison. Returns true only when a secret is
 * configured AND matches. Fails closed.
 */
export function isValidCronSecret(provided, expected) {
  if (!expected) return false;            // not configured → deny
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
