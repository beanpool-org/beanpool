/**
 * The signed requests' nonce store holds nonces in two regions, by whose they are, and says "busy" past a share (NB1 of
 * #2038's deciding review; re-decided by Fable after each of #2359's deciding reviews:
 * scratch/fable-design/DESIGN-nonce-store-3-fable.md).
 *
 * Round 1 drew the members' region at "acts here" (isNodeMember or isLiveVisitor), so keys that cost nothing (84
 * open-door accounts on the global node, or 20 fresh keys a day a member gives a visitor's row by opening DMs) filled
 * it and every member was refused 503 (measured on 49aa3028). Now:
 *   - an ESTABLISHED member (a node role, or a member row 72 hours old; where probation is on, also off probation and not
 *     12 words alone: engine/probation.ts isEstablishedMember) spends from the rows' region, 3,000 a key, refused only
 *     when the region holds 600,000;
 *   - a NEWCOMER (a key with a row that is not established: a member in their first days, a visitor's row) spends from
 *     the same region, 600 a key, refused once the region holds 350,000 (the line), so established members keep 250,000
 *     (the reserve) no newcomer can take;
 *   - any other verified key (a STRANGER) from the strangers' region, 3,000 an address (IPv6 by its /64), 100,000
 *     together.
 * The earned test is lazy: never run while a key is under the newcomer share and the region under the line, and kept 60
 * s per key. A replay of a live nonce is still 403, and no live nonce is ever forgotten to make room.
 *
 *  1. The store (rows 6 / reserve 3 / key 2 / newKey 1 / strangers 3 / address 2), with a counting classifier: no
 *     classification on the fast path, one per key, the 60 s memo; newcomers held to their share and the line,
 *     established keys to theirs and the region, strangers as before; the counts exact through expiry and re-spends; the
 *     defaults and the shares by the gateway's allowance; the real sizes at the floor shares, as at 120 a minute (584
 *     newcomer keys reach the line, 200 established keys fill the region).
 *  2. The verifier, with stores of its own: the four sentences and the scope for the three classes; who is established
 *     (a member of 4 days, a role holder joined today) and who is not (a member joined today, a visitor's row); a replay
 *     and a forgery 403 with every region full; a route that spends no nonce never refused; a caller with no client held
 *     to one address's share; a caller with no perMinute held to the floor shares.
 *  3. Over HTTPS, the real node and the gateway limiter on at its defaults, attackers sent as X-Forwarded-For from
 *     loopback: 15 addresses with fresh keys fill the strangers' region, and a member of 4 days still writes, reads,
 *     reads publicly and opens /ws.
 *  4. One member key held to its own share while another member on the same address goes on; its refusals are charged
 *     to its own bucket, never the address's.
 *  5. The rows' region: six newcomers fill the line, a seventh is "busy with new members" (its public read answered as
 *     unsigned, its /ws 503); established members still write into the reserve until the region is full.
 *  6. "20 DM-visitor keys can't fill the members' region": a member opens DMs with 20 fresh keys; each visitor's row is
 *     held to 5, the line refuses the rest, and the established member and the owner go on.
 *  7. The alert (requests.flood): by class, counts only, formatted; cleared after the 15-minute hold.
 *  8. The security line: at most one an hour per class (2b).
 *  9. Over HTTPS at 600 a minute: the middleware and /ws pass the allowance, so a newer key is refused at 3,000 and an
 *     established one at 15,000, not at the floors.
 *
 * Fail-first: run against 49aa3028 (round 1), checks 1, 2, 5, 6 and 7 fail. Round 1 had one members' ceiling,
 * `membersMax`; the HTTPS checks set it to the rows' ceiling too (scaled()), so they measure round 1 at the same size.
 *
 * Run: node scripts/run-server-suites.mjs with SERVER_SUITES_ONLY=test-nonce-store-cap
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME; // force self-signed / LAN mode
delete process.env.NODE_PROFILE; // a local community: probation off, so established is a row 72 hours old
// The community's one name, so a format-2 request signed for it is this community's whatever the switch date.
const HOST = 'nonce-cap.test';
process.env.BEANPOOL_ADDRESSES = HOST;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { SIGNED_FOR_HEADER, signedRequestBytes, signedRequestText } from '@beanpool/core';
import { isLiveVisitor } from '@beanpool/engine';
import { db } from './db/db.js';
import { initTls } from './services/tls.js';
import { initStateEngine, registerVisitor } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } from './config/local-config.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { checkServerAlerts, resetAlertsForTests, serverAlertsBanner, setAlertsClockForTests, type AlertEvent } from './services/alerts.js';
import { noteRoomRefusal, requestNoncePressure } from './engine/nonce-pressure.js';
import * as pressure from './engine/nonce-pressure.js';
// A namespace, not named imports: so this suite runs, and counts its failures, against a verifier without some of them.
import * as sig from './engine/member-signature.js';
import type { NonceLimits, NonceSpender, NonceStore as Store, SignedRequestParts } from './engine/member-signature.js';

const { NonceStore, requestNonces, SIGNATURE_FRESHNESS_MS, verifyMemberSignature } = sig;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`  ✓ ${msg}`); } else console.log(`  ✗ ${msg}`);
}

/** A check that throws counts as one failure, and the next one still runs. */
async function section(title: string, body: () => void | Promise<void>): Promise<void> {
    console.log(`\n${title}`);
    try {
        await body();
    } catch (e) {
        assert(false, `ran to the end (threw: ${e instanceof Error ? e.message : String(e)})`);
    }
}

const W = SIGNATURE_FRESHNESS_MS;
const HOUR = 60 * 60_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const SMALL: NonceLimits = { rowsMax: 6, membersReserve: 3, keyMax: 2, newKeyMax: 1, strangersMax: 3, addressMax: 2 };
const KEY_SHARE_ERROR = 'Your app has sent more requests than this community holds at once. Please wait a minute and try again.';
const MEMBERS_FULL_ERROR = 'This community is very busy right now. Please try again in a minute.';
const NEWCOMERS_FULL_ERROR = 'This community is busy with new members right now. Please try again in a minute.';
const STRANGERS_FULL_ERROR = 'This community is busy with new visitors right now. Please try again in a minute.';

/**
 * Limits for the HTTPS checks, with round 1's one members' ceiling (`membersMax`, gone now) set to the rows' ceiling, so
 * the same check run against 49aa3028 measures round 1 at the same size. This store reads no such limit.
 */
const scaled = (limits: NonceLimits): Partial<NonceLimits> => ({ ...limits, membersMax: limits.rowsMax } as Partial<NonceLimits>);

interface Id { pubKeyHex: string; privateKey: crypto.KeyObject }

function newKey(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

let members = 0;
/** A member of this node, as test-gateway-real-client makes one, joined `daysAgo` days back: 4 is established, 0 new. */
function makeMember(daysAgo: number): Id {
    const id = newKey();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status) VALUES (?, ?, ?, 'active')`)
        .run(id.pubKeyHex, `nonce-cap-${++members}`, new Date(Date.now() - daysAgo * DAY).toISOString());
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
    return id;
}
/** A member joined today who holds a node role (`owner` or `moderator`): established by the role alone. */
function makeRoleHolder(role: 'owner' | 'moderator'): Id {
    const id = makeMember(0);
    db.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, ?, 'genesis')`).run(id.pubKeyHex, role);
    return id;
}
/** A visitor's row (registerVisitor: a key a member wrote to or paid), made today. */
function makeVisitor(): Id {
    const id = newKey();
    registerVisitor(id.pubKeyHex);
    return id;
}
const moveJoined = (id: Id, daysAgo: number) =>
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(new Date(Date.now() - daysAgo * DAY).toISOString(), id.pubKeyHex);

