import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    cancelKnock, cancelledKnocks, cardKnockLines, communityOrigin, forgetKnock, KNOCK_CANCEL_BLOCK_HOURS, KNOCK_MESSAGES,
    readKnockStatus, readStatus, rememberKnock, rememberedKnocks, type RememberedKnock,
} from './knock';
import * as knockLib from './knock';
import type { BeanPoolIdentity } from './identity';
import { formatDate, KNOCK_ANSWERABLE_DAYS, t } from '@beanpool/core';

const PUB = 'a'.repeat(64);
const PRIV = '00'.repeat(32);
const IDENTITY: BeanPoolIdentity = { publicKey: PUB, privateKey: PRIV, callsign: 'Test', createdAt: '2026-01-01T00:00:00.000Z' } as BeanPoolIdentity;

describe('communityOrigin on web', () => {
    it('accepts valid https host origins and public IPv4', () => {
        expect(communityOrigin('https://byron.example.org')).toBe('https://byron.example.org');
        expect(communityOrigin('https://byron.example.org/some/path?x=1')).toBe('https://byron.example.org');
        expect(communityOrigin('https://203.0.113.5')).toBe('https://203.0.113.5');
    });

    it('rejects invalid or global node URLs', () => {
        expect(communityOrigin('http://byron.example.org')).toBeNull();
        expect(communityOrigin('https://global.beanpool.org')).toBeNull();
        expect(communityOrigin('https://localhost')).toBeNull();
        expect(communityOrigin('https://10.0.0.1')).toBeNull();
    });
});

describe('readStatus', () => {
    it('parses status payloads correctly', () => {
        expect(readStatus({ status: 'none' })).toEqual({ status: 'none' });
        expect(readStatus({ status: 'pending' })).toEqual({ status: 'pending' });
        expect(readStatus({ status: 'approved', invite: 'bp:inv:123' })).toEqual({ status: 'approved', invite: 'bp:inv:123', expiresAt: null });
        expect(readStatus({ status: 'declined' })).toEqual({ status: 'pending' }); // silence: a no is never a message
    });
});

