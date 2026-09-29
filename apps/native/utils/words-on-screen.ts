import { useEffect, useState } from 'react';
import { phoneHasNoScreenLock } from './LocalAuth';
import { loadScreenCapture } from './screen-capture-module';

/**
 * No screenshots or screen recordings while an account's 12 words are on screen, and the rest of the app as it was.
 *
 * Every screen that draws the words, or the boxes a member types them into, draws them inside
 * components/WordsOnScreen.tsx `NoScreenCapture`: Safety Backup's words (welcome.tsx), "Replace this phone's
 * account?"'s outgoing words, Recover with 12 Words, Settings' Account Protection and View Recovery Phrase, "Add your
 * 12 words" (AddWordsForm), the owners' "Check your 12 words" (owner-words-check.tsx) and node-mismatch's delete.
 * __tests__/words-on-screen.test.ts lists every one.
 *
 * The block comes first and goes last. `NoScreenCapture` draws the words only once the library has answered the block
 * (`answered` below: on both platforms the block is in place on the main thread before that answer), so not even the
 * first frame of the words is drawn without it, and a recording or screen share already running when the member taps
 * Show gets nothing. It lets go only after the words have left the screen: when they are put away, and when another
 * screen comes in front (a screen left in the stack stays mounted, and the next one must stay screenshot-able). Coming
 * back, the words wait for the block again.
 *
 * Never a gate: a build without the module, the web, or a library that refuses answers at once, and the words show as
 * before; a library that never answers is given ANSWER_WAIT_MS, then the words show anyway.
 *
 * What expo-screen-capture 55 does (its source, read for this):
 * - Android: FLAG_SECURE on the app's window. A screenshot is refused (or comes out black, depending on the phone), a
 *   screen recording or cast shows the window black, and the recent-apps preview is blank. A Modal copies the flag
 *   only as it opens (React Native's ReactModalHostView), so none of the screens above shows the words in one. The
 *   library as published also listens for screenshots of the whole app from launch (on Android 14 and later, every
 *   screenshot of BeanPool would say "BeanPool detected this screenshot"): patches/expo-screen-capture@55.0.18.patch
 *   takes that out (package.json's expo.autolinking builds it from that source, not the library's prebuilt copy), and
 *   app.json blocks its DETECT_SCREEN_CAPTURE permission.
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

/** How long the words wait for the library's answer before they show anyway (never a gate). */
export const ANSWER_WAIT_MS = 2_000;

const holders = new Set<object>();
/** The answer to the block now held (every holder while it is held waits on the same one). */
let answered: Promise<void> = Promise.resolve();

/** Settles when the library has answered, whatever it answered. Never rejects. */
function ask(block: boolean): Promise<void> {
    const capture = loadScreenCapture();
    if (!capture) return Promise.resolve();
    try {
        const call = block ? capture.preventScreenCaptureAsync(TAG) : capture.allowScreenCaptureAsync(TAG);
        // A refusal (the web, or a build without the module) is an answer too: the words show as before.
        return call.then(() => {}, () => {});
    } catch {
        // Same: nothing to block with.
        return Promise.resolve();
    }
}

function withinWait(call: Promise<void>): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ANSWER_WAIT_MS);
        void call.then(() => { clearTimeout(timer); resolve(); });
    });
}

export interface ScreenCaptureHold {
    /** Settles once the block is in force, or the library has said it can't (the words show then too). Never rejects. */
    answered: Promise<void>;
    /** Lets go (once is enough; more are ignored). Call it only once the words have left the screen. */
    release: () => void;
}

/** Blocks capture until released. Draw the words only once `answered` has settled. */
export function holdNoScreenCapture(): ScreenCaptureHold {
    const holder = {};
    holders.add(holder);
    if (holders.size === 1) answered = withinWait(ask(true));
    let released = false;
    return {
        answered,
        release: () => {
            if (released) return;
            released = true;
            holders.delete(holder);
            if (holders.size === 0) void ask(false);
        },
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