const freshNonce = () => crypto.randomBytes(16).toString('hex');

function sign(id: Id, method: string, path: string, ts: number, nonce: string, body: string): string {
    const text = signedRequestText({ host: HOST, method, path, timestamp: String(ts), nonce, body });
    return crypto.sign(null, Buffer.from(signedRequestBytes(text)), id.privateKey).toString('base64');
}

function parts(id: Id, nonce: string, ts: number, forged = false): SignedRequestParts {
    const body = '{"x":1}';
    return {
        pubKeyHex: id.pubKeyHex, nonce, timestamp: String(ts), method: 'POST', path: '/api/messages/mark-read', body, signedFor: HOST,
        signature: sign(id, 'POST', '/api/messages/mark-read', ts, nonce, forged ? '{"x":2}' : body),
    };
}

const heapLength = (s: Store): number => (s as unknown as { heapExp: number[] }).heapExp.length;
const ownersHeld = (s: Store): number => (s as unknown as { owners: Map<string, unknown> }).owners.size;
const storeWith = (limits: Partial<NonceLimits>): Store => new NonceStore(W, limits);

type Cls = 'member' | 'newcomer' | 'stranger';
/** The security lines about a full share, by class: a stranger's says "no account here", a newcomer's "newer account". */
const securityLines = (cls: Cls): number => (db.prepare(
    `SELECT COUNT(*) AS n FROM system_logs WHERE level = 'SECURITY' AND message LIKE '%store_full%' AND ${
        cls === 'stranger' ? "message LIKE '%no account here%'"
            : cls === 'newcomer' ? "message LIKE '%newer account%'"
                : "message NOT LIKE '%no account here%' AND message NOT LIKE '%newer account%'"}`,
).get() as { n: number }).n;

/** The verifier's answer, reduced to what these checks read. */
function verify(store: Store, p: SignedRequestParts, now: number, opts: { client?: string; consumeNonce?: boolean; perMinute?: number } = {}) {
    const v = verifyMemberSignature(p, { consumeNonce: opts.consumeNonce ?? true, nonces: store, now, client: opts.client, perMinute: opts.perMinute });
    return v.ok
        ? { ok: true as const, status: 200, code: undefined, retryAfterSec: undefined, error: '', scope: undefined, signer: undefined }
        : { ok: false as const, status: v.status, code: v.code, retryAfterSec: v.retryAfterSec, error: v.error, scope: v.scope as string | undefined, signer: v.signer };
}

// ─── 1. The store ───────────────────────────────────────────────────────────────────────────

/** Spenders for the store's checks: each rows key's classifier counts its calls in `calls`. */
function spenders() {
    const calls = { n: 0 };
    return {
        calls,
        newcomer: (i: number | string): NonceSpender => ({ region: 'rows', owner: `k:n${i}`, established: () => { calls.n++; return false; } }),
        established: (i: number | string): NonceSpender => ({ region: 'rows', owner: `k:e${i}`, established: () => { calls.n++; return true; } }),
        address: (i: number | string): NonceSpender => ({ region: 'stranger', owner: `a:${i}` }),
    };
}

