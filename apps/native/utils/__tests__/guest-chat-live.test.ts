/**
 * Guests in groups, the phone's own IO (utils/guest-chat-live.ts guestIO) under core's round: the TWO TABS rule (G2
 * follow-ups) on the phone's store. The phone runs one round at a time, so it has no second tab; the rule is core's and the
 * same here: a page read before the newest one this phone applied moves nothing and confirms nothing. What is the phone's
 * own is where the mark lives: core's GUEST_LINKS_META in the community's file beside the chats (utils/outside-chat-store.ts
 * meta, on real SQL here: node:sqlite), one for each account, so one account's newest page never makes another's stale. The
 * web's half is apps/pwa/src/lib/guest-chat-live.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const server = vi.hoisted(() => ({ pages: new Map<string, unknown[]>(), confirmed: [] as Array<{ who: string; ids: string[] }> }));

vi.mock('react-native', () => ({ DeviceEventEmitter: { emit: vi.fn() } }));
vi.mock('../outside-chat-live', () => ({ outsideContext: vi.fn(async () => null) }));
vi.mock('../node-profile', () => ({ fetchNodeProfile: vi.fn(), getCachedNodeProfile: vi.fn(), groupGuestsOn: () => true }));
vi.mock('../member-statements', async () => {
    const core = await import('@beanpool/core');
    return { signRelayEnvelopeStatement: (f: any, k: string) => core.signRelayEnvelope(f, core.ed25519Signer(Uint8Array.from(Buffer.from(k, 'hex')))) };
});
// My community's server, played here: each account's next page, in the order the test lines them up.
vi.mock('../node-post', () => ({
    signedGet: vi.fn(async (_url: string, _path: string, id: { publicKey: string }) => {
        const page = server.pages.get(id.publicKey)?.shift() ?? { items: [], more: false, groups: [], sent: [], sentMore: false };
        return new Response(JSON.stringify(page), { status: 200 });
    }),
    signedPost: vi.fn(async (_url: string, path: string, body: any, id: { publicKey: string }) => {
        if (path === '/api/mail/group/confirm') server.confirmed.push({ who: id.publicKey, ids: body.ids });
        return new Response(JSON.stringify({ confirmed: body.ids?.length ?? 0 }), { status: 200 });
    }),
}));

import { syncGuestMail, guestChatId, GUEST_LINKS_META } from '@beanpool/core';
import { guestIO } from '../guest-chat-live';
import { outsideChatStore, OUTSIDE_CHAT_TABLES_SQL } from '../outside-chat-store';

const person = (name: string) => {
    const seed = randomBytes(32);
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed), callsign: name };
};
const GUS = person('Gus'), GIA = person('Gia'), ANA = person('Ana');
const NODE = 'https://hillside.example', HOST = 'riverside.example', GROUP = 'grp-tools';
const ID = guestChatId(HOST, GROUP);
const page = (linksAt: number, items: unknown[], groups: unknown[]) => ({ items, more: false, groups, linksAt, sent: [], sentMore: false });
const invite = (id: string) => ({ id, host: HOST, group: GROUP, kind: 'invite', data: { name: 'Tools', invitedBy: { key: ANA.publicKey, name: 'Ana' } }, receivedAt: 2 });
const removal = (id: string) => ({ id, host: HOST, group: GROUP, kind: 'removed', data: { why: 'removed' }, receivedAt: 1 });
const invited = { host: HOST, group: GROUP, state: 'invited', roster: null, rosterAt: null };

/** The community's file on this phone (the SQL the phone runs, on node:sqlite), and an account's IO over it. */
function phone() {
    const sql = new DatabaseSync(':memory:');
    sql.exec(OUTSIDE_CHAT_TABLES_SQL);
    const db = {
        getAllAsync: async (q: string, p: any[] = []) => sql.prepare(q).all(...p) as any[],
        getFirstAsync: async (q: string, p: any[] = []) => (sql.prepare(q).get(...p) as any) ?? null,
        runAsync: async (q: string, p: any[] = []) => sql.prepare(q).run(...p),
    };
    const store = outsideChatStore(async () => db as any);
    return { store, io: (who: typeof GUS) => guestIO({ nodeUrl: NODE, identity: who, store, isBlocked: async () => false }) };
}

beforeEach(() => {
    server.pages.clear();
    server.confirmed.length = 0;
});

describe('TWO TABS on the phone (G2 follow-ups): the mark is kept per account in the community file', () => {
    it("a page older than the newest this account applied moves nothing; another account's newest page makes none of this one's stale", async () => {
        const { store, io } = phone();
        server.pages.set(GUS.publicKey, [page(2_000, [invite('n-gus')], [invited]), page(1_000, [removal('n-old')], [])]);
        server.pages.set(GIA.publicKey, [page(1_500, [invite('n-gia')], [invited])]);
        await syncGuestMail(io(GUS));
        await syncGuestMail(io(GUS));
        await syncGuestMail(io(GIA));
        expect((await io(GUS).load())[ID]?.state).toBe('invited');
        expect((await io(GUS).load())[ID]?.inviteId).toBe('n-gus');
        expect((await io(GIA).load())[ID]?.state).toBe('invited');
        expect(server.confirmed).toEqual([{ who: GUS.publicKey, ids: ['n-gus'] }, { who: GIA.publicKey, ids: ['n-gia'] }]);
        // Each account's own mark, under its own key in the file (the IO's getMeta names the account).
        expect(await store.getMeta(`${GUEST_LINKS_META}:${GUS.publicKey}`)).toBe('2000');
        expect(await store.getMeta(`${GUEST_LINKS_META}:${GIA.publicKey}`)).toBe('1500');
    });
});
