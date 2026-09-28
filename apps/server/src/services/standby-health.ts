/**
 * The main server's watch on its standbys (design scratch/global-node/DESIGN-standby-takeover-gaps-opus.md §2 G8, and
 * Marty's answer 3 of 2026-09-28: the community's owners are told in the app, one push and a Settings banner per incident).
 *
 * Each standby reports how its copies have gone with each pull (services/standby-report.ts, on the replication-token
 * channel only). This server keeps the latest report of each, and the standby needs its owners when:
 *   - it hasn't made a copy of this server for an hour (it stopped pulling, or its pulls land nothing);
 *   - three copies in a row came and were refused; or
 *   - its last whole copy wasn't this server's exactly (the standby also takes one force-resync, services/backup-puller.ts).
 * Then an incident opens: the community's owners get one push, and a banner in Settings and the app's admin queue
 * (engine/admin-queue.ts) until the standby is healthy again, which ends it; a later one is a new incident. Nobody else is
 * told, and nothing reaches anyone outside the community.
 *
 * A standby taken out of service for good would keep an incident open: an owner stops watching it from the banner
 * (forgetStandby), and it is watched again from its next report.
 *
 * Kept in node_config `standby_health`, so a restart neither forgets an incident nor pushes it again.
 */

import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { logger } from '../logger.js';
import { getNodeRole } from '../config/node-role.js';
import { NODE_ROLE_ACTS } from '../engine/node-roles.js';
import { dispatchPushNotification } from '../state-engine.js';
import { getReplacedInfo } from './identity-epoch.js';
import { errorMessage } from '../error-message.js';
import { differsInWords, parseStandbyReport, timeInWords, whyInWords, type PullOutcome, type WhyCode } from './standby-report.js';

const KEY = 'standby_health';
/** No copy for this long, and the standby needs its owners. */
export const STOPPED_AFTER_MS = 60 * 60_000;
/** Copies that came and were refused, in a row. */
export const REFUSED_IN_A_ROW = 3;
/** A new incident this soon after the last one ended is told in Settings but not pushed again: a standby that flaps. */
export const PUSH_COOLDOWN_MS = 60 * 60_000;
/** How many standbys one main server keeps reports for. A report from another one past this is ignored. */
const MAX_STANDBYS = 8;
const WATCH_EVERY_MS = 5 * 60_000;

/** This process's start: a main server that was down itself doesn't blame its standby for not copying it meanwhile. */
const bootAt = Date.now();
let clockOffsetMs = 0;
let lastIgnoredNote = 0;
const now = () => Date.now() + clockOffsetMs;

/** A suite moves this server's clock for the watch forward (an hour without a pull, in a second). */
export function setStandbyHealthClockForTests(offsetMs: number): void {
    clockOffsetMs = offsetMs;
}

export interface StandbySeen {
    id: string;
    /** The address its pulls come from, as this server sees it (client-ip.ts): how an owner tells one standby from another. */
    address: string | null;
    firstSeenAt: number;
    lastPullAt: number;
    lastOutcome: PullOutcome | null;
    lastWhy: WhyCode | null;
    failedInARow: number;
    /** When its last copy landed, on this server's clock. */
    lastCopyAt: number | null;
    lastWholeAt: number | null;
    exact: boolean | null;
    lastExactAt: number | null;
    differs: string[];
    hashed: boolean;
}

export type Problem =
    | { standby: string; kind: 'stopped'; since: number }
    | { standby: string; kind: 'refused'; count: number; why: WhyCode | null }
    | { standby: string; kind: 'inexact'; at: number | null; differs: string[]; lastExactAt: number | null };

export interface Incident {
    id: string;
    startedAt: number;
    /** When the owners' push went; null when this incident was not pushed (PUSH_COOLDOWN_MS). */
    pushedAt: number | null;
    /** Notifications handed to the push service (one per registered phone of each owner). */
    pushed: number;
    problems: Problem[];
}

interface HealthState {
    standbys: StandbySeen[];
    incident: Incident | null;
    lastIncident: { id: string; startedAt: number; endedAt: number } | null;
}