function storeChecks(T0: number): void {
    const s = storeWith(SMALL);
    const { calls, newcomer: n, established: k, address: a } = spenders();
    /** One spend: null when it was stored, else why there was no room (and then nothing is stored). */
    const spend = (sp: NonceSpender, at = T0, nonce = freshNonce()): string | null => {
        const why = s.room(sp, at);
        if (why) return why;
        return s.consume(nonce, at, at, sp) ? null : 'replay';
    };

    assert(spend(n(1)) === null && calls.n === 0, `n:1's first spend is stored with no classification: under the newcomer share and the line (${calls.n} calls)`);
    assert(spend(n(1)) === 'owner' && calls.n === 1, `its second is refused at its own share of 1 after one classification, not established (${calls.n} calls)`);
    assert(spend(n(1), T0 + 30_000) === 'owner' && calls.n === 1, `a third within 60 s is refused with no further classification: the memo (${calls.n} calls)`);
    assert(spend(n(2)) === null && spend(n(3)) === null && calls.n === 1, `n:2 and n:3 spend 1 each, unclassified: the rows' region holds 3, the line (${calls.n} calls)`);
    const atLine = s.size;
    assert(spend(n(4)) === 'line' && calls.n === 2 && s.size === atLine,
        `a fourth newcomer's first spend is refused at the line though it holds nothing, after one classification, and stores nothing (${calls.n} calls)`);
    assert(spend(k(1)) === null && calls.n === 3, `k:1, established, spends at the line: one classification (${calls.n} calls)`);
    assert(spend(k(1)) === null && calls.n === 3, `its second spend asks nothing more: the answer was kept when its first nonce made its owner (${calls.n} calls)`);
    assert(spend(k(1)) === 'owner', 'its third is refused at its own share of 2');
    assert(spend(k(2)) === null && calls.n === 4, `k:2 spends 1 after one classification: the rows' region holds its 6 (${calls.n} calls)`);
    assert(spend(k(3)) === 'region' && calls.n === 5, `k:3 is refused after one classification: the rows' region is full (${calls.n} calls)`);
    assert(spend(a(1)) === null && spend(a(1)) === null, 'a:1 spends 2 with the rows\' region full: strangers spend from their own');
    assert(spend(a(1)) === 'owner', 'a:1\'s third is refused at its own share');
    assert(spend(a(2)) === null, 'a:2 spends 1: the strangers\' region holds its 3');
    assert(spend(a(3)) === 'region', 'a:3 is refused: the strangers\' region is full though a:3 has spent nothing');
    const c = s.counts() as unknown as Record<string, { live: number; owners: number }>;
    assert(c.rows?.live === 6 && c.rows.owners === 5 && c.stranger?.live === 3 && c.stranger.owners === 2,
        `counts: rows 6 from 5 keys, strangers 3 from 2 addresses (${JSON.stringify(c)})`);
    assert(s.size === 9 && heapLength(s) === 9, `the map and the heap hold one entry each per live nonce (map ${s.size}, heap ${heapLength(s)})`);
    assert(spend(n(1), T0 + 61_000) === 'owner' && calls.n === 6, `past 60 s n:1 is classified again (${calls.n} calls)`);

    const p = s.pressure() as unknown as Record<string, { ownerAt: number | null; ownerRefusals: number; regionAt: number | null; regionRefusals: number; live: number; owners: number; ceiling: number; share: number }>;
    assert(p.newcomer?.ownerRefusals === 3 && p.newcomer.regionAt === T0 && p.newcomer.regionRefusals === 1,
        `pressure(): the newcomers' refusals, 3 at their share and 1 at the line (${JSON.stringify(p.newcomer)})`);
    assert(p.newcomer?.ceiling === 3 && p.newcomer.share === 1, 'with the line as their ceiling and their share of 1');
    assert(p.member?.ownerAt === T0 && p.member.ownerRefusals === 1 && p.member.regionAt === T0 && p.member.regionRefusals === 1
        && p.member.live === 6 && p.member.owners === 5 && p.member.ceiling === 6 && p.member.share === 2,
        `pressure(): the established members' refusals, the region's count and owners, its ceiling and their share (${JSON.stringify(p.member)})`);
    assert(p.stranger?.ownerRefusals === 1 && p.stranger.regionRefusals === 1 && p.stranger.live === 3 && p.stranger.owners === 2,
        `pressure(): the strangers' likewise (${JSON.stringify(p.stranger)})`);
    const since = (cls: 'member' | 'newcomer') => (pressure.keysAtShareSince as unknown as (p: unknown, since: number, cls: string) => number)(s.pressure(), T0, cls);
    assert(since('newcomer') === 1 && since('member') === 1, `keys at their share, by class: 1 newcomer, 1 member (${since('newcomer')}, ${since('member')})`);

    // A nonce string re-spent after its expiry, by another owner, before any sweep popped it.
    const t = T0 + W + 2;
    const x = new NonceStore(W);
    x.consume('same', T0, T0, n(9));
    assert(x.consume('same', t, t, a(9)), 'a nonce re-spent after its expiry by another owner is accepted');
    const xc = x.counts() as unknown as Record<string, { live: number; owners: number }>;
    assert(xc.rows?.live === 0 && xc.rows.owners === 0 && xc.stranger?.live === 1 && xc.stranger.owners === 1 && heapLength(x) === 1 && x.size === 1,
        `it moved the counts to its new owner and left one heap pair (${JSON.stringify(xc)}, heap ${heapLength(x)})`);

    s.prune(t + 61_000);
    const z = s.counts() as unknown as Record<string, { live: number; owners: number }>;
    assert(z.rows?.live === 0 && z.rows.owners === 0 && z.stranger?.live === 0 && z.stranger.owners === 0,
        `past the window every count is 0 (${JSON.stringify(z)})`);
    assert(ownersHeld(s) === 0 && heapLength(s) === 0 && s.size === 0, `the owners, the heap and the map are empty (${ownersHeld(s)}, ${heapLength(s)}, ${s.size})`);
    assert(spend(a(3), t + 61_000) === null && spend(k(3), t + 61_000) === null && spend(n(4), t + 61_000) === null, 'and every region has room again');

    const limits = new NonceStore(W).limits as unknown as Record<string, number>;
    assert(limits.rowsMax === 600_000 && limits.membersReserve === 250_000 && limits.keyMax === 3_000 && limits.newKeyMax === 600
        && limits.strangersMax === 100_000 && limits.addressMax === 3_000 && !('membersMax' in limits),
        `the default limits: rows 600,000 with 250,000 kept for established members, a key 3,000, a newer key 600, strangers 100,000, an address 3,000 (${JSON.stringify(limits)})`);
    const keyShare = sig.nonceKeyShare as ((pm: number) => number) | undefined;
    const newShare = (sig as unknown as { nonceNewKeyShare?: (pm: number) => number }).nonceNewKeyShare;
    assert(keyShare?.(120) === 3_000 && keyShare(600) === 15_000 && newShare?.(120) === 600 && newShare(600) === 3_000,
        `the shares by the gateway's minute allowance: a key 25 ×, at least 3,000; a newer key 5 ×, at least 600 (${keyShare?.(120)}, ${keyShare?.(600)}, ${newShare?.(120)}, ${newShare?.(600)})`);

    // The real sizes. Newcomers: 583 keys store 600 each, the 584th the last 200 of the line, with 400 of its share to spare.
    const big = new NonceStore(W);
    const r = spenders();
    /** What each newcomer key stored before its first refusal, and why it was refused. */
    const storedBy: number[] = [], whyStopped: string[] = [];
    for (let key = 0; key < 600; key++) {
        let mine = 0, why: string | null = null;
        for (; mine <= 600 && !(why = big.room(r.newcomer(key), T0)); mine++) big.consume(`n-${key}-${mine}`, T0, T0, r.newcomer(key));
        if (mine === 0) break;
        storedBy.push(mine);
        whyStopped.push(String(why));
    }
    const bc = () => (big.counts() as unknown as Record<string, { live: number; owners: number }>).rows?.live;
    const first583 = storedBy.slice(0, 583).every((n) => n === 600) && whyStopped.slice(0, 583).every((w) => w === 'owner');
    assert(storedBy.length === 584 && first583 && storedBy[583] === 200 && whyStopped[583] === 'line' && bc() === 350_000,
        `584 newcomer keys reach the line: 583 store their 600 each, the 584th 200 with 400 to spare (${storedBy.length} keys, the last ${storedBy[583]} then ${whyStopped[583]}, rows ${bc()})`);
    assert(big.room(r.newcomer(600), T0) === 'line', 'a 585th newcomer is refused at the line');
    assert(r.calls.n <= 600, `with one classification for each key at its share or the line, ${r.calls.n} in all for 600,000-odd spends`);
    assert(big.room(r.established(0), T0) === null, 'an established key still has room: the reserve');
    const full = new NonceStore(W);
    let estRefused = 0;
    for (let key = 0; key < 200; key++) {
        for (let i = 0; i < 3_000; i++) {
            if (full.room(r.established(key), T0)) { estRefused++; break; }
            full.consume(`e-${key}-${i}`, T0, T0, r.established(key));
        }
    }
    assert(estRefused === 0 && full.room(r.established(0), T0) === 'owner' && full.room(r.established(200), T0) === 'region',
        `200 established keys at 3,000 fill the rows' region of 600,000 with none refused before; a key holds 3,000 (${estRefused} refused early)`);
    assert(full.room(r.established(200), T0 + W + 2) === null && big.room(r.newcomer(600), T0 + W + 2) === null, 'until they expire');
}

// ─── 2. The verifier ────────────────────────────────────────────────────────────────────────

