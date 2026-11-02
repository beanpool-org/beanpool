/**
 * The address check round (design scratch/fable-design/DESIGN-dns-robustness-fable.md §5, §8 slice 1; Marty, 1 Nov: "the
 * DNS has been worrying me"). Nothing else tells an owner whether a name answers from outside, or what it points at: a
 * right tunnel and a wrong DNS answer looked fine in Settings.
 *
 * Every 15 minutes and on demand, on the main server, for every configured address that isn't loopback:
 *   1. a DNS lookup (A, AAAA, CNAME) with `node:dns`, so a name with no answer is told from one the resolver couldn't ask;
 *   2. `https://<address>/api/attest` with a fresh nonce, three times at most, read by the name watch's own classifier
 *      (registrar-name-watch.ts classify): own · other · other-origin · silence, and `tls` for a certificate a phone would
 *      refuse or a TLS handshake that failed, which that watch counts as silence. `own` as soon as one ask is, as the watch
 *      reads a tunnel run from two machines; a certificate fails the same way each time, so it isn't asked again.
 *
 * The result is kept per host in node_config row ADDRESS_CHECK_KEY, per-server, as the watch's evidence is: a promoted
 * standby looks for itself. The numbers a name pointed at go with the 7-day rule (address-retention.ts).
 *
 * It only reports. It writes nothing but its own row: never the record of names, never a `lost` mark, never a published
 * address. What drops a name is the watch's proof alone (registrar-name-watch.ts), so a bad round costs nobody anything.
 *
 * ssrfSafeFetch, with redirects off and strict TLS as https.request defaults to: an admin can confirm any address in
 * Settings, so what a round asks must never be something inside this server's network (a cloud's metadata address, a
 * neighbour). A name that points at a private address from here is not asked, and says only that: with split DNS a home
 * server's name reads 192.168.x inside and the public number outside, so phones may reach it perfectly well. One no outside
 * reader could reach by its shape (a `.lan` name, a private number) isn't asked either, and says so. The same refusal reads
 * as silence for anything this doesn't catch first.
 *
 * A former or lost name is still asked, as configuredAddresses keeps it: this server's key answering there is worth saying.
 * Anything else answering there is no fault of this community's, so it gets no next step that sends the owner after it.
 *
 * No domain lock-in (memory no-domain-lock-in): it asks this server's own addresses and the resolver this machine already
 * uses, nothing of BeanPool's. A self-hosted node with its own domain gets the same round, and the words of its case.
 *
 * Only the main server, only after boot, never awaited by it.
 */

import crypto from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { addressNextStep, wordsFor, type AddressAnswer, type AddressStep } from '@beanpool/core';
import { db } from '../db/db.js';
import { getNodeConfig, getNodeRole } from '../state-engine.js';
import { logger } from '../logger.js';
import { configuredAddresses, isBeanPoolName, isLocalNetworkHost, isLoopbackHost } from '../engine/own-addresses.js';
import { isIpLiteral, reachableFromInternet } from '../engine/host-kinds.js';
import { parseRegistrarNames } from '../engine/registrar-names.js';
import { PayloadTooLargeError, __ssrfSafeFetchWithResolverForTests, ssrfSafeFetch, type SsrfSafeFetchOptions } from '../engine/pulse-resolver.js';
import { nodePubkeyHex } from './registrar-client.js';
import { EDGE_ASKS, classify, edgeUrl, type Answer } from './registrar-name-watch.js';
import { withoutOldAddresses } from './address-retention.js';
import { heldCertificates } from './acme/schedule.js';

/** The node_config row the results are kept in: { [host]: AddressCheck }. */
export const ADDRESS_CHECK_KEY = 'addressChecks';

