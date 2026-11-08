/**
 * Copy one chat message's words to the clipboard (Marty, 9 Nov: "I can't select and copy text from previous messages").
 *
 * The words are copied exactly as the bubble shows them. Nothing is copied for a line that did not open (its stand-in
 * "[Unable to decrypt this message]" is the app's, not the person's), for a deleted or removed line, or for one with no
 * words (a photo with no caption).
 *
 * navigator.clipboard exists only in a secure context (https, or localhost). A node reached at a plain http:// address on
 * the local network (lights-out mode) has none, so the older copy command is the fallback there.
 */

/** The words a Copy would put on the clipboard, or null when there is nothing to copy. */
export function copyableChatText(
    shown: string | null | undefined,
    opts: { removed?: boolean; unreadable?: readonly string[] } = {},
): string | null {
    if (opts.removed) return null;
    if (shown == null) return null;
    if (opts.unreadable?.includes(shown.trim())) return null;
    if (shown.trim() === '') return null;
    return shown;
}

/** Puts `text` on the clipboard. Resolves true once it is there, false when the browser refused. */
export async function copyChatText(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Refused (no permission, or the page is not in front): try the older way below.
    }
    return copyWithSelection(text);
}

function copyWithSelection(text: string): boolean {
    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.setAttribute('aria-hidden', 'true');
    box.style.position = 'fixed';
    box.style.top = '0';
    box.style.left = '-9999px';
    box.style.opacity = '0';
    document.body.appendChild(box);
    // What the person had selected stays selected once the copy is done.
    const selection = document.getSelection();
    const kept = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    try {
        box.select();
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        document.body.removeChild(box);
        if (kept && selection) {
            selection.removeAllRanges();
            selection.addRange(kept);
        }
    }
}
