/**
 * The model id to offer as a custom entry in the model picker, or null when
 * there is nothing new to offer.
 *
 * The picker lists the provider's model directory, but a directory is not
 * always available: some OpenAI-compatible servers have no /models route, and
 * after a save the key box is empty, so the lookup falls back to OpenRouter's
 * list. Offering the typed text as-is keeps every model reachable.
 */
export function customModelId(
  query: string,
  models: ReadonlyArray<{ id: string }> | null,
): string | null {
  const id = query.trim();
  if (!id) return null;
  if (models?.some((m) => m.id === id)) return null;
  return id;
}
