/**
 * The 3 Nov keyboard audit, group G (scratch/keyboard-audit/AUDIT-2026-11-03.md): an Alert raised from a screen with a text
 * field used to open over a raised keyboard. Those screens now import `Alert` from utils/keyboard-alert, which closes the
 * keyboard first. The behaviour is tested on the helper; the wiring is read from the sources so a screen that goes back to
 * react-native's own Alert fails here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeKeyboardAlert } from '../keyboard-alert';

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
        const first = [{ text: 'Cancel' }, { text: 'Pay', onPress: () => {} }];
        const second = [{ text: 'Cancel' }, { text: 'Pay', onPress: () => {} }];
        alert.alert('Pay the Commons', 'Pay 5 Beans?', first);
        alert.alert('Pay the Commons', 'Pay 5 Beans?', second);
        await new Promise((r) => setTimeout(r, 0)); // the dismiss starts a microtask after the call
        expect(hides()).toBe(1); // the second call did not start a wait of its own
        expect(opened).toHaveLength(0);
        finish();
        await vi.waitFor(() => expect(opened).toHaveLength(1));
        await new Promise((r) => setTimeout(r, 20));
        expect(opened).toHaveLength(1);
        expect(opened[0]).toEqual(['Pay the Commons', 'Pay 5 Beans?', first]);
        expect(opened[0][2]).toBe(first);
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

    it('once the waiting Alert has opened, the same Alert raised later opens again', async () => {
        const { alert, opened, finish, setVisible } = held();
        alert.alert('Saved');
        finish();
        await vi.waitFor(() => expect(opened).toHaveLength(1));
        alert.alert('Saved'); // keyboard still reported up: waits on the (already finished) hide, then opens
        await vi.waitFor(() => expect(opened).toHaveLength(2));
        setVisible(false);
        alert.alert('Saved'); // no keyboard: at once
        expect(opened).toHaveLength(3);
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
