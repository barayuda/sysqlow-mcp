/**
 * Context Isolation Invariant:
 * A relation between two snippets is allowed iff at least one endpoint is
 * generic (project_id === null) OR both endpoints share the same project_id.
 *
 * Mirrored at the DB layer by the `enforce_relation_isolation` trigger.
 */
export function canRelate(
  sourceProjectId: string | null,
  targetProjectId: string | null,
): boolean {
  if (sourceProjectId === null) return true;
  if (targetProjectId === null) return true;
  return sourceProjectId === targetProjectId;
}