function verifierChecks(T0: number): void {
    const s = storeWith(SMALL);
    const t = T0 + 1000;
    const okStranger = (client: string) => verify(s, parts(newKey(), freshNonce(), t), t, { client });

    const s1 = [okStranger('c1'), okStranger('c1')];
    assert(s1.every((v) => v.ok), `a stranger address spends its share of 2 (${s1.map((v) => v.status)})`);
    const kept = parts(newKey(), freshNonce(), t);
    const keptStatus = verify(s, kept, t, { client: 'c2' }).status;
    const own = okStranger('c1');
    assert(!own.ok && own.status === 503 && own.code === 'store_full' && own.retryAfterSec === 60,
        `its third, with a fresh key, is 503 store_full, 60 s (got ${own.status} ${own.code ?? ''} ${own.retryAfterSec})`);
    assert(own.error === STRANGERS_FULL_ERROR && own.scope === 'stranger', `in the strangers' words, scope stranger ("${own.error}", ${own.scope})`);
    assert(keptStatus === 200, 'another address spends 1: the strangers\' region holds its 3');
    const region = okStranger('c3');
    assert(!region.ok && region.status === 503 && region.error === STRANGERS_FULL_ERROR,
        `a third address is 503 in the same words: the strangers' region is full (got ${region.status} "${region.error}")`);

    const N = makeMember(0), N2 = makeMember(0), N3 = makeMember(0), V = makeVisitor(), E = makeMember(4), R = makeRoleHolder('moderator');
    const n1 = verify(s, parts(N, freshNonce(), t), t, { client: 'c1' });
    const nFull = verify(s, parts(N, freshNonce(), t), t, { client: 'c9' });
    assert(n1.ok && !nFull.ok && nFull.status === 503 && nFull.error === KEY_SHARE_ERROR && nFull.retryAfterSec === 60,
        `a member joined today on that full address spends its newcomer share of 1; its second is 503 in the words for its own app (${n1.status}, ${nFull.status} "${nFull.error}")`);
    assert(nFull.scope === 'newcomer' && nFull.signer === N.pubKeyHex, `with scope newcomer and the signer (${nFull.scope}, ${nFull.signer?.slice(0, 8)})`);
    const v1 = verify(s, parts(V, freshNonce(), t), t, { client: 'c9' });
    const n2 = verify(s, parts(N2, freshNonce(), t), t, { client: 'c9' });
    assert(v1.ok && n2.ok, `a visitor's row and another member joined today spend 1 each: the rows' region holds 3, the line (${v1.status}, ${n2.status})`);
    const vFull = verify(s, parts(V, freshNonce(), t), t, { client: 'c9' });
    assert(!vFull.ok && vFull.error === KEY_SHARE_ERROR && vFull.scope === 'newcomer', `the visitor's row is a newcomer: its second is refused at its share of 1 (${vFull.status} ${vFull.scope})`);
    const line = verify(s, parts(N3, freshNonce(), t), t, { client: 'c9' });
    assert(!line.ok && line.status === 503 && line.error === NEWCOMERS_FULL_ERROR && line.retryAfterSec === 60 && line.scope === 'newcomer',
        `a third member joined today is 503 "busy with new members": the line (got ${line.status} "${line.error}" ${line.scope})`);
    const e = [0, 1].map(() => verify(s, parts(E, freshNonce(), t), t, { client: 'c9' }));
    assert(e.every((v) => v.ok), `a member of 4 days spends its share of 2 past the line: established, it spends from the reserve (${e.map((v) => v.status)})`);
    const eFull = verify(s, parts(E, freshNonce(), t), t, { client: 'c9' });
    assert(!eFull.ok && eFull.error === KEY_SHARE_ERROR && eFull.scope === 'member' && eFull.signer === E.pubKeyHex,
        `its third is 503 in the words for its own app, scope member (${eFull.status} ${eFull.scope})`);
    const r1 = verify(s, parts(R, freshNonce(), t), t, { client: 'c9' });
    const busy = verify(s, parts(R, freshNonce(), t), t, { client: 'c9' });
    assert(r1.ok && !busy.ok && busy.status === 503 && busy.error === MEMBERS_FULL_ERROR && busy.scope === 'member',
        `a moderator joined today is established by the role: it spends past the line, and its second is 503 "very busy", the region full, not its share (${r1.status}, ${busy.status} "${busy.error}" ${busy.scope})`);

    const s3 = storeWith(SMALL);
    moveJoined(N, 4);
    const moved = [0, 1, 2].map(() => verify(s3, parts(N, freshNonce(), t), t, { client: 'c1' }));
    assert(moved[0].ok && moved[1].ok && !moved[2].ok && moved[2].scope === 'member',
        `the member joined today, its join moved 4 days back, is established: 2 spent, the third refused as a member's (${moved.map((v) => `${v.status} ${v.scope ?? ''}`).join(', ')})`);

    // Every region full now.
    const replay = verify(s, kept, t, { client: 'c2' });
    assert(!replay.ok && replay.status === 403 && /replay/i.test(replay.error), `a replay of a live nonce is still 403 replay, not busy (got ${replay.status} ${replay.error})`);
    const memberNonce = freshNonce();
    const s2 = storeWith(SMALL);
    verify(s2, parts(E, memberNonce, t), t);
    verify(s2, parts(E, freshNonce(), t), t);
    const memberReplay = verify(s2, parts(E, memberNonce, t), t);
    assert(!memberReplay.ok && memberReplay.status === 403, `a member's replay with its own share full is 403 too (got ${memberReplay.status})`);
    const forged = verify(s, parts(newKey(), freshNonce(), t, true), t, { client: 'c4' });
    assert(!forged.ok && forged.status === 403 && /signature/i.test(forged.error), `a forged request keeps its own answer (got ${forged.status} ${forged.error})`);
    const unspent = verify(s, parts(newKey(), freshNonce(), t), t, { client: 'c4', consumeNonce: false });
    assert(unspent.ok, `a route that spends no nonce (the redeem routes) is not refused (got ${unspent.status} ${unspent.error})`);
    assert(s.size === 9, `none of these stored anything (size ${s.size})`);

    const anon = storeWith(SMALL);
    const noClient = [0, 1, 2].map(() => verify(anon, parts(newKey(), freshNonce(), t), t).status);
    assert(noClient[0] === 200 && noClient[1] === 200 && noClient[2] === 503,
        `a caller that passes no client is held to one address's share, every key together (${noClient.join(', ')})`);

    // A store's own limits (not a suite's fixed ones) follow the gateway's minute allowance when the caller gives it.
    const floors = new NonceStore(W, { rowsMax: 100, membersReserve: 50, keyMax: 2, newKeyMax: 1 } as Partial<NonceLimits>);
    const A = makeMember(0), B = makeMember(0);
    const noPm = [0, 1].map(() => verify(floors, parts(A, freshNonce(), t), t, { client: 'c5' }).status);
    const pm = Array.from({ length: 6 }, () => verify(floors, parts(B, freshNonce(), t), t, { client: 'c5', perMinute: 1 }).status);
    assert(noPm.join(' ') === '200 503' && pm.join(' ') === '200 200 200 200 200 503',
        `a caller with no perMinute gets the floor share (1 for a newcomer: ${noPm.join(' ')}); one passing 1 a minute gets 5 × it (${pm.join(' ')})`);

    const later = t + W + 2; // past the expiry of every nonce spent at t (t + W + 1)
    const again = verify(s, parts(newKey(), freshNonce(), later), later, { client: 'c3' });
    assert(again.ok, `once the nonces have expired a stranger is accepted again (got ${again.status} ${again.error})`);
}

