/**
 * A second way in when the phone's address stops answering (utils/address-fallback.ts;
 * scratch/fable-design/DESIGN-dns-robustness-fable.md §3.2, slice S3). Before S3 the phone held every address its
 * community published and used them only to follow a changed main address: when byron.beanpool.org's DNS answer went
 * wrong, a phone on it had no way in, though mullum.beanpool.org reached the same server.
 *
 * What is pinned here, through the module's own functions with real Ed25519 node keys and statements signed in the
 * server's own bytes (apps/server services/identity-epoch.ts), as address-follow.test.ts does:
 *   - one card once the phone's address has failed for five minutes of tries, kept across a cold start within the hour;
 *   - only to an address whose statement is the community the phone first verified at its own address: another key,
 *     another community, a forged statement, or fewer take-overs is never offered;
 *   - "Not now" is per pair of addresses, for 24 hours;
 *   - never from or to http, never the worldwide community, never a bare number;
 *   - the move is the follow card's move (switchPhoneTo, the copy carried before the address is written);
 *   - never silent, and the follow card offers the way back once the main address answers again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
    },
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
// The switch's database swap (utils/reconnect.ts switchPhoneTo imports it when it runs) and its announcement.
const switched = vi.hoisted(() => ({ dbClosed: 0, dbOpened: 0, announced: 0, carried: [] as string[][] }));
vi.mock('../db', () => ({
    closeDB: vi.fn(async () => { switched.dbClosed++; }),
    initDB: vi.fn(async () => { switched.dbOpened++; }),
    whileCopyMoves: vi.fn(async (_to: string, move: () => Promise<unknown>) => { switched.dbClosed++; return move(); }),
}));
// The copy's carry itself runs over real files in community-copy-carry.test.ts.
vi.mock('../community-copy-carry', () => ({
    carryCommunityCopy: vi.fn(async (from: string, to: string, writeAddress: () => Promise<void>) => { switched.carried.push([from, to]); await writeAddress(); return 'carried'; }),
}));
vi.mock('../community-switch', () => ({ communitySwitched: vi.fn(() => { switched.announced++; }), onCommunitySwitched: vi.fn(() => () => {}) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import {
    acceptAddressFallback, addressFallbackOffer, fallbackCandidates, forgetFallbackChecks, snoozeAddressFallback,
    ANSWERED_FOR_MS, ASK_EVERY_MS, FALLBACK_AFTER_MS, FALLBACK_SNOOZE_KEY, FALLBACK_SNOOZE_MS, FALLBACK_TRIES_KEY, TRIES_GAP_MS,
    type AddressFallbackOffer,
} from '../address-fallback';
import { addressFollowOffer, forgetFollowChecks, readIdentityStatement, COMMUNITY_IDENTITY_KEY, type AddressFollowDeps } from '../address-follow';
import { communitySwitched } from '../community-switch';
import { carryCommunityCopy } from '../community-copy-carry';
import { GLOBAL_NODE_URL } from '../global-node-url';
import type { NodeProfile } from '../node-profile';
import type { SavedNode } from '../nodes';

// A real Ed25519 PeerId for a real node key (as address-follow.test.ts makes one).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function peerIdOf(pub: Uint8Array): string {
    const bytes = [0x00, 0x24, 0x08, 0x01, 0x12, 0x20, ...pub];
    let n = BigInt('0x' + bytesToHex(new Uint8Array(bytes)));
    let out = '';
    while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
    for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
    return out;
}

interface Node { seed: Uint8Array; peerId: string }
const nodeKey = (): Node => { const seed = randomBytes(32); return { seed, peerId: peerIdOf(ed25519.getPublicKey(seed)) }; };

/** A statement as the server signs it (services/identity-epoch.ts signEpochStatement). */
function statement(node: Node, communityId: string | null, epoch = 0, since: string | null = null, signer: Uint8Array = node.seed) {
    const s = { v: 1 as const, peerId: node.peerId, communityId, epoch, since };
    const bytes = new TextEncoder().encode('beanpool-identity-epoch-v1\n' + JSON.stringify({
        v: s.v, peerId: s.peerId, communityId: s.communityId, epoch: s.epoch, since: s.since,
    }));
    return { statement: s, sig: Buffer.from(ed25519.sign(bytes, signer)).toString('base64') };
}