function read(): HealthState {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(KEY) as { value: string } | undefined;
    if (!row) return { standbys: [], incident: null, lastIncident: null };
    try {
        const s = JSON.parse(row.value);
        return {
            standbys: Array.isArray(s?.standbys) ? s.standbys.filter((x: unknown) => typeof (x as StandbySeen | null)?.id === 'string') : [],
            incident: s?.incident && typeof s.incident.id === 'string' ? s.incident : null,
            lastIncident: s?.lastIncident && typeof s.lastIncident.id === 'string' ? s.lastIncident : null,
        };
    } catch {
        return { standbys: [], incident: null, lastIncident: null };
    }
}

function write(s: HealthState): void {
    db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(s));
}

/**
 * A pull's report (the `X-Standby-Report` header), from a request the replication token opened: kept for its standby,
 * and the incident opened or closed. Anything that isn't a report (services/standby-report.ts) is ignored, whole. Never
 * throws: a pull never fails over its report.
 */
export function noteStandbyReport(header: unknown, address: string | null): boolean {
    try {
        if (getNodeRole() !== 'primary' || header === undefined) return false;
        const r = parseStandbyReport(Array.isArray(header) ? undefined : header);
        if (!r) {
            if (Date.now() - lastIgnoredNote >= 60 * 60_000) {
                lastIgnoredNote = Date.now();
                logger.warn('P2P', '[StandbyHealth] Ignored a standby report that is not one (malformed, too long or out of range). Said once an hour.');
            }
            return false;
        }
        const s = read();
        const t = now();
        let seen = s.standbys.find((x) => x.id === r.id);
        if (!seen) {
            if (s.standbys.length >= MAX_STANDBYS) {
                logger.warn('P2P', `[StandbyHealth] Ignored a report from a ${MAX_STANDBYS + 1}th standby: this server watches ${MAX_STANDBYS} at most.`);
                return false;
            }
            seen = {
                id: r.id, address: null, firstSeenAt: t, lastPullAt: t, lastOutcome: null, lastWhy: null, failedInARow: 0,
                lastCopyAt: null, lastWholeAt: null, exact: null, lastExactAt: null, differs: [], hashed: false,
            };
            s.standbys.push(seen);
            logger.info('P2P', `[StandbyHealth] Watching a new standby (${r.id.slice(0, 8)}) for this community's owners.`);
        }
        const at = (ago: number | null) => (ago === null ? null : t - ago);
        Object.assign(seen, {
            address: typeof address === 'string' && address.length <= 64 ? address : null,
            lastPullAt: t,
            lastOutcome: r.last === 'none' ? null : r.last,
            lastWhy: r.why,
            failedInARow: r.fails,
            lastCopyAt: at(r.okAgo),
            lastWholeAt: at(r.wholeAgo),
            exact: r.exact,
            lastExactAt: at(r.exactAgo),
            differs: r.differs,
            hashed: r.hashed,
        });
        evaluate(s, t);
        return true;
    } catch (e) {
        logger.warn('P2P', `[StandbyHealth] Could not keep a standby's report: ${errorMessage(e)}`);
        return false;
    }
}

function problemsOf(s: HealthState, t: number): Problem[] {
    const out: Problem[] = [];
    // In this server's first hour up, a standby that hasn't copied it isn't found to have stopped: it may only have been
    // unable to reach this server while it was down. One already found stays found until the standby copies again, so a
    // restart never reads as an all-clear.
    const stillStopped = new Set((s.incident?.problems ?? []).filter((p) => p.kind === 'stopped').map((p) => p.standby));
    const justStarted = t - bootAt < STOPPED_AFTER_MS;
    for (const x of s.standbys) {
        const since = x.lastCopyAt ?? x.firstSeenAt;
        if (t - since >= STOPPED_AFTER_MS && (!justStarted || stillStopped.has(x.id))) out.push({ standby: x.id, kind: 'stopped', since });
        if (x.failedInARow >= REFUSED_IN_A_ROW) out.push({ standby: x.id, kind: 'refused', count: x.failedInARow, why: x.lastWhy });
        if (x.exact === false) out.push({ standby: x.id, kind: 'inexact', at: x.lastWholeAt, differs: x.differs, lastExactAt: x.lastExactAt });
    }
    return out;
}

