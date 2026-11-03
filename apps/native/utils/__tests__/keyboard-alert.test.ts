/**
 * The 3 Nov keyboard audit, group G (scratch/keyboard-audit/AUDIT-2026-11-03.md): an Alert raised from a screen with a text
 * field used to open over a raised keyboard. Those screens now import `Alert` from utils/keyboard-alert, which closes the
 * keyboard first. The behaviour is tested on the helper; the wiring is read from the sources so a screen that goes back to
 * react-native's own Alert fails here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