function securityLineChecks(first: number, before: Record<Cls, number>): void {
    const grew = (cls: Cls) => securityLines(cls) - before[cls];
    assert(grew('stranger') === 1 && grew('newcomer') === 1 && grew('member') === 1,
        `the first refusals wrote one line each for strangers, newcomers and members (${grew('stranger')}, ${grew('newcomer')}, ${grew('member')})`);
    const newcomer = makeMember(0);
    /** One refusal at `at` of `cls`, from a store whose shares are 1. */
    const trip = (cls: 'stranger' | 'newcomer', at: number): number => {
        const s = storeWith({ ...SMALL, addressMax: 1, newKeyMax: 1 });
        const id = () => (cls === 'stranger' ? newKey() : newcomer);
        verify(s, parts(id(), freshNonce(), at), at, { client: 'z' });
        return verify(s, parts(id(), freshNonce(), at), at, { client: 'z' }).status;
    };
    const statuses = [first + MINUTE, first + 30 * MINUTE, first + HOUR - 1].flatMap((at) => [trip('stranger', at), trip('newcomer', at)]);
    assert(statuses.every((st) => st === 503), `refused within the hour (${statuses.join(', ')})`);
    assert(grew('stranger') === 1 && grew('newcomer') === 1, `no second strangers' or newcomers' line within the hour (${grew('stranger')}, ${grew('newcomer')})`);
    trip('stranger', first + HOUR);
    trip('newcomer', first + HOUR);
    assert(grew('stranger') === 2 && grew('newcomer') === 2, `a second one each an hour after the first (${grew('stranger')}, ${grew('newcomer')})`);
    for (let i = 1; i <= 50; i++) { trip('stranger', first + HOUR + i * 1000); trip('newcomer', first + HOUR + i * 1000); }
    assert(grew('stranger') === 2 && grew('newcomer') === 2, `50 more refusals of each in that hour write none (${grew('stranger')}, ${grew('newcomer')})`);
    assert(grew('member') === 1, 'nor do they write a members\' line');
    const newcomerLine = (db.prepare(`SELECT message FROM system_logs WHERE level = 'SECURITY' AND message LIKE '%newer account%' ORDER BY rowid DESC LIMIT 1`).get() as { message: string } | undefined)?.message ?? '';
    assert(!!newcomerLine && !newcomerLine.includes(newcomer.pubKeyHex.slice(0, 12)), 'a newcomer\'s line names no key (a visitor\'s key is somebody else\'s)');
}

// ─── HTTPS ──────────────────────────────────────────────────────────────────────────────────

let BASE = '';
interface Answer { status: number; retryAfter: string | null; error?: string; code?: string }

/** A request from `ip` (X-Forwarded-For from loopback, which the node trusts), signed by `id` when given. */
async function request(id: Id | null, method: 'GET' | 'POST', path: string, ip: string, body = ''): Promise<Answer> {
    const headers: Record<string, string> = { 'X-Forwarded-For': ip };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now(), nonce = freshNonce();
        Object.assign(headers, {
            'X-Public-Key': id.pubKeyHex, 'X-Timestamp': String(ts), 'X-Nonce': nonce, [SIGNED_FOR_HEADER]: HOST,
            'X-Signature': sign(id, method, path.split('?')[0], ts, nonce, body),
        });
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? body : undefined });
    let json: { error?: string; code?: string } = {};
    try { json = await res.json(); } catch { /* no json */ }
    return { status: res.status, retryAfter: res.headers.get('retry-after'), error: json.error, code: json.code };
}

const WRITE_PATH = '/api/notices/seen';
const WRITE_BODY = JSON.stringify({ ids: ['nonce-cap'] });
const write = (id: Id, ip: string) => request(id, 'POST', WRITE_PATH, ip, WRITE_BODY);

/** A /ws upgrade from `ip`, with a connect token signed by `id` (none when null). */
function socket(id: Id | null, ip: string): Promise<{ opened: boolean; status: number }> {
    return new Promise((resolve) => {
        let query = '';
        if (id) {
            const ts = Date.now(), nonce = freshNonce();
            query = `?pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sign(id, 'WS', '/ws', ts, nonce, ''))}&for=${HOST}&v=2`;
        }
        const ws = new WebSocket(`${BASE.replace('https', 'wss')}/ws${query}`, { rejectUnauthorized: false, headers: { 'X-Forwarded-For': ip } });
        ws.on('open', () => { ws.close(); resolve({ opened: true, status: 101 }); });
        ws.on('unexpected-response', (_req, res) => { resolve({ opened: false, status: res.statusCode ?? 0 }); res.resume(); });
        ws.on('error', () => resolve({ opened: false, status: 0 }));
    });
}

/** Every nonce forgotten (each expires within 10 minutes), the gateway's counts cleared: a check starts from nothing. */
function freshNode(maxRequestsPerMinute = 120): void {
    requestNonces.prune(Date.now() + 11 * MINUTE);
    resetGatewayRateLimit();
    updateGatewayConfig({ rateLimiting: { ...DEFAULT_GATEWAY_CONFIG.rateLimiting, enabled: true, maxRequestsPerMinute } });
}

/** The store's counts by region; NaN for a region a store (round 1's) does not have, so a check reads on past it. */
const liveCounts = () => {
    const c = requestNonces.counts() as unknown as Partial<Record<'rows' | 'stranger', { live: number; owners: number }>>;
    const none = { live: NaN, owners: NaN };
    return { rows: c.rows ?? none, stranger: c.stranger ?? none };
};
const attacker = (n: number) => `198.51.100.${n}`;

async function fifteenAddressesCheck(): Promise<void> {
    freshNode();
    requestNonces.setLimitsForTests(scaled({ rowsMax: 200, membersReserve: 100, keyMax: 20, newKeyMax: 5, strangersMax: 300, addressMax: 30 }));
    const lines = securityLines('stranger');
    const stored: number[] = [];
    let firstRefused = 0, wrongRefusal = 0;
    for (let n = 1; n <= 15; n++) {
        let ok = 0;
        for (let i = 0; i < 40; i++) {
            const r = await write(newKey(), attacker(n));
            if (r.status !== 503) { ok++; continue; }
            if (i === 0) firstRefused++;
            if (r.code !== 'store_full' || r.retryAfter !== '60' || r.error !== STRANGERS_FULL_ERROR) wrongRefusal++;
        }
        stored.push(ok);
    }
    assert(stored.every((n) => n <= 30), `each address stored at most its share of 30 (${stored.join(' ')})`);
    assert(liveCounts().stranger.live === 300, `the strangers' region holds its 300 (${liveCounts().stranger.live})`);
    assert(firstRefused === 5, `addresses 11 to 15 were refused from their first request (${firstRefused})`);
    assert(wrongRefusal === 0, `every refusal was 503 store_full, Retry-After 60, in the strangers' words (${wrongRefusal} not)`);

    const member = makeMember(4);
    const home = '203.0.113.7';
    const w = await write(member, home);
    assert(w.status === 200, `a member's signed write reaches its route (got ${w.status} ${w.error ?? ''})`);
    const gated = await request(member, 'GET', '/api/members', home);
    assert(gated.status === 200, `its gated read (/api/members) is 200 (got ${gated.status} ${gated.error ?? ''})`);
    const health = await request(member, 'GET', '/api/community/health', home);
    assert(health.status === 200, `its signed public read (/api/community/health) is 200 (got ${health.status})`);
    const rowsLive = liveCounts().rows.live;
    const ws = await socket(member, home);
    assert(ws.opened, `its /ws opens (status ${ws.status})`);
    assert(liveCounts().rows.live === rowsLive + 1, 'as a member\'s: its token was spent in the rows\' region');

    const sixteenth = attacker(16);
    const strangerLive = liveCounts().stranger.live;
    const pub = await request(newKey(), 'GET', '/api/community/health', sixteenth);
    assert(pub.status === 200, `a stranger's signed public read is answered as unsigned, 200 (got ${pub.status} ${pub.error ?? ''})`);
    const sw = await write(newKey(), sixteenth);
    assert(sw.status === 503 && sw.code === 'store_full', `a stranger's signed write from a 16th address is 503 (got ${sw.status} ${sw.code ?? ''})`);
    const sws = await socket(newKey(), sixteenth);
    assert(sws.opened, `a stranger's /ws token opens as unsigned, not 503, not 401 (status ${sws.status})`);
    assert(liveCounts().stranger.live === strangerLive, `none of the three stored a nonce (${strangerLive} → ${liveCounts().stranger.live})`);

    // M-4 still holds for a public read answered as unsigned: fresh keys buy no more than the address's 120 a minute.
    const reads: number[] = [];
    for (let i = 0; i < 121; i++) reads.push((await request(newKey(), 'GET', '/api/version', attacker(17))).status);
    assert(reads.slice(0, 120).every((st) => st === 200) && reads[120] === 429,
        `a 17th address's 121 signed public reads with fresh keys: 120 answered, the 121st 429 (${reads.filter((st) => st === 200).length} answered, last ${reads[120]})`);

    requestNonces.prune(Date.now() + 11 * MINUTE);
    const after = await write(newKey(), sixteenth);
    assert(after.status !== 503, `once the nonces have expired the 16th address is accepted (got ${after.status})`);
    assert(securityLines('stranger') === lines + 1, `one security line for all of it (${securityLines('stranger') - lines})`);
}

