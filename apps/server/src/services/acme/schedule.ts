/**
 * The renewal scheduler (design scratch/global-node/DESIGN-https-anywhere-fable.md §1, §2): an hourly tick on the main
 * server only, the first one as soon as index.ts has both listeners up. Never awaited by the boot.
 *
 * Each tick, for each identifier (engine/own-addresses.ts tlsIdentifiers, plus the fleet's CF_RECORD_NAME on dns-01),
 * one at a time:
 *   - a certificate with more than a third of its life left (30 of 90 days for a name, ~53 of ~160 hours for an IP) is
 *     left alone, unless it came from another ACME directory than ACME_DIRECTORY_URL names now (state.json records it);
 *   - otherwise, once `nextAttemptAt` has come, one order (order.ts), its self-check first; a failed self-check asks the
 *     CA anyway when it was not asked so in the last day (UNCONFIRMED_EVERY_MS), else sends it nothing. The old certificate serves
 *     until the new one is on disk; a failed order keeps it and sets the next try: 1 h, 4 h, then daily after failures in
 *     a row, but for an identifier with a certificate never later than a third of the time it has left (so the window an
 *     IP certificate opens ~53 h before it expires is tried in, hourly as it closes). Failures at another directory than
 *     the one configured now (state.json records the last attempt's) neither delay the next try nor add to its count.
 * An order still running after ORDER_TIMEOUT_MS counts as failed, and whatever it brings back later is thrown away.
 * Before an order asks the CA anything, state.json already holds the attempt as a failure would leave it (its count, its
 * next try), and the once-a-day mark is written before an unconfirmed challenge goes out: a server that stops mid-order
 * waits at its next boot instead of asking the CA again on every one.
 * An address handed to this server again (`beanpool claim --ip/--address` run again, Settings; runAcmeTickSoon) is the
 * owner asking for a retry, having fixed what failed: its next tick orders past the back-off and counts its failures
 * from none. Not when an attempt began less than OWNER_RETRY_FLOOR_MS before it (that one answers it: a command run
 * twice orders once), and never past the once-a-day limit on asking the CA unconfirmed.
 *
 * A standby orders nothing: certificates never travel, and a standby gets its own once the address points at it and it
 * has taken over (D8). A `.beanpool.org` name (Cloudflare's edge holds those) and a private host are never ordered.
 *
 * The owners are told (services/alerts.ts, from heldCertificates and tls.ts selfSignedHosts) when a renewal is a day
 * past due, when a certificate has less than a day left, and when one expired before it was renewed.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getNodeRole } from '../../config/node-role.js';
import { tlsIdentifiers } from '../../engine/own-addresses.js';
import { writeFileAtomic } from '../../write-file-atomic.js';
import {
    checkedHosts, fleetIdentifier, noteChecked, serveCertificate, servedCertificate, servedHosts, setPreferredOrder, tlsDataDir,
} from '../tls.js';
import { LETS_ENCRYPT_PRODUCTION, SelfCheckFailed, orderCertificate, type AcmeTarget } from './order.js';
import { readPair, readState, writePair, writeState, type AcmeState, type CertPair } from './store.js';

const HOUR = 60 * 60_000;
export const TICK_MS = HOUR;
/** Renew when less than this share of the certificate's life is left. */
export const RENEW_WHEN_LEFT = 1 / 3;
/** The wait after 1, 2, 3+ failures in a row. */
export const BACKOFF_MS = [HOUR, 4 * HOUR, 24 * HOUR] as const;
export const ORDER_TIMEOUT_MS = 10 * 60_000;
/**
 * After a failed self-check, the CA is still asked, at most this often: the check runs from inside the server's network,
 * and a home router without NAT loopback fails it although the CA reaches the server. Let's Encrypt allows 5 failed
 * validations an hour per identifier, and pauses one after 1,152 in a row, giving one back a day
 * (letsencrypt.org/docs/rate-limits, read 18 Oct 2026): one a day never comes near either.
 */
export const UNCONFIRMED_EVERY_MS = 24 * HOUR;
/** An address handed over this soon after an attempt for it began waits out the back-off: that attempt answers it. */
export const OWNER_RETRY_FLOOR_MS = 60_000;

/** The ACME directory: ACME_DIRECTORY_URL (Let's Encrypt staging for a trial, another CA), else Let's Encrypt production. */
export function acmeDirectoryUrl(): string {
    return (process.env.ACME_DIRECTORY_URL ?? '').trim() || LETS_ENCRYPT_PRODUCTION;
}

