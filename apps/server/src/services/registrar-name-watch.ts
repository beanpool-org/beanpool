/**
 * Proof drops a name, and its own key brings it back (lost-name L3; design
 * scratch/registrar/DESIGN-lost-name-audience-opus.md §3, §4.3; Marty's answers, 2026-09-28).
 *
 * Every registrar name this community's key held is accepted here (engine/registrar-names.ts, L1): a community never
 * loses its own name through a check, a bug or a stale registrar (Marty, 2026-09-24). But once another community holds
 * a name, members' apps that still use it reach THAT community, which can pass what they sign on to this one while it is
 * fresh. So a name stops counting here (its `lost` mark, engine/own-addresses.ts) when, and only when, it is proven
 * someone else's, or this node gave it up itself.
 *
 * Refusing a name refuses only the members whose app reaches this server by that name. A registrar name is always
 * proxied through Cloudflare, so members and this server reach the same origin at it, at the same moment: if a
 * member's app reaches this server by the name, this server's own ask there reaches it too and gets back its own
 * signature. So the server looks for itself, and its own key answering there always keeps the name.
 *
 * A round, for one name:
 *   1. the registrar: who holds it? (registrar-client.ts askNameHolder). Only `other` with a key (R-other(K)) is
 *      evidence. `you`, `free`, `reserved`, 401, 404 (an older registrar), 5xx, a timeout or anything unreadable is none;
 *   2. when there is something to learn there (R-other, evidence being gathered, or the name is lost): this server's own
 *      /api/attest over loopback with a fresh nonce (if that doesn't verify, nothing this round counts: a broken attest
 *      route would make every answer look like someone else's); then /api/attest at https://<name> itself, three times
 *      (a tunnel run from two machines is load-balanced between them), each with a fresh nonce, with the default fetch
 *      and its strict TLS, never a custom agent, redirects not followed. What answers there:
 *        own           a valid attestation by THIS server's key over our nonce: the name leads here (E4);
 *        holder        a valid attestation by K, the key the registrar named (E1);
 *        foreign       a valid attestation by some other key (E2);
 *        other-origin  an answer that is not an attestation: a page, an origin's 404 (E3);
 *        silence       nothing: no answer, a DNS or TLS failure, any 5xx (Cloudflare's 530 and 52x among them), a
 *                      401/403/429, a redirect, a Cloudflare error or challenge page, or an attestation claiming this
 *                      server's key that doesn't verify (E5).
 *
 * The rule (§3.4, as Marty approved it: minutes when both channels agree, a full day otherwise):
 *   - lost, fast: R-other(K) and `holder` (K itself answers) on two counting rounds at least 10 minutes apart;
 *   - lost, slow: R-other(K) and holder, foreign or other-origin on every counting round for at least 24 hours, at
 *     least 6 of them (a holder that hides its key);
 *   - a counting round is R-other(K), plus this server's own attest verified, plus one of those three. Any other round
 *     counts for nothing; and this server's key answering at the name, or the registrar saying `you`, `free` or
 *     `reserved`, or naming a different key, starts the evidence again from nothing;
 *   - lost, own release (decision D-B): this node released the name itself (Take offline), 30 days have passed (or a
 *     longer hold it recorded), no claim took it back, and the registrar's latest answer is `free` or `other`;
 *   - never: on the registrar's word alone; on silence; while this server's own key answers at the name; for a name the
 *     registrar calls `reserved` (the fleet's); nor, at all, against an older registrar (404: it can't say, so nothing
 *     is dropped);
 *   - back: this server's key answering at the name, or the registrar saying `you`, clears the mark at once (a claim or
 *     a status answer giving the name to this key clears it too: engine/registrar-names.ts). An own-release mark goes
 *     only with the registrar's `you` or a claim: an origin answering with this server's key after the hold is exactly
 *     what a new holder relaying our asks would show (§3.6). A refused request for a lost name asks for a round at once,
 *     at most every 5 minutes per name, so a name that comes back is accepted again within seconds.
 *
 * Cadence: every 5 minutes for a name at risk (lost, evidence being gathered, the registrar naming another key, a
 * former name, or a latest status that doesn't hold it for this key: none, released, revoked, …, unless the registrar's
 * own latest answer is that this key holds it in a state that holds a name); every 6 hours for the rest (the registrar
 * alone is asked then, and only `other` leads further), so a node whose admin never opens Settings still learns. Only on the main server, and only when the record has a name: a node that never had a registrar name
 * asks nothing.
 *
 * What it can't catch (§3.6): a new holder that relays this server's own asks back to it, so it sees its own key,
 * while answering everyone else with its own. Keeping a name while this server's key answers there is the rule.
 *
 * The evidence is kept in node_config row NAME_WATCH_KEY, apart from the record: it moves every round, and the record
 * travels in the take-over envelope, which is sealed again whenever it changes. A promoted standby carries the `lost`
 * marks (it refuses a lost name at once) and gathers evidence afresh, which can only keep a name longer.
 */

