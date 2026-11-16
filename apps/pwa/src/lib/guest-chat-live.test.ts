/**
 * Guests in groups, the web app's own IO (lib/guest-chat-live.ts guestIO) under core's round: TWO TABS (G2 follow-ups,
 * #3246 round 2 note: "two web tabs can delete each other's invitation through a stale page"). Two tabs of one browser
 * share its store (lib/outside-chat-store.ts, here on the in-memory IndexedDB, lib/memory-indexeddb.ts) and its mail id;
 * the tab whose fetch went out first can come back last. Its page was read before the newest one applied here, so it moves
 * nothing and confirms nothing: the invitation the other tab brought stays, and so does the mark (core GUEST_LINKS_META,
 * kept per account in this community's store). The phone's half is utils/__tests__/guest-chat-live.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { syncGuestMail, guestChatId, GUEST_LINKS_META } from '@beanpool/core';
import { MemoryIDBKeyRange, memoryIndexedDB } from './memory-indexeddb';

const server = vi.hoisted(() => ({ gets: [] as Array<{ who: string; answer: (r: Response) => void }>, confirmed: [] as string[] }));

vi.mock('./api', async (importOriginal) => {
    const real = await importOriginal<typeof import('./api')>();
    return {
        ...real,
        // My community's server, played here: each GET waits until the test answers it, so the order they come back is the test's.
        signedMailFetch: vi.fn((method: string, _community: string, path: string, body: any, id: { publicKey: string }) => {
            if (method === 'GET') return new Promise<Response>((answer) => server.gets.push({ who: id.publicKey, answer }));
            if (path === '/api/mail/group/confirm') {
                server.confirmed.push(...body.ids);
                return Promise.resolve(new Response(JSON.stringify({ confirmed: body.ids.length }), { status: 200 }));
            }
            return Promise.resolve(new Response(JSON.stringify({ error: 'no', code: 'no' }), { status: 404 }));
        }),
    };
});

import { guestIO } from './guest-chat-live';
import { outsideChatStore } from './outside-chat-store';

const person = (name: string) => {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed), callsign: name };
};
const GUS = person('Gus'), ANA = person('Ana');
const NODE = 'https://hillside.example', HOST = 'riverside.example', GROUP = 'grp-tools';
const ID = guestChatId(HOST, GROUP);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const page = (linksAt: number, items: unknown[], groups: unknown[]) => json({ items, more: false, groups, linksAt, sent: [], sentMore: false });
const invite = (id: string) => ({ id, host: HOST, group: GROUP, kind: 'invite', data: { name: 'Tools', invitedBy: { key: ANA.publicKey, name: 'Ana' } }, receivedAt: 2 });
const removal = (id: string) => ({ id, host: HOST, group: GROUP, kind: 'removed', data: { why: 'removed' }, receivedAt: 1 });
const invited = { host: HOST, group: GROUP, state: 'invited', roster: null, rosterAt: null };
/** One tab: its own IO over this browser's one store for the community. */
const tab = () => guestIO({ nodeUrl: NODE, identity: GUS, store: outsideChatStore(NODE), isBlocked: async () => false });

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.stubGlobal('IDBKeyRange', MemoryIDBKeyRange);
    server.gets.length = 0;
    server.confirmed.length = 0;
});

describe('TWO TABS on the web (G2 follow-ups): the page read first and answered last moves nothing', () => {
    it("tab B brings an invitation; tab A's older page (no such group listed, a removal from before it) leaves it, confirms nothing, keeps B's mark", async () => {
        const a = syncGuestMail(tab());
        await vi.waitFor(() => expect(server.gets.length).toBe(1));
        const b = syncGuestMail(tab());
        await vi.waitFor(() => expect(server.gets.length).toBe(2));
        // B's read came after an invitation arrived, and comes back first.
        server.gets[1].answer(page(2_000, [invite('n-new')], [invited]));
        await b;
        expect((await tab().load())[ID]?.state).toBe('invited');
        server.gets[0].answer(page(1_000, [removal('n-old')], []));
        await a;
        const chats = await tab().load();
        expect(chats[ID]?.state).toBe('invited');
        expect(chats[ID]?.inviteId).toBe('n-new');
        expect(server.confirmed).toEqual(['n-new']);
        expect(await outsideChatStore(NODE).getMeta(GUS.publicKey, GUEST_LINKS_META)).toBe('2000');
    });

    it('in the order they went out (no stale page), the older page is applied first and the newer one brings the invitation', async () => {
        const a = syncGuestMail(tab());
        await vi.waitFor(() => expect(server.gets.length).toBe(1));
        server.gets[0].answer(page(1_000, [], []));
        await a;
        const b = syncGuestMail(tab());
        await vi.waitFor(() => expect(server.gets.length).toBe(2));
        server.gets[1].answer(page(2_000, [invite('n-new')], [invited]));
        await b;
        expect((await tab().load())[ID]?.state).toBe('invited');
        expect(await outsideChatStore(NODE).getMeta(GUS.publicKey, GUEST_LINKS_META)).toBe('2000');
    });
});
