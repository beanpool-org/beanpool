/**
 * A link's invite is kept on the phone until it is used (Damo, 9 Nov): "I just scanned a brand new invite code … it SHOULD
 * have entered the invite code automatically … instead it forced me to click the 'Join with an Invite' button manually and
 * even worse once I click that button I have to 'SCAN a QR Code' again".
 *
 * A warm start's link routes the app to `/` and on to a NEW welcome (app/index.tsx), after the root layout has set the
 * invite as params on the old one; the new one's `Linking.useURL()` starts empty. So a second copy of welcome had no code.
 * The root layout now holds the invite (utils/held-invite.ts); every copy of welcome reads it, hears a newer one, and
 * "Join with an invite" fills the step from it. The screen cannot be rendered here (see vitest.config.ts), so the last
 * block checks that the screen and the root layout call these functions where the route needs them.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    holdInvite, readHeldInvite, forgetHeldInvite, onHeldInvite, heldInviteKey, HELD_INVITE_KEY, HELD_INVITE_MAX_AGE_MS,
    type HeldInviteStorage, type HeldInvite,
} from '../held-invite';

function memoryStorage(): HeldInviteStorage & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
        map,
        getItem: async (k) => map.get(k) ?? null,
        setItem: async (k, v) => { map.set(k, v); },
        removeItem: async (k) => { map.delete(k); },
    };
}

const T0 = 1_762_650_000_000;
const LINK = { invite: 'INV-K7Q2-BSXA', server: 'https://test.beanpool.org' };

describe('the held invite', () => {
    it('keeps a link\'s invite, community and listing until it is read', async () => {
        const s = memoryStorage();
        await holdInvite(s, { ...LINK, post: 'p-1' }, T0);
        expect(await readHeldInvite(s, T0 + 5_000)).toEqual({ ...LINK, post: 'p-1', at: T0 });
    });

    it('a newer link replaces the one held', async () => {
        const s = memoryStorage();
        await holdInvite(s, LINK, T0);
        await holdInvite(s, { invite: 'INV-NEWR-CODE', server: 'https://byron.beanpool.org' }, T0 + 1_000);
        expect((await readHeldInvite(s, T0 + 2_000))?.invite).toBe('INV-NEWR-CODE');
    });

    it('is forgotten once that invite is redeemed, but a newer one held meanwhile stays', async () => {
        const s = memoryStorage();
        await holdInvite(s, LINK, T0);
        await forgetHeldInvite(s, 'inv-k7q2-bsxa');
        expect(await readHeldInvite(s, T0)).toBeNull();

        await holdInvite(s, { invite: 'INV-NEWR-CODE' }, T0);
        await forgetHeldInvite(s, 'INV-K7Q2-BSXA');
        expect((await readHeldInvite(s, T0))?.invite).toBe('INV-NEWR-CODE');
    });

    it('an invite held longer than an invite lasts, or something unreadable, is not offered and is cleared', async () => {
        const s = memoryStorage();
        await holdInvite(s, LINK, T0);
        expect(await readHeldInvite(s, T0 + HELD_INVITE_MAX_AGE_MS + 1)).toBeNull();
        expect(s.map.has(HELD_INVITE_KEY)).toBe(false);
        s.map.set(HELD_INVITE_KEY, '{not json');
        expect(await readHeldInvite(s, T0)).toBeNull();
        s.map.set(HELD_INVITE_KEY, JSON.stringify({ invite: '', at: T0 }));
        expect(await readHeldInvite(s, T0)).toBeNull();
    });

    it('a welcome that is open hears the invite as it is held, even when the write fails', async () => {
        const failing: HeldInviteStorage = { getItem: async () => null, setItem: async () => { throw new Error('disk'); }, removeItem: async () => {} };
        const heard: HeldInvite[] = [];
        const off = onHeldInvite((h) => heard.push(h));
        await holdInvite(failing, LINK, T0);
        off();
        await holdInvite(failing, { invite: 'INV-AFTR-OFFF' }, T0);
        expect(heard.map((h) => h.invite)).toEqual(['INV-K7Q2-BSXA']);
    });

    it('each arrival has its own key, so a second tap on the same invite counts', () => {
        expect(heldInviteKey({ ...LINK, at: T0 })).not.toBe(heldInviteKey({ ...LINK, at: T0 + 1 }));
    });
});

describe('the screens use it (Damo\'s route: a warm start\'s link lands on a new welcome)', () => {
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
    const layout = read('app/_layout.tsx');
    const welcome = read('app/welcome.tsx');

    it('the root layout holds the invite as it routes the link to welcome', () => {
        const route = layout.slice(layout.indexOf('const routeToWelcomeWithInvite'), layout.indexOf('// Case 1: No active identity'));
        expect(route).toMatch(/holdInvite\(AsyncStorage, \{ invite: parsedCode, server: extractedNodeOrigin, post: linkPostId \}\)/);
    });

    it('welcome reads it when it opens, hears a newer one, and forgets it at the redeem', () => {
        expect(welcome).toMatch(/onHeldInvite\(/);
        expect(welcome).toMatch(/readHeldInvite\(AsyncStorage\)\.then\(\(held\) => \{\s*\/\/[^\n]*\n[^\n]*\n\s*if \(!live \|\| !held \|\| appliedInvites\.current\.size > 0 \|\| accountRef\.current\) return;/);
        const redeemed = welcome.slice(welcome.indexOf('setInviteRedeemed(true);\n                undoCommunity = false;'));
        expect(redeemed.slice(0, 300)).toMatch(/forgetHeldInvite\(AsyncStorage, parsedCode\)/);
    });

    it('"Join with an invite" on the first screen fills the step from a held invite before any scan', () => {
        expect(welcome).toMatch(/<WelcomeDoors door=\{globalDoor\} joinWithInvite=\{openInviteStep\}/);
        const open = welcome.slice(welcome.indexOf('const openInviteStep'), welcome.indexOf('const openInviteStep') + 600);
        expect(open).toMatch(/readHeldInvite\(AsyncStorage\)/);
        expect(open).toMatch(/setInviteCode\(held\.invite\)/);
        expect(open).toMatch(/setCreateAnchorUrl\(held\.server\)/);
    });
});