import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { db } from '../db/db.js';
import { getNodeRole } from '../state-engine.js';
import { logger } from '../logger.js';
import { forgetOwnAddresses } from '../engine/own-addresses.js';
import { setLostAddressRefusedHandler } from '../engine/member-signature.js';
import {
    HOLDING_STATUSES, registrarNames, setRegistrarNameLost, type RegistrarName, type RegistrarNameLost,
} from '../engine/registrar-names.js';
import { askNameHolder, attestMessage, DEFAULT_PROTO, nodePubkeyHex, PROTOCOLS, type Proto } from './registrar-client.js';

/** The node_config row the evidence is kept in: { [host]: NameWatch }. */
export const NAME_WATCH_KEY = 'registrarNameWatch';

const CLOSE_EVERY_MS = 5 * 60_000;
const QUIET_EVERY_MS = 6 * 60 * 60_000;
export const FAST_SPAN_MS = 10 * 60_000;
export const SLOW_SPAN_MS = 24 * 60 * 60_000;
export const SLOW_MIN_ROUNDS = 6;
/** Decision D-B: a name this node released is accepted for the registrar's 30-day hold (RELEASE_COOLOFF_S), then not. */
export const OWN_RELEASE_HOLD_MS = 30 * 86_400_000;
const EDGE_ASKS = 3;
const EDGE_TIMEOUT_MS = 10_000;
const SELF_TIMEOUT_MS = 5_000;
/** At most one round per name this often from refused requests. */
const RECHECK_EVERY_MS = 5 * 60_000;
const TICK_MS = 60_000;
/** After identity and the servers are up. */
const FIRST_TICK_MS = 30_000;
/** An answer is read up to this much; anything longer is cut, never waited on. */
const MAX_ANSWER_BYTES = 65_536;
const ZONE_SUFFIX = '.beanpool.org';

export type EdgeSeen = 'own' | 'holder' | 'foreign' | 'other-origin' | 'silence';

export type HolderAnswer =
    | { held: 'you'; state: string | null; heldUntil: number | null }
    | { held: 'other'; key: string; state: string | null }
    | { held: 'free' }
    | { held: 'reserved' }
    /** 404: an older registrar, which can't say. */
    | { held: 'old' }
    /** Nothing it said can be read as an answer: 401, 5xx, a timeout, an answer about another name… */
    | { held: 'none'; why: string };

interface Streak {
    /** The key the registrar named on every round of it. */
    key: string;
    /** Its first counting round (ms, the round's clock). */
    since: number;
    rounds: number;
    /** The first and last counting rounds at which K itself answered at the name. */
    matchFirst: number | null;
    matchLast: number | null;
}