/** The CA as the owner reads it: Let's Encrypt for its directories (production or staging), else "the CA". */
export function caName(directoryUrl: string): string {
    try {
        const host = new URL(directoryUrl).hostname;
        if (host === 'letsencrypt.org' || host.endsWith('.letsencrypt.org')) return "Let's Encrypt";
    } catch { /* not a URL */ }
    return 'the CA';
}

/** The owner's words for an attempt whose self-check failed (`problem`), with what the CA said if it was asked. */
function unconfirmedWords(ca: string, problem: string, caAnswer: string | null): string {
    return `could not confirm from inside your network; trying with ${ca} anyway, once a day.`
        + (caAnswer ? ` ${ca[0].toUpperCase()}${ca.slice(1)} said: ${caAnswer}.` : '') + ` The check from here: ${problem}`;
}

/** What to order, in configured order: every tlsIdentifier on http-01, the fleet's CF_RECORD_NAME on dns-01. */
export function acmeTargets(): AcmeTarget[] {
    const fleet = fleetIdentifier();
    const hosts = tlsIdentifiers();
    if (fleet && !hosts.includes(fleet)) hosts.push(fleet);
    return hosts.map((host) => {
        const ip = host.startsWith('[') || /^[\d.]+$/.test(host);
        const value = host.startsWith('[') ? new URL(`http://${host}/`).hostname.slice(1, -1) : host;
        return { host, value, type: ip ? 'ip' : 'dns', challenge: host === fleet ? 'dns-01' : 'http-01' };
    });
}

let clock = () => Date.now();
let orderFn: typeof orderCertificate = orderCertificate;
let orderTimeoutMs = ORDER_TIMEOUT_MS;
/** Tests only: a clock, an order function and an order timeout (null puts each back). */
export function _setScheduleHooksForTests(hooks: { now?: (() => number) | null; order?: typeof orderCertificate | null; orderTimeoutMs?: number | null }): void {
    if (hooks.now !== undefined) clock = hooks.now ?? (() => Date.now());
    if (hooks.order !== undefined) orderFn = hooks.order ?? orderCertificate;
    if (hooks.orderTimeoutMs !== undefined) orderTimeoutMs = hooks.orderTimeoutMs ?? ORDER_TIMEOUT_MS;
}

/** One ACME account per server, its key in data/tls/acme-account.json (0600), as before. */
function accountKey(): string {
    const file = path.join(tlsDataDir(), 'tls', 'acme-account.json');
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (typeof saved?.key === 'string' && saved.key.includes('PRIVATE KEY')) return saved.key;
    } catch { /* none yet */ }
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify({ key: privateKey }), { mode: 0o600 });
    return privateKey;
}

/** When to try again after `failures` in a row: the back-off, never past a third of what a held certificate has left. */
export function nextAttemptDelay(failures: number, notAfter: number | null, now: number): number {
    const backoff = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? HOUR;
    if (notAfter === null) return backoff;
    return Math.min(backoff, Math.max(HOUR, (notAfter - now) / 3));
}

export type TargetOutcome = 'fresh' | 'waiting' | 'renewed' | 'failed';
export interface TickReport {
    skipped?: 'standby' | 'running';
    outcomes: Record<string, TargetOutcome>;
}

let running = false;
/** A tick asked for (runAcmeTickSoon) while one was under way: one more runs after it. */
let again = false;
/** Addresses handed over (runAcmeTickSoon) and when, until the next tick looks at each: a retry past its back-off. */
const retryAsked = new Map<string, number>();

/** One tick: every identifier looked at, at most one order each. Never throws. */
export async function runAcmeTick(): Promise<TickReport> {
    if (running) return { skipped: 'running', outcomes: {} };
    running = true;
    again = false;
    try {
        if (getNodeRole() !== 'primary') return { skipped: 'standby', outcomes: {} };
        const now = clock();
        const targets = acmeTargets();
        const wanted = new Set(targets.map((t) => t.host));
        setPreferredOrder([...wanted]);
        // An identifier no longer configured is no longer served; its folder stays, and is used again if it comes back.
        for (const host of servedHosts()) if (!wanted.has(host)) serveCertificate(host, null);
        const outcomes: Record<string, TargetOutcome> = {};
        for (const target of targets) {
            try {
                outcomes[target.host] = await considerTarget(target, now);
            } catch (err) {
                outcomes[target.host] = 'failed';
                console.error(`❌ ACME: ${target.host}:`, (err as Error).message);
            }
            noteChecked(target.host);
        }
        return { outcomes };
    } catch (err) {
        console.error('❌ ACME: the renewal check failed:', (err as Error).message);
        return { outcomes: {} };
    } finally {
        running = false;
        if (again) void runAcmeTick();
    }
}

