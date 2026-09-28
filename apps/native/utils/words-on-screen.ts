import { useEffect, useState } from 'react';
import { phoneHasNoScreenLock } from './LocalAuth';
import { loadScreenCapture } from './screen-capture-module';

/**
 * No screenshots or screen recordings while an account's 12 words are on screen, and the rest of the app as it was.
 *
 * Every screen that draws the words, or the boxes a member types them into, holds this while they are there and the
 * screen is in front (components/WordsOnScreen.tsx `NoScreenCapture`, released when the screen loses focus): Safety
 * Backup's words (welcome.tsx), "Replace this phone's account?"'s outgoing words, Recover with 12 Words, Settings'
 * Account Protection and View Recovery Phrase, "Add your 12 words" (AddWordsForm), the owners' "Check your 12 words"
 * (owner-words-check.tsx) and node-mismatch's delete. __tests__/words-on-screen.test.ts lists every one.
 *
 * What expo-screen-capture 55 does (its source, read for this):
 * - Android: FLAG_SECURE on the app's window. A screenshot is refused (or comes out black, depending on the phone), a
 *   screen recording or cast shows the window black, and the recent-apps preview is blank. A Modal copies the flag
 *   only as it opens (React Native's ReactModalHostView), so none of the screens above shows the words in one.
 * - iPhone: the app's window is drawn inside a secure text field's layer, which iOS leaves out of screenshots and
 *   recordings (iOS 13 and later; this app needs 15.1), so the picture shows a blank screen, not the words; while the
 *   screen is being recorded or mirrored, a black cover goes over it as well. iOS still takes the screenshot, and this
 *   is a technique Apple does not document. Nothing stops a photo of the screen taken with another camera.
 *
 * One tag for the whole app: the library's iPhone code nests the window a second time if its block is asked for twice
 * without a release in between, and would then never let go. So the screens hold it here, and the library is asked
 * once when the first holder comes and once when the last one goes.
 */
const TAG = 'beanpool-12-words';

const holders = new Set<object>();

function ask(block: boolean): void {
    const capture = loadScreenCapture();
    if (!capture) return;
    try {
        const call = block ? capture.preventScreenCaptureAsync(TAG) : capture.allowScreenCaptureAsync(TAG);
        call.catch(() => { /* the web, or a build without the module: the words show as before */ });
    } catch {
        // Same: nothing to block with.
    }
}

/** Blocks capture until the returned release is called (once is enough; more are ignored). */
export function holdNoScreenCapture(): () => void {
    const holder = {};
    holders.add(holder);
    if (holders.size === 1) ask(true);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holders.delete(holder);
        if (holders.size === 0) ask(false);
    };
}

/**
 * Whether to say, under the words, that this phone has no screen lock (the words' lock lets anyone through then:
 * words-behind-lock.ts). Asked each time the words come on screen (the line mounts with them), so a lock set since is
 * noticed. Nothing is gated on it: a phone that can't answer is taken to have a lock, and the line stays away.
 */
export function useNoScreenLock(): boolean {
    const [noLock, setNoLock] = useState(false);
    useEffect(() => {
        let current = true;
        phoneHasNoScreenLock().then((none) => { if (current) setNoLock(none); });
        return () => { current = false; };
    }, []);
    return noLock;
}

export const NO_SCREEN_LOCK_LINE = "This phone has no screen lock, so anyone holding it can open these words. You can set one in the phone's settings.";