export interface NameWatch {
    /** When the last round ran (ms). */
    checkedAt: number | null;
    /** The registrar's latest answer that said something, and when. */
    registrar: 'you' | 'other' | 'free' | 'reserved' | null;
    registrarAt: number | null;
    /** The key it named with `other`. */
    holderKey: string | null;
    /** The row's state it gave with `you` or `other`, and a release's hold (ms) with `you`. */
    state: string | null;
    heldUntil: number | null;
    /** Its last answer was a 404: an older registrar. */
    old: boolean;
    /** What answered at the name the last time it was asked, and when; the last time this server's key did. */
    edge: EdgeSeen | null;
    edgeAt: number | null;
    ownAt: number | null;
    /** Whether this server's own attest verified, the last time it was asked. */
    selfOk: boolean | null;
    /** The evidence being gathered, or null. */
    streak: Streak | null;
    /** The state last logged, so each change is logged once. */
    logged: string | null;
}

const blank = (): NameWatch => ({
    checkedAt: null, registrar: null, registrarAt: null, holderKey: null, state: null, heldUntil: null, old: false,
    edge: null, edgeAt: null, ownAt: null, selfOk: null, streak: null, logged: null,
});

// ── The evidence row ────────────────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null);
const KEY_RE = /^[0-9a-f]{64}$/;
const WORD_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const EDGE_WORDS: readonly EdgeSeen[] = ['own', 'holder', 'foreign', 'other-origin', 'silence'];

/** One stored entry, read defensively: anything malformed reads as nothing gathered (which only keeps a name longer). */
function watchOf(raw: unknown): NameWatch {
    if (!raw || typeof raw !== 'object') return blank();
    const r = raw as Record<string, any>;
    const registrar = ['you', 'other', 'free', 'reserved'].includes(r.registrar) ? r.registrar : null;
    const s = r.streak;
    const streak: Streak | null = s && typeof s === 'object' && str(s.key, KEY_RE) && num(s.since) !== null && num(s.rounds) !== null
        ? { key: s.key, since: s.since, rounds: s.rounds, matchFirst: num(s.matchFirst), matchLast: num(s.matchLast) }
        : null;
    return {
        checkedAt: num(r.checkedAt), registrar, registrarAt: num(r.registrarAt), holderKey: str(r.holderKey, KEY_RE),
        state: str(r.state, WORD_RE), heldUntil: num(r.heldUntil), old: r.old === true,
        edge: EDGE_WORDS.includes(r.edge) ? r.edge : null, edgeAt: num(r.edgeAt), ownAt: num(r.ownAt),
        selfOk: typeof r.selfOk === 'boolean' ? r.selfOk : null, streak, logged: typeof r.logged === 'string' ? r.logged.slice(0, 40) : null,
    };
}

function readWatches(): Record<string, NameWatch> {
    const out: Record<string, NameWatch> = {};
    try {
        const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(NAME_WATCH_KEY) as { value?: string } | undefined;
        const v = row?.value ? JSON.parse(row.value) : null;
        if (v && typeof v === 'object' && !Array.isArray(v)) for (const [host, w] of Object.entries(v)) out[host] = watchOf(w);
    } catch { /* an unreadable row reads as nothing gathered */ }
    return out;
}

/** Only the names the record has: a name can't be forgotten from the record, so neither is its evidence. */
function writeWatches(all: Record<string, NameWatch>, hosts: Set<string>): void {
    const kept = Object.fromEntries(Object.entries(all).filter(([h]) => hosts.has(h)));
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(NAME_WATCH_KEY, JSON.stringify(kept));
}

/** Every recorded name's evidence (Settings, tests). */
export function nameWatches(): Record<string, NameWatch> {
    return readWatches();
}

// ── Asking ──────────────────────────────────────────────────────────────────────────────────

const labelOf = (host: string): string | null => (host.endsWith(ZONE_SUFFIX) ? host.slice(0, -ZONE_SUFFIX.length) : null);

