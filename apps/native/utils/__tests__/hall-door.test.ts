/**
 * Lights-out H2: the hall door (utils/hall.ts, utils/hall-state.ts; scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md
 * §2.3–2.5, §3.6).
 *
 * A stand-in network answers as the hall laptop and the community's own address would: each node's signed statement and
 * its signature over a nonce, made with real Ed25519 node keys, read by the app's real readers (address-follow.ts
 * fetchIdentityStatement, hall.ts attestationProves) through the real `fetch` path. The member key signs through
 * @noble/ed25519's `sign`, watched, so "nothing was signed" is measured. The move itself (utils/reconnect.ts
 * switchPhoneTo) is handed in and recorded: hall-carry.test.ts runs the real carry with hall addresses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('expo-crypto', async () => {
    const { randomBytes: rb } = await import('node:crypto');
    return { getRandomBytes: (n: number) => new Uint8Array(rb(n)) };
});
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) mem.delete(k); }),
        getAllKeys: vi.fn(async () => [...mem.keys()]),
    },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined) }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(async () => 3),
    authenticateAsync: vi.fn(async () => ({ success: true })),
}));
vi.mock('@noble/ed25519', async (orig) => {
    const real = await orig<typeof import('@noble/ed25519')>();
    return { ...real, sign: vi.fn(real.sign) };
});
// The real switch and anchor read pull in the whole database layer: the move is recorded here, the anchor kept in `mem`.
const moves = vi.hoisted(() => [] as { url: string; from: string; audienceThen: string | null }[]);
vi.mock('../reconnect', () => ({ switchPhoneTo: vi.fn() }));
vi.mock('../node-post', () => ({ anchorUrl: vi.fn(async () => mem.get('beanpool_anchor_url') ?? null) }));

import { sign as memberKeySign } from '@noble/ed25519';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { signedRequestBytes, signedRequestText } from '@beanpool/core';
import { switchPhoneTo } from '../reconnect';
import { COMMUNITY_IDENTITY_KEY } from '../address-follow';
import {
    attestationProves, enterHall, forgetHallRun, goHome, hallAddressOf, hallDepsWith, hallRouteFromSystemPath, hallTick,
    parseHallLink, type HallLink,
} from '../hall';
import { HALL_KEY, forgetHallCache, hallAudienceFor, readHall } from '../hall-state';
import { buildSignedHeaders, buildSignedWsParams } from '../crypto';
import { rememberRequestSigning } from '../request-signing-version';

// ─── Node keys, statements and attestations, as the server makes them ─────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function peerIdOf(pub: Uint8Array): string {
    const bytes = [0x00, 0x24, 0x08, 0x01, 0x12, 0x20, ...pub];
    let n = BigInt('0x' + bytesToHex(new Uint8Array(bytes)));
    let out = '';
    while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
    for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
    return out;
}
interface NodeKey { seed: Uint8Array; peerId: string; pubHex: string }
const nodeKey = (): NodeKey => {
    const seed = new Uint8Array(randomBytes(32));
    const pub = ed25519.getPublicKey(seed);
    return { seed, peerId: peerIdOf(pub), pubHex: bytesToHex(pub) };
};
/** services/identity-epoch.ts signEpochStatement. */
function statement(node: NodeKey, communityId: string, epoch: number, signer: Uint8Array = node.seed) {
    const s = { v: 1 as const, peerId: node.peerId, communityId, epoch, since: null };
    const bytes = new TextEncoder().encode('beanpool-identity-epoch-v1\n' + JSON.stringify(s));
    return { statement: s, sig: Buffer.from(ed25519.sign(bytes, signer)).toString('base64') };
}
/** services/registrar-client.ts buildAttestation (v2). */
function attestation(nonce: string, signer: Uint8Array, pubHex: string, ts = 1793750000) {
    const msg = new TextEncoder().encode(`beanpool-node-attest/v2\n${nonce}\n${ts}`);
    return { pubkey: pubHex, nonce, timestamp: ts, signature: bytesToHex(ed25519.sign(msg, signer)), proto: 'v2' };
}

const HOME = 'https://byron.beanpool.org';
const NAME = 'byron.beanpool.org';
const HALL = 'http://192.168.8.1:8080';
const COMMUNITY = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const LINK: HallLink = { at: HALL, for: NAME, id: null };

// ─── The stand-in network ──────────────────────────────────────────────────────────────────────

