/**
 * The app names its version on every request to its own community (`X-BeanPool-App: <version> <platform>`), from the
 * fetch wrapper (utils/node-request-signing.ts), so the community can count who runs what before it raises its floor
 * (apps/server/src/app-version-counts.ts). Never to another host, never over a header the caller set, and nothing at all
 * when the wrapper was installed without a value (the web build).
 *
 * Nothing here contacts a node.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
const who = vi.hoisted(() => ({ identity: null as null | { publicKey: string; privateKey: string; callsign: string } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => who.identity) }));

import { ed25519 } from '@noble/curves/ed25519.js';
import { installNodeRequestSigning } from '../node-request-signing';
import { APP_VERSION_HEADER } from '../force-update';
import type { BeanPoolIdentity } from '../identity';

const SEED = new Uint8Array(32).fill(7);
const PUB = Buffer.from(ed25519.getPublicKey(SEED)).toString('hex');
const identity = { publicKey: PUB, privateKey: Buffer.from(SEED).toString('hex'), callsign: 'Kim', createdAt: '' } as BeanPoolIdentity;

const underlying = vi.fn(async (_input: unknown, _init?: RequestInit) => ({ ok: true, status: 200 } as unknown as Response));
(globalThis as any).fetch = underlying;
installNodeRequestSigning({ appVersionHeader: '1.2.57 android' });

const sentHeaders = (i: number) => (underlying.mock.calls[i][1]?.headers ?? {}) as Record<string, string>;

beforeEach(() => {
    underlying.mockClear();
    mem.clear();
    mem.set('beanpool_anchor_url', 'https://mullum.test');
    who.identity = identity;
});

describe('X-BeanPool-App on requests to the phone\'s own community', () => {
    it('a GET (the health ping) carries it, beside the signature', async () => {
        await fetch('https://mullum.test/api/community/health');
        const h = sentHeaders(0);
        expect(h[APP_VERSION_HEADER]).toBe('1.2.57 android');
        expect(h['X-Public-Key']).toBe(PUB);
    });

    it('a write carries it too, keeping the headers it was given', async () => {
        await fetch('https://mullum.test/api/ledger/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': 's' }, body: '{}' });
        const h = sentHeaders(0);
        expect(h[APP_VERSION_HEADER]).toBe('1.2.57 android');
        expect(h['Content-Type']).toBe('application/json');
        expect(h['X-Signature']).toBe('s');
    });

    it('without an account on the phone, it still says which app it is', async () => {
        who.identity = null;
        await fetch('https://mullum.test/api/community/health');
        expect(sentHeaders(0)[APP_VERSION_HEADER]).toBe('1.2.57 android');
    });

    it('never to another host', async () => {
        await fetch('https://bellingen.test/api/community/health');
        await fetch('https://mullum.test.evil.example/api/community/health');
        await fetch('https://itunes.apple.com/lookup?bundleId=x');
        for (let i = 0; i < 3; i++) expect(sentHeaders(i)[APP_VERSION_HEADER]).toBeUndefined();
    });

    it('never over one the caller set, and never into a Headers object or a Request it would replace', async () => {
        await fetch('https://mullum.test/api/x', { headers: { 'x-beanpool-app': '9.9.9 ios' } });
        expect(sentHeaders(0)['x-beanpool-app']).toBe('9.9.9 ios');
        expect(sentHeaders(0)[APP_VERSION_HEADER]).toBeUndefined();

        const own = new Headers({ 'X-Own': '1' });
        await fetch('https://mullum.test/api/x', { method: 'POST', headers: own, body: '{}' });
        expect(underlying.mock.calls[1][1]?.headers).toBe(own);
    });

    it('no community on the phone: nothing added', async () => {
        mem.clear();
        await fetch('https://mullum.test/api/community/health');
        expect(sentHeaders(0)[APP_VERSION_HEADER]).toBeUndefined();
    });
});
