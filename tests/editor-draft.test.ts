import { describe, expect, it } from 'vitest';
import { clearSavedDraft } from '../src/lib/editor-draft';

function draftStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('editor draft cleanup after an asynchronous save', () => {
  it('retains further edits when an earlier save finishes after leaving the editor', async () => {
    const storage = draftStorage();
    const id = 'document';
    const savedContent = 'Text submitted to the cloud';
    storage.setItem(`draft:${id}`, JSON.stringify({ content: savedContent, version: 1 }));
    let finishSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      finishSave = resolve;
    }).then(() => clearSavedDraft(storage, id, savedContent));

    const newerDraft = JSON.stringify({
      content: savedContent + '\nMore unsaved text',
      version: 1,
    });
    storage.setItem(`draft:${id}`, newerDraft);
    // The user has now returned to the file list; no mounted editor effect can rewrite this draft.
    finishSave();
    await pendingSave;

    expect(storage.getItem(`draft:${id}`)).toBe(newerDraft);
  });

  it('clears only the saved document when its draft still matches the successful save', () => {
    const storage = draftStorage();
    storage.setItem('draft:document', JSON.stringify({ content: 'Saved text', version: 1 }));
    storage.setItem('draft:other', JSON.stringify({ content: 'Another document', version: 1 }));

    clearSavedDraft(storage, 'document', 'Saved text');

    expect(storage.getItem('draft:document')).toBeNull();
    expect(storage.getItem('draft:other')).not.toBeNull();
  });

  it('preserves an empty unsaved draft instead of deleting it after a previous nonempty save', () => {
    const storage = draftStorage();
    const emptyDraft = JSON.stringify({ content: '', version: 1 });
    storage.setItem('draft:document', emptyDraft);

    clearSavedDraft(storage, 'document', 'Earlier text');
    expect(storage.getItem('draft:document')).toBe(emptyDraft);
    clearSavedDraft(storage, 'document', '');
    expect(storage.getItem('draft:document')).toBeNull();
  });

  it('leaves unreadable drafts intact and tolerates unavailable storage', () => {
    const storage = draftStorage();
    storage.setItem('draft:document', 'invalid draft');
    clearSavedDraft(storage, 'document', 'Saved text');
    expect(storage.getItem('draft:document')).toBe('invalid draft');
    expect(() =>
      clearSavedDraft(
        {
          getItem: () => {
            throw new Error('Storage unavailable');
          },
          removeItem: () => {},
        },
        'document',
        'Saved text',
      ),
    ).not.toThrow();
  });
});
