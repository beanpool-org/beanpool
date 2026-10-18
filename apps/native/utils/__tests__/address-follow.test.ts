/**
 * Following a community to where it lives now (utils/address-follow.ts; scratch/global-node/DESIGN-https-anywhere-fable.md
 * §3, D4, slice S3). Before S3, nothing in the app read `primaryAddress` from /api/community/info: a community that moved
 * from its server's number to a name (or to a new name) told its members "Open the app to follow it", and the app had
 * nothing to follow with.
 *
 * What is pinned here, through the module's own functions with real Ed25519 node keys and statements signed in the
 * server's own bytes (apps/server services/identity-epoch.ts):
 *   - offered only when the new address is the same community: the same PeerId and community id, signed by the key the
 *     PeerId names, not an older server of it; checked against who the phone first knew at its address;
 *   - never silent: asking for the offer writes no community address and switches nothing;
 *   - "Not now" asks again in 7 days, for that same new address;
 *   - the move goes through utils/reconnect.ts switchPhoneTo, which writes the address and says communitySwitched().
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
const switched = vi.hoisted(() => ({ dbClosed: 0, dbOpened: 0, announced: 0 }));
vi.mock('../db', () => ({
    closeDB: vi.fn(async () => { switched.dbClosed++; }),
    initDB: vi.fn(async () => { switched.dbOpened++; }),
}));
vi.mock('../community-switch', () => ({ communitySwitched: vi.fn(() => { switched.announced++; }), onCommunitySwitched: vi.fn(() => () => {}) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import {
    acceptAddressFollow, addressFollowOffer, followCandidate, fetchIdentityStatement, forgetFollowChecks, numberOnlyAddress,
    readIdentityStatement, sameCommunity, snoozeAddressFollow, COMMUNITY_IDENTITY_KEY, FOLLOW_SNOOZE_KEY, FOLLOW_SNOOZE_MS,
    IDENTITY_STATEMENT_PATH, type AddressFollowDeps, type AddressFollowOffer,
} from '../address-follow';
import { communitySwitched } from '../community-switch';
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

const anchorWrites = () => vi.mocked(AsyncStorage.setItem).mock.calls.filter(([k]) => k === 'beanpool_anchor_url');

beforeEach(() => {
    store.clear();
    forgetFollowChecks();
    vi.mocked(AsyncStorage.setItem).mockClear();
    switched.dbClosed = switched.dbOpened = switched.announced = 0;
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

describe('what may be followed (followCandidate)', () => {
    it('a number to its name, or a name to a new name', () => {
        expect(followCandidate(IP, profile())).toEqual({ from: IP, to: NAME, host: 'beans.example.org' });
        expect(followCandidate(`${IP}/`, profile())).toEqual({ from: IP, to: NAME, host: 'beans.example.org' });
        expect(followCandidate('https://old.example.org', profile({ addresses: ['new.example.org'], primaryAddress: 'new.example.org' })))
            .toEqual({ from: 'https://old.example.org', to: 'https://new.example.org', host: 'new.example.org' });
        expect(followCandidate(IP, profile({ addresses: ['beans.example.org:8443'], primaryAddress: 'beans.example.org:8443' })))
            .toEqual({ from: IP, to: 'https://beans.example.org:8443', host: 'beans.example.org:8443' });
    });

    it('nothing when the phone is already there, the primary is not one of its addresses, or none is said', () => {
        expect(followCandidate(NAME, profile())).toBeNull();
        expect(followCandidate('https://beans.example.org:8443', profile())).toBeNull(); // the same host: signatures name the host only
        expect(followCandidate(IP, profile({ addresses: ['203.0.113.5'] }))).toBeNull();
        expect(followCandidate(IP, profile({ primaryAddress: undefined }))).toBeNull();
        expect(followCandidate(IP, profile({ addresses: undefined }))).toBeNull();
        expect(followCandidate(IP, null)).toBeNull();
        expect(followCandidate(null, profile())).toBeNull();
    });

    it('never from cleartext, never from the worldwide community, never from a name to a number', () => {
        expect(followCandidate('http://192.168.1.10:8080', profile())).toBeNull();
        expect(followCandidate('http://203.0.113.5', profile())).toBeNull();
        expect(followCandidate(GLOBAL_NODE_URL, profile())).toBeNull();
        expect(followCandidate(NAME, profile({ addresses: ['beans.example.org', '198.51.100.7'], primaryAddress: '198.51.100.7' }))).toBeNull();
        // A number to another number is the same kind of address: offered (the server moved, with the phone told).
        expect(followCandidate(IP, profile({ addresses: ['198.51.100.7'], primaryAddress: '198.51.100.7' })))
            .toEqual({ from: IP, to: 'https://198.51.100.7', host: '198.51.100.7' });
    });

    it('never to an address the phone would not use as a community\'s', () => {
        for (const bad of ['10.0.0.5', '192.168.1.20', '127.0.0.1', 'intranet', 'global.beanpool.org', '0.0.0.0', 'localhost']) {
            expect(followCandidate(IP, profile({ addresses: [bad], primaryAddress: bad })), bad).toBeNull();
        }
    });
});

describe('offered only when the new address is the same community', () => {
    const node = nodeKey();
    const same = () => ({ [IP]: statement(node, COMMUNITY), [NAME]: statement(node, COMMUNITY) });

    it('the same key and community at both: offered', async () => {
        const { deps } = world({ answers: same() });
        expect(await addressFollowOffer(deps)).toEqual({ from: IP, to: NAME, host: 'beans.example.org' });
    });

    it('another server at the new address, another community, a forged statement, or no answer: nothing', async () => {
        const other = nodeKey();
        const cases: Record<string, Record<string, unknown>> = {
            'another node key': { [IP]: statement(node, COMMUNITY), [NAME]: statement(other, COMMUNITY) },
            'another community': { [IP]: statement(node, COMMUNITY), [NAME]: statement(node, 'deadbeef') },
            'not signed by the key it names': { [IP]: statement(node, COMMUNITY), [NAME]: statement(node, COMMUNITY, 0, null, other.seed) },
            'no answer at the new address': { [IP]: statement(node, COMMUNITY) },
            'not a statement': { [IP]: statement(node, COMMUNITY), [NAME]: { peerId: node.peerId, communityId: COMMUNITY } },
        };
        for (const [why, answers] of Object.entries(cases)) {
            forgetFollowChecks();
            store.clear();
            const { deps } = world({ answers });
            expect(await addressFollowOffer(deps), why).toBeNull();
        }
    });

    it('an older server of the same community (fewer take-overs) is not followed; a newer one is', async () => {
        const older = world({ answers: { [IP]: statement(node, COMMUNITY, 2), [NAME]: statement(node, COMMUNITY, 1) } });
        expect(await addressFollowOffer(older.deps)).toBeNull();
        forgetFollowChecks();
        store.clear();
        const newer = world({ answers: { [IP]: statement(node, COMMUNITY, 1), [NAME]: statement(node, COMMUNITY, 2) } });
        expect(await addressFollowOffer(newer.deps)).not.toBeNull();
    });

    it('checked against who the phone first knew at its address: a number that later answers as another community offers nothing', async () => {
        // The first check of a move keeps who the phone's community is (here the new name didn't answer yet).
        const first = world({ answers: { [IP]: statement(node, COMMUNITY) } });
        expect(await addressFollowOffer(first.deps)).toBeNull();
        expect(JSON.parse(store.get(COMMUNITY_IDENTITY_KEY)!)[IP]).toEqual({ peerId: node.peerId, communityId: COMMUNITY, epoch: 0 });
        // Later the number is someone else's server, naming a name of its own, and both say so of themselves consistently.
        forgetFollowChecks();
        const stranger = nodeKey();
        const later = world({ answers: { [IP]: statement(stranger, 'f00d'), [NAME]: statement(stranger, 'f00d') } });
        expect(await addressFollowOffer(later.deps)).toBeNull();
        expect(await acceptAddressFollow({ from: IP, to: NAME, host: 'beans.example.org' }, later.deps)).toBe('not-same');
        expect(later.deps.switchTo).not.toHaveBeenCalled();
        // What was kept is not overwritten by the stranger.
        expect(JSON.parse(store.get(COMMUNITY_IDENTITY_KEY)!)[IP]).toEqual({ peerId: node.peerId, communityId: COMMUNITY, epoch: 0 });
    });

    it('a take-over at the same address raises the kept count, so its replaced server is never followed', async () => {
        const w = world({ answers: { [IP]: statement(node, COMMUNITY, 0) } });
        await addressFollowOffer(w.deps);
        forgetFollowChecks();
        w.state.answers[IP] = statement(node, COMMUNITY, 1);
        w.state.answers[NAME] = statement(node, COMMUNITY, 0);
        expect(await addressFollowOffer(w.deps)).toBeNull();
        expect(JSON.parse(store.get(COMMUNITY_IDENTITY_KEY)!)[IP].epoch).toBe(1);
    });

    it('with nothing to follow, Home asks nobody: no statement read, no profile read beyond the phone\'s own copy', async () => {
        const w = world({ prof: profile({ addresses: ['203.0.113.5'], primaryAddress: '203.0.113.5' }), answers: { [IP]: statement(node, COMMUNITY) } });
        expect(await addressFollowOffer(w.deps)).toBeNull();
        expect(w.state.asked).toEqual([]);
        expect(vi.mocked(AsyncStorage.setItem)).not.toHaveBeenCalled();
    });

    it('a number that stopped answering can still be followed to a name the phone heard of, checked against what it kept', async () => {
        store.set(COMMUNITY_IDENTITY_KEY, JSON.stringify({ [IP]: { peerId: node.peerId, communityId: COMMUNITY, epoch: 0 } }));
        const dead = world({ answers: { [NAME]: statement(node, COMMUNITY) } });
        expect(await addressFollowOffer(dead.deps)).toEqual({ from: IP, to: NAME, host: 'beans.example.org' });
        forgetFollowChecks();
        const elsewhere = world({ answers: { [NAME]: statement(nodeKey(), COMMUNITY) } });
        expect(await addressFollowOffer(elsewhere.deps)).toBeNull();
    });

    it('a number that stopped answering, with nothing kept, offers nothing (the member types the new address)', async () => {
        const { deps } = world({ answers: { [NAME]: statement(node, COMMUNITY) } });
        expect(await addressFollowOffer(deps)).toBeNull();
    });

    it('asks the two servers once an hour at most for the same offer, and again five minutes after no answer', async () => {
        const w = world({ answers: { [IP]: statement(node, COMMUNITY) } });
        expect(await addressFollowOffer(w.deps)).toBeNull();
        expect(w.state.asked).toEqual([IP, NAME]);
        // The name answers now; Home comes back into view a minute later: not asked again yet.
        w.state.answers[NAME] = statement(node, COMMUNITY);
        w.state.now += 60 * 1000;
        expect(await addressFollowOffer(w.deps)).toBeNull();
        expect(w.state.asked).toHaveLength(2);
        w.state.now += 5 * 60 * 1000;
        expect(await addressFollowOffer(w.deps)).not.toBeNull();
        expect(w.state.asked).toHaveLength(4);
        w.state.now += 30 * 60 * 1000;
        expect(await addressFollowOffer(w.deps)).not.toBeNull();
        expect(w.state.asked).toHaveLength(4);
        w.state.now += 31 * 60 * 1000;
        await addressFollowOffer(w.deps);
        expect(w.state.asked).toHaveLength(6);
    });
});

describe('never silent', () => {
    const node = nodeKey();

    it('asking for the offer switches nothing and writes no community address: only who the community is', async () => {
        const { deps, state } = world({ answers: { [IP]: statement(node, COMMUNITY), [NAME]: statement(node, COMMUNITY) } });
        expect(await addressFollowOffer(deps)).not.toBeNull();
        expect(deps.switchTo).not.toHaveBeenCalled();
        expect(deps.addSavedNode).not.toHaveBeenCalled();
        expect(deps.removeSavedNode).not.toHaveBeenCalled();
        expect(deps.markGuestNode).not.toHaveBeenCalled();
        expect(anchorWrites()).toEqual([]);
        expect(vi.mocked(AsyncStorage.setItem).mock.calls.map(([k]) => k)).toEqual([COMMUNITY_IDENTITY_KEY]);
        expect(state.anchor).toBe(IP);
        expect(communitySwitched).not.toHaveBeenCalled();
    });
});

describe('"Not now" asks again in 7 days', () => {
    const node = nodeKey();

    it('the same offer is not made for 7 days, then is', async () => {
        const w = world({ answers: { [IP]: statement(node, COMMUNITY), [NAME]: statement(node, COMMUNITY) } });
        const offer = (await addressFollowOffer(w.deps))!;
        await snoozeAddressFollow(offer, w.deps);
        expect(JSON.parse(store.get(FOLLOW_SNOOZE_KEY)!)).toEqual({ [IP]: { to: NAME, until: w.state.now + FOLLOW_SNOOZE_MS } });
        expect(FOLLOW_SNOOZE_MS).toBe(7 * DAY);
        const start = w.state.now;
        w.state.now = start + DAY;
        expect(await addressFollowOffer(w.deps)).toBeNull();
        w.state.now = start + 7 * DAY - 1;
        expect(await addressFollowOffer(w.deps)).toBeNull();
        w.state.now = start + 7 * DAY + 1;
        expect(await addressFollowOffer(w.deps)).toEqual(offer);
        expect(w.deps.switchTo).not.toHaveBeenCalled();
    });

    it('a different new address is a new offer, snoozed or not', async () => {
        const w = world({ answers: { [IP]: statement(node, COMMUNITY), [NAME]: statement(node, COMMUNITY), 'https://other.example.org': statement(node, COMMUNITY) } });
        await snoozeAddressFollow((await addressFollowOffer(w.deps))!, w.deps);
        w.state.prof = profile({ addresses: ['other.example.org'], primaryAddress: 'other.example.org' });
        expect(await addressFollowOffer(w.deps)).toEqual({ from: IP, to: 'https://other.example.org', host: 'other.example.org' });
    });
});

describe('"Use the new address": the move', () => {
    const node = nodeKey();
    const answers = () => ({ [IP]: statement(node, COMMUNITY), [NAME]: statement(node, COMMUNITY) });

    it('checks again, switches through the switch, moves the saved row with its name, and forgets "Not now"', async () => {
        const w = world({ answers: answers() });
        const offer = (await addressFollowOffer(w.deps))!;
        await snoozeAddressFollow(offer, w.deps);
        expect(await acceptAddressFollow(offer, w.deps)).toBe('moved');
        expect(w.deps.switchTo).toHaveBeenCalledTimes(1);
        expect(w.deps.switchTo).toHaveBeenCalledWith(NAME);
        expect(w.state.anchor).toBe(NAME);
        expect(w.state.saved).toEqual([{ url: NAME, alias: 'Beans Town', currencyType: 'image', currencyValue: 'bean' }]);
        expect(JSON.parse(store.get(FOLLOW_SNOOZE_KEY)!)).toEqual({});
        // Nothing to follow from the new address: no card.
        w.state.prof = profile();
        expect(await addressFollowOffer(w.deps)).toBeNull();
    });

    it('a guest visit stays a guest visit at the new address', async () => {
        const w = world({ answers: answers(), guest: [IP] });
        expect(await acceptAddressFollow((await addressFollowOffer(w.deps))!, w.deps)).toBe('moved');
        expect(w.state.guest).toContain(NAME);
        const marked = vi.mocked(w.deps.markGuestNode).mock.invocationCallOrder[0];
        expect(marked).toBeLessThan(vi.mocked(w.deps.switchTo).mock.invocationCallOrder[0]);
    });

    it('the new address changed since the card was drawn: nothing moves', async () => {
        const w = world({ answers: answers() });
        const offer = (await addressFollowOffer(w.deps))!;
        w.state.answers[NAME] = statement(nodeKey(), COMMUNITY);
        expect(await acceptAddressFollow(offer, w.deps)).toBe('not-same');
        w.state.answers[NAME] = undefined;
        expect(await acceptAddressFollow(offer, w.deps)).toBe('unreachable');
        expect(w.deps.switchTo).not.toHaveBeenCalled();
        expect(w.state.anchor).toBe(IP);
    });

    it('the phone switched community meanwhile, or the card was handed a move the rules refuse: nothing moves', async () => {
        const w = world({ answers: answers() });
        const offer = (await addressFollowOffer(w.deps))!;
        w.state.anchor = 'https://elsewhere.example.org';
        expect(await acceptAddressFollow(offer, w.deps)).toBe('gone');
        w.state.anchor = IP;
        const forged: AddressFollowOffer = { from: IP, to: 'https://evil.example.org', host: 'beans.example.org' };
        expect(await acceptAddressFollow(forged, w.deps)).toBe('not-same');
        const toPrivate: AddressFollowOffer = { from: IP, to: 'https://10.0.0.5', host: '10.0.0.5' };
        expect(await acceptAddressFollow(toPrivate, w.deps)).toBe('not-same');
        expect(w.deps.switchTo).not.toHaveBeenCalled();
    });

    it('the write is switchPhoneTo\'s: the database swapped, the address written, then communitySwitched()', async () => {
        const w = world({ answers: answers() });
        const offer = (await addressFollowOffer(w.deps))!;
        const { switchTo: _ownSwitch, ...rest } = w.deps;
        // Every dependency the test's own but the switch: the app's (utils/reconnect.ts switchPhoneTo).
        expect(await acceptAddressFollow(offer, rest)).toBe('moved');
        expect(anchorWrites()).toEqual([['beanpool_anchor_url', NAME]]);
        expect(switched).toEqual({ dbClosed: 1, dbOpened: 1, announced: 1 });
        const setItem = vi.mocked(AsyncStorage.setItem).mock;
        const anchorWrite = setItem.invocationCallOrder[setItem.calls.findIndex(([k]) => k === 'beanpool_anchor_url')];
        expect(vi.mocked(communitySwitched).mock.invocationCallOrder.at(-1)).toBeGreaterThan(anchorWrite);
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
