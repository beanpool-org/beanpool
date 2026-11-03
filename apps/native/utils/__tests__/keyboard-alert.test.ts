/**
 * The 3 Nov keyboard audit, group G (scratch/keyboard-audit/AUDIT-2026-11-03.md): an Alert raised from a screen with a text
 * field used to open over a raised keyboard. Those screens now import `Alert` from utils/keyboard-alert, which closes the
 * keyboard first. The behaviour is tested on the helper; the wiring is read from the sources so a screen that goes back to
 * react-native's own Alert fails here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KEYBOARD_ALERT_HOLD_MS, makeKeyboardAlert } from '../keyboard-alert';

const calls: string[] = [];

vi.mock('react-native', () => ({
    Alert: { alert: vi.fn((...a: unknown[]) => { calls.push(`alert:${String(a[0])}`); }) },
    Keyboard: { dismiss: vi.fn(() => { calls.push('dismiss'); }) },
}));

const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url).href);
const code = (rel: string) => readFileSync(root(rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Alert from utils/keyboard-alert', () => {
    beforeEach(() => { calls.length = 0; });

    it('closes the keyboard, then opens the alert with the same arguments', async () => {
        const { Alert } = await import('../keyboard-alert');
        const rn = await import('react-native');
        const buttons = [{ text: 'OK' }];
        Alert.alert('Title', 'Body', buttons);
        expect(calls).toEqual(['dismiss', 'alert:Title']);
        expect(rn.Alert.alert).toHaveBeenLastCalledWith('Title', 'Body', buttons);
    });

    it('with no keyboard-controller to load (node), opens at once, as before', async () => {
        const { Alert } = await import('../keyboard-alert');
        Alert.alert('Plain');
        expect(calls).toEqual(['dismiss', 'alert:Plain']);
    });
});

// The 4 Nov Opus review of #2804: Keyboard.dismiss() and an Alert in the same tick open the Alert over a keyboard that is
// still closing (phantom padding). With a keyboard up, the Alert waits for the hide; with none, it opens at once.
describe('makeKeyboardAlert: order of the hide and the Alert', () => {
    const make = (opts: { visible: boolean; dismiss?: () => unknown; timeoutMs?: number; keyboard?: () => any }) => {
        const log: string[] = [];
        const kb = { isVisible: () => opts.visible, dismiss: opts.dismiss ?? (() => { log.push('hide-start'); return Promise.resolve(); }) };
        const alert = makeKeyboardAlert({
            openAlert: (...a: any[]) => { log.push(`alert:${String(a[0])}`); },
            keyboard: opts.keyboard ?? (() => kb),
            blurNow: () => { log.push('blur'); },
            timeoutMs: opts.timeoutMs,
        });
        return { log, alert };
    };

    it('keyboard up: the Alert opens only AFTER the awaited hide, with the same arguments', async () => {
        let finishHide!: () => void;
        const hide = new Promise<void>((r) => { finishHide = r; });
        const log: string[] = [];
        const alert = makeKeyboardAlert({
            openAlert: (...a: any[]) => { log.push(`alert:${a.join('|')}`); },
            keyboard: () => ({ isVisible: () => true, dismiss: () => { log.push('hide-start'); return hide; } }),
            blurNow: () => { log.push('blur'); },
        });
        const ret = alert.alert('T', 'B');
        expect(ret).toBeUndefined(); // synchronous-looking: nobody awaits it
        await Promise.resolve();
        await Promise.resolve();
        expect(log).toEqual(['hide-start']); // hide not reported yet: no Alert over the closing keyboard
        finishHide();
        await vi.waitFor(() => expect(log).toEqual(['hide-start', 'alert:T|B']));
        expect(log).not.toContain('blur');
    });

    it('no keyboard up: opens at once, in the same tick, with no wait', () => {
        const { log, alert } = make({ visible: false });
        alert.alert('Now');
        expect(log).toEqual(['blur', 'alert:Now']);
    });

    it('no keyboard-controller at all: opens at once', () => {
        const { log, alert } = make({ visible: true, keyboard: () => null });
        alert.alert('Now');
        expect(log).toEqual(['blur', 'alert:Now']);
    });

    it('keyboard-controller throwing when asked: the Alert still goes ahead at once', () => {
        const { log, alert } = make({ visible: true, keyboard: () => { throw new Error('native side missing'); } });
        alert.alert('Now');
        expect(log).toEqual(['blur', 'alert:Now']);
    });

    it('bounded: a hide that never reports does not hold the Alert back', async () => {
        vi.useFakeTimers();
        try {
            const { log, alert } = make({ visible: true, dismiss: () => new Promise(() => {}), timeoutMs: 400 });
            alert.alert('Stuck');
            await vi.advanceTimersByTimeAsync(399);
            expect(log).toEqual([]);
            await vi.advanceTimersByTimeAsync(2);
            expect(log).toEqual(['alert:Stuck']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a dismiss that throws does not stop the Alert', async () => {
        const { log, alert } = make({ visible: true, dismiss: () => { throw new Error('boom'); } });
        alert.alert('Still');
        await vi.waitFor(() => expect(log).toEqual(['alert:Still']));
    });
});

// The 4 Nov Opus review of #2804 (round 2): while the Alert waits for the hide, the screen behind still takes taps, so a
// double tap queued two identical Alerts (on Pay the Commons, two payments). While one is waiting, the same title + message
// is dropped; any other Alert still opens.
describe('makeKeyboardAlert: a double tap during the wait opens one Alert', () => {
    const held = () => {
        let finish!: () => void;
        const hide = new Promise<void>((r) => { finish = r; });
        const opened: any[][] = [];
        let hides = 0;
        let visible = true;
        const alert = makeKeyboardAlert({
            openAlert: (...a: any[]) => { opened.push(a); },
            keyboard: () => ({ isVisible: () => visible, dismiss: () => { hides += 1; return hide; } }),
            blurNow: () => {},
        });
        return { alert, opened, finish, hides: () => hides, setVisible: (v: boolean) => { visible = v; } };
    };

    it('the same Alert raised twice before the hide is reported opens exactly once, with the first call\'s buttons', async () => {
        const { alert, opened, finish, hides } = held();
        const firstPay = vi.fn();
        const secondPay = vi.fn();
        const first = [{ text: 'Cancel', style: 'cancel' }, { text: 'Pay', onPress: firstPay }];
        const second = [{ text: 'Cancel', style: 'cancel' }, { text: 'Pay', onPress: secondPay }];
        alert.alert('Pay the Commons', 'Pay 5 Beans?', first);
        alert.alert('Pay the Commons', 'Pay 5 Beans?', second);
        await new Promise((r) => setTimeout(r, 0)); // the dismiss starts a microtask after the call
        expect(hides()).toBe(1); // the second call did not start a wait of its own
        expect(opened).toHaveLength(0);
        finish();
        await vi.waitFor(() => expect(opened).toHaveLength(1));
        await new Promise((r) => setTimeout(r, 20));
        expect(opened).toHaveLength(1);
        // The first call's dialog as it was raised: its title, message and buttons, nothing added to the call. Since round 3
        // its buttons are copies that also end the hold after the opening, so they are checked by what they do.
        expect(opened[0]).toHaveLength(3);
        expect(opened[0].slice(0, 2)).toEqual(['Pay the Commons', 'Pay 5 Beans?']);
        expect(opened[0][2].map((b: any) => [b.text, b.style])).toEqual([['Cancel', 'cancel'], ['Pay', undefined]]);
        opened[0][2][1].onPress();
        expect(firstPay).toHaveBeenCalledTimes(1);
        expect(secondPay).not.toHaveBeenCalled();
    });

    it('a hide that never reports: the duplicate is still dropped, and the one Alert opens at the time limit', async () => {
        vi.useFakeTimers();
        try {
            const opened: string[] = [];
            const alert = makeKeyboardAlert({
                openAlert: (...a: any[]) => { opened.push(String(a[0])); },
                keyboard: () => ({ isVisible: () => true, dismiss: () => new Promise(() => {}) }),
                blurNow: () => {},
                timeoutMs: 400,
            });
            alert.alert('Delete?', 'This can’t be undone.');
            await vi.advanceTimersByTimeAsync(150);
            alert.alert('Delete?', 'This can’t be undone.');
            await vi.advanceTimersByTimeAsync(260);
            expect(opened).toEqual(['Delete?']);
            await vi.advanceTimersByTimeAsync(1000);
            expect(opened).toEqual(['Delete?']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('two different Alerts in a row both open, in order', async () => {
        const { alert, opened, finish } = held();
        alert.alert('Couldn’t save', 'Try again.');
        alert.alert('Saved');
        finish();
        await vi.waitFor(() => expect(opened.map((a) => a[0])).toEqual(['Couldn’t save', 'Saved']));
    });

    it('the same title with a different message is a different Alert: both open', async () => {
        const { alert, opened, finish } = held();
        alert.alert('Pay the Commons', 'Pay 5 Beans?');
        alert.alert('Pay the Commons', 'Pay 50 Beans?');
        finish();
        await vi.waitFor(() => expect(opened.map((a) => a[1])).toEqual(['Pay 5 Beans?', 'Pay 50 Beans?']));
    });

    it('a duplicate behind another waiting Alert is still dropped (each waiting Alert is remembered, not just the last)', async () => {
        const { alert, opened, finish } = held();
        alert.alert('A', 'one');
        alert.alert('B', 'two');
        alert.alert('A', 'one');
        alert.alert('B', 'two');
        finish();
        await vi.waitFor(() => expect(opened.map((a) => a[0])).toEqual(['A', 'B']));
        await new Promise((r) => setTimeout(r, 20));
        expect(opened.map((a) => a[0])).toEqual(['A', 'B']);
    });

    it('once the waiting Alert has opened and its hold has ended, the same Alert raised later opens again', async () => {
        vi.useFakeTimers();
        try {
            const { alert, opened, finish, setVisible } = held();
            alert.alert('Saved');
            finish();
            await flush();
            expect(opened).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(KEYBOARD_ALERT_HOLD_MS); // past the hold (round 3)
            alert.alert('Saved'); // keyboard still reported up: waits on the (already finished) hide, then opens
            await flush();
            expect(opened).toHaveLength(2);
            await vi.advanceTimersByTimeAsync(KEYBOARD_ALERT_HOLD_MS);
            setVisible(false);
            alert.alert('Saved'); // no keyboard, nothing held: at once
            expect(opened).toHaveLength(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a duplicate raised after the controller already reads the keyboard closed, while the first still waits, is dropped too', async () => {
        const { alert, opened, finish, setVisible } = held();
        alert.alert('Pay the Commons', 'Pay 5 Beans?');
        setVisible(false);
        alert.alert('Pay the Commons', 'Pay 5 Beans?');
        expect(opened).toHaveLength(0);
        finish();
        await vi.waitFor(() => expect(opened).toHaveLength(1));
        await new Promise((r) => setTimeout(r, 20));
        expect(opened).toHaveLength(1);
    });

    it('no keyboard up and nothing waiting: each call opens at once, as before (no wait, nothing dropped)', () => {
        const opened: string[] = [];
        const alert = makeKeyboardAlert({
            openAlert: (...a: any[]) => { opened.push(String(a[0])); },
            keyboard: () => ({ isVisible: () => false, dismiss: () => Promise.resolve() }),
            blurNow: () => {},
        });
        alert.alert('Now');
        alert.alert('Now');
        expect(opened).toEqual(['Now', 'Now']);
    });
});

/** Lets a resolved hide reach the Alert (a few promise steps) without moving any timer, real or fake. */
async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