/**
 * An address just given to this server (`beanpool claim --ip/--address`, Settings), new or again: looked at now rather
 * than at the next hourly tick, so the command that gave it sees the certificate within its wait, and ordered past a
 * back-off its failures set (the header says when not). Once the scheduler runs (index.ts starts it); a tick under way is
 * followed by one more. Not awaited.
 */
export function runAcmeTickSoon(host: string): void {
    if (!interval) return;
    retryAsked.set(host, clock());
    if (running) { again = true; return; }
    void runAcmeTick();
}

async function considerTarget(target: AcmeTarget, now: number): Promise<TargetOutcome> {
    const dataDir = tlsDataDir();
    const askedAt = retryAsked.get(target.host);
    retryAsked.delete(target.host);
    let held = servedCertificate(target.host);
    if (held && held.notAfter <= now) {
        serveCertificate(target.host, null);
        held = null;
    }
    if (!held) {
        // A folder from before: an identifier configured again after it was dropped.
        const pair = readPair(dataDir, target.host);
        if (pair && !serveCertificate(target.host, pair, now)) held = servedCertificate(target.host);
    }
    const state = readState(dataDir, target.host);
    const directoryUrl = acmeDirectoryUrl();
    // A certificate from another directory (staging before production, another CA) is due whatever its dates; a state
    // that records none (the fleet's adopted pair, one written before this was recorded) counts as this directory's.
    const otherDirectory = !!held && state.directoryUrl !== null && state.directoryUrl !== directoryUrl;
    if (held && !otherDirectory) {
        const lifetime = held.notAfter - held.notBefore;
        if (held.notAfter - now > lifetime * RENEW_WHEN_LEFT) {
            if (state.validUntil !== held.notAfter) writeState(dataDir, { ...state, validUntil: held.notAfter, lifetimeMs: lifetime });
            return 'fresh';
        }
    }
    // The wait and the count after failures belong to the directory they happened at: a switch (staging, port 80 shut,
    // then production once it is open) is tried at once, from the first back-off step. None recorded counts as this one.
    const sameAttempts = state.attemptDirectoryUrl === null || state.attemptDirectoryUrl === directoryUrl;
    // Handed over again by the owner, and no attempt began in the minute before: the wait and the count are set aside.
    const ownerRetry = askedAt !== undefined && askedAt - state.lastAttemptAt >= OWNER_RETRY_FLOOR_MS;
    const failuresSoFar = sameAttempts && !ownerRetry ? state.failures : 0;
    if (sameAttempts && !ownerRetry && now < state.nextAttemptAt) return 'waiting';
    const lastUnconfirmed = sameAttempts ? state.unconfirmedAttemptAt : 0;
    const ca = caName(directoryUrl);

    console.log(`🔐 ACME: ${held ? 'renewing' : 'ordering'} the certificate for ${target.host} (${target.challenge}) at ${directoryUrl}`
        + (otherDirectory ? `; the one held came from ${state.directoryUrl}` : '')
        + (!sameAttempts && state.failures ? `; the failures at ${state.attemptDirectoryUrl} do not count here` : '')
        + (sameAttempts && ownerRetry && state.failures ? `; given again by the owner, so the wait after ${state.failures} failed attempt(s) is set aside` : ''));
    // A failed self-check: what it said, and whether the CA was asked anyway (never once this attempt is over).
    let selfCheckProblem: string | null = null;
    let askedUnconfirmed = false;
    let settled = false;
    const attempt = (): AcmeState => ({
        ...state, lastAttemptAt: now, attemptDirectoryUrl: directoryUrl, unconfirmedAttemptAt: askedUnconfirmed ? now : lastUnconfirmed,
    });
    // On disk before the CA is asked anything, as if this attempt failed: a server that stops mid-order (a crash loop, a
    // restart) reads it at its next boot and waits out the back-off, rather than asking the CA again on every boot. The
    // outcome below writes over it.
    writeState(dataDir, { ...attempt(), failures: failuresSoFar + 1, nextAttemptAt: now + nextAttemptDelay(failuresSoFar + 1, held?.notAfter ?? null, now) });
    try {
        const pair = await withTimeout(orderFn(target, {
            directoryUrl,
            accountKey: accountKey(),
            log: (line) => console.log(`   ACME: ${line}`),
            orderUnconfirmed: (problem) => {
                selfCheckProblem = problem;
                askedUnconfirmed = !settled && now - lastUnconfirmed >= UNCONFIRMED_EVERY_MS;
                // The once-a-day limit on disk before the challenge goes to the CA, for the same reason; and what the check
                // found, so whoever reads state.json meanwhile (`beanpool claim`, waiting) is told it before the CA answers.
                if (askedUnconfirmed) {
                    writeState(dataDir, { ...readState(dataDir, target.host), unconfirmedAttemptAt: now, lastError: unconfirmedWords(ca, problem, null) });
                }
                return askedUnconfirmed;
            },
        })).finally(() => { settled = true; });
        writePair(dataDir, target.host, pair);
        const problem = serveCertificate(target.host, pair, clock());
        if (problem) throw new Error(`the new certificate is on disk but cannot be served: ${problem}`);
        const fresh = servedCertificate(target.host)!;
        writeState(dataDir, {
            ...attempt(), validUntil: fresh.notAfter, lifetimeMs: fresh.notAfter - fresh.notBefore,
            nextAttemptAt: 0, failures: 0, lastError: null, lastSuccessAt: clock(), directoryUrl,
        });
        console.log(`✅ ACME: certificate for ${target.host} until ${new Date(fresh.notAfter).toISOString()}`
            + (askedUnconfirmed ? ` (not confirmed from inside this network; ${ca} reached it)` : ''));
        return 'renewed';
    } catch (err) {
        const failures = failuresSoFar + 1;
        const why = (err as Error).message || String(err);
        const next = now + nextAttemptDelay(failures, held?.notAfter ?? null, now);
        const words = selfCheckProblem === null ? why : unconfirmedWords(ca, selfCheckProblem, askedUnconfirmed ? why : null);
        writeState(dataDir, { ...attempt(), failures, lastError: words, nextAttemptAt: next });
        const kind = err instanceof SelfCheckFailed ? `self-check failed, nothing was sent to the CA (asked anyway once a day)`
            : askedUnconfirmed ? 'self-check failed, the CA was asked anyway; order failed' : 'order failed';
        console.warn(`⚠️  ACME: ${target.host}: ${kind}: ${words}. ${held ? 'The current certificate stays. ' : ''}Next try ${new Date(next).toISOString()}.`);
        return 'failed';
    }
}