async function oneMemberKeyCheck(): Promise<void> {
    freshNode(30);
    requestNonces.setLimitsForTests(scaled({ rowsMax: 600_000, membersReserve: 250_000, keyMax: 20, newKeyMax: 5, strangersMax: 100_000, addressMax: 3_000 }));
    const lines = securityLines('member');
    const A = makeMember(4), B = makeMember(4);
    const hall = '192.0.2.44';
    const answers: Answer[] = [];
    for (let i = 0; i < 25; i++) answers.push(await write(A, hall));
    const ok = answers.filter((r) => r.status === 200).length;
    const refused = answers.filter((r) => r.status === 503 && r.code === 'store_full' && r.retryAfter === '60' && r.error === KEY_SHARE_ERROR).length;
    assert(ok === 20 && refused === 5, `member A's 25 writes: 20 reach the route, 5 are 503 in the words for its own app (${ok} ok, ${refused} refused; ${answers.map((r) => r.status).join(' ')})`);
    const b = await write(B, hall);
    assert(b.status === 200, `member B on the same address is accepted (got ${b.status} ${b.error ?? ''})`);
    const wsA = await socket(A, hall);
    assert(!wsA.opened && wsA.status === 503, `A's /ws is turned away 503, busy (opened ${wsA.opened}, status ${wsA.status})`);
    const wsB = await socket(B, hall);
    assert(wsB.opened, `B's /ws opens (status ${wsB.status})`);
    const reads: number[] = [];
    for (let i = 0; i < 31; i++) reads.push((await request(null, 'GET', '/api/version', hall)).status);
    assert(reads.slice(0, 30).every((st) => st === 200) && reads[30] === 429,
        `30 unsigned public reads from that address are 200 and the 31st 429: A's refusals were charged to A, not the address (${reads.join(' ')})`);
    assert(securityLines('member') === lines + 1, `one members' security line (${securityLines('member') - lines})`);
    const line = db.prepare(`SELECT message FROM system_logs WHERE level = 'SECURITY' AND message LIKE '%store_full%' ORDER BY rowid DESC LIMIT 1`).get() as { message: string } | undefined;
    assert(!!line && line.message.includes(A.pubKeyHex.slice(0, 12)) && !line.message.includes(A.pubKeyHex.slice(0, 13)),
        'which names the member\'s key by its first 12 characters only');
}

async function rowsRegionCheck(): Promise<void> {
    freshNode();
    requestNonces.setLimitsForTests(scaled({ rowsMax: 60, membersReserve: 30, keyMax: 20, newKeyMax: 5, strangersMax: 100_000, addressMax: 3_000 }));
    const newcomers = Array.from({ length: 7 }, () => makeMember(0));
    let ok = 0;
    for (const [i, n] of newcomers.slice(0, 6).entries()) for (let j = 0; j < 5; j++) if ((await write(n, `192.0.2.${70 + i}`)).status === 200) ok++;
    assert(ok === 30 && liveCounts().rows.live === 30, `six members joined today write 5 each: the rows' region holds 30, the line (${ok} ok, ${liveCounts().rows.live} live)`);
    const seventh = newcomers[6];
    const s = await write(seventh, '192.0.2.77');
    assert(s.status === 503 && s.code === 'store_full' && s.error === NEWCOMERS_FULL_ERROR && s.retryAfter === '60',
        `a seventh's first write is 503 "busy with new members" (got ${s.status} "${s.error ?? ''}")`);
    const pub = await request(seventh, 'GET', '/api/community/health', '192.0.2.77');
    assert(pub.status === 200 && liveCounts().rows.live === 30, `its signed public read is answered as unsigned, 200, nothing stored (got ${pub.status}, ${liveCounts().rows.live} live)`);
    const ws = await socket(seventh, '192.0.2.77');
    assert(!ws.opened && ws.status === 503, `its /ws is 503 (opened ${ws.opened}, status ${ws.status})`);
    const E1 = makeMember(4), E2 = makeMember(4), E3 = makeMember(4);
    let est = 0;
    for (let i = 0; i < 20; i++) if ((await write(E1, '192.0.2.81')).status === 200) est++;
    for (let i = 0; i < 10; i++) if ((await write(E2, '192.0.2.82')).status === 200) est++;
    assert(est === 30 && liveCounts().rows.live === 60, `two members of 4 days write 20 and 10 past the line, from the reserve: the region holds its 60 (${est} ok, ${liveCounts().rows.live} live)`);
    const e3 = await write(E3, '192.0.2.83');
    assert(e3.status === 503 && e3.error === MEMBERS_FULL_ERROR && e3.retryAfter === '60', `a third member of 4 days is 503 "very busy": the region is full (got ${e3.status} "${e3.error ?? ''}")`);
    const stranger = await write(newKey(), '192.0.2.84');
    assert(stranger.status !== 503, `a stranger is still accepted: its region is its own (got ${stranger.status})`);
    requestNonces.prune(Date.now() + 11 * MINUTE);
    const after = await write(seventh, '192.0.2.77');
    assert(after.status === 200, `once the nonces have expired the seventh newcomer writes (got ${after.status} ${after.error ?? ''})`);
}

