/**
 * When the phone signs a re-key's succession statement (utils/key-succession.ts; line-display design §5, §6, §8):
 *
 * - right after its own re-key, only when the node lists exactly one re-key to this brand-new key: a node listing more
 *   is asking it to sign for keys the member never saw (it would then serve whichever chain it liked), so it signs none
 *   and each is asked about at sign-in;
 * - the sign-in prompt waits for a re-key this run just completed, so a member is never asked about the one they just did;
 * - "Yes, that was me" signs the one date the prompt showed;
 * - "Not me" offers only a well-formed contact the owner published.
 *
 * The node is a stand-in here (signedGet/signedPost mocked); the statements are core's real ones, checked as the node
 * checks them. group-chat-key-succession.test.ts runs the same functions against a real node.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { verifyKeySuccession } from '@beanpool/core';

const node = vi.hoisted(() => ({
    rows: [] as { pubkey: string; at: string; attested: boolean }[],
    posts: [] as { oldPubkey: string; at: string; sig: string }[],
    postDelayMs: 0,
}));
vi.mock('../node-post', () => ({
    signedGet: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ rekeyedFrom: node.rows.map((r) => ({ ...r })) }) })),
    signedPost: vi.fn(async (_url: string, _path: string, body: { oldPubkey: string; at: string; sig: string }) => {
        if (node.postDelayMs) await new Promise((r) => setTimeout(r, node.postDelayMs));
        node.posts.push(body);
        const row = node.rows.find((r) => r.pubkey === body.oldPubkey);
        if (!row) return { ok: false, status: 404 };
        if (row.attested) return { ok: false, status: 409 };
        row.attested = true;
        return { ok: true, status: 201 };
    }),
}));

import { attestJustCompletedRekey, attestOwnRekeys, operatorContact, rekeyToAsk, unattestedRekeys } from '../key-succession';

const person = () => { const seed = randomBytes(32); return { privateKey: bytesToHex(seed), publicKey: bytesToHex(ed25519.getPublicKey(seed)) }; };
const URL_BASE = 'https://node.test';

describe('when the phone signs for an old key', () => {
    beforeEach(() => { node.rows = []; node.posts = []; node.postDelayMs = 0; });

    it('right after its own re-key: signs the one re-key the node lists, with a statement the node accepts', async () => {
        const me = person();
        const old = person();
        node.rows = [{ pubkey: old.publicKey, at: '2026-10-03T04:00:00.000Z', attested: false }];
        expect(await attestJustCompletedRekey(URL_BASE, me as any)).toBe(1);
        expect(node.posts).toHaveLength(1);
        expect(verifyKeySuccession({ pubkey: node.posts[0].oldPubkey, at: node.posts[0].at, sig: node.posts[0].sig }, me.publicKey)).toBe(true);
    });

    it('right after its own re-key: a node listing two old keys for a brand-new key gets no statement at all', async () => {
        const me = person();
        node.rows = [
            { pubkey: person().publicKey, at: '2026-10-03T04:00:00.000Z', attested: false },
            { pubkey: person().publicKey, at: '2026-10-01T04:00:00.000Z', attested: false },
        ];
        expect(await attestJustCompletedRekey(URL_BASE, me as any)).toBe(0);
        expect(node.posts).toHaveLength(0);
        expect(await unattestedRekeys(URL_BASE, me as any)).toHaveLength(2);
    });

    it('the sign-in prompt waits for the re-key this run just completed, and has nothing to ask after it', async () => {
        const me = person();
        node.rows = [{ pubkey: person().publicKey, at: '2026-10-03T04:00:00.000Z', attested: false }];
        node.postDelayMs = 50;
        const completing = attestJustCompletedRekey(URL_BASE, me as any);
        expect(await rekeyToAsk(URL_BASE, me as any)).toBeNull();
        expect(await completing).toBe(1);
    });

    it('"Yes, that was me" signs only the date the prompt showed; the next sign-in asks about the next', async () => {
        const me = person();
        const newer = { pubkey: person().publicKey, at: '2026-10-03T04:00:00.000Z', attested: false };
        const older = { pubkey: person().publicKey, at: '2026-10-01T04:00:00.000Z', attested: false };
        node.rows = [newer, older];
        const ask = await rekeyToAsk(URL_BASE, me as any);
        expect(ask?.pubkey).toBe(newer.pubkey);
        expect(await attestOwnRekeys(URL_BASE, me as any, [ask!])).toBe(1);
        expect(node.posts.map((p) => p.oldPubkey)).toEqual([newer.pubkey]);
        expect((await rekeyToAsk(URL_BASE, me as any))?.pubkey).toBe(older.pubkey);
    });

    it('"Not me" offers only a contact that is a plain address or number', async () => {
        const answer = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })));
        answer({ contactEmail: 'admins@mullum.example', contactPhone: '+61 2 5550 1234' });
        expect(await operatorContact(URL_BASE)).toEqual({ email: 'admins@mullum.example', phone: '+61 2 5550 1234' });
        answer({ contactEmail: 'admins@mullum.example?body=send%20your%20words', contactPhone: 'tel:123;x' });
        expect(await operatorContact(URL_BASE)).toEqual({ email: null, phone: null });
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        expect(await operatorContact(URL_BASE)).toEqual({ email: null, phone: null });
        vi.unstubAllGlobals();
    });
});
