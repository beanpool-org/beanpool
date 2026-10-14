/**
 * The web app's Copy of the 12 words (Settings → View Recovery Phrase): the words go on the clipboard, and a minute later
 * the app clears them, but only when nothing else can have been copied since. It never reads the clipboard (Chrome would
 * ask the member for permission, and the answer isn't needed). Best effort, and silent: nothing here throws or shows an
 * error.
 *
 * "Nothing else since" is what the page itself saw: the member stayed on the words screen, no other Copy button on the page
 * was used (they write without a copy event, so each calls anotherCopyMade: the screen's Public Key copy does), the page kept
 * focus and stayed in view (another app or tab could have copied), and nothing was copied or cut on the page. If any of that
 * fails, the clipboard is left alone for good.
 *
 * Browsers differ on the write itself (PR #1284 review 4124179538):
 * - Chrome, Edge and the other Chromium browsers let the page in front write at any time: cleared on the minute.
 * - Safari (and so every browser on an iPhone or iPad) and Firefox let a page write only inside a tap or key press, and
 *   refuse the write on the minute. There the words are cleared at the member's first tap or key press on the page after
 *   the minute, still only if nothing else was copied since. A key press with Ctrl, Cmd or Alt doesn't count: it may be
 *   the start of a copy.
 * The line next to the button says both.
 *
 * The minute is kept here, not by the screen: leaving the screen doesn't cancel it, it only means the clipboard is left.
 * A newer copy takes over.
 */
export const WORDS_ON_CLIPBOARD_MS = 60_000;

export const WEB_COPY_CLEARS_LINE = 'If you stay on this screen, the copy clears from your clipboard after a minute. On an iPhone or iPad, in Safari or in Firefox, it clears at your first tap or key press after that minute. If you leave this screen or switch to another app or tab first, it stays: copy something else over it.';

/** The moments Safari and Firefox let a page write the clipboard. Each tries; the first that isn't refused clears. */
const GESTURES = ['pointerup', 'touchend', 'click', 'keydown'] as const;

interface Copy {
    /** Takes every listener off and forgets this copy. */
    finish: () => void;
}

let latest: Copy | null = null;

/** Never throws: a refusal of any kind is a rejection. */
function clearWords(): Promise<void> {
    try {
        return navigator.clipboard.writeText('');
    } catch (e) {
        return Promise.reject(e);
    }
}

function isPlainKey(e: Event): boolean {
    if (e.type !== 'keydown') return true;
    const k = e as KeyboardEvent;
    return !(k.ctrlKey || k.metaKey || k.altKey);
}

/** Copies the words; true if the browser took them. A minute later they are cleared, if nothing else can have been copied. */
export async function copyWordsForAMinute(words: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(words);
    } catch {
        return false;
    }
    latest?.finish();
    // A page that isn't in front the moment the copy lands can't vouch for anything after it: the clipboard is left.
    if (!document.hasFocus()) return true;

    const listeners: [EventTarget, string, EventListener, boolean][] = [];
    const listen = (target: EventTarget, type: string, fn: EventListener, capture = false) => {
        target.addEventListener(type, fn, capture);
        listeners.push([target, type, fn, capture]);
    };
    const minute = setTimeout(() => {
        if (latest !== copy) return;
        clearWords().then(copy.finish, () => {
            if (latest !== copy) return;
            // Safari and Firefox: not without a tap or key press. Cleared inside the next one, if nothing else was copied.
            const onGesture = (e: Event) => {
                if (latest !== copy || !isPlainKey(e)) return;
                // Called inside the event, which is what those browsers need; refused anyway, the next one tries again.
                clearWords().then(copy.finish, () => {});
            };
            for (const type of GESTURES) listen(document, type, onGesture, true);
        });
    }, WORDS_ON_CLIPBOARD_MS);
    const copy: Copy = {
        finish: () => {
            clearTimeout(minute);
            for (const [target, type, fn, capture] of listeners) target.removeEventListener(type, fn, capture);
            listeners.length = 0;
            if (latest === copy) latest = null;
        },
    };
    latest = copy;

    // Anything that may have changed the clipboard without the page seeing what: left alone for good.
    const unsure = () => copy.finish();
    listen(document, 'copy', unsure);
    listen(document, 'cut', unsure);
    listen(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') unsure(); });
    listen(window, 'blur', unsure);
    return true;
}

/** The words screen closed (Back, another section, or Settings itself): the clipboard may change without the page seeing it. */
export function leftTheWordsScreen(): void {
    latest?.finish();
}

/** Another Copy button on the page is about to write (it fires no copy event): the words' clear must not wipe what it copies. */
export function anotherCopyMade(): void {
    latest?.finish();
}
