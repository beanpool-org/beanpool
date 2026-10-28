import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    cancelKnock, cancelledKnocks, communityOrigin, forgetKnock, KNOCK_CANCEL_BLOCK_HOURS, KNOCK_MESSAGES,
    readKnockStatus, readStatus, rememberKnock, rememberedKnocks, type RememberedKnock,
} from './knock';
import type { BeanPoolIdentity } from './identity';
import { formatDate, t } from '@beanpool/core';

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
});