async function askHolder(label: string, ours: string): Promise<HolderAnswer> {
    let res: { status: number; data: any };
    try {
        res = await askNameHolder(label);
    } catch (e: any) {
        return { held: 'none', why: e?.message || String(e) };
    }
    if (res.status === 404) return { held: 'old' };
    if (res.status !== 200) return { held: 'none', why: `HTTP ${res.status}` };
    const d = res.data;
    if (!d || typeof d !== 'object' || d.name !== label) return { held: 'none', why: 'no answer about this name' };
    const state = str(d.state, WORD_RE);
    switch (d.held) {
        case 'you':
            return { held: 'you', state, heldUntil: num(d.held_until) !== null ? d.held_until * 1000 : null };
        case 'other': {
            const key = typeof d.holder_key === 'string' && /^[0-9a-f]{64}$/i.test(d.holder_key) ? d.holder_key.toLowerCase() : null;
            if (!key) return { held: 'none', why: '`other` naming no key' };
            // This server's own key named as another's is no evidence of anyone else.
            if (key === ours) return { held: 'none', why: "`other` naming this server's own key" };
            return { held: 'other', key, state };
        }
        case 'free':
            return { held: 'free' };
        case 'reserved':
            return { held: 'reserved' };
        default:
            return { held: 'none', why: `held: ${JSON.stringify(d.held)?.slice(0, 40)}` };
    }
}

interface Answer { status: number; headers: Headers; text: string }

async function readCapped(res: Response): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_ANSWER_BYTES) {
            await reader.cancel().catch(() => {});
            break;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

/** One GET with the default fetch (strict TLS), redirects not followed. Null when nothing answered in time. */
async function ask(url: string, timeoutMs: number): Promise<Answer | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' } });
        return { status: res.status, headers: res.headers, text: await readCapped(res) };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** An attestation (registrar-client.ts buildAttestation) and whether it is valid over `nonce`, or null for anything else. */
function attestationOf(body: unknown, nonce: string): { pubkey: string; valid: boolean } | null {
    const b = body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || typeof b.pubkey !== 'string' || typeof b.signature !== 'string') return null;
    const pubkey = b.pubkey.toLowerCase();
    if (!KEY_RE.test(pubkey)) return null;
    let valid = false;
    try {
        const proto = (b.proto === undefined ? DEFAULT_PROTO : b.proto) as Proto;
        const ts = b.timestamp;
        if (b.nonce === nonce && (typeof ts === 'number' || typeof ts === 'string') && typeof proto === 'string'
            && Object.hasOwn(PROTOCOLS, proto) && /^[0-9a-f]{128}$/i.test(b.signature)) {
            valid = ed25519.verify(Buffer.from(b.signature, 'hex'), new TextEncoder().encode(attestMessage(proto, nonce, ts)), Buffer.from(pubkey, 'hex'));
        }
    } catch {
        valid = false;
    }
    return { pubkey, valid };
}

/** Cloudflare's own error and challenge pages ("error code: 1033", its HTML error page): never an origin's answer. */
const CLOUDFLARE_PAGE = /error code:\s*1\d{3}\b|cf-error-details|cf-wrapper|Cloudflare Ray ID/i;
/** The answers other than 200 that can only be an origin's: nothing else counts as one (anything unsure is silence). */
const ORIGIN_STATUSES = new Set([400, 404, 405, 410]);

function classify(got: Answer | null, nonce: string, ours: string, holderKey: string | null): EdgeSeen {
    if (!got) return 'silence';
    if (got.headers.get('cf-mitigated') || CLOUDFLARE_PAGE.test(got.text)) return 'silence';
    if (got.status === 200) {
        let body: unknown = null;
        try { body = JSON.parse(got.text); } catch { body = null; }
        const a = attestationOf(body, nonce);
        if (a) {
            // Something claiming this server's key that doesn't verify is never evidence against it.
            if (a.pubkey === ours) return a.valid ? 'own' : 'silence';
            if (!a.valid) return 'other-origin';
            return a.pubkey === holderKey ? 'holder' : 'foreign';
        }
        return 'other-origin';
    }
    if ((got.status > 200 && got.status < 300) || ORIGIN_STATUSES.has(got.status)) return 'other-origin';
    return 'silence';
}

function edgeUrl(host: string, nonce: string): string {
    const query = `/api/attest?nonce=${encodeURIComponent(nonce)}`;
    // Tests only: the suite's stand-in for Cloudflare's edge, the name as the first path segment. Unset in every real
    // deployment.
    const test = process.env.BEANPOOL_TEST_EDGE_ORIGIN;
    return test ? `${test.replace(/\/+$/, '')}/${host}${query}` : `https://${host}${query}`;
}