describe('rememberedKnocks & storage on web', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('remembers knocks, orders by newest first, and forgets on request', async () => {
        await rememberKnock(PUB, { url: 'https://a.example.org', name: 'Alpha', key: 'a' }, new Date('2026-10-01T00:00:00Z'));
        await rememberKnock(PUB, { url: 'https://b.example.org', name: 'Beta', key: 'b' }, new Date('2026-10-02T00:00:00Z'));

        const list = await rememberedKnocks(PUB, Date.parse('2026-10-03T00:00:00Z'));
        expect(list.map(k => k.url)).toEqual(['https://b.example.org', 'https://a.example.org']);

        await forgetKnock(PUB, 'https://a.example.org');
        const updated = await rememberedKnocks(PUB, Date.parse('2026-10-03T00:00:00Z'));
        expect(updated.map(k => k.url)).toEqual(['https://b.example.org']);
    });

    it('filters out knocks older than 61 days', async () => {
        const now = Date.parse('2026-10-15T00:00:00Z');
        const old = new Date(now - 62 * 86_400_000);
        await rememberKnock(PUB, { url: 'https://old.example.org', name: 'Old' }, old);

        const list = await rememberedKnocks(PUB, now);
        expect(list).toHaveLength(0);
    });

    // PR #2573, decided 29 Oct 2026: one 61-day horizon, core's; the web file defines no copy of it.
    it('forgets by core\'s horizon, which this file does not define again', async () => {
        expect(knockLib).not.toHaveProperty('KNOCK_ANSWERABLE_DAYS');
        expect(KNOCK_ANSWERABLE_DAYS).toBe(61);
        const sent = new Date('2026-09-01T00:00:00Z');
        await rememberKnock(PUB, { url: 'https://a.example.org', name: 'Alpha' }, sent);
        expect((await rememberedKnocks(PUB, sent.getTime() + (KNOCK_ANSWERABLE_DAYS - 1) * 86_400_000)).map(k => k.url)).toEqual(['https://a.example.org']);
        expect(await rememberedKnocks(PUB, sent.getTime() + KNOCK_ANSWERABLE_DAYS * 86_400_000)).toEqual([]);
    });

    it('says what a request nothing holds, and a cancelled one, mean, in the words the phone uses', () => {
        expect(KNOCK_MESSAGES.none).toBe('This request is no longer open. You can ask again.');
        expect(KNOCK_MESSAGES.cancelled).toBe('You cancelled your request. You can ask again after 24 hours.');
    });

    it('cancels a knock and records cancelledAt', async () => {
        await rememberKnock(PUB, { url: 'https://c.example.org', name: 'CancelMe' }, new Date('2026-10-10T00:00:00Z'));

        // Mock fetch for /api/join/knock/cancel
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        const res = await cancelKnock('https://c.example.org', IDENTITY, new Date('2026-10-11T00:00:00Z'));
        expect(res.ok).toBe(true);

        const list = await rememberedKnocks(PUB, Date.parse('2026-10-12T00:00:00Z'));
        expect(list).toHaveLength(0); // cancelled knocks are excluded from active rememberedKnocks

        const recent = await cancelledKnocks(PUB, Date.parse('2026-10-11T05:00:00Z'));
        expect(recent['https://c.example.org']).toBeDefined();

        fetchSpy.mockRestore();
    });

    it('never reports false success when cancel fails', async () => {
        await rememberKnock(PUB, { url: 'https://f.example.org', name: 'Fail' }, new Date('2026-10-10T00:00:00Z'));

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Already closed' }), { status: 404 }));

        const res = await cancelKnock('https://f.example.org', IDENTITY, new Date('2026-10-11T00:00:00Z'));
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.message).toBe('Already closed');
        }

        // Still remembered since it did not succeed
        const list = await rememberedKnocks(PUB, Date.parse('2026-10-11T00:00:00Z'));
        expect(list).toHaveLength(1);

        fetchSpy.mockRestore();
    });

    it('a cancel the community refuses carries its status and code, so the card can tell "nothing open" from a failure', async () => {
        await rememberKnock(PUB, { url: 'https://n.example.org', name: 'Nothing open' }, new Date('2026-10-10T00:00:00Z'));

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ error: 'No open request from you.', code: 'not_found' }), { status: 404 }));

        const res = await cancelKnock('https://n.example.org', IDENTITY, new Date('2026-10-11T00:00:00Z'));
        expect(res).toEqual({ ok: false, message: 'No open request from you.', status: 404, code: 'not_found' });

        // A network failure has no status or code: it is not "nothing open".
        fetchSpy.mockRejectedValueOnce(new Error('offline'));
        const offline = await cancelKnock('https://n.example.org', IDENTITY, new Date('2026-10-11T00:00:00Z'));
        expect(offline.ok).toBe(false);
        expect(offline).not.toHaveProperty('status');
        expect(offline).not.toHaveProperty('code');

        fetchSpy.mockRestore();
    });

    it('formats cardKnockLines for approved and pending knocks', () => {
        const knocks: RememberedKnock[] = [
            { url: 'https://approved.example.org', name: 'Approved Town', key: 'approved', sentAt: '2026-10-10T00:00:00Z' },
            { url: 'https://pending.example.org', name: 'Pending Town', key: 'pending', sentAt: '2026-10-10T00:00:00Z' },
            { url: 'https://offline.example.org', name: 'Offline Town', key: 'offline', sentAt: '2026-10-10T00:00:00Z' },
        ];
        const lines = cardKnockLines(knocks, {
            'https://approved.example.org': { ok: true, value: { status: 'approved', invite: 'bp:123', expiresAt: null } },
            'https://pending.example.org': { ok: true, value: { status: 'pending' } },
            'https://offline.example.org': { ok: false, kind: 'unreachable', message: 'network error' },
        });

        expect(lines).toHaveLength(2);
        expect(lines[0]).toEqual({
            url: 'https://approved.example.org',
            text: 'Approved Town said yes. Join now.',
            invited: true,
        });
        expect(lines[1]).toEqual({
            url: 'https://pending.example.org',
            text: 'Waiting for Pending Town: usually a few days.',
            invited: false,
        });
    });
});

// PR #2573 round 3: the signing moved from this file to lib/api.ts (signing-source-rule.test.ts). The status read and the
// cancel must still leave signed for the community they name, and for that host only.
describe('the status read and the cancel are signed for the community they name', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('a status read is a signed GET to that community\'s status path', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending' }), { status: 200 }));

        const res = await readKnockStatus('https://s.example.org/some/path', IDENTITY);
        expect(res).toEqual({ ok: true, value: { status: 'pending' } });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://s.example.org/api/join/knock/status');
        expect(init?.method).toBe('GET');
        expect(init?.body).toBeUndefined();
        const headers = init?.headers as Record<string, string>;
        expect(headers['X-Public-Key']).toBe(PUB);
        expect(headers['X-Signature']).toMatch(/\S/);
        expect(headers['X-Timestamp']).toMatch(/^\d+$/);
        expect(headers['X-Nonce']).toMatch(/\S/);
        expect(headers['X-Signed-For']).toBe('s.example.org');
    });

    it('a cancel is a signed POST of {} to that community\'s cancel path', async () => {
        await rememberKnock(PUB, { url: 'https://c.example.org', name: 'CancelMe' }, new Date('2026-10-10T00:00:00Z'));
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        expect((await cancelKnock('https://c.example.org', IDENTITY, new Date('2026-10-11T00:00:00Z'))).ok).toBe(true);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://c.example.org/api/join/knock/cancel');
        expect(init?.method).toBe('POST');
        expect(init?.body).toBe('{}');
        const headers = init?.headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['X-Public-Key']).toBe(PUB);
        expect(headers['X-Signature']).toMatch(/\S/);
        expect(headers['X-Signed-For']).toBe('c.example.org');
    });

    it('sends nothing for a community with no usable address', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        expect(await readKnockStatus(null, IDENTITY)).toMatchObject({ ok: false, kind: 'no_address' });
        expect(await cancelKnock('http://insecure.example.org', IDENTITY)).toMatchObject({ ok: false });
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
