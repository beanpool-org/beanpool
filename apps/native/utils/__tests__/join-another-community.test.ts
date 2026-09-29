/**
 * Joining a second community with an invite (utils/join-another-community.ts): the path People's "Join Another
 * Community" takes, and now an approved request to join too. The invite is redeemed on the NEW community, with the
 * member's one key; a failure puts the phone back where it was. Nothing here contacts a node.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.delete(key); }),
    },
}));

import { joinAnotherCommunity, joinedNudge, type JoinDeps } from '../join-another-community';
import type { BeanPoolIdentity } from '../identity';

const GLOBAL = 'https://global.beanpool.org';
const LOCAL = 'https://mullum.beanpool.org';
const me = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'Robin' } as BeanPoolIdentity;

function deps(redeem: JoinDeps['redeemInvite']): JoinDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        closeDB: vi.fn(async () => { calls.push(`close:${mem.get('beanpool_anchor_url')}`); }),
        initDB: vi.fn(async () => { calls.push(`init:${mem.get('beanpool_anchor_url')}`); }),
        redeemInvite: vi.fn(async (code, callsign, identity) => {
            calls.push(`redeem:${code}:${callsign}:${identity.publicKey.slice(0, 4)}@${mem.get('beanpool_anchor_url')}`);
            return redeem(code, callsign, identity);
        }),
        addSavedNode: vi.fn(async () => {}),
        clearGuestNode: vi.fn(async () => {}),
        requestSync: vi.fn(async () => {}),
    };
}

beforeEach(() => {
    mem.clear();
    mem.set('beanpool_anchor_url', GLOBAL);
    (globalThis as any).fetch = vi.fn(async (url: string) => {
        expect(url).toBe(`${LOCAL}/api/community/health`);
        return { ok: true, status: 200, json: async () => ({ nodeName: 'Mullumbimby', currency: { type: 'image', value: 'bean' } }) };
    });
});

describe('joining another community with an invite', () => {
    it('redeems on the new community (not the one it came from) with the member’s key, and stays there', async () => {
        const d = deps(async () => ({ success: true, alreadyMember: false, nodeHasPhoto: false }));
        const joined = await joinAnotherCommunity({ targetUrl: `${LOCAL}/`, code: 'ABCD2345', identity: me, returnUrl: GLOBAL, knownName: 'Mullum' }, d);
        expect(joined).toEqual({ url: LOCAL, name: 'Mullumbimby', alreadyMember: false });
        expect(d.calls).toEqual([`close:${GLOBAL}`, `init:${LOCAL}`, `redeem:ABCD2345:Robin:abab@${LOCAL}`]);
        expect(mem.get('beanpool_anchor_url')).toBe(LOCAL);
        expect(d.addSavedNode).toHaveBeenCalledWith(LOCAL, 'Mullumbimby', 'image', 'bean');
        expect(d.clearGuestNode).toHaveBeenCalledWith(LOCAL);
        expect(d.requestSync).toHaveBeenCalled();
    });

    it('a refused invite puts the phone back on the community it came from, and passes the node’s words on', async () => {
        const d = deps(async () => { throw new Error('This invite is for a different key.'); });
        await expect(joinAnotherCommunity({ targetUrl: LOCAL, code: 'ABCD2345', identity: me, returnUrl: GLOBAL }, d))
            .rejects.toThrow('This invite is for a different key.');
        expect(mem.get('beanpool_anchor_url')).toBe(GLOBAL);
        expect(d.calls.slice(-2)).toEqual([`close:${LOCAL}`, `init:${GLOBAL}`]);
        expect(d.addSavedNode).not.toHaveBeenCalled();
    });

    it('with no answer from the new community’s health, keeps the name it was given', async () => {
        (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); });
        const d = deps(async () => ({ success: true, alreadyMember: true, nodeHasPhoto: true }));
        expect(await joinAnotherCommunity({ targetUrl: LOCAL, code: 'X', identity: me, returnUrl: GLOBAL, knownName: 'Mullum' }, d))
            .toEqual({ url: LOCAL, name: 'Mullum', alreadyMember: true });
        expect(d.addSavedNode).toHaveBeenCalledWith(LOCAL, 'Mullum', undefined, undefined);
    });
});

// Was '"protect this community too"', which asked the member to connect a sign-in at each community they joined. Key
// vault design (custody K1, V4): the copy is kept by BeanPool's key vault for every community, and no community is
// ever asked for one, so the nudge is removed.
describe('after joining another community: no "protect this community too"', () => {
    it('says what came along and what didn’t, and never asks to protect the new community', () => {
        const n = joinedNudge('Mullumbimby');
        expect(n.title).toBe('You’re in Mullumbimby'.replace('’', "'"));
        expect(n.body).toContain('Your key and your 12 words came with you');
        expect(n.body).toContain('Your posts, chats and trades stay in each community.');
        expect(n.body).toContain('A sign-in you linked to get back into your account works here too');
        expect(n.body).not.toMatch(/protect your account in/i);
        expect(Object.keys(n).sort()).toEqual(['body', 'next', 'title']);
        expect(n.next).toBe('Next');
    });

    it('neither screen that joins another community offers a way to protect it there', () => {
        for (const file of ['../../app/(tabs)/people.tsx', '../../app/find-community.tsx']) {
            const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
            expect(src, file).not.toMatch(/PROTECT_REDIRECT|nudge\.protect|section=protection/);
            expect(src, file).toMatch(/nudge\.next/);
        }
    });
});
