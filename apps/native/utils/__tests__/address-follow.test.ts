/**
 * Who a community is, by its signed statement, and what the phone first verified at each address (utils/address-follow.ts).
 * The follow card these tests also pinned went in addresses S4 (scratch/fable-design/DESIGN-several-addresses-fable.md §9):
 * the phone follows by itself, by the signed list and a fresh proof (utils/__tests__/address-verify.test.ts).
 *
 * What is pinned here, with real Ed25519 node keys and statements signed in the server's own bytes (apps/server
 * services/identity-epoch.ts): the statement is read only when signed by the key its PeerId names; who the community is
 * at an address is kept from the phone's first read there, once, and never replaced by whoever answers later; the
 * owner's number nudge and the registrar name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
    // It writes the address itself once the copy is there (writeAddress), before the old copy goes.
    carryCommunityCopy: vi.fn(async (from: string, to: string, writeAddress: () => Promise<void>) => { switched.carried.push([from, to]); await writeAddress(); return 'carried'; }),
}));
vi.mock('../community-switch', () => ({ communitySwitched: vi.fn(() => { switched.announced++; }), onCommunitySwitched: vi.fn(() => () => {}) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import {
    fetchIdentityStatement, forgetFollowChecks, keepCommunityIdentity, numberOnlyAddress, registrarNameOf, readIdentityStatement, sameCommunity,
    COMMUNITY_IDENTITY_KEY, IDENTITY_STATEMENT_PATH,
} from '../address-follow';
import { GLOBAL_NODE_URL } from '../global-node-url';
import type { NodeProfile } from '../node-profile';
import type { SavedNode } from '../nodes';

// A real Ed25519 PeerId for a real node key (as takeover-unlock.test.ts makes one).
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

const IP = 'https://203.0.113.5';
const NAME = 'https://beans.example.org';
const COMMUNITY = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const DAY = 24 * 60 * 60 * 1000;

const profile = (over: Partial<NodeProfile> = {}): NodeProfile => ({
    profile: 'local', features: {}, checkedAt: new Date().toISOString(),
    addresses: ['203.0.113.5', 'beans.example.org'], primaryAddress: 'beans.example.org', ...over,
});

/** The phone and the two servers. `answers[origin]` is what GET /api/node/identity-epoch gives there (undefined: no answer). */
function world(opts: { anchor?: string | null; prof?: NodeProfile | null; answers?: Record<string, unknown>; now?: number; saved?: SavedNode[]; guest?: string[] } = {}) {
    const state = {
        anchor: opts.anchor === undefined ? IP : opts.anchor,
        prof: opts.prof === undefined ? profile() : opts.prof,
        answers: { ...(opts.answers ?? {}) } as Record<string, unknown>,
        now: opts.now ?? Date.UTC(2026, 9, 18),
        saved: [...(opts.saved ?? [{ url: IP, alias: 'Beans Town', currencyType: 'image' as const, currencyValue: 'bean' }])],
        guest: [...(opts.guest ?? [])],
        asked: [] as string[],
    };
    const deps = {
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

const anchorWrites = () => vi.mocked(AsyncStorage.setItem).mock.calls.filter(([k]) => k === 'beanpool_anchor_url');

beforeEach(() => {
    store.clear();
    forgetFollowChecks();
    vi.mocked(AsyncStorage.setItem).mockClear();
    switched.dbClosed = switched.dbOpened = switched.announced = 0;
    switched.carried = [];
});

describe('the statement: who a node says it is, signed with its node key', () => {
    const node = nodeKey();

    it('reads a statement signed by the key its PeerId names', () => {
        expect(readIdentityStatement(statement(node, COMMUNITY, 2, '2026-10-01T00:00:00.000Z'))).toEqual({ peerId: node.peerId, communityId: COMMUNITY, epoch: 2 });
    });

    it('refuses one signed by any other key, changed after signing, malformed, or naming no community', () => {
        const other = nodeKey();
        expect(readIdentityStatement(statement(node, COMMUNITY, 0, null, other.seed))).toBeNull();
        const changed = statement(node, COMMUNITY);
        expect(readIdentityStatement({ ...changed, statement: { ...changed.statement, communityId: 'beef' } })).toBeNull();
        expect(readIdentityStatement({ ...changed, statement: { ...changed.statement, epoch: 1 } })).toBeNull();
        expect(readIdentityStatement({ ...changed, sig: changed.sig.slice(0, -4) })).toBeNull();
        expect(readIdentityStatement({ ...changed, sig: '!' + changed.sig.slice(1) })).toBeNull();
        expect(readIdentityStatement(statement(node, null))).toBeNull();
        expect(readIdentityStatement({ ...changed, statement: { ...changed.statement, peerId: 'QmNotAnEd25519Key' } })).toBeNull();
        for (const bad of [null, 'x', [], {}, { statement: changed.statement }, { sig: changed.sig }]) expect(readIdentityStatement(bad)).toBeNull();
    });

    it('signs the bytes the server signs: its domain and the five fields in its order (services/identity-epoch.ts)', () => {
        const server = fs.readFileSync(path.resolve(__dirname, '../../../server/src/services/identity-epoch.ts'), 'utf8');
        expect(server).toContain("export const IDENTITY_EPOCH_PATH = '/api/node/identity-epoch';");
        expect(IDENTITY_STATEMENT_PATH).toBe('/api/node/identity-epoch');
        expect(server).toContain("const DOMAIN = 'beanpool-identity-epoch-v1\\n';");
        expect(server).toMatch(/new TextEncoder\(\)\.encode\(DOMAIN \+ JSON\.stringify\(\{\s*v: s\.v, peerId: s\.peerId, communityId: s\.communityId, epoch: s\.epoch, since: s\.since,\s*\}\)\)/);
        expect(server).toMatch(/sig: Buffer\.from\(ed25519\.sign\(canonical\(statement\), seed\)\)\.toString\('base64'\)/);
        const mine = fs.readFileSync(path.resolve(__dirname, '../address-follow.ts'), 'utf8');
        expect(mine).toContain("const STATEMENT_DOMAIN = 'beanpool-identity-epoch-v1\\n';");
        expect(mine).toMatch(/v: s\.v, peerId: s\.peerId, communityId: s\.communityId, epoch: s\.epoch, since: s\.since,/);
    });

    it('is fetched from the public route, and a refusal or a non-answer is none', async () => {
        const body = statement(node, COMMUNITY);
        const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(body), { status: url === `${NAME}/api/node/identity-epoch` ? 200 : 404 }));
        expect(await fetchIdentityStatement(NAME, fetchImpl as unknown as typeof fetch)).toEqual({ peerId: node.peerId, communityId: COMMUNITY, epoch: 0 });
        expect(await fetchIdentityStatement(IP, fetchImpl as unknown as typeof fetch)).toBeNull();
        expect(await fetchIdentityStatement(IP, (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
        expect(await fetchIdentityStatement(IP, (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch)).toBeNull();
    });

    it('the same community: same key, same community id, and never fewer take-overs', () => {
        const a = { peerId: 'p', communityId: 'c', epoch: 1 };
        expect(sameCommunity(a, { ...a })).toBe(true);
        expect(sameCommunity(a, { ...a, epoch: 2 })).toBe(true);
        expect(sameCommunity(a, { ...a, epoch: 0 })).toBe(false);
        expect(sameCommunity(a, { ...a, peerId: 'q' })).toBe(false);
        expect(sameCommunity(a, { ...a, communityId: 'd' })).toBe(false);
    });
});

describe('who the community is, kept from the phone\'s first read of it at its address', () => {
    const node = nodeKey();
    const Y = 'https://y.example.org';
    const keptAt = (origin: string) => JSON.parse(store.get(COMMUNITY_IDENTITY_KEY) ?? '{}')[origin];
    const x = () => ({ peerId: node.peerId, communityId: COMMUNITY, epoch: 0 });

    it('at a number with no name yet; the number given to another community later keeps the first (the review\'s case)', async () => {
        const first = world({ prof: profile({ addresses: ['203.0.113.5'], primaryAddress: undefined }), answers: { [IP]: statement(node, COMMUNITY) } });
        await keepCommunityIdentity(IP, first.deps);
        expect(first.state.asked).toEqual([IP]);
        expect(keptAt(IP)).toEqual(x());
        // The number is community Y's server now: Y names its own name as where it lives, and signs both addresses.
        const y = nodeKey();
        const later = world({
            prof: profile({ addresses: ['203.0.113.5', 'y.example.org'], primaryAddress: 'y.example.org' }),
            answers: { [IP]: statement(y, 'f00d'), [Y]: statement(y, 'f00d') },
        });
        // The next app start's read asks nothing and keeps what it had.
        await keepCommunityIdentity(IP, later.deps);
        expect(later.state.asked).toEqual([]);
        expect(anchorWrites()).toEqual([]);
        expect(keptAt(IP)).toEqual(x());
    });

    it('a name granted again to someone else keeps what the phone first read there', async () => {
        const first = world({ anchor: NAME, prof: profile({ addresses: ['beans.example.org'], primaryAddress: 'beans.example.org' }), answers: { [NAME]: statement(node, COMMUNITY) } });
        await keepCommunityIdentity(NAME, first.deps);
        expect(keptAt(NAME)).toEqual(x());
        const y = nodeKey();
        const later = world({
            anchor: NAME, prof: profile({ addresses: ['beans.example.org', 'y.example.org'], primaryAddress: 'y.example.org' }),
            answers: { [NAME]: statement(y, 'f00d'), [Y]: statement(y, 'f00d') },
        });
        await keepCommunityIdentity(NAME, later.deps);
        expect(later.state.asked).toEqual([]);
        expect(keptAt(NAME)).toEqual(x());
    });

    it('one read per address: none once kept, and none for five minutes after no answer', async () => {
        const w = world({ answers: {} });
        await keepCommunityIdentity(IP, w.deps);
        expect(w.state.asked).toEqual([IP]);
        expect(store.has(COMMUNITY_IDENTITY_KEY)).toBe(false);
        w.state.answers[IP] = statement(node, COMMUNITY);
        w.state.now += 60 * 1000;
        await keepCommunityIdentity(IP, w.deps);
        expect(w.state.asked).toHaveLength(1);
        w.state.now += 5 * 60 * 1000;
        await keepCommunityIdentity(IP, w.deps);
        expect(w.state.asked).toHaveLength(2);
        expect(keptAt(IP)).toEqual(x());
        w.state.now += 365 * DAY;
        await keepCommunityIdentity(`${IP}/`, w.deps);
        await keepCommunityIdentity(IP, w.deps);
        expect(w.state.asked).toHaveLength(2);
    });

    it('a statement that isn\'t signed by the key it names is not kept', async () => {
        const w = world({ answers: { [IP]: statement(node, COMMUNITY, 0, null, nodeKey().seed) } });
        await keepCommunityIdentity(IP, w.deps);
        expect(store.has(COMMUNITY_IDENTITY_KEY)).toBe(false);
    });

    it('only where an address may be followed: never over http, at the worldwide community, or with no address', async () => {
        const w = world({ answers: { [IP]: statement(node, COMMUNITY) } });
        for (const url of ['http://203.0.113.5', 'http://192.168.1.10:8443', GLOBAL_NODE_URL, '', null, undefined, 'https://user@beans.example.org']) {
            await keepCommunityIdentity(url, w.deps);
        }
        expect(w.state.asked).toEqual([]);
        expect(vi.mocked(AsyncStorage.setItem)).not.toHaveBeenCalled();
    });

    it('the tab strip keeps it after its community answered, at each app start and switch, without waiting for it', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/_layout.tsx'), 'utf-8');
        expect(src).toMatch(/import \{ keepCommunityIdentity \} from '\.\.\/\.\.\/utils\/address-follow';/);
        const start = src.indexOf('const fresh = await fetchNodeProfile(url);');
        const end = src.indexOf('}, [nodeUrl, pathname]);', start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        expect(src.slice(start, end)).toMatch(/if \(fresh\) keepCommunityIdentity\(url\)\.catch\(\(\) => \{\}\);/);
        expect(src.slice(start, end)).not.toMatch(/await keepCommunityIdentity/);
    });
});

describe('the owner\'s nudge: members reach this community by its server\'s number', () => {
    it('the number, when none of the community\'s own addresses is a name', () => {
        expect(numberOnlyAddress(IP)).toBe('203.0.113.5');
        expect(numberOnlyAddress(IP, [])).toBe('203.0.113.5');
        expect(numberOnlyAddress(`${IP}:8443/`, ['203.0.113.5'])).toBe('203.0.113.5');
    });

    it('nothing once it has a name, at a name, on a home network, or with no address', () => {
        expect(numberOnlyAddress(IP, ['203.0.113.5', 'beans.example.org'])).toBeNull();
        expect(numberOnlyAddress(NAME, [])).toBeNull();
        expect(numberOnlyAddress('http://192.168.1.10:8080', [])).toBeNull();
        expect(numberOnlyAddress('https://192.168.1.10', [])).toBeNull();
        expect(numberOnlyAddress(null)).toBeNull();
    });
});

describe('registrarNameOf', () => {
    it('returns the .beanpool.org host when origin is a beanpool.org name', () => {
        expect(registrarNameOf('https://byron.beanpool.org')).toBe('byron.beanpool.org');
        expect(registrarNameOf('https://byron.beanpool.org:8443')).toBe('byron.beanpool.org');
    });

    it('returns the .beanpool.org host from addresses when origin is an IP or local address', () => {
        expect(registrarNameOf('http://192.168.1.10:8080', ['byron.beanpool.org'])).toBe('byron.beanpool.org');
        expect(registrarNameOf('https://203.0.113.5', ['203.0.113.5', 'mullum.beanpool.org'])).toBe('mullum.beanpool.org');
    });

    it('returns null when there is no beanpool.org name', () => {
        expect(registrarNameOf('https://beans.example.org', ['203.0.113.5'])).toBeNull();
        expect(registrarNameOf('https://203.0.113.5', [])).toBeNull();
        expect(registrarNameOf(null, null)).toBeNull();
    });
});