async function dmVisitorsCheck(): Promise<void> {
    freshNode();
    requestNonces.setLimitsForTests(null);
    const E = makeMember(4), O = makeRoleHolder('owner');
    const home = '203.0.113.90';
    const visitors = Array.from({ length: 21 }, () => newKey());
    const opened: { status: number; id?: string }[] = [];
    for (const v of visitors) {
        const body = JSON.stringify({ type: 'dm', participants: [E.pubKeyHex, v.pubKeyHex], createdBy: E.pubKeyHex });
        const ts = Date.now(), nonce = freshNonce();
        const res = await fetch(`${BASE}/api/messages/conversation`, {
            method: 'POST', body,
            headers: {
                'Content-Type': 'application/json', 'X-Forwarded-For': home, 'X-Public-Key': E.pubKeyHex, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
                [SIGNED_FOR_HEADER]: HOST, 'X-Signature': sign(E, 'POST', '/api/messages/conversation', ts, nonce, body),
            },
        });
        let json: { conversation?: { id?: string } } = {};
        try { json = await res.json(); } catch { /* no json */ }
        opened.push({ status: res.status, id: json.conversation?.id });
    }
    assert(opened.slice(0, 20).every((o) => o.status === 200 && !!o.id) && opened[20].status === 429,
        `a member of 4 days opens DMs with 20 fresh keys, and the 21st is 429 (W-main) (${opened.map((o) => o.status).join(' ')})`);
    const live = visitors.slice(0, 20).filter((v) => isLiveVisitor(db, v.pubKeyHex)).length;
    assert(live === 20, `each of the 20 has a visitor's row (isLiveVisitor: ${live})`);

    freshNode();
    requestNonces.setLimitsForTests(scaled({ rowsMax: 60, membersReserve: 30, keyMax: 20, newKeyMax: 5, strangersMax: 100_000, addressMax: 3_000 }));
    const strangersBefore = liveCounts().stranger.live;
    const seen: string[] = [];
    let firstSixRight = 0, restRight = 0;
    for (const [i, v] of visitors.slice(0, 20).entries()) {
        const answers: Answer[] = [];
        for (let j = 0; j < 6; j++) answers.push(await request(v, 'GET', `/api/messages/${opened[i].id}`, `192.0.2.${100 + i}`));
        seen.push(answers.map((a) => a.status).join(','));
        if (i < 6) {
            if (answers.slice(0, 5).every((a) => a.status === 200) && answers[5].status === 503 && answers[5].error === KEY_SHARE_ERROR) firstSixRight++;
        } else if (answers.every((a) => a.status === 503 && a.error === NEWCOMERS_FULL_ERROR)) restRight++;
    }
    assert(firstSixRight === 6, `visitors 1 to 6 each read their own conversation 5 times, and the 6th is 503 in the words for their own app (${seen.slice(0, 6).join(' | ')})`);
    assert(restRight === 14, `from the seventh visitor on, the first read is 503 "busy with new members": the line (${seen.slice(6, 9).join(' | ')} …)`);
    assert(liveCounts().rows.live === 30 && liveCounts().stranger.live === strangersBefore,
        `the rows' region holds the line's 30 and the strangers' count never moved: visitors spend from the rows' region (${liveCounts().rows.live}, ${strangersBefore} → ${liveCounts().stranger.live})`);
    for (const [who, id, ip] of [['the member', E, home], ['the owner', O, '203.0.113.91']] as const) {
        const w = await write(id, ip);
        const g = await request(id, 'GET', '/api/members', ip);
        const ws = await socket(id, ip);
        assert(w.status === 200 && g.status === 200 && ws.opened, `${who}'s write is 200, /api/members 200, /ws opens (${w.status} ${w.error ?? ''}, ${g.status}, ${ws.status})`);
    }

    // Under the real limits: one member's 20 new people a day hold 20 × 600, a 29th of the line, none of the reserve.
    const real = new NonceStore(W);
    const { newcomer, established } = spenders();
    let held = 0, wrong = 0;
    const T = Date.now();
    for (let v = 0; v < 20; v++) {
        for (let i = 0; i <= 600; i++) {
            const why = real.room(newcomer(`v${v}`), T);
            if (why) { if (why !== 'owner' || i !== 600) wrong++; break; }
            real.consume(`v-${v}-${i}`, T, T, newcomer(`v${v}`));
            held++;
        }
    }
    const rows = (real.counts() as unknown as Record<string, { live: number }>).rows?.live;
    assert(held === 12_000 && rows === 12_000 && wrong === 0 && rows * 29 < 350_000 && real.room(established('m'), T) === null,
        `under the real limits the 20 visitors hold 12,000, each refused at its 600: a 29th of the 350,000 line, the reserve untouched (${held} held, rows ${rows})`);
}

/**
 * 9. The middleware and /ws pass the gateway's allowance to the store (#2359 review of 087685cd: every other HTTPS check
 * runs at 120 or 30, where the shares are the floors, so a caller that dropped it stayed green). At 600 a minute, the
 * manager's "Standard", a newer key's share is 3,000 and an established one's 15,000. Each key's nonces but its last two
 * are spent straight into the store; those two go over HTTPS, a write and a /ws token, and the next of each is refused
 * at its share. A caller that passed 120, or nothing, would refuse the first write: the floors are 600 and 3,000.
 */
async function allowanceCheck(): Promise<void> {
    freshNode(600);
    requestNonces.setLimitsForTests(null);
    const now = Date.now();
    const keys = [
        { who: 'a member joined today', id: makeMember(0), cls: 'newcomer', share: 3_000, ip: '192.0.2.150' },
        { who: 'a member of 4 days', id: makeMember(4), cls: 'member', share: 15_000, ip: '192.0.2.151' },
    ] as const;
    for (const { who, id, cls, share, ip } of keys) {
        const spender: NonceSpender = { region: 'rows', owner: `k:${id.pubKeyHex}`, established: () => cls === 'member' };
        for (let i = 0; i < share - 2; i++) requestNonces.consume(`pm-${cls}-${i}`, now, now, spender);
        const w = await write(id, ip);
        const ws = await socket(id, ip);
        assert(w.status === 200 && ws.opened,
            `at 600 a minute ${who} holding ${(share - 2).toLocaleString('en')} still writes and opens /ws (${w.status} ${w.error ?? ''}, ${ws.status})`);
        const over = await write(id, ip);
        const wsOver = await socket(id, ip);
        assert(over.status === 503 && over.error === KEY_SHARE_ERROR && over.retryAfter === '60' && !wsOver.opened && wsOver.status === 503,
            `its next write is 503 in the words for its own app, and its next /ws 503 (${over.status} "${over.error ?? ''}", ${wsOver.status})`);
        const noted = (requestNonces.pressure() as unknown as Record<string, { share: number }>)[cls]?.share;
        assert(noted === share, `the store refused it at its share of ${share.toLocaleString('en')} (${noted})`);
    }
}

// ─── 7. The alert ───────────────────────────────────────────────────────────────────────────

const flood = (told: AlertEvent[]) => told.filter((e) => e.key === 'requests.flood');
const ADDRESS_OR_KEY = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|[0-9a-f]{12}/i;
const bannerDetail = () => serverAlertsBanner().items.find((i) => i.key === 'requests.flood')?.detail ?? '';