const ROUND_EVERY_MS = 15 * 60_000;
/** After identity, the tunnel and the servers are up. */
const FIRST_ROUND_MS = 90_000;
const ON_DEMAND_GAP_MS = 30_000;
const ON_DEMAND_WAIT_MS = 20_000;
/** A name made this recently may still be remembered as missing: the zone's SOA minimum is 1800 s. */
export const NEW_NAME_MS = 30 * 60_000;
const ASK_TIMEOUT_MS = 8_000;
const MAX_ANSWER_BYTES = 65_536;
const DNS_TRY_MS = 2_000;
/** Most of the numbers or names kept from one answer. */
const DNS_KEPT = 8;
/** A round of the most addresses a node can hold, every one dead, still ends inside the 15 minutes. */
const AT_ONCE = 4;
/**
 * Node's codes for a certificate it refused or a TLS handshake that failed: anything else that failed is silence. EPROTO is
 * the handshake, on Node 22, 24 and 26: plain HTTP on the port, or a fatal alert (an edge with no certificate for the name).
 * A hang-up in the handshake is ECONNRESET, like any dropped connection, so it stays silence.
 */
const TLS_FAILURE = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|HOSTNAME_MISMATCH|^ERR_SSL_|^ERR_TLS_|^EPROTO$/;

export interface DnsSeen {
    /** `answers`: some record; `no-such-name`: the resolver says there is none; `failed`: it couldn't say. */
    outcome: 'answers' | 'no-such-name' | 'failed';
    a: string[];
    aaaa: string[];
    cname: string[];
}

export interface AddressCheck {
    checkedAt: number;
    /** Null when it wasn't asked: a home-network address, by its shape (`dns` null) or by what its name points at from here. */
    answers: AddressAnswer | null;
    /** The last time this server's key answered here. */
    ownAt: number | null;
    /** Null for a number, or a name with no lookup to make. */
    dns: DnsSeen | null;
}

/** One address as `appAddressesReport` shows it. */
export interface AddressReach extends Omit<AddressCheck, 'checkedAt' | 'ownAt'> {
    checkedAt: string;
    ownAt: string | null;
    step: AddressStep;
    /** How long ago a `new-name` was made. */
    minutes: number | null;
    /** The step's sentence in English; the screens draw it with addressNextStep in their reader's language. */
    nextStep: string;
}

// ── The row ─────────────────────────────────────────────────────────────────────────────────

function readChecks(now = Date.now()): Record<string, AddressCheck> {
    try {
        const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(ADDRESS_CHECK_KEY) as { value?: string } | undefined;
        const v = row?.value ? JSON.parse(row.value) : null;
        if (v && typeof v === 'object' && !Array.isArray(v)) return withoutOldAddresses(ADDRESS_CHECK_KEY, v, now);
    } catch { /* an unreadable row reads as nothing checked */ }
    return {};
}

/** Only the addresses configured now: one taken off the list takes its result with it. */
function storeCheck(host: string, check: AddressCheck, hosts: Set<string>): void {
    const kept = Object.fromEntries(Object.entries(readChecks()).filter(([h]) => hosts.has(h)));
    kept[host] = check;
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(ADDRESS_CHECK_KEY, JSON.stringify(kept));
}

// ── Asking ──────────────────────────────────────────────────────────────────────────────────

async function lookUp(host: string): Promise<DnsSeen> {
    const resolver = new Resolver({ timeout: DNS_TRY_MS, tries: 2 });
    // Tests only: the suite's own DNS server. Unset in every real deployment.
    const test = process.env.BEANPOOL_TEST_DNS_SERVER;
    if (test) resolver.setServers([test]);
    const [a, aaaa, cname] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host), resolver.resolveCname(host)]);
    const records = (r: PromiseSettledResult<string[]>) => (r.status === 'fulfilled' ? r.value.slice(0, DNS_KEPT) : []);
    const seen = { a: records(a), aaaa: records(aaaa), cname: records(cname) };
    const nothing = (r: PromiseSettledResult<string[]>) => r.status === 'rejected' && (r.reason?.code === 'ENOTFOUND' || r.reason?.code === 'ENODATA');
    const outcome = seen.a.length || seen.aaaa.length || seen.cname.length ? 'answers' : nothing(a) && nothing(aaaa) ? 'no-such-name' : 'failed';
    return { outcome, ...seen };
}

const pointsAtHomeNetwork = (dns: DnsSeen | null): boolean =>
    !!dns && (dns.a.some(isLocalNetworkHost) || dns.aaaa.some((ip) => isLocalNetworkHost(`[${ip}]`)));

