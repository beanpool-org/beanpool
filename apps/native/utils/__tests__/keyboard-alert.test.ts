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
