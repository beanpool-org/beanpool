/**
 * Where the "Worldwide forum ›" row shows (slice F3 part 2; utils/worldwide-forum.ts, joint design §2.2): in another
 * community's Forum, for a member this phone keeps as joined on the worldwide community (a saved community, not a guest's);
 * never on the worldwide community itself, never where it isn't kept, and nothing on a fault. And what a tap does: the
 * switch a notice from there makes, landing on its Forum.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const phone = vi.hoisted(() => ({ anchor: null as string | null, saved: [] as { url: string }[], guests: [] as string[], broken: false, switched: [] as unknown[] }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? phone.anchor : null)) } }));
vi.mock('../nodes', () => ({
    getSavedNodes: vi.fn(async () => { if (phone.broken) throw new Error('unreadable'); return phone.saved; }),
    isGuestNode: vi.fn(async (url: string) => phone.guests.includes(url)),
}));
vi.mock('../push-notice-switch', () => ({
    openNoticeIn: vi.fn(async (community: string, id: string | null, route: () => Promise<string>) => { phone.switched.push([community, id, await route()]); return 'switched'; }),
}));
vi.mock('../use-communities', () => ({ switchCommunity: vi.fn(), communitySwitchUnderWay: () => false }));
vi.mock('../onboarding-state', () => ({ getPendingOnboarding: vi.fn(async () => null) }));

import { GLOBAL_NODE_URL } from '../global-node-url';
import { openWorldwideForum, worldwideForumJoined } from '../worldwide-forum';

const HOME = 'https://riverside.example';

beforeEach(() => Object.assign(phone, { anchor: HOME, saved: [{ url: HOME }, { url: GLOBAL_NODE_URL }], guests: [], broken: false, switched: [] }));

describe('the Worldwide forum row', () => {
    it('shows in another community\'s Forum for a member kept as joined on the worldwide community', async () => {
        expect(await worldwideForumJoined()).toBe(true);
    });

    it('not on the worldwide community itself, not where it isn\'t kept, not for a guest there, not on a fault', async () => {
        phone.anchor = GLOBAL_NODE_URL;
        expect(await worldwideForumJoined()).toBe(false);
        phone.anchor = HOME;
        phone.saved = [{ url: HOME }];
        expect(await worldwideForumJoined()).toBe(false);
        phone.saved = [{ url: HOME }, { url: GLOBAL_NODE_URL }];
        phone.guests = [GLOBAL_NODE_URL];
        expect(await worldwideForumJoined()).toBe(false);
        phone.guests = [];
        phone.broken = true;
        expect(await worldwideForumJoined()).toBe(false);
        phone.broken = false;
        phone.anchor = null;
        expect(await worldwideForumJoined()).toBe(false);
    });

    it('a tap makes the switch a notice from there makes, landing on its Chat tab\'s Forum side', async () => {
        expect(await openWorldwideForum('k'.repeat(64), async () => 'member')).toBe('switched');
        expect(phone.switched).toEqual([[GLOBAL_NODE_URL, null, '/(tabs)/chats?view=forum']]);
    });
});