/** Three asks at the name; `own` as soon as one is, else the strongest evidence any gave. */
async function askAtName(host: string, ours: string, holderKey: string | null): Promise<EdgeSeen> {
    const seen: EdgeSeen[] = [];
    for (let i = 0; i < EDGE_ASKS; i++) {
        const nonce = crypto.randomUUID();
        const s = classify(await ask(edgeUrl(host, nonce), EDGE_TIMEOUT_MS), nonce, ours, holderKey);
        if (s === 'own') return 'own';
        seen.push(s);
    }
    return (['holder', 'foreign', 'other-origin'] as const).find((s) => seen.includes(s)) ?? 'silence';
}

/** This server's own /api/attest, over loopback: valid, by its key, over a fresh nonce. */
async function selfAttests(origin: string | null, ours: string): Promise<boolean> {
    if (!origin) return false;
    const nonce = crypto.randomUUID();
    const got = await ask(`${origin.replace(/\/+$/, '')}/api/attest?nonce=${nonce}`, SELF_TIMEOUT_MS);
    if (!got || got.status !== 200) return false;
    let body: unknown = null;
    try { body = JSON.parse(got.text); } catch { return false; }
    const a = attestationOf(body, nonce);
    return !!a && a.valid && a.pubkey === ours;
}

// ── Deciding ────────────────────────────────────────────────────────────────────────────────

const iso = (ms: number) => new Date(ms).toISOString();

/** When this node's own release of `entry` stops counting: 30 days on, or the end of a longer recorded hold; NaN for none. */
export function ownReleaseEndsAt(entry: RegistrarName): number {
    const released = entry.releasedByUsAt ? Date.parse(entry.releasedByUsAt) : NaN;
    if (!Number.isFinite(released)) return NaN;
    const held = entry.heldUntil ? Date.parse(entry.heldUntil) : NaN;
    return Math.max(released + OWN_RELEASE_HOLD_MS, Number.isFinite(held) ? held : 0);
}

/**
 * One round's outcome: the evidence as it now stands, and the `lost` mark to write (undefined: unchanged). Pure: the
 * whole rule is here.
 */
export function decide(entry: RegistrarName, prev: NameWatch, holder: HolderAnswer, selfOk: boolean | null, edge: EdgeSeen | null, now: number):
    { watch: NameWatch; lost: RegistrarNameLost | null | undefined; counted: boolean } {
    const w: NameWatch = { ...prev, checkedAt: now, streak: prev.streak ? { ...prev.streak } : null };
    let lost: RegistrarNameLost | null | undefined;

    w.old = holder.held === 'old';
    if (holder.held === 'you' || holder.held === 'other' || holder.held === 'free' || holder.held === 'reserved') {
        w.registrar = holder.held;
        w.registrarAt = now;
        w.holderKey = holder.held === 'other' ? holder.key : null;
        w.state = holder.held === 'you' || holder.held === 'other' ? holder.state : null;
        w.heldUntil = holder.held === 'you' ? holder.heldUntil : null;
    }
    if (selfOk !== null) w.selfOk = selfOk;
    if (edge) {
        w.edge = edge;
        w.edgeAt = now;
        if (edge === 'own') w.ownAt = now;
    }

    // The evidence starts again from nothing.
    if (edge === 'own' || holder.held === 'you' || holder.held === 'free' || holder.held === 'reserved'
        || (holder.held === 'other' && w.streak && w.streak.key !== holder.key)) w.streak = null;

    // Back: the registrar gives it to this key, or this server's key answers there (a proof mark only).
    if (entry.lost && (holder.held === 'you' || (edge === 'own' && entry.lost.why === 'another-key'))) lost = null;

    const counted = holder.held === 'other' && selfOk === true && (edge === 'holder' || edge === 'foreign' || edge === 'other-origin');
    if (counted) {
        const s = (w.streak ??= { key: holder.key, since: now, rounds: 0, matchFirst: null, matchLast: null });
        s.rounds++;
        if (edge === 'holder') {
            s.matchFirst ??= now;
            s.matchLast = now;
        }
        const fast = s.matchFirst !== null && s.matchLast !== null && s.matchLast - s.matchFirst >= FAST_SPAN_MS;
        const slow = now - s.since >= SLOW_SPAN_MS && s.rounds >= SLOW_MIN_ROUNDS;
        if ((fast || slow) && !entry.lost) lost = { since: iso(now), why: 'another-key', holderKey: holder.key };
    }

    // This node's own release, once the hold is over and the registrar no longer holds it for this key.
    const ends = ownReleaseEndsAt(entry);
    if (!entry.lost && lost === undefined && Number.isFinite(ends) && now >= ends && !w.old
        && (w.registrar === 'free' || w.registrar === 'other')) {
        lost = { since: iso(now), why: 'released', holderKey: w.registrar === 'other' ? w.holderKey : null };
    }
    return { watch: w, lost, counted };
}