const ASK_OPTIONS: SsrfSafeFetchOptions = {
    timeoutMs: ASK_TIMEOUT_MS, maxBytes: MAX_ANSWER_BYTES, maxRedirects: 0, allowedContentTypes: [],
    headers: { Accept: 'application/json', 'User-Agent': 'BeanPool-AddressCheck/1.0' },
};

/** Too long to be an attestation: whatever said it, something answered. */
const longAnswer = (status = 200): Answer => ({ status, headers: new Headers(), text: '' });

/** One GET: what answered, `tls` for a certificate refused or a failed handshake, null for nothing (a redirect, a refusal, a timeout). */
async function askOnce(url: string): Promise<Answer | 'tls' | null> {
    try {
        // Tests only (BEANPOOL_TEST_EDGE_ORIGIN, as the name watch's): the whole pipeline, aimed at the suite's edge, which
        // ssrfSafeFetch rightly refuses on loopback. The hook is locked to BEANPOOL_SSRF_TEST_HOOK besides.
        const res = process.env.BEANPOOL_TEST_EDGE_ORIGIN
            ? await __ssrfSafeFetchWithResolverForTests(url, ASK_OPTIONS, async () => ({ pinnedIp: '127.0.0.1', family: 4 }))
            : await ssrfSafeFetch(url, ASK_OPTIONS);
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v);
        try {
            return { status: res.status, headers, text: await res.text() };
        } catch (e) {
            return e instanceof PayloadTooLargeError ? longAnswer(res.status) : null;
        }
    } catch (e: any) {
        if (e instanceof PayloadTooLargeError) return longAnswer();
        return TLS_FAILURE.test(String(e?.code ?? '')) ? 'tls' : null;
    }
}

async function askAt(host: string, ours: string): Promise<AddressAnswer> {
    const seen: AddressAnswer[] = [];
    for (let i = 0; i < EDGE_ASKS; i++) {
        const nonce = crypto.randomUUID();
        const got = await askOnce(edgeUrl(host, nonce));
        if (got === 'tls') return 'tls';
        const s = classify(got, nonce, ours, null);
        if (s === 'own') return 'own';
        seen.push(s === 'holder' || s === 'foreign' ? 'other' : s);
    }
    return (['other', 'other-origin'] as const).find((s) => seen.includes(s)) ?? 'silence';
}

async function checkOne(host: string, ours: string): Promise<Omit<AddressCheck, 'ownAt'>> {
    const outside = reachableFromInternet(host);
    const dns = outside && !isIpLiteral(host) ? await lookUp(host) : null;
    const answers = outside && !pointsAtHomeNetwork(dns) ? await askAt(host, ours) : null;
    return { checkedAt: Date.now(), answers, dns };
}

// ── The round ───────────────────────────────────────────────────────────────────────────────

const checkedHosts = (): string[] => configuredAddresses().map((a) => a.address).filter((a) => !isLoopbackHost(a));

async function runRound(): Promise<void> {
    if (getNodeRole() !== 'primary') return;
    let ours: string;
    try {
        ours = nodePubkeyHex().toLowerCase();
    } catch {
        return; // no node identity yet: the next round asks
    }
    const hosts = checkedHosts();
    const queue = [...hosts];
    const worker = async () => {
        for (let host = queue.shift(); host; host = queue.shift()) {
            try {
                const check = await checkOne(host, ours);
                const stillHere = new Set(checkedHosts());
                if (!stillHere.has(host)) continue;
                const ownAt = check.answers === 'own' ? check.checkedAt : (readChecks()[host]?.ownAt ?? null);
                storeCheck(host, { ...check, ownAt }, stillHere);
            } catch (e: any) {
                logger.warn('SYS', `[Addresses] check of ${host} failed: ${e?.message || e}`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, hosts.length) }, worker));
}

let round: Promise<void> | null = null;
let lastRoundAt = -Infinity;

/** A round now, or the one already running: there is never more than one. Never rejects. */
export function runAddressCheckRound(): Promise<void> {
    round ??= runRound()
        .catch((e: any) => logger.warn('SYS', `[Addresses] round failed: ${e?.message || e}`))
        .finally(() => {
            round = null;
            lastRoundAt = Date.now();
        });
    return round;
}

