type DraftStorage = Pick<Storage, 'getItem' | 'removeItem'>;

export function clearSavedDraft(storage: DraftStorage, id: string, savedContent: string) {
  const key = `draft:${id}`;
  try {
    const value = storage.getItem(key);
    if (value === null) return;
    const draft = JSON.parse(value) as { content?: unknown } | null;
    // A save may finish after more typing, another tab's edit, or the editor has closed.
    // Only discard the exact content that this request has persisted to the cloud.
    if (draft?.content === savedContent) storage.removeItem(key);
  } catch {
    // Unavailable storage or an unreadable draft must not turn a successful save into an error.
  }
}
