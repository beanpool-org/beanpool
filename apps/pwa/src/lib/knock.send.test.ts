/**
 * Front doors S2: the web app's own "Ask to join". The knock is the phone's (apps/native/utils/knock.ts sendKnock): a signed
 * POST to the community's own address, its body naming no key (`fromNode`, never `from`) and the community it is for
 * (`toNode`), and the community's refusals carried in its own words. Fails before S2: lib/knock.ts had no sendKnock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@beanpool/core';
import * as knockLib from './knock';
import type { BeanPoolIdentity } from './identity';

const PUB = 'a'.repeat(64);
const IDENTITY: BeanPoolIdentity = { publicKey: PUB, privateKey: '00'.repeat(32), callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' } as BeanPoolIdentity;
const REQ = { callsign: 'Ana', message: '  I grow tomatoes by the river.  ' };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('sendKnock: a signed POST to the community it asks', () => {
    beforeEach(() => { localStorage.clear(); localStorage.setItem('bp_node_url', 'https://global.example.org'); });
    afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

    it('goes to that community\'s own knock path, signed for its host, with the phone\'s body', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(201, { knock: { status: 'pending' } }));
        const r = await knockLib.sendKnock('https://riverside.example.org/some/path', IDENTITY, REQ);
        expect(r).toEqual({ kind: 'waiting', message: t(knockLib.KNOCK_MESSAGES.waiting) });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://riverside.example.org/api/join/knock');
        expect(init?.method).toBe('POST');
        const headers = init?.headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['X-Public-Key']).toBe(PUB);
        expect(headers['X-Signature']).toMatch(/\S/);
        expect(headers['X-Signed-For']).toBe('riverside.example.org');
        const body = JSON.parse(String(init?.body));
        // No key in the body (the signer is the applicant), `fromNode` (this web app's community), never `from`.
        expect(body).toEqual({ message: 'I grow tomatoes by the river.', callsign: 'Ana', fromNode: 'global.example.org', toNode: 'riverside.example.org' });
        expect(body).not.toHaveProperty('from');
        expect(body).not.toHaveProperty('pubkey');
    });

    it('a web app served same-origin says its own host, never a fixed name of ours', () => {
        localStorage.removeItem('bp_node_url');
        expect(knockLib.knockFromNode()).toBe(window.location.host.toLowerCase() || undefined);
        localStorage.setItem('bp_node_url', 'https://my-own-node.example.net:8443/');
        expect(knockLib.knockFromNode()).toBe('my-own-node.example.net:8443');
    });

    it('an open request already there, or a yes already given, reads as asked', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(json(409, { error: 'You’ve already asked to join. There’s no answer yet.', code: 'knock_open' }))
            .mockResolvedValueOnce(json(409, { error: 'A member has already invited you.', code: 'knock_approved' }));
        expect(await knockLib.sendKnock('https://riverside.example.org', IDENTITY, REQ))
            .toEqual({ kind: 'waiting', message: 'You’ve already asked to join. There’s no answer yet.' });
        expect(await knockLib.sendKnock('https://riverside.example.org', IDENTITY, REQ)).toEqual({ kind: 'invited' });
    });

    it('a member there already is told so, in the community\'s words', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(409, { error: 'You are already a member of this community.', code: 'already_member' }));
        expect(await knockLib.sendKnock('https://riverside.example.org', IDENTITY, REQ))
            .toEqual({ kind: 'member', message: 'You are already a member of this community.' });
    });

    it('a refusal is the community\'s own words, as it sent them, with its status and code', async () => {
        const words = 'Too many requests to join have come from this network today (5). Please try again tomorrow.';
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(json(429, { error: words, code: 'rate_limited' }))
            .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
        expect(await knockLib.sendKnock('https://riverside.example.org', IDENTITY, REQ))
            .toEqual({ kind: 'refused', status: 429, code: 'rate_limited', message: words });
        expect(await knockLib.sendKnock('https://riverside.example.org', IDENTITY, REQ))
            .toEqual({ kind: 'refused', status: 502, code: null, message: t(knockLib.KNOCK_MESSAGES.unreadable) });
    });

    it('a community it can\'t reach, and one with no usable address (nothing sent)', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
        expect(await knockLib.sendKnock('https://riverside.example.org', IDENTITY, REQ))
            .toEqual({ kind: 'unreachable', message: t(knockLib.KNOCK_MESSAGES.unreachable) });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        for (const bad of [null, 'http://riverside.example.org', 'https://global.beanpool.org', 'https://10.0.0.1']) {
            expect(await knockLib.sendKnock(bad, IDENTITY, REQ)).toEqual({ kind: 'no_address', message: t(knockLib.KNOCK_MESSAGES.noAddress) });
        }
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});

describe('the form holds the member to the node\'s limits, as the phone does', () => {
    it('a name of 2 to 20 characters and a message of 1 to 280', () => {
        expect(knockLib.knockFormProblem({ callsign: 'A', message: 'hi' })).toBe('Please give a name of at least 2 characters.');
        expect(knockLib.knockFormProblem({ callsign: 'x'.repeat(21), message: 'hi' })).toBe('Please keep your name to 20 characters.');
        expect(knockLib.knockFormProblem({ callsign: 'Ana', message: '   ' })).toBe('Please say a few words about yourself.');
        expect(knockLib.knockFormProblem({ callsign: 'Ana', message: 'x'.repeat(281) })).toBe('Please keep your message to 280 characters.');
        expect(knockLib.knockFormProblem({ callsign: '  Ana  ', message: 'x'.repeat(280) })).toBeNull();
    });

    it('an avatar only as the node takes it', () => {
        expect(knockLib.knockAvatar('bundled://bean_green')).toBe('bundled://bean_green');
        expect(knockLib.knockAvatar('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
        expect(knockLib.knockAvatar('https://elsewhere.example/me.png')).toBeUndefined();
        expect(knockLib.knockAvatar(null)).toBeUndefined();
    });
});
