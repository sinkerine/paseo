/** Inserts "\n" at the selection of a focused web textarea, keeping undo history. Returns false when nothing was inserted. */
export function insertComposerLineBreak(target: unknown): boolean {
  if (!(target instanceof HTMLTextAreaElement)) return false;
  return target.ownerDocument.execCommand("insertText", false, "\n");
}
