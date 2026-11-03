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
 * dropping every call instead would also swallow a different message (a request's failure arriving during the wait).
 * Buttons are not in the key: each render makes new onPress closures, and a dialog that reads the same is the same to the
 * member.
 *
 * Held a little past the opening too (4 Nov, Opus review of #2804, round 3; iPhone): a tap fires when the finger LIFTS,
 * and on iOS each Alert is a window of its own, so two stack (Android replaces the first). A second tap that went down
 * while the keyboard was closing and lifts just after the hide is reported would otherwise open a second, identical "Pay
 * N Beans?" on top of the first. So the same Alert stays dropped until the member answers the dialog (any button, or an
 * Android onDismiss) or KEYBOARD_ALERT_HOLD_MS after it opened, whichever comes first. The time limit is not optional:
 * App Lock's cover (AppLock.tsx lockAwareAlert) ignores a dialog's buttons while the app is locked, and a dialog raised
 * with no buttons has none to press. With no keyboard up and nothing held, nothing changes: the Alert opens at once.
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
    /** How long the same Alert stays dropped after it opened, if nobody answers it sooner. Default: KEYBOARD_ALERT_HOLD_MS. */
    holdMs?: number;
};

/**
 * How long, after an Alert that waited for the keyboard opens, the same Alert is still dropped if the member has not
 * answered it yet. Longer than a press (one that went down while the keyboard was closing), short enough that a member
 * whose dialog closed without a callback (App Lock, a dialog with no buttons) and who taps again is barely held up.
 */
export const KEYBOARD_ALERT_HOLD_MS = 600;

/** What the member reads in an Alert: its title and message. Two calls with the same key show the same dialog. */
function alertKey(args: any[]): string {
    const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));
    return JSON.stringify([text(args[0]), text(args[1])]);
}

/**
 * The Alert's arguments, with each button (and an Android onDismiss) also calling `answered` first. Copies, never the
 * caller's own objects; a button keeps its words, style and onPress, which still runs, with the same arguments.
 */
function endsHoldWhenAnswered(args: any[], answered: () => void): any[] {
    const out = [...args];
    const buttons = args[2];
    if (Array.isArray(buttons)) {
        out[2] = buttons.map((button) => (button !== null && typeof button === 'object'
            ? {
                ...button,
                onPress: (...a: any[]) => {
                    answered();
                    return typeof button.onPress === 'function' ? button.onPress(...a) : undefined;
                },
            }
            : button));
    }
    const options = args[3];
    if (options !== null && typeof options === 'object' && typeof options.onDismiss === 'function') {
        out[3] = { ...options, onDismiss: (...a: any[]) => { answered(); return options.onDismiss(...a); } };
    }
    return out;
}

export function makeKeyboardAlert(parts: Parts) {
    /**
     * The Alerts that waited for the keyboard, by alertKey: from the start of the wait until the member answers the
     * dialog or the hold after it opened ends. A held Alert is opened once.
     */
    const held = new Set<string>();
    const holdMs = parts.holdMs ?? KEYBOARD_ALERT_HOLD_MS;
    return {
        alert(...args: any[]): void {
            const key = alertKey(args);
            // A double tap while this same Alert waits, or a tap that lifts just after it opened: the dialog is already on
            // its way, or up. Checked before the keyboard is, so it holds once the controller reads the keyboard closed.
            if (held.has(key)) return;
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
            held.add(key);
            let released = false;
            let holdTimer: ReturnType<typeof setTimeout> | undefined;
            // Once only, and only this call's hold: a later Alert with the same words, raised after this one was answered,
            // holds its key itself, and this call's timer or a late button press must not free it.
            const release = () => {
                if (released) return;
                released = true;
                if (holdTimer !== undefined) clearTimeout(holdTimer);
                held.delete(key);
            };
            void dismissKeyboardWithin(() => kb.dismiss(), parts.timeoutMs).then(() => {
                // Started before the Alert opens, so one that throws as it opens still frees its copies when the hold ends.
                holdTimer = setTimeout(release, holdMs);
                parts.openAlert(...endsHoldWhenAnswered(args, release));
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