type Standing = 'held' | 'at-risk' | 'contradiction' | 'lost-another-key' | 'lost-released';

function standingOf(lost: RegistrarNameLost | null, w: NameWatch): Standing {
    if (lost) return lost.why === 'released' ? 'lost-released' : 'lost-another-key';
    if (w.registrar === 'other' && w.edge === 'own') return 'contradiction';
    if (w.registrar === 'other' || w.streak) return 'at-risk';
    return 'held';
}

const key16 = (k: string | null) => (k ? `${k.slice(0, 16)}…` : 'a key it did not name');

function logChange(host: string, standing: Standing, w: NameWatch, lost: RegistrarNameLost | null): void {
    switch (standing) {
        case 'lost-another-key':
            logger.security('AUTH', `[Names] ${host}: the address service names another community's key (${key16(lost?.holderKey ?? null)}) as its holder, `
                + 'and the name answers as that community, not this one. From now on this community refuses what apps sign for it. '
                + 'This server\'s own key answering there again, or the address service giving it back, brings it back at once.');
            return;
        case 'lost-released':
            logger.security('AUTH', `[Names] ${host}: this community released it, the hold is over and the address service no longer holds it for `
                + 'this community, so it no longer accepts what apps sign for it. Claiming it again brings it back.');
            return;
        case 'contradiction':
            logger.warn('AUTH', `[Names] ${host}: the address service says another community's key (${key16(w.holderKey)}) holds it, but it still `
                + 'leads to this server. It stays accepted.');
            return;
        case 'at-risk':
            logger.warn('AUTH', `[Names] ${host}: the address service says another community's key (${key16(w.holderKey)}) holds it. `
                + 'Still accepted, while this server checks what answers there.');
            return;
        case 'held':
            logger.info('AUTH', `[Names] ${host}: this community's again; members' apps that use it are accepted.`);
    }
}

export interface NameRound {
    host: string;
    skipped?: string;
    registrar?: HolderAnswer['held'];
    selfOk?: boolean | null;
    edge?: EdgeSeen | null;
    counted?: boolean;
    lost?: RegistrarNameLost | null;
    changed?: 'lost' | 'restored' | null;
}

/** Each name's rounds, one after another: a re-check for a refused request waits for a round already running. */
const running = new Map<string, Promise<unknown>>();
let loopbackOrigin: string | null = null;

/**
 * One round for one recorded name (above). `now` is the rule's clock (tests move it; the asks are made now);
 * `loopbackOrigin` where this server's own /api/attest answers, by default the one the watch was started with. Never
 * throws for a network failure: that is silence.
 */
export function checkRegistrarName(host: string, opts: { now?: number; loopbackOrigin?: string | null } = {}): Promise<NameRound> {
    const round = (running.get(host) ?? Promise.resolve()).catch(() => {}).then(() => runRound(host, opts));
    running.set(host, round);
    void round.catch(() => {}).finally(() => {
        if (running.get(host) === round) running.delete(host);
    });
    return round;
}