/** Check now: a round unless one ended in the last 30 seconds, waited on for up to 20. `checking`: it is still running. */
export async function checkAddressesNow(): Promise<{ checking: boolean }> {
    if (!round && Date.now() - lastRoundAt < ON_DEMAND_GAP_MS) return { checking: false };
    let wait: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<boolean>((resolve) => { wait = setTimeout(() => resolve(true), ON_DEMAND_WAIT_MS); });
    const checking = await Promise.race([runAddressCheckRound().then(() => false), waited]);
    clearTimeout(wait);
    return { checking };
}

let firstRound: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Started on every node: each round reads the role, so a standby asks nothing and a promoted one starts on its own. */
export function startAddressCheck(): void {
    stopAddressCheck();
    firstRound = setTimeout(() => { void runAddressCheckRound(); }, FIRST_ROUND_MS);
    firstRound.unref?.();
    timer = setInterval(() => { void runAddressCheckRound(); }, ROUND_EVERY_MS);
    timer.unref?.();
}

export function stopAddressCheck(): void {
    if (firstRound) clearTimeout(firstRound);
    if (timer) clearInterval(timer);
    firstRound = null;
    timer = null;
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────

/**
 * When each live registrar name was made, from the record as stored, never registrarNames(), which stamps a name it adds
 * from the stored address now: one the record doesn't hold would read as made this moment on every look.
 */
function liveNamesMade(): Map<string, number> {
    const live = parseRegistrarNames((getNodeConfig() as any).registrarNames).filter((e) => e.status === 'live');
    return new Map(live.map((e) => [e.address, Date.parse(e.since)]));
}

/** `letGo`: a former or lost name. Only this server's own key answering there still matters. */
export function stepOf(host: string, c: AddressCheck, made: number | undefined, certified: Set<string>, now: number, letGo: boolean): { step: AddressStep; minutes: number | null } {
    const only = (step: AddressStep) => ({ step, minutes: null });
    if (letGo && c.answers !== 'own') return only('no-longer-ours');
    switch (c.answers) {
        case 'own': return only('fine');
        case null: return only(c.dns ? 'home-network-from-here' : 'home-network');
        case 'other': return only('another-server');
        case 'other-origin': return only('something-else');
        case 'tls': return only('certificate');
    }
    if (c.dns?.outcome === 'no-such-name') {
        const age = made === undefined ? NaN : now - made;
        if (age >= 0 && age < NEW_NAME_MS) return { step: 'new-name', minutes: Math.max(1, Math.round(age / 60_000)) };
        return only(isBeanPoolName(host) ? 'no-dns-beanpool' : 'no-dns-own');
    }
    return only(certified.has(host) ? 'from-inside' : 'no-answer');
}

const english = wordsFor('en');

/** Each checked address, as the report shows it. Reads the row and asks nothing of the network. */
export function addressReaches(now = Date.now()): Map<string, AddressReach> {
    const out = new Map<string, AddressReach>();
    const checks = readChecks(now);
    if (Object.keys(checks).length === 0) return out;
    const made = liveNamesMade();
    const certified = new Set(heldCertificates(now).map((c) => c.host));
    const letGo = new Set(configuredAddresses().filter((a) => a.former || a.lost).map((a) => a.address));
    for (const [host, c] of Object.entries(checks)) {
        const { step, minutes } = stepOf(host, c, made.get(host), certified, now, letGo.has(host));
        out.set(host, {
            answers: c.answers, dns: c.dns, step, minutes, nextStep: addressNextStep(step, minutes, english),
            checkedAt: new Date(c.checkedAt).toISOString(), ownAt: c.ownAt !== null ? new Date(c.ownAt).toISOString() : null,
        });
    }
    return out;
}

/** The server key's last characters, as `/check` shows them, or null with no identity yet. */
export function serverKeyFingerprint(): string | null {
    try {
        return `····${nodePubkeyHex().slice(-4).toLowerCase()}`;
    } catch {
        return null;
    }
}