async function alertChecks(): Promise<void> {
    resetAlertsForTests();
    setAlertsClockForTests(0);
    await section('3. HTTPS: 15 addresses with fresh keys fill the strangers\' region; members are not touched', fifteenAddressesCheck);
    await section('7a. the alert, after the strangers\' region filled', async () => {
        const told = flood(await checkServerAlerts());
        assert(told.length === 1 && told[0].kind === 'raised' && told[0].priority === 3,
            `requests.flood is raised once, priority 3 (${JSON.stringify(told.map((e) => [e.kind, e.priority]))})`);
        const detail = told[0]?.detail ?? '';
        assert(detail.includes('300 in flight from 10 addresses') && detail.includes('Accounts are not affected.'),
            `its words count the region and its addresses and say accounts are not affected ("${detail}")`);
        assert(!ADDRESS_OR_KEY.test(detail), 'and name no address and no key');
        const banner = serverAlertsBanner().items.find((i) => i.key === 'requests.flood');
        assert(banner?.title === 'signed requests turned away', `it is in the owners' banner (${banner?.title})`);
        assert(flood(await checkServerAlerts()).length === 0, 'a second tick tells nothing');
    });
    await section('4. HTTPS: one member key is held to its own share; the next member goes on', oneMemberKeyCheck);
    await section('7b. the alert, after a member key reached its share', async () => {
        const told = flood(await checkServerAlerts());
        assert(told.length === 1 && told[0].kind === 'raised' && told[0].priority === 4,
            `requests.flood is told again at priority 4: an account is affected (${JSON.stringify(told.map((e) => [e.kind, e.priority]))})`);
        const detail = told[0]?.detail ?? '';
        assert(/\b1 member's app\b/.test(detail) && !ADDRESS_OR_KEY.test(detail), `its words count 1 member and name no key ("${detail}")`);
    });
    await section('5. HTTPS: the rows\' region: newcomers stop at the line, established members spend the reserve', rowsRegionCheck);
    await section('7c. the alert, after the line and the region filled, and its end', async () => {
        assert(flood(await checkServerAlerts()).length === 0, 'already told at priority 4: nothing more');
        const detail = bannerDetail();
        const newer = detail.indexOf('Signed requests from newer accounts');
        const everyone = detail.indexOf('Signed requests from members\' apps have filled');
        assert(newer >= 0 && /newer accounts[^.]*filled their share[^:]*: 30 in flight from 6 apps\./.test(detail) && detail.includes('established members are not affected'),
            `the banner's words say the newer accounts' share is full, 30 in flight from 6 apps ("${detail}")`);
        assert(everyone > newer && detail.includes('60 in flight from 8 apps'), 'then that everyone\'s share is full, 60 in flight from 8 apps');
        assert(!ADDRESS_OR_KEY.test(detail), 'naming no address and no key');
        requestNonces.prune(Date.now() + 11 * MINUTE);
        setAlertsClockForTests(3 * MINUTE);
        assert(flood(await checkServerAlerts()).length === 0, 'with nothing refused for 3 minutes, its end waits the 15-minute hold');
        assert(!serverAlertsBanner().items.some((i) => i.key === 'requests.flood'), 'and it leaves the banner');
        setAlertsClockForTests(19 * MINUTE);
        const told = flood(await checkServerAlerts());
        assert(told.length === 1 && told[0].kind === 'cleared', `15 minutes later it is told cleared (${JSON.stringify(told.map((e) => e.kind))})`);
        setAlertsClockForTests(0);
    });
    await section('7d. one address at its share raises nothing; a newcomer key alone tells at 3; a member key at 4', async () => {
        // On a clock 40 minutes on, so every refusal above is long past and only these count.
        const at = Date.now() + 40 * MINUTE;
        setAlertsClockForTests(40 * MINUTE);
        requestNonces.setLimitsForTests({ rowsMax: 600_000, membersReserve: 250_000, keyMax: 2, newKeyMax: 1, strangersMax: 100_000, addressMax: 2 });
        const spend = (id: Id, client: string) => verifyMemberSignature(parts(id, freshNonce(), at), { consumeNonce: true, now: at, client }).ok ? 200 : 503;
        const scanner = [0, 1, 2, 3].map(() => spend(newKey(), 'scanner'));
        assert(scanner.join(' ') === '200 200 503 503', `a scanner's address is held to its share of 2 (${scanner.join(' ')})`);
        assert(flood(await checkServerAlerts()).length === 0, 'and that raises nothing: one noisy address harms nobody else');
        const newcomer = makeMember(0);
        const mine = [0, 1].map(() => spend(newcomer, 'lobby'));
        const toldNew = flood(await checkServerAlerts());
        assert(mine.join(' ') === '200 503' && toldNew.length === 1 && toldNew[0].priority === 3,
            `a newer account's key at its share, alone, is told at priority 3 (${mine.join(' ')}; ${JSON.stringify(toldNew.map((e) => [e.kind, e.priority]))})`);
        assert(/\b1 newer account's app is at its share\b/.test(toldNew[0]?.detail ?? '') && /Nobody else is affected/.test(toldNew[0]?.detail ?? ''),
            `in its own words ("${toldNew[0]?.detail ?? ''}")`);
        const member = makeMember(4);
        const own = [0, 1, 2].map(() => spend(member, 'hall'));
        const told = flood(await checkServerAlerts());
        assert(own[2] === 503 && told.length === 1 && told[0].priority === 4,
            `a member key at its share is told at priority 4 (${own.join(' ')}; ${JSON.stringify(told.map((e) => [e.kind, e.priority]))})`);
        // These nonces were spent on the clock 40 minutes on: forget them, so the checks after this start from nothing.
        requestNonces.prune(at + 11 * MINUTE);
        setAlertsClockForTests(0);
    });
    await section('7e. the alert at the real sizes: counts with thousands separators', async () => {
        const at = Date.now() + 80 * MINUTE;
        setAlertsClockForTests(80 * MINUTE);
        const note = noteRoomRefusal as unknown as (p: unknown, cls: string, why: string, owner: string, at: number, held: object) => void;
        note(requestNoncePressure, 'newcomer', 'line', 'k:x', at, { live: 350_000, owners: 584, ceiling: 350_000, share: 600 });
        note(requestNoncePressure, 'member', 'region', 'k:y', at, { live: 600_000, owners: 412, ceiling: 600_000, share: 3_000 });
        note(requestNoncePressure, 'stranger', 'region', 'a:z', at, { live: 100_000, owners: 34, ceiling: 100_000, share: 3_000 });
        await checkServerAlerts();
        const detail = bannerDetail();
        assert(detail.includes('350,000 in flight from 584 apps') && detail.includes('600,000 in flight from 412 apps') && detail.includes('100,000 in flight from 34 addresses'),
            `"350,000 in flight from 584 apps", "600,000 in flight from 412 apps", "100,000 in flight from 34 addresses" ("${detail}")`);
        setAlertsClockForTests(0);
    });
}

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://127.0.0.1:${port}`;

    // The store's and the verifier's checks run on a clock 4 hours back, so the hour the security lines wait has passed
    // by the time the HTTPS checks trip them on the real clock.
    const T0 = Date.now() - 4 * HOUR;
    await section('1. the store: a share per owner, a line and a ceiling for the rows, a ceiling for strangers', () => storeChecks(T0));
    const before = { member: securityLines('member'), newcomer: securityLines('newcomer'), stranger: securityLines('stranger') };
    await section('2. the verifier: the sentences and the class, who is established, replays and forgeries with every region full', () => verifierChecks(T0));
    await section('2b (8). the security line: at most one an hour per class', () => securityLineChecks(T0 + 1000, before));
    try {
        await alertChecks();
        await section('6. HTTPS: 20 DM-visitor keys can\'t fill the members\' region', dmVisitorsCheck);
        await section('9. HTTPS at 600 a minute: the middleware and /ws give the store the allowance, and the shares follow it', allowanceCheck);
    } finally {
        try { requestNonces.setLimitsForTests(null); } catch { /* a store without limits to put back */ }
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