const BYRON = 'https://byron.example.org';
const MULLUM = 'https://mullum.example.org';
const THIRD = 'https://beans.example.net';
const COMMUNITY = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const node = nodeKey();
const kept = (epoch = 0) => ({ peerId: node.peerId, communityId: COMMUNITY, epoch });
const OFFER: AddressFallbackOffer = { from: BYRON, to: MULLUM, fromHost: 'byron.example.org', host: 'mullum.example.org' };

const profile = (over: Partial<NodeProfile> = {}): NodeProfile => ({
    profile: 'local', features: {}, checkedAt: new Date().toISOString(),
    addresses: ['byron.example.org', 'mullum.example.org'], primaryAddress: 'byron.example.org', ...over,
});

/**
 * The phone on byron, and the servers. `answers[origin]` is what GET /api/node/identity-epoch gives there (undefined: no
 * answer). By default byron gives none and mullum is the same community; what the phone first verified at byron is kept.
 */
function world(opts: { anchor?: string | null; prof?: NodeProfile | null; answers?: Record<string, unknown>; now?: number; saved?: SavedNode[]; guest?: string[]; keep?: boolean } = {}) {
    if (opts.keep !== false) store.set(COMMUNITY_IDENTITY_KEY, JSON.stringify({ [opts.anchor ?? BYRON]: kept() }));
    const state = {
        anchor: opts.anchor === undefined ? BYRON : opts.anchor,
        prof: opts.prof === undefined ? profile() : opts.prof,
        answers: { ...(opts.answers ?? { [MULLUM]: statement(node, COMMUNITY) }) } as Record<string, unknown>,
        now: opts.now ?? Date.UTC(2026, 10, 4, 9),
        saved: [...(opts.saved ?? [{ url: BYRON, alias: 'Byron Shire', currencyType: 'image' as const, currencyValue: 'bean' }])],
        guest: [...(opts.guest ?? [])],
        asked: [] as string[],
    };
    const deps: AddressFollowDeps = {
        anchor: vi.fn(async () => state.anchor),
        profile: vi.fn(async () => state.prof),
        statement: vi.fn(async (origin: string) => { state.asked.push(origin); return readIdentityStatement(state.answers[origin]); }),
        now: () => state.now,
        switchTo: vi.fn(async (url: string) => { state.anchor = url; }),
        savedNodes: vi.fn(async () => state.saved.map(n => ({ ...n }))),
        addSavedNode: vi.fn(async (url: string, alias?: string, currencyType?: 'text' | 'image', currencyValue?: string) => {
            if (!state.saved.some(n => n.url === url)) state.saved.push({ url, alias, currencyType, currencyValue });
        }),
        removeSavedNode: vi.fn(async (url: string) => { state.saved = state.saved.filter(n => n.url !== url); }),
        isGuestNode: vi.fn(async (url: string) => state.guest.includes(url)),
        markGuestNode: vi.fn(async (url: string) => { state.guest.push(url); }),
    };
    return { state, deps };
}

/** Five minutes of failed tries at the phone's address, a minute apart: the card is due at the last. */
async function failForFiveMinutes(w: ReturnType<typeof world>) {
    const out: (AddressFallbackOffer | null)[] = [];
    for (let i = 0; i <= 5; i++) {
        out.push(await addressFallbackOffer(w.deps));
        if (i < 5) w.state.now += MIN;
    }
    return out;
}

