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

export function makeKeyboardAlert(parts: Parts) {
    return {
        alert(...args: any[]): void {
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
            void dismissKeyboardWithin(() => kb.dismiss(), parts.timeoutMs).then(() => parts.openAlert(...args));
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
