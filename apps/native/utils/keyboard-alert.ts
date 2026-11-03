/**
 * An Alert that closes the keyboard first (3 Nov keyboard audit, group G: scratch/keyboard-audit/AUDIT-2026-11-03.md).
 *
 * A plain `Alert.alert` raised from a screen with a text field leaves the keyboard open behind the dialog: on a small
 * phone the pop-up is half covered, and when it closes the page sits with phantom padding. Screens that can have a field
 * focused import `Alert` from here instead of from react-native; the call sites stay `Alert.alert(...)`.
 *
 * Phantom padding (4 Nov, Opus review of #2804): `Keyboard.dismiss()` only STARTS the hide, and the Alert is its own
 * window. keyboard-controller hears keyboard events on the main window only, so an Alert opened while the keyboard is
 * still closing makes it miss the end of the hide, and the screen keeps keyboard-height padding. So when a keyboard is up
 * the Alert waits for the hide (bounded, utils/keyboard-dismiss.ts), as chat/[id].tsx, propose-project.tsx,
 * treasury-manage.tsx and RemovalReplySheet.tsx already do. With no keyboard up it opens at once: no delay.
 *
 * The call stays synchronous-looking (returns void; nobody awaits it). `NativeAlert.alert` is looked up when the Alert is
 * opened, because App Lock's cover (AppLock.tsx installLockCovers) replaces `Alert.alert` in place.
 *
 * A double tap during the wait (4 Nov, Opus review of #2804, round 2): while an Alert waits for the hide, the screen behind
 * it still takes taps, so a second tap on the same button queued a second, identical dialog. On Pay the Commons each
 * dialog's Pay mints a fresh payment id, so that could pay twice. So while an Alert from here is waiting, a call with the
 * same title and message is dropped: the member gets one dialog. Any other Alert raised in that window still opens.
 * Keyed on what the member reads, not on "anything while one waits": a double tap runs the same handler on the same
 * screen, so it raises the same title and message (none of the 36 screens builds an Alert's words from the clock), and
 * dropping every call instead would also swallow a different message (a request's failure arriving during the wait). Buttons are not in the key: each render makes new
 * onPress closures, and a dialog that reads the same is the same to the member. Once the waiting Alert has opened, it
 * covers the screen, and the next call goes through as usual; with no keyboard up and nothing waiting, nothing changes.
 *
 * keyboard-controller is required when an Alert is raised, not at import: its native side does not load in node, and
 * ~36 screens (and their tests) import this file. A runtime or test without it just means nobody to wait for: the Alert
 * always goes ahead. `makeKeyboardAlert` takes its three parts so the order is tested without a device.
 */
import { Alert as NativeAlert, Keyboard } from 'react-native';
import { dismissKeyboardWithin } from './keyboard-dismiss';

/** What the helper needs of keyboard-controller's KeyboardController. */
export type KeyboardLike = { isVisible: () => boolean; dismiss: () => unknown };

type Parts = {
    /** react-native's Alert.alert, looked up at call time (App Lock replaces it in place). */
    openAlert: (...args: any[]) => void;
    /** keyboard-controller's controller, or null when it can't load here. */
    keyboard: () => KeyboardLike | null;
    /** react-native's Keyboard.dismiss, to blur a field the controller did not report. */
    blurNow: () => void;
    /** How long to wait for the hide to be reported. Default: utils/keyboard-dismiss.ts's. */
    timeoutMs?: number;
};

/** What the member reads in an Alert: its title and message. Two calls with the same key show the same dialog. */
function alertKey(args: any[]): string {
    const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));
    return JSON.stringify([text(args[0]), text(args[1])]);
}

export function makeKeyboardAlert(parts: Parts) {
    /** The Alerts waiting for the keyboard to close, by alertKey: each is opened once, when its wait ends. */
    const waiting = new Set<string>();
    return {
        alert(...args: any[]): void {
            const key = alertKey(args);
            // A double tap while this same Alert waits: the dialog is already on its way. Checked before the keyboard is,
            // so it holds even if the controller already reads the keyboard closed while the first is still waiting.
            if (waiting.has(key)) return;
            let controller: KeyboardLike | null = null;
            let up = false;
            try {
                controller = parts.keyboard();
                up = controller !== null && controller.isVisible() === true;
            } catch {
                up = false; // can't tell: treat as no keyboard, the Alert still goes ahead
            }
            if (!up || controller === null) {
                // Nothing to wait for: open at once. The plain dismiss still blurs a field the controller did not report.
                try { parts.blurNow(); } catch { /* no keyboard to close (a mock, a runtime without one) */ }
                parts.openAlert(...args);
                return;
            }
            const kb = controller;
            waiting.add(key);
            void dismissKeyboardWithin(() => kb.dismiss(), parts.timeoutMs).then(() => {
                waiting.delete(key); // first, so an Alert that throws as it opens doesn't drop its copies for good
                parts.openAlert(...args);
            });
        },
    };
}

export const Alert = makeKeyboardAlert({
    openAlert: (...args: any[]) => (NativeAlert.alert as (...a: any[]) => void)(...args),
    keyboard: () => {
        try {
            return require('react-native-keyboard-controller').KeyboardController as KeyboardLike;
        } catch {
            return null; // no native side here (node, a test): nobody to wait for
        }
    },
    blurNow: () => Keyboard.dismiss(),
}) as { alert: (...args: Parameters<typeof NativeAlert.alert>) => void };
