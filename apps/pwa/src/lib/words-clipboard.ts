/**
 * The web app's Copy of the 12 words (Settings → View Recovery Phrase): the words go on the clipboard, and a minute later
 * the app clears them, but only when it can tell they are still what the clipboard holds. Something the member copied
 * since is never wiped. Best effort, and silent: nothing here throws or shows an error.
 *
 * A page can't simply look. Reading the clipboard makes Chrome ask the member for permission, and Safari and Firefox
 * refuse it without a tap; writing it needs the page to have focus. So the words are cleared when either:
 * - the browser already lets this site read the clipboard (the permission was given before): read, and cleared only if
 *   it is exactly the words; or
 * - nothing can have changed the clipboard since the copy: the member stayed on the words screen, the page kept focus,
 *   and nothing was copied or cut on it. (This screen has no other Copy.)
 * Otherwise it is left. The line next to the button says so.
 *
 * The minute is kept here, not by the screen: leaving the screen doesn't cancel it, it only means the second way no
 * longer applies. A newer copy takes over.
 */
export const WORDS_ON_CLIPBOARD_MS = 60_000;

export const WEB_COPY_CLEARS_LINE = 'The copy clears from your clipboard after a minute if you stay on this screen. Once you leave it, your browser may not let the app clear it.';

interface Copy {
    words: string;
    /** Something may have changed the clipboard since: the page lost focus or was hidden, a copy or cut on the page, or the member left the words screen. */
    unsure: boolean;
    stopWatching: () => void;
}

let latest: Copy | null = null;

function watch(copy: Copy): void {
    const unsure = () => { copy.unsure = true; };
    const hidden = () => { if (document.visibilityState === 'hidden') copy.unsure = true; };
    document.addEventListener('copy', unsure);
    document.addEventListener('cut', unsure);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('blur', unsure);
    copy.stopWatching = () => {
        document.removeEventListener('copy', unsure);
        document.removeEventListener('cut', unsure);
        document.removeEventListener('visibilitychange', hidden);
        window.removeEventListener('blur', unsure);
    };
}

/** Copies the words; true if the browser took them. A minute later they are cleared, if the app can tell they are still there. */
export async function copyWordsForAMinute(words: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(words);
    } catch {
        return false;
    }
    latest?.stopWatching();
    const copy: Copy = { words, unsure: false, stopWatching: () => {} };
    latest = copy;
    watch(copy);
    // A page that can't be sure the moment the copy lands can't be sure later either.
    if (!document.hasFocus()) copy.unsure = true;
    setTimeout(() => { void clearIfStillThere(copy); }, WORDS_ON_CLIPBOARD_MS);
    return true;
}

/** The words screen closed (Back, another section, or Settings itself): the clipboard may change without the page seeing it. */
export function leftTheWordsScreen(): void {
    if (latest) latest.unsure = true;
}

async function mayReadClipboard(): Promise<boolean> {
    try {
        const status = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
        return status.state === 'granted';
    } catch {
        return false;
    }
}

function nextFocus(): Promise<void> {
    return new Promise((resolve) => window.addEventListener('focus', () => resolve(), { once: true }));
}

async function clearIfStillThere(copy: Copy): Promise<void> {
    try {
        if (copy !== latest) return;
        // Writing the clipboard needs focus. Without it the page left, so only a read can tell: wait for the member to come back.
        if (!document.hasFocus()) {
            copy.stopWatching();
            await nextFocus();
            if (copy !== latest) return;
        }
        if (await mayReadClipboard()) {
            const now = await navigator.clipboard.readText();
            if (copy === latest && now === copy.words) await navigator.clipboard.writeText('');
            return;
        }
        if (!copy.unsure) await navigator.clipboard.writeText('');
    } catch {
        // Best effort: the browser said no.
    } finally {
        copy.stopWatching();
        if (latest === copy) latest = null;
    }
}
