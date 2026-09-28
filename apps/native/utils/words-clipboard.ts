import * as Clipboard from 'expo-clipboard';
import { AppState, Platform } from 'react-native';

/**
 * Copy for an account's 12 words: on the clipboard for a minute, then cleared, but only while it still holds exactly
 * those words. Something the member copied since is never touched. Every Copy of the words goes through here:
 * Safety Backup and "Replace this phone's account?" (welcome.tsx), and Account Protection and View Recovery Phrase
 * (settings.tsx). __tests__/words-clipboard.test.ts lists them.
 *
 * The minute is kept here, not by the screen: leaving the screen (or the app) doesn't cancel it. A newer copy of words
 * starts the minute again and takes over the clearing.
 *
 * The clipboard can be read only by the app in front: Android 10 and later answer an app behind another with nothing,
 * and React Native holds its timers while the app is behind on Android and while an iPhone has it suspended. So the
 * clipboard is read only while BeanPool is in front, a second after it came there (Android gives the clipboard to the
 * app with the keyboard focus, which follows the app's return by a moment). A minute that ends while BeanPool is behind
 * is finished when it comes back. An empty answer can mean "cleared" or "not allowed to read": that one is tried again
 * on each of the next two returns to the app, then left.
 *
 * On an iPhone, reading something another app copied shows iOS's own "Allow Paste" question (iOS 16 and later); that
 * happens only when the member copied something else in another app before BeanPool read the clipboard again. There
 * is no way to ask iOS whether the clipboard changed without reading it through expo-clipboard 55.
 *
 * Not marked sensitive: Android 13 hides a clip's preview when the copy says it is sensitive (ClipDescription
 * EXTRA_IS_SENSITIVE), but expo-clipboard 55's setStringAsync has no way to say so (its options are the format only).
 *
 * The native app's web build (not the members' web app, apps/pwa) copies as before and leaves the clipboard alone: a
 * browser would ask the member for permission to read it.
 */
export const WORDS_ON_CLIPBOARD_MS = 60_000;
/** After BeanPool comes to the front, before the clipboard is read. */
export const BACK_IN_FRONT_MS = 1_000;
/** Reads in all: the first, and one on each of the next two returns when an empty answer can't tell. */
const READS = 3;

/** Said next to every Copy of the words. */
export const COPY_CLEARS_LINE = 'The copy clears from your clipboard after a minute. If you leave BeanPool first, it clears when you come back.';

let latest = 0;

/** Copies the words, then clears them from the clipboard a minute later if they are still what it holds. */
export async function copyWordsForAMinute(words: string): Promise<void> {
    await Clipboard.setStringAsync(words);
    if (Platform.OS === 'web') return;
    const copy = ++latest;
    setTimeout(() => { void clearIfStillThere(words, copy); }, WORDS_ON_CLIPBOARD_MS);
}

function nextReturnToFront(): Promise<void> {
    return new Promise((resolve) => {
        const sub = AppState.addEventListener('change', (state) => {
            if (state !== 'active') return;
            sub.remove();
            resolve();
        });
    });
}

async function inFront(afterAReturn: boolean): Promise<void> {
    if (afterAReturn || AppState.currentState !== 'active') await nextReturnToFront();
    await new Promise((resolve) => setTimeout(resolve, BACK_IN_FRONT_MS));
}

async function clearIfStillThere(words: string, copy: number): Promise<void> {
    for (let read = 0; read < READS; read++) {
        await inFront(read > 0);
        // A newer copy took over.
        if (copy !== latest) return;
        let now: string;
        try {
            now = (await Clipboard.getStringAsync()) ?? '';
        } catch {
            now = '';
        }
        if (copy !== latest) return;
        if (now === words) {
            try { await Clipboard.setStringAsync(''); } catch { /* left: nothing else to try */ }
            return;
        }
        // The member copied something else since: theirs, left alone.
        if (now !== '') return;
    }
}