// The 4 Nov Opus review of #2804 (round 3, iPhone): a tap fires when the finger lifts, and iOS stacks Alert windows. A second
// press that went down while the keyboard was closing and lifted just after the hide was reported came after the key was
// cleared, so it opened a second, identical dialog on top of the first (two "Pay N Beans?", two payments). The same Alert now
// stays dropped until its dialog is answered, or KEYBOARD_ALERT_HOLD_MS after it opened.
describe('makeKeyboardAlert: the same Alert stays dropped just after it opens', () => {
    const opening = (opts: { holdMs?: number; cover?: (open: (...a: any[]) => void) => (...a: any[]) => void } = {}) => {
        let finish!: () => void;
        const hide = new Promise<void>((r) => { finish = r; });
        const opened: any[][] = [];
        let hides = 0;
        let visible = true;
        const open = (...a: any[]) => { opened.push(a); };
        const alert = makeKeyboardAlert({
            openAlert: opts.cover ? opts.cover(open) : open,
            keyboard: () => ({ isVisible: () => visible, dismiss: () => { hides += 1; return hide; } }),
            blurNow: () => {},
            holdMs: opts.holdMs,
        });
        /** keyboardDidHide: the awaited dismiss resolves, and the controller now reads the keyboard closed. */
        const hidden = async () => { finish(); visible = false; await flush(); };
        return { alert, opened, hidden, hides: () => hides, setVisible: (v: boolean) => { visible = v; } };
    };
    const payWith = (onPress: (...a: any[]) => void) => [{ text: 'Cancel', style: 'cancel' }, { text: 'Pay', onPress }];
    const withFakeTimers = (body: () => Promise<void>) => async () => {
        vi.useFakeTimers();
        try {
            await body();
        } finally {
            vi.useRealTimers();
        }
    };

    it('the hold is longer than a press, and short', () => {
        expect(KEYBOARD_ALERT_HOLD_MS).toBeGreaterThanOrEqual(500);
        expect(KEYBOARD_ALERT_HOLD_MS).toBeLessThanOrEqual(1000);
    });

    it('a second press that lifts just after the hide is reported (the dialog is up) is dropped: one dialog, one Pay', withFakeTimers(async () => {
        const { alert, opened, hidden, hides } = opening();
        const firstPay = vi.fn();
        const secondPay = vi.fn();
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(firstPay));
        await hidden();
        expect(opened).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(80); // the second press lifts about one press later; the keyboard reads closed
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(secondPay));
        await flush();
        expect(opened).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(KEYBOARD_ALERT_HOLD_MS - 81); // the last moment of the hold
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(secondPay));
        await flush();
        expect(opened).toHaveLength(1);
        expect(hides()).toBe(1); // the dropped calls started no wait of their own
        opened[0][2][1].onPress();
        expect(firstPay).toHaveBeenCalledTimes(1);
        expect(secondPay).not.toHaveBeenCalled();
    }));

    it('the same press with the keyboard still reported up is dropped too (the hold is checked before the keyboard)', withFakeTimers(async () => {
        const { alert, opened, hidden, hides, setVisible } = opening();
        alert.alert('Delete?', 'This can’t be undone.');
        await hidden();
        setVisible(true);
        alert.alert('Delete?', 'This can’t be undone.');
        await flush();
        expect(opened).toHaveLength(1);
        expect(hides()).toBe(1);
    }));

    it('the same Alert raised again once the hold has ended opens again', withFakeTimers(async () => {
        const { alert, opened, hidden } = opening();
        alert.alert('Saved');
        await hidden();
        expect(opened).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(KEYBOARD_ALERT_HOLD_MS - 1);
        alert.alert('Saved');
        expect(opened).toHaveLength(1); // still held
        await vi.advanceTimersByTimeAsync(1);
        alert.alert('Saved'); // the hold is over, no keyboard: at once, in the same tick
        expect(opened).toHaveLength(2);
    }));

    it('other Alerts still open during the hold', withFakeTimers(async () => {
        const { alert, opened, hidden } = opening();
        alert.alert('Pay the Commons', 'Pay 5 Beans?');
        await hidden();
        alert.alert('Couldn’t pay', 'Try again.');
        alert.alert('Pay the Commons', 'Pay 50 Beans?');
        expect(opened.map((a) => a[1])).toEqual(['Pay 5 Beans?', 'Try again.', 'Pay 50 Beans?']);
    }));

    const answers: Array<[string, (a: any[]) => void]> = [
        ['Cancel, a button with no onPress of its own', (a) => a[2][0].onPress()],
        ['Pay, whose own onPress still runs, once, with its arguments', (a) => a[2][1].onPress('picked')],
        ['an Android onDismiss (a tap outside a cancelable dialog)', (a) => a[3].onDismiss()],
    ];
    for (const [how, answer] of answers) {
        it(`answering the dialog ends the hold at once: ${how}`, withFakeTimers(async () => {
            const { alert, opened, hidden } = opening();
            const pay = vi.fn();
            const dismissed = vi.fn();
            const buttons = payWith(pay);
            const options = { cancelable: true, onDismiss: dismissed };
            alert.alert('Pay the Commons', 'Pay 5 Beans?', buttons, options);
            await hidden();
            expect(opened).toHaveLength(1);
            answer(opened[0]);
            alert.alert('Pay the Commons', 'Pay 5 Beans?', buttons, options); // a new tap after the answer: a new question
            expect(opened).toHaveLength(2);
            if (how.startsWith('Pay')) expect(pay.mock.calls).toEqual([['picked']]);
            else expect(pay).not.toHaveBeenCalled();
            if (how.startsWith('an Android')) expect(dismissed).toHaveBeenCalledTimes(1);
            else expect(dismissed).not.toHaveBeenCalled();
            // The caller's own objects are not changed: the dialog got copies.
            expect(buttons[0]).toEqual({ text: 'Cancel', style: 'cancel' });
            expect(buttons[1].onPress).toBe(pay);
            expect(options.onDismiss).toBe(dismissed);
        }));
    }

    it('App Lock is locked (its cover ignores the buttons, AppLock.tsx lockAwareAlert): the hold still ends at its time limit', withFakeTimers(async () => {
        // A stand-in for lockAwareAlert while the lock screen shows: each button's onPress is swallowed.
        const locked = (open: (...a: any[]) => void) => (title: string, message?: string, buttons?: any[]) =>
            open(title, message, buttons?.map((b) => (b.onPress ? { ...b, onPress: () => {} } : b)));
        const { alert, opened, hidden } = opening({ cover: locked });
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(() => {}));
        await hidden();
        opened[0][2][0].onPress(); // pressed while locked: nothing runs
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(() => {}));
        expect(opened).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(KEYBOARD_ALERT_HOLD_MS);
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(() => {}));
        expect(opened).toHaveLength(2);
    }));

    it('a dialog raised with no buttons (nothing to press): nothing is added to the call, and the hold ends at its time limit', withFakeTimers(async () => {
        const { alert, opened, hidden } = opening();
        alert.alert('Saved');
        await hidden();
        expect(opened[0]).toEqual(['Saved']);
        await vi.advanceTimersByTimeAsync(KEYBOARD_ALERT_HOLD_MS);
        alert.alert('Saved');
        expect(opened).toHaveLength(2);
    }));

    it('an answered dialog\'s time limit never ends a newer same Alert\'s hold', withFakeTimers(async () => {
        const { alert, opened, hidden, setVisible } = opening();
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(() => {}));
        await hidden(); // opens at t = 0; its own limit would be t = HOLD
        await vi.advanceTimersByTimeAsync(100);
        opened[0][2][0].onPress(); // answered at t = 100
        setVisible(true);
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(() => {})); // a new tap: waits, opens at t = 100, holds
        await flush();
        expect(opened).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(KEYBOARD_ALERT_HOLD_MS - 50); // past the first dialog's old limit, inside the second's
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(() => {}));
        await flush();
        expect(opened).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(50); // the second dialog's own limit
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(() => {}));
        await flush();
        expect(opened).toHaveLength(3);
    }));

    it('a late answer to an older dialog never ends a newer same Alert\'s hold', withFakeTimers(async () => {
        const { alert, opened, hidden, setVisible } = opening();
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(() => {}));
        await hidden();
        await vi.advanceTimersByTimeAsync(KEYBOARD_ALERT_HOLD_MS); // the first dialog's hold ends unanswered
        setVisible(true);
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(() => {})); // raised again: waits, opens, holds
        await flush();
        expect(opened).toHaveLength(2);
        opened[0][2][0].onPress(); // the first dialog answered late
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(() => {}));
        await flush();
        expect(opened).toHaveLength(2); // the second dialog's hold still stands
        opened[1][2][0].onPress(); // the second dialog answered: its hold ends
        alert.alert('Pay the Commons', 'Pay 5 Beans?', payWith(() => {}));
        await flush();
        expect(opened).toHaveLength(3);
    }));

    it('a hold given to makeKeyboardAlert is used', withFakeTimers(async () => {
        const { alert, opened, hidden } = opening({ holdMs: 2000 });
        alert.alert('Saved');
        await hidden();
        await vi.advanceTimersByTimeAsync(1999);
        alert.alert('Saved');
        expect(opened).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        alert.alert('Saved');
        expect(opened).toHaveLength(2);
    }));
});