function owners(): string[] {
    return (db.prepare(
        `SELECT nr.member_pubkey AS pk FROM node_roles nr JOIN members m ON nr.member_pubkey = m.public_key
         WHERE nr.role = 'owner' AND ${NODE_ROLE_ACTS}`,
    ).all() as { pk: string }[]).map((r) => r.pk);
}

/** Whether another server took this one's identity over (services/identity-epoch.ts): it is no main server now. */
function replaced(): boolean {
    try { return getReplacedInfo() !== null; } catch { return false; }
}

/** Open, update or close the incident for what the reports say now, and write the state. */
function evaluate(s: HealthState, t: number): void {
    // A server another took over from is read-only and no main server: nothing of its old standby is told from here.
    if (replaced()) {
        write(s);
        return;
    }
    const problems = problemsOf(s, t);
    if (problems.length === 0) {
        if (s.incident) {
            logger.info('P2P', `[StandbyHealth] ✅ The standby is healthy again: incident ${s.incident.id.slice(0, 8)} is over.`);
            s.lastIncident = { id: s.incident.id, startedAt: s.incident.startedAt, endedAt: t };
            s.incident = null;
        }
        write(s);
        return;
    }
    if (s.incident) {
        s.incident.problems = problems;
        write(s);
        return;
    }
    const incident: Incident = { id: crypto.randomBytes(8).toString('hex'), startedAt: t, pushedAt: null, pushed: 0, problems };
    s.incident = incident;
    const flapping = !!s.lastIncident && t - s.lastIncident.endedAt < PUSH_COOLDOWN_MS;
    // Written before the push: a push that throws never makes the next report push the same incident again.
    write(s);
    logger.security('P2P', `[StandbyHealth] ⚠️ The standby needs this community's owners: ${problems.map((p) => sentence(p, s)).join(' ')}`);
    if (flapping) {
        logger.info('P2P', '[StandbyHealth] No push for this one: the last incident ended less than an hour ago. Settings shows it.');
        return;
    }
    try {
        const to = owners();
        incident.pushed = to.length === 0 ? 0 : dispatchPushNotification(
            to, 'SYSTEM', PUSH_TITLE, pushBody(problems),
            { kind: 'standby_health', incidentId: incident.id, section: 'home' }, 'marketplace',
        );
        incident.pushedAt = t;
    } catch (e) {
        logger.warn('P2P', `[StandbyHealth] The owners' push failed: ${errorMessage(e)}`);
        incident.pushedAt = t;
    }
    write(s);
}

/** Every few minutes on a main server: a standby that stopped pulling sends no report to open its incident. */
export function checkStandbyHealth(): void {
    try {
        if (getNodeRole() !== 'primary') return;
        const s = read();
        if (s.standbys.length === 0 && !s.incident) return;
        evaluate(s, now());
    } catch (e) {
        logger.warn('P2P', `[StandbyHealth] Check failed: ${errorMessage(e)}`);
    }
}

let watch: ReturnType<typeof setInterval> | null = null;
/** Set on every node, as the directory mirror is: each tick reads the role, so a standby a take-over promotes starts watching its own. */
export function startStandbyHealthWatch(): void {
    if (watch) return;
    watch = setInterval(checkStandbyHealth, WATCH_EVERY_MS);
    watch.unref?.();
}

/** An owner's "this standby is gone for good": stop watching it (its next report, if any, watches it again). */
export function forgetStandby(id: unknown): boolean {
    if (typeof id !== 'string') return false;
    const s = read();
    const before = s.standbys.length;
    s.standbys = s.standbys.filter((x) => x.id !== id);
    if (s.standbys.length === before) return false;
    evaluate(s, now());
    logger.info('P2P', `[StandbyHealth] An owner stopped watching standby ${id.slice(0, 8)}.`);
    return true;
}