interface Answers { statement?: unknown; attest?: (nonce: string) => unknown; health?: unknown }
const net = { nodes: new Map<string, Answers>(), log: [] as { url: string; headers: Record<string, string> }[] };

function json(body: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

const fetchStub = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    net.log.push({ url, headers: { ...(init?.headers ?? {}) } });
    const u = new URL(url);
    const node = net.nodes.get(u.origin);
    if (!node) throw new TypeError('Network request failed');
    if (u.pathname === '/api/node/identity-epoch' && node.statement) return json(node.statement);
    if (u.pathname === '/api/attest' && node.attest) return json(node.attest(u.searchParams.get('nonce') ?? ''));
    if (u.pathname === '/api/community/health' && node.health) return json(node.health);
    return json({ error: 'not found' }, 404);
});

const signedRequests = () => net.log.filter((r) => Object.keys(r.headers).some((h) => /^x-(signature|signed-for|public-key)$/i.test(h)));

const COMMUNITY_KEY = nodeKey();
let clock = 1_793_750_000_000;

/** The phone: a member of byron.beanpool.org, which it checked once while online (address-follow keepCommunityIdentity). */
function phoneAtHome(epoch = 0) {
    mem.set('beanpool_anchor_url', HOME);
    mem.set(COMMUNITY_IDENTITY_KEY, JSON.stringify({ [HOME]: { peerId: COMMUNITY_KEY.peerId, communityId: COMMUNITY, epoch } }));
}

/** The laptop holding the community's node key, the record restored and lights-out on (epoch raised: design §2.1). */
function hallLaptop(key: NodeKey = COMMUNITY_KEY, opts: { statementKey?: NodeKey; epoch?: number; attestSigner?: NodeKey } = {}) {
    const named = opts.statementKey ?? key;
    net.nodes.set(HALL, {
        statement: statement(named, COMMUNITY, opts.epoch ?? 1, named.seed),
        attest: (nonce) => attestation(nonce, (opts.attestSigner ?? key).seed, (opts.attestSigner ?? key).pubHex),
        health: { status: 'ok', lightsOut: { on: true, since: '2026-11-04T08:00:00.000Z', address: HALL, recordAsOf: '2026-11-03T14:02:00.000Z', home: HOME } },
    });
}

async function deps() {
    return hallDepsWith({ now: () => clock });
}

beforeEach(() => {
    mem.clear();
    net.nodes.clear();
    net.log = [];
    moves.length = 0;
    forgetHallCache();
    forgetHallRun();
    (globalThis as any).fetch = fetchStub;
    vi.mocked(memberKeySign).mockClear();
    vi.mocked(switchPhoneTo).mockReset();
    vi.mocked(switchPhoneTo).mockImplementation(async (url: string, from?: string) => {
        // What the first signed request at the new address would be signed for, at the moment the address changes.
        moves.push({ url, from: from ?? '', audienceThen: await hallAudienceFor(`${url}/api/x`) });
        mem.set('beanpool_anchor_url', url);
        return 'carried';
    });
    rememberRequestSigning(HALL, 2);
    rememberRequestSigning(HOME, 2);
});

// ─── The door's link and the typed number ──────────────────────────────────────────────────────

describe('the door: the poster\'s link and the typed number', () => {
    it('reads the poster\'s link strictly, a private number only', () => {
        expect(parseHallLink('beanpool://hall?at=192.168.8.1:8080&for=byron.beanpool.org&id=12D3KooW')).toEqual({ at: HALL, for: NAME, id: '12D3KooW' });
        expect(parseHallLink('beanpool://hall?at=10.0.2.2:8080')).toEqual({ at: 'http://10.0.2.2:8080', for: null, id: null });
        expect(parseHallLink('beanpool://hall?at=192.168.2.1')).toEqual({ at: 'http://192.168.2.1', for: null, id: null });
        // A public number, a name, another scheme, a login, a `for` that isn't a bare host: not a hall.
        for (const bad of [
            'beanpool://hall?at=203.0.113.5:8080', 'beanpool://hall?at=byron.beanpool.org', 'beanpool://hall?at=javascript:alert(1)',
            'beanpool://hall?at=http://x@192.168.8.1', 'beanpool://hall?at=192.168.8.1&for=https://evil.example',
            'beanpool://hall?at=192.168.8.1&for=evil.example:443', 'beanpool://hallway?at=192.168.8.1',
        ]) expect(parseHallLink(bad), bad).toBeNull();
        expect(hallAddressOf('192.168.8.1:8080')).toBe(HALL);
        expect(hallAddressOf('http://192.168.8.1:8080/')).toBe(HALL);
        expect(hallAddressOf('8.8.8.8')).toBeNull();
    });

    it('routes the link to the hall screen, and a bare beanpool://hall to the typed door', () => {
        expect(hallRouteFromSystemPath('beanpool://hall?at=192.168.8.1:8080&for=byron.beanpool.org'))
            .toBe(`/hall?at=${encodeURIComponent(HALL)}&for=${NAME}`);
        expect(hallRouteFromSystemPath('beanpool://hall')).toBe('/hall');
        expect(hallRouteFromSystemPath('beanpool://hall?at=203.0.113.5')).toBe('/hall');
        expect(hallRouteFromSystemPath('beanpool://claim?node=x')).toBeNull();
    });
});