describe('App Lock cover: NativeAlert.alert is looked up when the Alert opens', () => {
    it('an Alert.alert replaced after import (installLockCovers) is the one that runs', async () => {
        const { Alert } = await import('../keyboard-alert');
        const rn = await import('react-native');
        const original = rn.Alert.alert;
        const cover = vi.fn();
        (rn.Alert as any).alert = cover;
        try {
            Alert.alert('Covered');
            expect(cover).toHaveBeenCalledWith('Covered');
        } finally {
            (rn.Alert as any).alert = original;
        }
    });
});

// Screens and sheets that draw a text field, or sit on a screen that does, and raise an Alert.
const SCREENS = [
    'app/(tabs)/ledger.tsx',
    'app/(tabs)/people.tsx',
    'app/(tabs)/settings.tsx',
    'app/_layout.tsx',
    'app/channels.tsx',
    'app/chat/[id].tsx',
    'app/claim-community.tsx',
    'app/community-card.tsx',
    'app/find-community.tsx',
    'app/group-post.tsx',
    'app/join-open-door.tsx',
    'app/names-list.tsx',
    'app/new-listing.tsx',
    'app/new-message.tsx',
    'app/node-mismatch.tsx',
    'app/pay-commons.tsx',
    'app/post/[id].tsx',
    'app/propose-project.tsx',
    'app/rekey-code.tsx',
    'app/treasury-detail.tsx',
    'app/treasury-manage.tsx',
    'app/treasury-post.tsx',
    'app/welcome.tsx',
    'components/CreateGroupModal.tsx',
    'components/EnterpriseDecisions.tsx',
    'components/EventChatView.tsx',
    'components/EventDetail.tsx',
    'components/GroupChatView.tsx',
    'components/InvitePeopleSheet.tsx',
    'components/ListingCopy.tsx',
    'components/NewEventModal.tsx',
    'components/NewPollModal.tsx',
    'components/PollCard.tsx',
    'components/ProposeDecisionModal.tsx',
    'components/RemovalReplySheet.tsx',
    'components/ReviewModal.tsx',
];