async function runRound(host: string, opts: { now?: number; loopbackOrigin?: string | null }): Promise<NameRound> {
    const now = opts.now ?? Date.now();
    const origin = opts.loopbackOrigin !== undefined ? opts.loopbackOrigin : loopbackOrigin;
    const first = registrarNames().find((e) => e.address === host);
    const label = labelOf(host);
    if (!first || !label) return { host, skipped: 'not a recorded registrar name' };
    let ours: string;
    try {
        ours = nodePubkeyHex().toLowerCase();
    } catch {
        return { host, skipped: 'no node identity yet' };
    }
    const holder = await askHolder(label, ours);
    const before = readWatches()[host] ?? blank();
    let selfOk: boolean | null = null;
    let edge: EdgeSeen | null = null;
    if (holder.held === 'other' || first.lost || before.streak) {
        selfOk = await selfAttests(origin, ours);
        edge = await askAtName(host, ours, holder.held === 'other' ? holder.key : null);
    }

    // From here on, nothing awaits: the record and the evidence are read, decided on and written as one step.
    const names = registrarNames();
    const entry = names.find((e) => e.address === host);
    if (!entry) return { host, skipped: 'no longer recorded' };
    const all = readWatches();
    const d = decide(entry, all[host] ?? blank(), holder, selfOk, edge, now);
    const lostNow = d.lost === undefined ? entry.lost : d.lost;
    const standing = standingOf(lostNow, d.watch);
    if (standing !== (d.watch.logged ?? 'held')) {
        logChange(host, standing, d.watch, lostNow);
        d.watch.logged = standing;
    }
    all[host] = d.watch;
    writeWatches(all, new Set(names.map((e) => e.address)));
    let changed: NameRound['changed'] = null;
    if (d.lost !== undefined && setRegistrarNameLost(host, d.lost)) {
        changed = d.lost ? 'lost' : 'restored';
        forgetOwnAddresses();
    }
    return { host, registrar: holder.held, selfOk, edge, counted: d.counted, lost: lostNow, changed };
}

/**
 * When a name's next round is due (ms). A former name, or one whose latest status doesn't hold it for this key, is
 * watched closely until the registrar's own answer says this key holds it in a state that holds a name (live, pending,
 * paused, blocked): then it is as safe as a current live name, and asked about as rarely.
 */
function dueAt(entry: RegistrarName, w: NameWatch): number {
    if (w.checkedAt === null) return 0;
    const heldForUs = w.registrar === 'you' && !!w.state && HOLDING_STATUSES.has(w.state);
    const atRisk = (entry.role === 'former' || !HOLDING_STATUSES.has(entry.status)) && !heldForUs;
    const close = !!entry.lost || !!w.streak || w.registrar === 'other' || atRisk;
    return w.checkedAt + (close ? CLOSE_EVERY_MS : QUIET_EVERY_MS);
}

/** A round for every recorded name that is due, one after another. On the main server only. */
export async function checkDueRegistrarNames(opts: { now?: number } = {}): Promise<NameRound[]> {
    const now = opts.now ?? Date.now();
    if (getNodeRole() !== 'primary') return [];
    const names = registrarNames();
    if (names.length === 0) return [];
    const all = readWatches();
    const out: NameRound[] = [];
    for (const e of names) {
        const w = all[e.address] ?? blank();
        // A round from a clock that has since gone back more than an hour is due now.
        if (dueAt(e, w) <= now || (w.checkedAt !== null && w.checkedAt > now + 3_600_000)) out.push(await checkRegistrarName(e.address));
    }
    return out;
}

// ── Refused requests ────────────────────────────────────────────────────────────────────────

const recheckedAt = new Map<string, number>();

/** A request was refused for lost `host` (member-signature.ts): look again now, at most every RECHECK_EVERY_MS. */
function recheckRefused(host: string): void {
    const now = Date.now();
    if (now - (recheckedAt.get(host) ?? -Infinity) < RECHECK_EVERY_MS) return;
    if (getNodeRole() !== 'primary') return;
    if (recheckedAt.size >= 200) recheckedAt.clear(); // only lost names get here, and there are at most 50
    recheckedAt.set(host, now);
    void checkRegistrarName(host).catch((e: any) => logger.warn('AUTH', `[Names] re-check of ${host} failed: ${e?.message || e}`));
}