// ─── The check: this laptop is my community ────────────────────────────────────────────────────

describe('the check comes before anything is signed for the laptop', () => {
    it('a laptop whose statement names another node key is refused, with no signed request and no move', async () => {
        phoneAtHome();
        hallLaptop(nodeKey());
        expect(await enterHall(LINK, await deps())).toEqual({ kind: 'refused', why: 'not-same' });
        expect(signedRequests()).toEqual([]);
        expect(memberKeySign).not.toHaveBeenCalled();
        expect(switchPhoneTo).not.toHaveBeenCalled();
        expect(mem.has(HALL_KEY)).toBe(false);
        expect(await hallAudienceFor(`${HALL}/api/x`)).toBeNull();
    });

    it('a stranger\'s laptop with the community\'s own statement copied onto it fails the nonce: refused, nothing signed', async () => {
        phoneAtHome();
        const stranger = nodeKey();
        // The statement is public and genuinely the community's; the laptop can only sign the nonce with its own key.
        hallLaptop(stranger, { statementKey: COMMUNITY_KEY, attestSigner: stranger });
        expect(await enterHall(LINK, await deps())).toEqual({ kind: 'refused', why: 'not-proved' });
        // Naming the community's key in the answer doesn't help: the signature is checked against it.
        net.nodes.get(HALL)!.attest = (nonce) => ({ ...attestation(nonce, stranger.seed, stranger.pubHex), pubkey: COMMUNITY_KEY.pubHex });
        expect(await enterHall(LINK, await deps())).toEqual({ kind: 'refused', why: 'not-proved' });
        // Nor does replaying an answer the community's server gave to another nonce.
        const old = attestation('a'.repeat(32), COMMUNITY_KEY.seed, COMMUNITY_KEY.pubHex);
        net.nodes.get(HALL)!.attest = () => old;
        expect(await enterHall(LINK, await deps())).toEqual({ kind: 'refused', why: 'not-proved' });
        expect(signedRequests()).toEqual([]);
        expect(memberKeySign).not.toHaveBeenCalled();
        expect(switchPhoneTo).not.toHaveBeenCalled();
        expect(mem.has(HALL_KEY)).toBe(false);
    });

    it('an older copy of the community (fewer take-overs than the phone has seen) is refused', async () => {
        phoneAtHome(3);
        hallLaptop(COMMUNITY_KEY, { epoch: 2 });
        expect(await enterHall(LINK, await deps())).toEqual({ kind: 'refused', why: 'older' });
        expect(switchPhoneTo).not.toHaveBeenCalled();
    });

    it('a phone with nothing kept, and no answer from its own address, can\'t check the laptop: refused', async () => {
        mem.set('beanpool_anchor_url', HOME);
        hallLaptop();
        expect(await enterHall(LINK, await deps())).toEqual({ kind: 'refused', why: 'nothing-kept' });
        expect(net.log.some((r) => r.url.startsWith(HALL))).toBe(false);
    });

    it('a laptop that doesn\'t answer is said plainly', async () => {
        phoneAtHome();
        expect(await enterHall(LINK, await deps())).toEqual({ kind: 'refused', why: 'no-answer' });
    });

    it('the laptop holding the community\'s node key passes, and the phone moves to it with its copy carried', async () => {
        phoneAtHome();
        hallLaptop();
        expect(await enterHall(LINK, await deps())).toEqual({ kind: 'moved', carried: 'carried' });
        // Before the move, only plain reads went to the laptop: its statement and its signature over our nonce.
        expect(net.log.map((r) => new URL(r.url).pathname)).toEqual(['/api/node/identity-epoch', '/api/attest']);
        expect(signedRequests()).toEqual([]);
        expect(memberKeySign).not.toHaveBeenCalled();
        // The move is the carried switch, from the phone's own address; the hall was kept before the address changed.
        expect(moves).toEqual([{ url: HALL, from: HOME, audienceThen: NAME }]);
        expect(await readHall()).toEqual({ at: HALL, for: NAME, home: HOME, since: new Date(clock).toISOString() });
    });

    it('the attestation reader takes only the named key over the nonce sent', () => {
        const nonce = 'b'.repeat(32);
        const good = attestation(nonce, COMMUNITY_KEY.seed, COMMUNITY_KEY.pubHex);
        expect(attestationProves(good, nonce, COMMUNITY_KEY.peerId)).toBe(true);
        expect(attestationProves(good, 'c'.repeat(32), COMMUNITY_KEY.peerId)).toBe(false);
        expect(attestationProves({ ...good, timestamp: good.timestamp + 1 }, nonce, COMMUNITY_KEY.peerId)).toBe(false);
        expect(attestationProves({ ...good, proto: 'v9' }, nonce, COMMUNITY_KEY.peerId)).toBe(false);
        expect(attestationProves(good, nonce, nodeKey().peerId)).toBe(false);
        expect(attestationProves(null, nonce, COMMUNITY_KEY.peerId)).toBe(false);
    });
});