const anchorWrites = () => vi.mocked(AsyncStorage.setItem).mock.calls.filter(([k]) => k === 'beanpool_anchor_url');
const triesAt = (origin: string) => JSON.parse(store.get(FALLBACK_TRIES_KEY) ?? '{}')[origin];

beforeEach(() => {
    store.clear();
    forgetFallbackChecks();
    forgetFollowChecks();
    vi.mocked(AsyncStorage.setItem).mockClear();
    switched.dbClosed = switched.dbOpened = switched.announced = 0;
    switched.carried = [];
});

describe('where the phone could fall back to (fallbackCandidates)', () => {
    it('every other address the community published, in its own order, on another host', () => {
        expect(fallbackCandidates(BYRON, profile())).toEqual([OFFER]);
        expect(fallbackCandidates(`${BYRON}/`, profile({ addresses: ['byron.example.org', 'mullum.example.org', 'beans.example.net', 'mullum.example.org'] })))
            .toEqual([OFFER, { ...OFFER, to: THIRD, host: 'beans.example.net' }]);
        expect(fallbackCandidates(BYRON, profile({ addresses: ['byron.example.org', 'mullum.example.org:8443'] })))
            .toEqual([{ ...OFFER, to: 'https://mullum.example.org:8443', host: 'mullum.example.org:8443' }]);
        // A community that names no main address: every other one of its addresses.
        expect(fallbackCandidates(BYRON, profile({ primaryAddress: undefined }))).toEqual([OFFER]);
    });

    it('never from or to cleartext', () => {
        expect(fallbackCandidates('http://byron.example.org', profile())).toEqual([]);
        expect(fallbackCandidates('http://192.168.1.10:8080', profile())).toEqual([]);
        expect(fallbackCandidates(BYRON, profile({ addresses: ['byron.example.org', 'http://mullum.example.org'] }))).toEqual([]);
    });

    it('never from or to the worldwide community', () => {
        expect(fallbackCandidates(GLOBAL_NODE_URL, profile())).toEqual([]);
        const global = GLOBAL_NODE_URL.replace(/^https:\/\//, '');
        expect(fallbackCandidates(BYRON, profile({ addresses: ['byron.example.org', global] }))).toEqual([]);
    });

    it('never to a bare number, public or private; a phone on a number may fall back to a name', () => {
        for (const n of ['203.0.113.5', '198.51.100.7:8443', '10.0.0.5', '192.168.1.20', '127.0.0.1', '0.0.0.0', '[2001:db8::1]']) {
            expect(fallbackCandidates(BYRON, profile({ addresses: ['byron.example.org', n] })), n).toEqual([]);
        }
        expect(fallbackCandidates('https://203.0.113.5', profile({ addresses: ['203.0.113.5', 'mullum.example.org'], primaryAddress: undefined })))
            .toEqual([{ from: 'https://203.0.113.5', to: MULLUM, fromHost: '203.0.113.5', host: 'mullum.example.org' }]);
    });

    it('never to an address the phone would not use as a community\'s, or its own host on another port', () => {
        for (const bad of ['intranet', 'localhost', 'user@mullum.example.org', 'byron.example.org:8443', '']) {
            expect(fallbackCandidates(BYRON, profile({ addresses: ['byron.example.org', bad] })), bad).toEqual([]);
        }
    });

    it('none while the community says it lives somewhere else now: that is the follow card\'s move', () => {
        expect(fallbackCandidates(BYRON, profile({ primaryAddress: 'mullum.example.org' }))).toEqual([]);
        expect(fallbackCandidates(BYRON, profile({ addresses: ['byron.example.org', 'mullum.example.org', 'beans.example.net'], primaryAddress: 'beans.example.net' }))).toEqual([]);
    });

    it('none with nothing published, or no address', () => {
        expect(fallbackCandidates(BYRON, profile({ addresses: ['byron.example.org'] }))).toEqual([]);
        expect(fallbackCandidates(BYRON, profile({ addresses: undefined, primaryAddress: undefined }))).toEqual([]);
        expect(fallbackCandidates(BYRON, null)).toEqual([]);
        expect(fallbackCandidates(null, profile())).toEqual([]);
    });
});

describe('unreachable: one card after five minutes of failed tries', () => {
    it('nothing at the first failures; the card at five minutes, one card for one address', async () => {
        const w = world({ answers: { [MULLUM]: statement(node, COMMUNITY), [THIRD]: statement(node, COMMUNITY) }, prof: profile({ addresses: ['byron.example.org', 'mullum.example.org', 'beans.example.net'] }) });
        const seen = await failForFiveMinutes(w);
        expect(seen.slice(0, 5)).toEqual([null, null, null, null, null]);
        expect(seen[5]).toEqual(OFFER);
        // The phone's address was asked at each try; the others only once the card was due.
        expect(w.state.asked.filter(o => o === BYRON)).toHaveLength(6);
        expect(w.state.asked.filter(o => o !== BYRON).sort()).toEqual([THIRD, MULLUM].sort());
        expect(FALLBACK_AFTER_MS).toBe(5 * MIN);
    });

    it('the phone\'s address is asked at most once a minute while it fails', async () => {
        const w = world();
        await addressFallbackOffer(w.deps);
        w.state.now += 30 * 1000;
        await addressFallbackOffer(w.deps);
        expect(w.state.asked).toEqual([BYRON]);
        w.state.now += 30 * 1000;
        await addressFallbackOffer(w.deps);
        expect(w.state.asked).toEqual([BYRON, BYRON]);
        expect(ASK_EVERY_MS).toBe(MIN);
    });

    it('an answer between failures starts the count again', async () => {
        const w = world();
        await addressFallbackOffer(w.deps);
        w.state.now += 3 * MIN;
        w.state.answers[BYRON] = statement(node, COMMUNITY);
        expect(await addressFallbackOffer(w.deps)).toBeNull();
        expect(triesAt(BYRON)).toBeUndefined();
        // Answered: not asked again for five minutes.
        w.state.now += 4 * MIN;
        await addressFallbackOffer(w.deps);
        expect(w.state.asked.filter(o => o === BYRON)).toHaveLength(2);
        expect(ANSWERED_FOR_MS).toBe(5 * MIN);
        // It fails again: five more minutes from this failure, not from the first.
        w.state.now += 2 * MIN;
        w.state.answers[BYRON] = undefined;
        expect(await addressFallbackOffer(w.deps)).toBeNull();
        w.state.now += 4 * MIN;
        expect(await addressFallbackOffer(w.deps)).toBeNull();
        w.state.now += MIN;
        expect(await addressFallbackOffer(w.deps)).toEqual(OFFER);
    });

    it('kept across a cold start: the app opened again within the hour with its address still failing shows the card', async () => {
        const w = world();
        expect(await addressFallbackOffer(w.deps)).toBeNull();
        expect(triesAt(BYRON)).toEqual({ since: w.state.now, last: w.state.now });
        // The app is closed; this run's memory goes. Twenty minutes later it opens, and the address still fails.
        forgetFallbackChecks();
        w.state.now += 20 * MIN;
        expect(await addressFallbackOffer(w.deps)).toEqual(OFFER);
    });

    it('an old failure never stands for a new one: a try more than an hour after the last starts again', async () => {
        const w = world();
        await addressFallbackOffer(w.deps);
        forgetFallbackChecks();
        w.state.now += TRIES_GAP_MS + 1;
        expect(await addressFallbackOffer(w.deps)).toBeNull();
        expect(triesAt(BYRON)).toEqual({ since: w.state.now, last: w.state.now });
        expect(TRIES_GAP_MS).toBe(HOUR);
    });

    it('another server answering at the phone\'s address, or an older one of the community, is not its community answering', async () => {
        for (const [why, answer] of Object.entries({
            'another node key': statement(nodeKey(), COMMUNITY),
            'another community': statement(node, 'f00d'),
            'a forged statement': statement(node, COMMUNITY, 0, null, nodeKey().seed),
            'not a statement': { hello: 'world' },
        })) {
            store.clear();
            forgetFallbackChecks();
            const w = world({ answers: { [BYRON]: answer, [MULLUM]: statement(node, COMMUNITY) } });
            expect((await failForFiveMinutes(w))[5], why).toEqual(OFFER);
        }
        // A take-over already seen at byron (epoch 1 kept); byron's old server (epoch 0) starts again there.
        store.clear();
        forgetFallbackChecks();
        const w = world({ answers: { [BYRON]: statement(node, COMMUNITY, 0), [MULLUM]: statement(node, COMMUNITY, 1) } });
        store.set(COMMUNITY_IDENTITY_KEY, JSON.stringify({ [BYRON]: kept(1) }));
        expect((await failForFiveMinutes(w))[5]).toEqual(OFFER);
    });

    it('while the phone\'s address answers as its community: no card, and the others are never asked', async () => {
        const w = world({ answers: { [BYRON]: statement(node, COMMUNITY), [MULLUM]: statement(node, COMMUNITY) } });
        for (let i = 0; i < 4; i++) {
            expect(await addressFallbackOffer(w.deps)).toBeNull();
            w.state.now += 6 * MIN;
        }
        expect(w.state.asked).toEqual([BYRON, BYRON, BYRON, BYRON]);
        expect(store.has(FALLBACK_TRIES_KEY)).toBe(false);
    });

    it('nothing to fall back to costs nothing: no other published name, nobody is asked and nothing is written', async () => {
        for (const prof of [profile({ addresses: ['byron.example.org'] }), profile({ addresses: ['byron.example.org', '203.0.113.5', GLOBAL_NODE_URL.slice(8)] }), null]) {
            const w = world({ prof });
            vi.mocked(AsyncStorage.setItem).mockClear();
            for (let i = 0; i < 7; i++) { expect(await addressFallbackOffer(w.deps)).toBeNull(); w.state.now += MIN; }
            expect(w.state.asked).toEqual([]);
            expect(vi.mocked(AsyncStorage.setItem)).not.toHaveBeenCalled();
        }
    });

    it('nothing kept at the phone\'s address: nothing to check another against, so no card and nobody asked', async () => {
        const w = world({ keep: false });
        for (let i = 0; i < 7; i++) { expect(await addressFallbackOffer(w.deps)).toBeNull(); w.state.now += MIN; }
        expect(w.state.asked).toEqual([]);
    });

    it('never from cleartext or the worldwide community, even with a name published and kept', async () => {
        for (const anchor of ['http://byron.example.org', 'http://192.168.1.10:8080', GLOBAL_NODE_URL]) {
            store.clear();
            const w = world({ anchor });
            for (let i = 0; i < 7; i++) { expect(await addressFallbackOffer(w.deps), anchor).toBeNull(); w.state.now += MIN; }
            expect(w.state.asked).toEqual([]);
        }
    });
});

describe('an address whose statement names another key is never offered', () => {
    const cases: Record<string, unknown> = {
        'another node key': statement(nodeKey(), COMMUNITY),
        'another community': statement(node, 'deadbeef'),
        'not signed by the key it names': statement(node, COMMUNITY, 0, null, nodeKey().seed),
        'no answer': undefined,
        'not a statement': { peerId: node.peerId, communityId: COMMUNITY },
    };

    for (const [why, answer] of Object.entries(cases)) {
        it(`${why}: no card`, async () => {
            const w = world({ answers: { [MULLUM]: answer } });
            expect((await failForFiveMinutes(w))[5]).toBeNull();
            // Asked again as its check ages (five minutes, or an hour), never offered.
            for (let i = 0; i < 70; i++) { w.state.now += MIN; expect(await addressFallbackOffer(w.deps)).toBeNull(); }
            expect(w.state.asked.filter(o => o === MULLUM).length).toBeGreaterThan(1);
            expect(w.deps.switchTo).not.toHaveBeenCalled();
        });
    }

    it('skipped for the next address that is the community', async () => {
        const w = world({
            prof: profile({ addresses: ['byron.example.org', 'mullum.example.org', 'beans.example.net'] }),
            answers: { [MULLUM]: statement(nodeKey(), COMMUNITY), [THIRD]: statement(node, COMMUNITY) },
        });
        expect((await failForFiveMinutes(w))[5]).toEqual({ ...OFFER, to: THIRD, host: 'beans.example.net' });
    });

    it('fewer take-overs than the phone kept (a replaced server) is not the community; more is', async () => {
        store.set(COMMUNITY_IDENTITY_KEY, JSON.stringify({ [BYRON]: kept(2) }));
        const older = world({ keep: false, answers: { [MULLUM]: statement(node, COMMUNITY, 1) } });
        expect((await failForFiveMinutes(older))[5]).toBeNull();
        store.clear();
        forgetFallbackChecks();
        store.set(COMMUNITY_IDENTITY_KEY, JSON.stringify({ [BYRON]: kept(2) }));
        const newer = world({ keep: false, answers: { [MULLUM]: statement(node, COMMUNITY, 3) } });
        expect((await failForFiveMinutes(newer))[5]).toEqual(OFFER);
    });

    it('a take-over seen at the phone\'s address raises what is kept, so the replaced server is never offered after', async () => {
        const w = world({ answers: { [BYRON]: statement(node, COMMUNITY, 1), [MULLUM]: statement(node, COMMUNITY, 0) } });
        expect(await addressFallbackOffer(w.deps)).toBeNull();
        expect(JSON.parse(store.get(COMMUNITY_IDENTITY_KEY)!)[BYRON]).toEqual(kept(1));
        // Byron stops answering; mullum still leads to the server it replaced.
        w.state.answers[BYRON] = undefined;
        w.state.now += ANSWERED_FOR_MS;
        expect((await failForFiveMinutes(w))[5]).toBeNull();
    });

    it('checked again at the tap: another key there now, or no answer, moves nothing', async () => {
        const w = world();
        const offer = (await failForFiveMinutes(w))[5]!;
        w.state.answers[MULLUM] = statement(nodeKey(), COMMUNITY);
        expect(await acceptAddressFallback(offer, w.deps)).toBe('not-same');
        w.state.answers[MULLUM] = undefined;
        expect(await acceptAddressFallback(offer, w.deps)).toBe('unreachable');
        expect(w.deps.switchTo).not.toHaveBeenCalled();
        expect(w.state.anchor).toBe(BYRON);
    });
});

describe('"Not now": 24 hours, per pair of addresses', () => {
    it('the same pair is not offered for 24 hours, then is', async () => {
        const w = world();
        const offer = (await failForFiveMinutes(w))[5]!;
        await snoozeAddressFallback(offer, w.deps);
        expect(JSON.parse(store.get(FALLBACK_SNOOZE_KEY)!)).toEqual({ [`${BYRON} ${MULLUM}`]: w.state.now + FALLBACK_SNOOZE_MS });
        expect(FALLBACK_SNOOZE_MS).toBe(24 * HOUR);
        const start = w.state.now;
        w.state.now = start + HOUR;
        expect(await addressFallbackOffer(w.deps)).toBeNull();
        w.state.now = start + 24 * HOUR - 1;
        expect(await addressFallbackOffer(w.deps)).toBeNull();
        // While every pair is snoozed nobody is asked, so the count starts again: five minutes of fresh failures.
        w.state.now = start + 24 * HOUR + 1;
        expect((await failForFiveMinutes(w))[5]).toEqual(offer);
        expect(w.deps.switchTo).not.toHaveBeenCalled();
    });

    it('another address of the community is another pair, offered meanwhile', async () => {
        const w = world({
            prof: profile({ addresses: ['byron.example.org', 'mullum.example.org', 'beans.example.net'] }),
            answers: { [MULLUM]: statement(node, COMMUNITY), [THIRD]: statement(node, COMMUNITY) },
        });
        await snoozeAddressFallback((await failForFiveMinutes(w))[5]!, w.deps);
        w.state.now += MIN;
        expect(await addressFallbackOffer(w.deps)).toEqual({ ...OFFER, to: THIRD, host: 'beans.example.net' });
    });

    it('a pair is the two addresses: the same other address from another phone address is not snoozed by it', async () => {
        const w = world();
        await snoozeAddressFallback(OFFER, w.deps);
        // The phone is on a third address of the same community now (switched there by hand), and it fails too.
        store.set(COMMUNITY_IDENTITY_KEY, JSON.stringify({ [THIRD]: kept() }));
        w.state.anchor = THIRD;
        w.state.prof = profile({ addresses: ['beans.example.net', 'mullum.example.org'], primaryAddress: 'beans.example.net' });
        expect((await failForFiveMinutes(w))[5]).toEqual({ from: THIRD, to: MULLUM, fromHost: 'beans.example.net', host: 'mullum.example.org' });
    });

    it('with every pair snoozed, the phone\'s address is not even asked', async () => {
        const w = world();
        await snoozeAddressFallback(OFFER, w.deps);
        for (let i = 0; i < 7; i++) { expect(await addressFallbackOffer(w.deps)).toBeNull(); w.state.now += MIN; }
        expect(w.state.asked).toEqual([]);
    });
});

describe('never silent', () => {
    it('asking for the card switches nothing and writes no community address: only the count of failed tries', async () => {
        const w = world();
        expect((await failForFiveMinutes(w))[5]).toEqual(OFFER);
        expect(w.deps.switchTo).not.toHaveBeenCalled();
        expect(w.deps.addSavedNode).not.toHaveBeenCalled();
        expect(w.deps.removeSavedNode).not.toHaveBeenCalled();
        expect(w.deps.markGuestNode).not.toHaveBeenCalled();
        expect(anchorWrites()).toEqual([]);
        expect(new Set(vi.mocked(AsyncStorage.setItem).mock.calls.map(([k]) => k))).toEqual(new Set([FALLBACK_TRIES_KEY]));
        expect(w.state.anchor).toBe(BYRON);
        expect(communitySwitched).not.toHaveBeenCalled();
    });
});

describe('"Use that address for now": the move keeps the copy whole', () => {
    it('the write is switchPhoneTo\'s: the copy carried first, the address written, then communitySwitched()', async () => {
        const w = world();
        const offer = (await failForFiveMinutes(w))[5]!;
        const { switchTo: _ownSwitch, ...rest } = w.deps;
        // Every dependency the test's own but the switch: the app's (utils/reconnect.ts switchPhoneTo).
        expect(await acceptAddressFallback(offer, rest)).toBe('moved');
        expect(anchorWrites()).toEqual([['beanpool_anchor_url', MULLUM]]);
        expect(switched).toEqual({ dbClosed: 1, dbOpened: 1, announced: 1, carried: [[BYRON, MULLUM]] });
        const setItem = vi.mocked(AsyncStorage.setItem).mock;
        const anchorWrite = setItem.invocationCallOrder[setItem.calls.findIndex(([k]) => k === 'beanpool_anchor_url')];
        expect(vi.mocked(carryCommunityCopy).mock.invocationCallOrder.at(-1)).toBeLessThan(anchorWrite);
        expect(vi.mocked(communitySwitched).mock.invocationCallOrder.at(-1)).toBeGreaterThan(anchorWrite);
    });

    it('the saved row moves with its name, a profile change waiting goes with it, a guest stays a guest, and the count is forgotten', async () => {
        const waiting = JSON.stringify({ publicKey: 'ab'.repeat(32), callsign: 'Renamed offline', avatar: 'bundled://koala' });
        store.set(`beanpool_pending_profile:${BYRON}`, waiting);
        const w = world({ guest: [BYRON] });
        const offer = (await failForFiveMinutes(w))[5]!;
        await snoozeAddressFallback({ ...offer, to: THIRD, host: 'beans.example.net' }, w.deps);
        expect(await acceptAddressFallback(offer, w.deps)).toBe('moved');
        expect(w.deps.switchTo).toHaveBeenCalledTimes(1);
        expect(w.deps.switchTo).toHaveBeenCalledWith(MULLUM, BYRON);
        expect(w.state.anchor).toBe(MULLUM);
        expect(w.state.saved).toEqual([{ url: MULLUM, alias: 'Byron Shire', currencyType: 'image', currencyValue: 'bean' }]);
        expect(store.get(`beanpool_pending_profile:${MULLUM}`)).toBe(waiting);
        expect(store.has(`beanpool_pending_profile:${BYRON}`)).toBe(false);
        expect(w.state.guest).toContain(MULLUM);
        expect(vi.mocked(w.deps.markGuestNode).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(w.deps.switchTo).mock.invocationCallOrder[0]);
        expect(triesAt(BYRON)).toBeUndefined();
        // Only the pair moved along is forgotten; another pair's "Not now" stays.
        expect(Object.keys(JSON.parse(store.get(FALLBACK_SNOOZE_KEY)!))).toEqual([`${BYRON} ${THIRD}`]);
    });

    it('the phone switched meanwhile, or the card was handed a move the rules refuse: nothing moves', async () => {
        const w = world({ answers: { [MULLUM]: statement(node, COMMUNITY), 'https://203.0.113.5': statement(node, COMMUNITY), 'http://mullum.example.org': statement(node, COMMUNITY) } });
        const offer = (await failForFiveMinutes(w))[5]!;
        w.state.anchor = 'https://elsewhere.example.org';
        expect(await acceptAddressFallback(offer, w.deps)).toBe('gone');
        w.state.anchor = BYRON;
        const forged: AddressFallbackOffer[] = [
            { ...OFFER, to: 'https://evil.example.org' },
            { ...OFFER, to: 'https://203.0.113.5', host: '203.0.113.5' },
            { ...OFFER, to: 'http://mullum.example.org' },
            { ...OFFER, to: GLOBAL_NODE_URL, host: GLOBAL_NODE_URL.slice(8) },
            { ...OFFER, to: BYRON, host: 'byron.example.org' },
        ];
        for (const f of forged) expect(await acceptAddressFallback(f, w.deps), f.to).toBe('not-same');
        expect(w.deps.switchTo).not.toHaveBeenCalled();
    });

    it('the way back: on mullum, the follow card offers byron again once it answers, and this card offers nothing', async () => {
        const w = world();
        expect(await acceptAddressFallback((await failForFiveMinutes(w))[5]!, w.deps)).toBe('moved');
        // Mullum's info still names byron as the community's main address.
        w.state.answers[MULLUM] = statement(node, COMMUNITY);
        store.set(COMMUNITY_IDENTITY_KEY, JSON.stringify({ [BYRON]: kept(), [MULLUM]: kept() }));
        expect(fallbackCandidates(MULLUM, w.state.prof)).toEqual([]);
        expect(await addressFollowOffer(w.deps)).toBeNull();
        w.state.answers[BYRON] = statement(node, COMMUNITY);
        forgetFollowChecks();
        expect(await addressFollowOffer(w.deps)).toEqual({ from: MULLUM, to: BYRON, host: 'byron.example.org' });
        w.state.now += 10 * MIN;
        expect(await addressFallbackOffer(w.deps)).toBeNull();
    });
});