/** Tests: forget when each name was last re-checked for a refused request. */
export function resetNameRecheckLimitForTests(): void {
    recheckedAt.clear();
}

// ── The watch ───────────────────────────────────────────────────────────────────────────────

let firstTick: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * Start watching. Called on every node: each tick asks whether this is the main server, so a standby does nothing and
 * a promoted one starts on its own. `loopbackOrigin`: where this server's own /api/attest answers over loopback (the
 * plain-HTTP listener, which serves /api as the tunnel reaches it). `timer: false` (tests): only the refused-request
 * re-checks, and rounds on demand.
 */
export function startRegistrarNameWatch(opts: { loopbackOrigin: string | null; timer?: boolean }): void {
    stopRegistrarNameWatch();
    loopbackOrigin = opts.loopbackOrigin;
    setLostAddressRefusedHandler(recheckRefused);
    if (opts.timer === false) return;
    const tick = async () => {
        if (ticking) return;
        ticking = true;
        try {
            await checkDueRegistrarNames();
        } catch (e: any) {
            logger.warn('AUTH', `[Names] check failed: ${e?.message || e}`);
        } finally {
            ticking = false;
        }
    };
    firstTick = setTimeout(() => { void tick(); }, FIRST_TICK_MS);
    firstTick.unref?.();
    timer = setInterval(() => { void tick(); }, TICK_MS);
    timer.unref?.();
}

export function stopRegistrarNameWatch(): void {
    if (firstTick) clearTimeout(firstTick);
    if (timer) clearInterval(timer);
    firstTick = null;
    timer = null;
    setLostAddressRefusedHandler(null);
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────

/** What Settings says about one registrar name (design §4.4), when there is anything to say. */
export interface NameStanding {
    /**
     * `at-risk`: the address service says it isn't this community's (released, free, none, another's…), and it is still
     * accepted; `contradiction`: it says another community holds it, but it still leads to this server; `lost`.
     */
    state: 'at-risk' | 'contradiction' | 'lost';
    /** `other`, `free`, `released` (by this community), or the address service's latest status word (none, revoked…). */
    registrarSays: string | null;
    /** This community released it (ISO), and until when it is still accepted. */
    releasedOn: string | null;
    acceptedUntil: string | null;
    /** This server's key answered at the name the last time it was asked. */
    leadsHere: boolean;
    /** Lost since, and why. */
    lostSince: string | null;
    why: RegistrarNameLost['why'] | null;
    /** The last round (ISO). */
    checkedAt: string | null;
}

/** Per recorded name with something to say: host → its standing. */
export function nameStandings(): Map<string, NameStanding> {
    const out = new Map<string, NameStanding>();
    const all = readWatches();
    for (const e of registrarNames()) {
        const w = all[e.address] ?? blank();
        const ends = ownReleaseEndsAt(e);
        const released = Number.isFinite(ends);
        // The registrar's own latest answer first: `you` (outside this community's own release) leaves nothing to say.
        const says = w.registrar === 'other' ? 'other' : released ? 'released' : w.registrar === 'you' ? null : w.registrar === 'free' ? 'free'
            : !HOLDING_STATUSES.has(e.status) && e.status !== 'unknown' ? e.status : null;
        const leadsHere = w.edge === 'own';
        const base = {
            registrarSays: says, releasedOn: e.releasedByUsAt, acceptedUntil: released ? iso(ends) : null, leadsHere,
            lostSince: e.lost?.since ?? null, why: e.lost?.why ?? null, checkedAt: w.checkedAt !== null ? iso(w.checkedAt) : null,
        };
        if (e.lost) out.set(e.address, { state: 'lost', ...base });
        else if (w.registrar === 'other' && leadsHere) out.set(e.address, { state: 'contradiction', ...base });
        else if (says) out.set(e.address, { state: 'at-risk', ...base });
    }
    return out;
}