// ─── What the phone signs for in the hall ──────────────────────────────────────────────────────

describe('in the hall the phone signs for its community\'s name, never one a node sent', () => {
    it('requests and the socket to the laptop\'s number are signed for the community\'s name; other addresses for their own', async () => {
        phoneAtHome();
        hallLaptop();
        await enterHall(LINK, await deps());
        const me = { pub: bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(7))), priv: bytesToHex(new Uint8Array(32).fill(7)) };

        const h = await buildSignedHeaders('POST', `${HALL}/api/ledger/transfer`, '{"to":"b"}', me.priv, me.pub);
        expect(h['X-Signed-For']).toBe(NAME);
        const text = signedRequestText({ host: NAME, method: 'POST', path: '/api/ledger/transfer', timestamp: h['X-Timestamp'], nonce: h['X-Nonce'], body: '{"to":"b"}' });
        expect(ed25519.verify(Buffer.from(h['X-Signature'], 'base64'), signedRequestBytes(text), ed25519.getPublicKey(new Uint8Array(32).fill(7)))).toBe(true);

        const ws = new URLSearchParams(await buildSignedWsParams('ws://192.168.8.1:8080/ws', me.priv, me.pub));
        expect(ws.get('for')).toBe(NAME);

        // Another private number, or the community's own address, signs for its own host as before.
        expect((await buildSignedHeaders('GET', 'http://192.168.8.2:8080/api/x', '', me.priv, me.pub))['X-Signed-For']).toBe('192.168.8.2');
        expect((await buildSignedHeaders('GET', `${HOME}/api/x`, '', me.priv, me.pub))['X-Signed-For']).toBe(NAME);
    });

    it('the poster naming another community moves nothing and asks nothing', async () => {
        phoneAtHome();
        hallLaptop();
        expect(await enterHall({ ...LINK, for: 'evil.example' }, await deps())).toEqual({ kind: 'other-community', named: 'evil.example', home: NAME });
        expect(net.log).toEqual([]);
        expect(switchPhoneTo).not.toHaveBeenCalled();
    });

    it('with no name on the poster, the name signed for is still the phone\'s own', async () => {
        phoneAtHome();
        hallLaptop();
        await enterHall({ at: HALL, for: null, id: null }, await deps());
        expect(await hallAudienceFor(`${HALL}/api/x`)).toBe(NAME);
    });

    it('a health answer naming another home moves nothing and changes nothing signed', async () => {
        phoneAtHome();
        hallLaptop();
        await enterHall(LINK, await deps());
        net.nodes.get(HALL)!.health = { lightsOut: { on: false, home: 'https://evil.example' } };
        net.nodes.set('https://evil.example', { statement: statement(COMMUNITY_KEY, COMMUNITY, 5) });
        expect(await hallTick(await deps())).toBeNull();
        expect(moves).toHaveLength(1);
        expect(await hallAudienceFor(`${HALL}/api/x`)).toBe(NAME);
        expect(net.log.some((r) => r.url.startsWith('https://evil.example'))).toBe(false);
    });

    it('a hall record whose name is not its home\'s host is not used', async () => {
        mem.set(HALL_KEY, JSON.stringify({ at: HALL, for: 'evil.example', home: HOME, since: '2026-11-04T00:00:00.000Z' }));
        forgetHallCache();
        expect(await hallAudienceFor(`${HALL}/api/x`)).toBeNull();
    });
});