/** A CA certificate an identifier holds (heldCertificates). */
export interface HeldCertificate {
    host: string;
    notAfter: number;
    /** When its renewal fell due: a third of its life left (RENEW_WHEN_LEFT). */
    renewDueAt: number;
}

/**
 * The valid CA certificates of the identifiers a renewal tick has looked at since this start, in configured order, at
 * `now`: what services/alerts.ts tells the owners of (design scratch/global-node/DESIGN-https-anywhere-fable.md §2), with
 * tls.ts selfSignedHosts for those that have none. Empty on a standby, which orders nothing, and before the first tick,
 * so nothing is told before the scheduler has had its go.
 */
export function heldCertificates(now: number): HeldCertificate[] {
    return checkedHosts().flatMap((host) => {
        const held = servedCertificate(host);
        if (!held || held.notAfter <= now) return [];
        return [{ host, notAfter: held.notAfter, renewDueAt: held.notAfter - (held.notAfter - held.notBefore) * RENEW_WHEN_LEFT }];
    });
}

/** The order, or a rejection after the timeout. What a timed-out order brings back later is never written. */
function withTimeout(order: Promise<CertPair>): Promise<CertPair> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer from the CA within ${Math.round(orderTimeoutMs / 1000)} s`)), orderTimeoutMs);
        timer.unref?.();
    });
    order.catch(() => { /* a late failure of an order already given up on */ });
    return Promise.race([order, timeout]).finally(() => clearTimeout(timer));
}

let interval: ReturnType<typeof setInterval> | null = null;

/** index.ts, after both listeners are up: the first tick now, then hourly. Each tick reads the role. Not awaited. */
export function startAcmeScheduler(): void {
    if (interval) return;
    void runAcmeTick();
    interval = setInterval(() => { void runAcmeTick(); }, TICK_MS);
    interval.unref?.();
    console.log('🔄 Certificate renewal scheduler started (hourly)');
}
