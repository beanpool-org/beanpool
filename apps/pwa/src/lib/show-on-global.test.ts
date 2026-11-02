/**
 * The browser's half of "Also show this on the global community" (slice G3): the pairs in IndexedDB, what a request carries,
 * the id a phone on the same account works out too, how often a tend runs, and who is asked what. The cases of the copy itself run
 * in Chromium against real nodes (e2e/global-tick-check.mjs) and in core (src/__tests__/show-on-global.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519Signer, makeCopyKeeper, toEd25519Pkcs8, type CopyPair } from '@beanpool/core';
import { copyIdFor, setNodeApiUrl, signedCopyFetch } from './api';
import { clearCopyPairs, copyPairs } from './copy-pairs';
import { memoryIndexedDB } from './memory-indexeddb';
import { askGlobalStanding, forgetGlobalStanding, readGlobalStanding, tendCopiesSoon } from './show-on-global';
import { communityInfoOnce } from './visitor-lobby-gate';
import type { BeanPoolIdentity } from './identity';

vi.mock('./visitor-lobby-gate', async () => ({ ...(await vi.importActual('./visitor-lobby-gate')), communityInfoOnce: vi.fn() }));

const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const me: BeanPoolIdentity = {
    publicKey: 'ab'.repeat(32), privateKey: hex(toEd25519Pkcs8(bytes(7))), callsign: 'River', createdAt: new Date().toISOString(),
} as BeanPoolIdentity;
const pair = (copyId: string, extra: Partial<CopyPair> = {}): CopyPair => ({ publicKey: me.publicKey, home: 'https://home.test', homeId: `home-${copyId}`, copyId, sent: '', sentAt: 0, photo: '', skips: [], ...extra });
const fetchMock = vi.fn();

beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    localStorage.clear();
    setNodeApiUrl?.('');
    vi.mocked(communityInfoOnce).mockResolvedValue({ profile: 'local', globalCommunityUrl: 'https://global.test', addresses: [] } as never);
    await clearCopyPairs().catch(() => {});
});

describe('the pairs in this browser', () => {
    it('keep what a change wrote, as a change makes it', async () => {
        await copyPairs.change((pairs) => [...pairs, pair('a')]);
        await copyPairs.change((pairs) => [...pairs, pair('b')]);
        expect((await copyPairs.read()).map((p) => p.copyId)).toEqual(['a', 'b']);
    });

    it('a change is one transaction: what it read is what it writes over', async () => {
        // This stand-in can't interleave two tabs, so what makes that safe is held here: the race itself runs in Chromium
        // (e2e/global-tick-check.mjs, "twenty changes at once").
        const real = indexedDB.open.bind(indexedDB);
        const modes: string[] = [];
        vi.stubGlobal('indexedDB', {
            ...indexedDB,
            open: (...args: Parameters<typeof real>) => {
                const req = real(...args);
                const success = Object.getOwnPropertyDescriptor(req, 'onsuccess');
                let handler: ((ev: unknown) => void) | null = success?.value ?? null;
                Object.defineProperty(req, 'onsuccess', {
                    get: () => handler,
                    set: (next) => {
                        handler = (ev) => {
                            const open = req.result.transaction.bind(req.result);
                            req.result.transaction = (store: string, mode?: IDBTransactionMode) => { modes.push(mode ?? 'readonly'); return open(store, mode); };
                            next(ev);
                        };
                    },
                });
                return req;
            },
        });
        vi.resetModules();
        const fresh = await import('./copy-pairs');
        await fresh.copyPairs.change((pairs) => [...pairs, pair('a')]);
        expect(modes).toEqual(['readwrite']);
    });

    it('sign-out leaves none', async () => {
        await copyPairs.change(() => [pair('a')]);
        await clearCopyPairs();
        expect(await copyPairs.read()).toEqual([]);
    });

    it('are what the shared code runs on', async () => {
        const keeper = makeCopyKeeper<BeanPoolIdentity>({
            store: copyPairs, deps: {} as never, copyId: copyIdFor, plainOrigin: (u) => u, isEventEnded: () => false,
        });
        await copyPairs.change(() => [pair('a', { homeId: 'h' })]);
        expect((await keeper.pairOf('h', me.publicKey))?.copyId).toBe('a');
    });
});

describe('the id of a copy', () => {
    it('is the one a phone holding the raw seed works out', async () => {
        // core's __tests__/show-on-global.test.ts pins the same id for the same seed, and apps/native's for its own signer.
        expect(await copyIdFor('home-1', 0, me)).toBe('3b4f24a2-7451-40ce-aeab-2a2317ba5be9');
        expect(ed25519Signer(bytes(7))).toBeTypeOf('function');
    });
});

describe('what a request carries', () => {
    it('the signature, a JSON type and nothing of the member: no cookie, no Referer, no language', async () => {
        fetchMock.mockResolvedValue(new Response('{}'));
        await signedCopyFetch('POST', 'https://global.test', '/api/marketplace/posts', { a: 1 }, me);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://global.test/api/marketplace/posts');
        expect(Object.keys(init.headers).map((h) => h.toLowerCase()).sort()).toEqual(['accept-language', 'content-type', 'x-nonce', 'x-public-key', 'x-signature', 'x-signed-for', 'x-timestamp']);
        expect(init.headers['Accept-Language']).toBe('en');
        expect(init.credentials).toBe('omit');
        expect(init.referrerPolicy).toBe('no-referrer');
        expect(init.cache).toBe('no-store');
    });

    it('is signed for global, not for the community it was sent from', async () => {
        fetchMock.mockResolvedValue(new Response('{}'));
        await signedCopyFetch('GET', 'https://global.test', '/api/marketplace/posts?id=x', undefined, me);
        const [, init] = fetchMock.mock.calls[0];
        expect(init.headers['x-signed-for'] ?? init.headers['X-Signed-For']).toBe('global.test');
        expect(init.body).toBeUndefined();
    });
});

describe('a tend', () => {
    const NOW = 1_800_000_000_000;

    it('with no copy to tend asks nobody anything', async () => {
        await tendCopiesSoon(me, NOW);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('runs at most hourly, across reloads', async () => {
        await copyPairs.change(() => [pair('a', { homeId: 'h', sent: '{}' })]);
        fetchMock.mockResolvedValue(new Response('[]'));
        await tendCopiesSoon(me, NOW);
        const calls = fetchMock.mock.calls.length;
        expect(calls).toBeGreaterThan(0);
        await tendCopiesSoon(me, NOW + 59 * 60_000);
        expect(fetchMock.mock.calls.length).toBe(calls);
        await tendCopiesSoon(me, NOW + 61 * 60_000);
        expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    });

    it('needs a key: a visitor tends nothing', async () => {
        await tendCopiesSoon(null, NOW);
        expect(localStorage.length).toBe(0);
    });
});

describe('asking global', () => {
    const NOW = 1_800_000_000_000;

    it('a community that names no global asks nobody', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue({ profile: 'local', addresses: [] } as never);
        expect(await askGlobalStanding(me, NOW)).toBe('unknown');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the answer a day: drawing a row reads it, and asks nobody', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ isMember: false })));
        expect(await askGlobalStanding(me, NOW)).toBe('stranger');
        expect(readGlobalStanding(me.publicKey, NOW + 1000)).toBe('stranger');
        expect(readGlobalStanding(me.publicKey, NOW + 25 * 3_600_000)).toBe('unknown');
        expect(readGlobalStanding('another-key', NOW)).toBe('unknown');
    });

    it('going to the door lets go of a kept stranger, for this key: a reload is the tick again, and drawing it asks nobody', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ isMember: false })));
        const soon = Date.now();
        await askGlobalStanding(me, soon);
        forgetGlobalStanding('another-key');
        expect(readGlobalStanding(me.publicKey, soon)).toBe('stranger');
        forgetGlobalStanding(me.publicKey);
        expect(readGlobalStanding(me.publicKey, soon)).toBe('unknown');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a kept member stays through it', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ isMember: true })));
        const soon = Date.now();
        await askGlobalStanding(me, soon);
        forgetGlobalStanding(me.publicKey);
        expect(readGlobalStanding(me.publicKey, soon)).toBe('member');
    });

    it('a member needs no second ask', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ isMember: true })));
        expect(await askGlobalStanding(me, NOW)).toBe('member');
        expect(await askGlobalStanding(me, NOW + 1000)).toBe('member');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('an answer that is not one says nothing of the key', async () => {
        fetchMock.mockResolvedValue(new Response('<html>a portal</html>'));
        expect(await askGlobalStanding(me, NOW)).toBe('unknown');
        fetchMock.mockRejectedValue(new Error('offline'));
        expect(await askGlobalStanding(me, NOW)).toBe('unknown');
    });
});