// ─── The banner's source and the way home ──────────────────────────────────────────────────────

describe('while in the hall, and the way home', () => {
    async function inTheHall() {
        phoneAtHome();
        hallLaptop();
        expect((await enterHall(LINK, await deps())).kind).toBe('moved');
        net.log = [];
    }

    it('a phone that never opened the door asks nothing', async () => {
        phoneAtHome();
        hallLaptop();
        expect(await hallTick(await deps())).toBeNull();
        expect(net.log).toEqual([]);
    });

    it('lights-out on: the banner has the record\'s time', async () => {
        await inTheHall();
        expect(await hallTick(await deps())).toEqual({ kind: 'in-hall', recordAsOf: '2026-11-03T14:02:00.000Z' });
    });

    it('a node with no lightsOut in its health (one from before H1) shows nothing and moves nobody', async () => {
        await inTheHall();
        net.nodes.get(HALL)!.health = { status: 'ok' };
        expect(await hallTick(await deps())).toBeNull();
        expect(moves).toHaveLength(1);
    });

    it('the switch goes off: the phone checks its own address and goes home with its copy, the hall forgotten', async () => {
        await inTheHall();
        net.nodes.get(HALL)!.health = { lightsOut: { on: false, home: HOME } };
        // Its own address answers as the community, with the take-over count the phone kept before the hall (lower than
        // the hall laptop's): the community's own server.
        net.nodes.set(HOME, { statement: statement(COMMUNITY_KEY, COMMUNITY, 0) });
        expect(await hallTick(await deps())).toEqual({ kind: 'back-home', host: NAME });
        expect(moves[1]).toEqual({ url: HOME, from: HALL, audienceThen: null });
        expect(await readHall()).toBeNull();
        expect(mem.has(HALL_KEY)).toBe(false);
        expect(await hallAudienceFor(`${HALL}/api/x`)).toBeNull();
    });

    it('the switch off but the own address not the community (or not answering): the phone stays', async () => {
        await inTheHall();
        net.nodes.get(HALL)!.health = { lightsOut: { on: false, home: HOME } };
        net.nodes.set(HOME, { statement: statement(nodeKey(), COMMUNITY, 0) });
        expect(await hallTick(await deps())).toBeNull();
        expect(moves).toHaveLength(1);
        expect((await readHall())?.at).toBe(HALL);
    });

    it('the laptop gone: its own address is asked at most once an hour, and the one card offers the move', async () => {
        await inTheHall();
        net.nodes.delete(HALL);
        // The internet isn't back yet.
        expect(await hallTick(await deps())).toEqual({ kind: 'in-hall', recordAsOf: null });
        const homeAsks = () => net.log.filter((r) => r.url.startsWith(HOME)).length;
        expect(homeAsks()).toBe(1);
        net.nodes.set(HOME, { statement: statement(COMMUNITY_KEY, COMMUNITY, 0) });
        clock += 30 * 60 * 1000;
        expect(await hallTick(await deps())).toEqual({ kind: 'in-hall', recordAsOf: null });
        expect(homeAsks()).toBe(1);
        clock += 31 * 60 * 1000;
        expect(await hallTick(await deps())).toEqual({ kind: 'home-answers', host: NAME });
        expect(homeAsks()).toBe(2);
        // Nothing moved until the member taps; then it goes home with the copy.
        expect(moves).toHaveLength(1);
        expect(await goHome(await deps())).toBe('moved');
        expect(moves[1]).toEqual({ url: HOME, from: HALL, audienceThen: null });
    });

    it('a phone that left the hall another way (a switch in Settings) forgets it', async () => {
        await inTheHall();
        mem.set('beanpool_anchor_url', HOME);
        expect(await hallTick(await deps())).toBeNull();
        expect(await readHall()).toBeNull();
    });
});