const rnImports = (c: string) => [...c.matchAll(/import\s*\{([^}]*)\}\s*from\s*'react-native';?/g)].flatMap((m) => m[1].split(',').map((x) => x.trim()));

describe('group G: each screen with a text field raises its Alerts through the keyboard-closing one', () => {
    for (const file of SCREENS) {
        it(`${file}: Alert comes from keyboard-alert, not react-native, and is still called`, () => {
            const c = code(file);
            expect(c).toMatch(/import \{ Alert \} from '(\.\.?\/)+utils\/keyboard-alert';|import \{ Alert \} from '\.\/keyboard-alert';/);
            expect(rnImports(c)).not.toContain('Alert');
            expect(c).toMatch(/\bAlert\.alert\(/);
        });
    }

    it('no screen or sheet draws a TextInput and still takes Alert from react-native', () => {
        const walk = (dir: string): string[] => readdirSync(root(dir)).flatMap((name) => {
            const rel = `${dir}/${name}`;
            return statSync(root(rel)).isDirectory() ? walk(rel) : /\.tsx$/.test(name) ? [rel] : [];
        });
        const offenders = [...walk('app'), ...walk('components')].filter((rel) => {
            const c = code(rel);
            return /<TextInput\b/.test(c) && rnImports(c).includes('Alert');
        });
        expect(offenders).toEqual([]);
    });
});
