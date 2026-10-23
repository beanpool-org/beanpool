/**
 * The phone's language on every request to its own community (Marty's call M6; translation design §3), from the fetch
 * wrapper (utils/node-request-signing.ts): the helpers that sign a request themselves (the names list, a knock, the
 * member area) and a screen's own fetch get it too, so the community's refusal comes back in the member's language.
 * Following a switch at once, never the pseudo-locale, never to another host, never over a header the caller set; in a
 * build without an app version (the web build) as well.
 *
 * Nothing here contacts a node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) };
});
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
    },
}));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));

import { setLanguage } from '@beanpool/core';
import { installNodeRequestSigning } from '../node-request-signing';

const underlying = vi.fn(async (_input: unknown, _init?: RequestInit) => ({ ok: true, status: 200 } as unknown as Response));
(globalThis as any).fetch = underlying;
// No app version: the web build's wrapper, which still names the language.
installNodeRequestSigning();

const sentHeaders = (i: number) => (underlying.mock.calls[i][1]?.headers ?? {}) as Record<string, string>;

beforeEach(() => {
    underlying.mockClear();
    mem.clear();
    mem.set('beanpool_anchor_url', 'https://mullum.test');
});
afterEach(() => setLanguage('en'));

describe("X-Language on every request to the phone's own community", () => {
    it('a read and a write a helper signed itself carry it, beside the headers they were given', async () => {
        setLanguage('pt');
        await fetch('https://mullum.test/api/names/list');
        await fetch('https://mullum.test/api/knocks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': 's' }, body: '{}' });
        expect(sentHeaders(0)['X-Language']).toBe('pt');
        expect(sentHeaders(1)).toEqual({ 'Content-Type': 'application/json', 'X-Signature': 's', 'X-Language': 'pt' });
    });

    it('follows a switch at once, and never sends the pseudo-locale', async () => {
        setLanguage('ru');
        await fetch('https://mullum.test/api/x');
        setLanguage('xx');
        await fetch('https://mullum.test/api/x');
        expect(sentHeaders(0)['X-Language']).toBe('ru');
        expect(sentHeaders(1)['X-Language']).toBe('en');
    });

    it('never to another host, and nothing with no community on the phone', async () => {
        setLanguage('fr');
        await fetch('https://bellingen.test/api/x');
        await fetch('https://mullum.test.evil.example/api/x');
        await fetch('https://itunes.apple.com/lookup?bundleId=x');
        mem.clear();
        await fetch('https://mullum.test/api/x');
        for (let i = 0; i < 4; i++) expect(sentHeaders(i)['X-Language']).toBeUndefined();
    });

    it('never over one the caller set, and never into a Headers object it would replace', async () => {
        setLanguage('fr');
        await fetch('https://mullum.test/api/x', { headers: { 'x-language': 'es' } });
        expect(sentHeaders(0)).toEqual({ 'x-language': 'es' });
        const own = new Headers({ 'X-Own': '1' });
        await fetch('https://mullum.test/api/x', { method: 'POST', headers: own, body: '{}' });
        expect(underlying.mock.calls[1][1]?.headers).toBe(own);
    });
});