/**
 * Whether this server watches standbys now: a main server no other took over from. What an owner is shown (the admin
 * queue's item, the Settings banner) asks this first, so a server demoted to standby, or replaced, never shows an incident
 * it kept from when it was the main one, which nothing there could ever end.
 */
export function watchesStandbys(): boolean {
    try { return getNodeRole() === 'primary' && !replaced(); } catch { return false; }
}

/** Whether an incident is open: the admin queue's item (engine/admin-queue.ts), for owners only. */
export function standbyIncidentOpen(): boolean {
    try { return watchesStandbys() && read().incident !== null; } catch { return false; }
}

// ── Words ──────────────────────────────────────────────────────────────────────────────────

const PUSH_TITLE = 'Your standby server needs attention';

function label(id: string, s: HealthState): string {
    const x = s.standbys.find((y) => y.id === id);
    const others = s.standbys.length > 1;
    if (x?.address) return `The standby at ${x.address}`;
    return others ? `Standby ${id.slice(0, 6)}` : 'The standby';
}

function sentence(p: Problem, s: HealthState): string {
    const who = label(p.standby, s);
    if (p.kind === 'stopped') return `${who} has not made a copy of this server since ${timeInWords(p.since)}.`;
    if (p.kind === 'refused') return `${who}'s last ${p.count} copies of this server were refused: ${whyInWords(p.why)}.`;
    return `${who}'s last whole copy of this server${p.at !== null ? `, at ${timeInWords(p.at)},` : ''} did not match it: `
        + `${differsInWords(p.differs)} differed. Last exact copy: ${timeInWords(p.lastExactAt)}.`;
}

function pushBody(problems: Problem[]): string {
    const kinds = new Set(problems.map((p) => p.kind));
    const what = kinds.has('stopped') ? 'It has stopped copying this server.'
        : kinds.has('refused') ? 'Its copies of this server are being refused.'
            : 'Its copy of this server does not match it.';
    return `${what} If this server were lost, a take-over from it would miss what it has not copied. Open Settings to see what is wrong.`;
}

/** What to do, per kind, for the banner. */
const WHAT_TO_DO: Record<Problem['kind'], string> = {
    stopped: 'Check the standby server is running and can reach this one, and that it still has the replication token (a new token from Replication Access replaces the old one).',
    refused: "Open the standby's own Settings, under Live Backup Server, for what it says; a force-resync there copies this server afresh.",
    inexact: "It copies this server afresh by itself, at most every six hours. If this stays, run a force-resync from the standby's own Settings, under Live Backup Server.",
};

export interface StandbyHealthBanner {
    incident: {
        id: string;
        startedAt: number;
        pushed: boolean;
        lines: string[];
        whatToDo: string[];
    } | null;
    standbys: {
        id: string;
        label: string;
        lastPullAt: number;
        lastCopyAt: number | null;
        lastExactAt: number | null;
        healthy: boolean;
    }[];
}

/** For the Settings banner (owners only: routes/admin.ts diagnostics). Empty on a server that watches no standby now. */
export function getStandbyHealthBanner(): StandbyHealthBanner {
    if (!watchesStandbys()) return { incident: null, standbys: [] };
    const s = read();
    const problems = s.incident?.problems ?? [];
    const sick = new Set(problems.map((p) => p.standby));
    return {
        incident: s.incident ? {
            id: s.incident.id,
            startedAt: s.incident.startedAt,
            pushed: s.incident.pushedAt !== null && s.incident.pushed > 0,
            lines: problems.map((p) => sentence(p, s)),
            whatToDo: [...new Set(problems.map((p) => WHAT_TO_DO[p.kind]))],
        } : null,
        standbys: s.standbys.map((x) => ({
            id: x.id, label: label(x.id, s), lastPullAt: x.lastPullAt, lastCopyAt: x.lastCopyAt, lastExactAt: x.lastExactAt,
            healthy: !sick.has(x.id),
        })),
    };
}

/** The whole state, and when this process started, for a suite. */
export function readStandbyHealthForTests(): HealthState & { bootAt: number } {
    return { ...read(), bootAt };
}
