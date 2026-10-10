/**
 * A cap on the heavy list reads, so that a burst of them can't kill the node (docs/global-heavy-lists.md §5(c), slice 1).
 *
 * Every heavy list (the directory, the web app's directory, a big group's roster, the list of groups at its most) is
 * built whole in memory and kept until its last byte leaves. A 30,000-member directory (11.9 MB) holds about 57 MB while
 * it is in flight: two copies of the body in the heap, and a native write buffer three times its size. So the limit was
 * answers in flight, not members. On a 256 MB heap 12 directory reads at once ended the process, and on the global node's
 * 1 GB droplet (512 MB heap) the kernel killed it at 20 to 24. Docker restarted it, every phone synced again, and the
 * same burst met it again.
 *
 * Here a heavy answer is admitted while the weight of the answers in flight stays within a budget. An answer is in
 * flight from before its build until its last byte is written.
 *   - An answer's weight is the size of the last answer under its key. The key is the route and every input that changes
 *     its answer's size (heavyReadKey: a roster's group, status and role; the list of groups' filters, page and size),
 *     so a small answer (one group's convenors, a search that matches nothing) never stands in for the big one. So the
 *     web app's directory weighs more than a roster, and a small group's roster next to nothing. A key not yet measured
 *     counts as a quarter of the budget, about a directory at the default.
 *   - A key whose last answer was under LIGHT_BYTES isn't heavy and goes straight through. Answers that size are built
 *     and written in milliseconds: the list of groups at 50 a page (1.4 MB) survived 512 at once on a 256 MB heap.
 *   - Nothing waits behind the first answer: one answer bigger than the whole budget is still served, alone.
 *   - One that doesn't fit waits its turn, in order, for up to WAIT_MS. That is under the apps' shortest timeout on
 *     these reads (10 s, native syncMessages). Then it is answered 503 with Retry-After and `code: heavy_read_busy`. So is
 *     one that arrives with MAX_QUEUE already waiting.
 *   - The weight comes back when the last byte is written ('finish'), when the connection closes first ('close': a
 *     phone that gives up mid-answer must not keep it), and when the build throws. A reader who leaves while waiting
 *     leaves the line.
 *   - An answer let in has DEADLINE_MS to be sent. Then its connection is closed and its weight comes back. The server
 *     has no write timeout of its own, so a reader who stops reading (a phone put away mid-download, or one doing it on
 *     purpose) held its share for as long as it kept the connection open: four held 45 of the 48 MB.
 *   - While it refuses or cuts answers off, the log gets one line a minute saying how many.
 *   - A shared body (a snapshot's bytes, members-snapshot.ts) is counted once, at its full size, for as long as any send
 *     of it is in flight (holdSharedBody): a send holds the whole body until its last byte leaves, however small its
 *     window, and a body a newer version has replaced stays alive for as long as a send of it does. So the current
 *     snapshot is counted once however many read it, and so is each older one a reader who stopped reading still holds.
 *
 * Only a request the routes would answer gets here. The read gate, the signature and each route's own checks run first,
 * and a 304 costs nothing, so an unsigned or refused read never takes budget.
 *
 * This is a safety net, not service: under a real burst most readers are told "busy", keep what they have and ask again
 * later. Shared snapshots of the directory and rosters (slices 2 and 3) are what will serve them.
 *
 * The budget: HEAVY_READ_BUDGET_MB, a whole number above 0, default 48. That is about four 30,000-member directories.
 * The design measured four in flight at most 177 MB of heap on a 256 MB heap, 255 MB on a 512 MB heap, and 481 MB RSS:
 * inside the 1 GB droplet. A server with more memory can raise it; a smaller one should lower it.
 */
import { createHash } from 'node:crypto';
import type Koa from 'koa';
import { logger } from './logger.js';

/** The machine code on a heavy read refused as busy. */
export const HEAVY_READ_BUSY_CODE = 'heavy_read_busy';
/** The .env line that sets the budget, in MB. */
export const HEAVY_READ_BUDGET_ENV = 'HEAVY_READ_BUDGET_MB';
export const DEFAULT_HEAVY_READ_BUDGET_MB = 48;

const MB = 2 ** 20;
/** How long a heavy read waits for room before it is told "busy": under the apps' shortest timeout on these reads, 10 s. */
const WAIT_MS = 6_000;
/** How many may wait at once. Past this, one would wait only to be refused. */
const MAX_QUEUE = 64;
/**
 * How long an answer let in has to be sent before its connection is closed (see above). A 12 MB answer (a 30,000-member
 * directory or roster) takes about 100 s on a poor 1 Mbit/s mobile link, so 180 s still carries it at 0.56 Mbit/s, and
 * the web app's 15.4 MB directory at 0.72 Mbit/s. Generous on purpose: a reader cut off loses the whole download, while
 * one who stops reading on purpose can open another connection anyway, so the deadline is there to get back what a
 * stalled connection holds, not to hurry a slow one. Under server-limits.ts' 300 s for receiving a whole request.
 */
const DEADLINE_MS = 180_000;
/** Below this, a route's answer isn't heavy (see above). */
export const LIGHT_BYTES = 512 * 1024;
/** A route not yet measured weighs this share of the budget. */
const UNMEASURED_SHARE = 4;
/** Retry-After on a refusal, in seconds: spread over this range, so the readers turned away don't all come back at once. */
const RETRY_AFTER_MIN_S = 10;
const RETRY_AFTER_SPREAD_S = 20;
const LOG_EVERY_MS = 60_000;
/** How many keys' last sizes are kept (a roster's, one for each group and filter read). Past it, the longest unread is dropped. */
const MAX_SIZES_KEPT = 10_000;

interface HeavyReadSettings {
    budgetBytes: number;
    waitMs: number;
    maxQueue: number;
    deadlineMs: number;
}

interface Waiter {
    weight: () => number;
    admit: () => void;
    leave: () => void;
}

let testOverrides: Partial<HeavyReadSettings> = {};
let resolved: HeavyReadSettings | null = null;

let inFlightBytes = 0;
/** The most ever in flight at once (heavyReadStats), noted wherever inFlightBytes grows. */
let peakInFlightBytes = 0;
const notePeak = (): void => { if (inFlightBytes > peakInFlightBytes) peakInFlightBytes = inFlightBytes; };
const line: Waiter[] = [];
/** Each shared body held by sends in flight, and how many hold it (holdSharedBody). Its bytes are in inFlightBytes once. */
const sharedHeld = new Map<Buffer, number>();
/** The answer in flight on each request, so that its send can say which shared body it holds. */
const tickets = new WeakMap<object, Ticket>();

interface Ticket { phase: 'waiting' | 'in' | 'out'; held: number; shared: Buffer | null; waiter: Waiter | null; deadline: NodeJS.Timeout | null }
const lastSize = new Map<string, number>();
/**
 * The map keeps a fixed-size digest of each key, never the key: a key carries the request's inputs in full (a delta's
 * cursor, a search), so one long URL would keep kilobytes per entry, and MAX_SIZES_KEPT of them hundreds of MB.
 */
const slot = (key: string): string => createHash('sha256').update(key).digest('base64url');
let admittedCount = 0;
let refusedCount = 0;
let cutOffCount = 0;
let refusedSinceLog = 0;
let cutOffSinceLog = 0;
let lastLogAt = 0;
let logTimer: NodeJS.Timeout | null = null;

function budgetFromEnv(): number {
    const raw = process.env[HEAVY_READ_BUDGET_ENV] ?? '';
    const value = raw.trim();
    if (value === '') return DEFAULT_HEAVY_READ_BUDGET_MB * MB;
    const n = /^\d{1,7}$/.test(value) ? Number(value) : 0;
    if (n > 0) return n * MB;
    console.warn(`⚠️  ${HEAVY_READ_BUDGET_ENV}=${JSON.stringify(raw)} is not a whole number above 0, so this node keeps ${DEFAULT_HEAVY_READ_BUDGET_MB} MB for heavy list reads in flight.`);
    return DEFAULT_HEAVY_READ_BUDGET_MB * MB;
}

/** What the cap runs with: the .env's budget (read once) and the fixed wait, line and deadline, under any test overrides. */
export function heavyReadSettings(): Readonly<HeavyReadSettings> {
    resolved ??= { budgetBytes: budgetFromEnv(), waitMs: WAIT_MS, maxQueue: MAX_QUEUE, deadlineMs: DEADLINE_MS, ...testOverrides };
    return resolved;
}

/**
 * What is in flight and waiting now, the most ever in flight at once, and how many were let through, refused and cut off
 * at the deadline since the server started.
 */
export function heavyReadStats(): { inFlightBytes: number; peakInFlightBytes: number; waiting: number; admitted: number; refused: number; cutOff: number; sharedBodies: number } {
    return { inFlightBytes, peakInFlightBytes, waiting: line.length, admitted: admittedCount, refused: refusedCount, cutOff: cutOffCount, sharedBodies: sharedHeld.size };
}

/** What a send holding `body` would add to the bytes in flight now: nothing while another send in flight holds it. */
export function sharedBodyCost(body: Buffer): number {
    return sharedHeld.has(body) ? 0 : body.length;
}

/**
 * Called by a heavy read's build as it sends a shared body (members-snapshot.ts): from now until this answer is out, it
 * holds `window` bytes of its own, and `body`, counted once among all the sends that hold it. Outside a heavy read it
 * does nothing.
 */
export function holdSharedBody(ctx: Koa.Context, body: Buffer, window: number): void {
    const ticket = tickets.get(ctx);
    if (!ticket || ticket.phase !== 'in') return;
    if (ticket.shared) releaseShared(ticket.shared);
    inFlightBytes += window - ticket.held;
    ticket.held = window;
    ticket.shared = body;
    const holders = sharedHeld.get(body) ?? 0;
    sharedHeld.set(body, holders + 1);
    if (holders === 0) inFlightBytes += body.length;
    notePeak();
}

function releaseShared(body: Buffer): void {
    const holders = sharedHeld.get(body) ?? 0;
    if (holders > 1) { sharedHeld.set(body, holders - 1); return; }
    sharedHeld.delete(body);
    inFlightBytes -= body.length;
}

/** Tests only: how many characters the kept keys hold, all together. */
export function heavyReadKeptKeyCharsForTests(): number {
    let chars = 0;
    for (const k of lastSize.keys()) chars += k.length;
    return chars;
}

/** The size of the last answer a route gave, as a heavy read counts it; undefined before its first. */
export function heavyReadWeight(key: string): number | undefined {
    return lastSize.get(slot(key));
}

/**
 * Tests only: other settings (a smaller budget, a shorter wait or deadline), and a clean slate: no sizes known, nothing
 * counted, the log's minute begun again. Call it with nothing in flight. `undefined` puts the defaults back.
 */
export function setHeavyReadsForTests(overrides: Partial<HeavyReadSettings> | undefined): void {
    testOverrides = { ...(overrides ?? {}) };
    resolved = null;
    lastSize.clear();
    peakInFlightBytes = inFlightBytes;
    admittedCount = 0;
    refusedCount = 0;
    cutOffCount = 0;
    refusedSinceLog = 0;
    cutOffSinceLog = 0;
    lastLogAt = 0;
    if (logTimer) clearTimeout(logTimer);
    logTimer = null;
}

function fits(weight: number): boolean {
    return inFlightBytes === 0 || inFlightBytes + weight <= heavyReadSettings().budgetBytes;
}

/** Let in whoever is first in line, for as long as they fit. In order: a big answer waiting is never overtaken. */
function drain(): void {
    while (line.length > 0 && fits(line[0].weight())) line.shift()!.admit();
}

function remember(key: string, bytes: number): void {
    const k = slot(key);
    lastSize.delete(k);
    lastSize.set(k, bytes);
    if (lastSize.size > MAX_SIZES_KEPT) lastSize.delete(lastSize.keys().next().value!);
}

/** The size of the answer on `ctx`, once its headers say it: Koa sets Content-Length for a string or Buffer body. */
function answerBytes(ctx: Koa.Context): number | null {
    const header = typeof ctx.res?.getHeader === 'function' ? ctx.res.getHeader('content-length') : undefined;
    const n = Number(header);
    return header !== undefined && Number.isFinite(n) && n >= 0 ? n : null;
}

function noteRefusal(): void {
    refusedCount++;
    refusedSinceLog++;
    noteForLog();
}

function noteCutOff(): void {
    cutOffCount++;
    cutOffSinceLog++;
    noteForLog();
}

/** At most one log line a minute, for the refusals and cut-offs since the last. */
function noteForLog(): void {
    const now = Date.now();
    if (now - lastLogAt >= LOG_EVERY_MS) writeLogLine(now);
    else logTimer ??= setTimeout(() => { logTimer = null; if (refusedSinceLog + cutOffSinceLog > 0) writeLogLine(Date.now()); }, lastLogAt + LOG_EVERY_MS - now).unref();
}

function writeLogLine(now: number): void {
    const s = heavyReadSettings();
    const what = [
        refusedSinceLog > 0 ? `${refusedSinceLog} answered "busy" (503)` : '',
        cutOffSinceLog > 0 ? `${cutOffSinceLog} cut off, not sent within ${s.deadlineMs / 1000} s` : '',
    ].filter(Boolean).join('; ');
    logger.warn('SYS', `Heavy list reads: ${what} in the last minute. `
        + `${(inFlightBytes / MB).toFixed(1)} MB of ${(s.budgetBytes / MB).toFixed(0)} MB in flight, ${line.length} waiting. `
        + `${HEAVY_READ_BUDGET_ENV} sets the budget (apps/server/src/heavy-reads.ts).`);
    refusedSinceLog = 0;
    cutOffSinceLog = 0;
    lastLogAt = now;
}

function refuse(ctx: Koa.Context): void {
    ctx.status = 503;
    // The route set its ETag before it came here: a refusal must not carry the tag of an answer it isn't.
    if (typeof ctx.remove === 'function') ctx.remove('ETag');
    ctx.set('Retry-After', String(RETRY_AFTER_MIN_S + Math.floor(Math.random() * (RETRY_AFTER_SPREAD_S + 1))));
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { error: 'This community is busy right now. Please try again in a moment.', code: HEAVY_READ_BUSY_CODE };
}

/**
 * A heavy read's key: its route and every input that changes its answer's size, so that a small answer (a roster's
 * convenors, a search that matches nothing) never stands in for the big one under the same route. An input left
 * undefined is the route's default and is left out. Each value is URI-encoded, so none can read as another input.
 */
export function heavyReadKey(route: string, inputs: Record<string, unknown>): string {
    const parts = Object.entries(inputs).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
    return parts.length > 0 ? `${route}?${parts.join('&')}` : route;
}

/**
 * Build and send a heavy answer under the cap: `build` sets ctx.body as the route always has, once there is room. Call it
 * after every check that refuses or answers 304, so only an answer that will be built takes budget. `key` names whose
 * last size this answer's weight is (heavyReadKey: every input that changes the answer's size). When there is no room in
 * time, the reader gets 503 with Retry-After and `code: heavy_read_busy`, and `build` never runs.
 *
 * `fixedWeight`: what this answer holds in flight when that isn't its size (a shared body sent a window at a time,
 * members-snapshot.ts). It is always weighed at that, never light, and its size isn't learned. A function is asked
 * again each time the answer is weighed, while it waits too: a ready snapshot's send weighs its body only while no other
 * send holds that (sharedBodyCost).
 */
export async function heavyRead(ctx: Koa.Context, key: string, build: () => void | Promise<void>, fixedWeight?: number | (() => number)): Promise<void> {
    const res = ctx.res;
    const fixed = fixedWeight !== undefined;
    const known = fixed ? undefined : lastSize.get(slot(key));
    const fixedBytes = typeof fixedWeight === 'number' ? fixedWeight : 0;
    // A caller's function holds what it weighs (a ready snapshot, both its bodies), so it is let go as soon as this answer
    // is in or out: the listeners below, and all they hold, live as long as the connection. Kept, a reader who stopped
    // reading a gzip copy held the plain body too.
    let weighs = typeof fixedWeight === 'function' ? fixedWeight : null;
    // A fixed weight of 0 is a caller's light answer (a small shared roster whose body is already held, roster-snapshots.ts):
    // straight through, as a key whose last answer was light.
    const light = fixed ? (weighs ? weighs() : fixedBytes) === 0 : known !== undefined && known < LIGHT_BYTES;
    const learned = light ? 0 : (known ?? Math.ceil(heavyReadSettings().budgetBytes / UNMEASURED_SHARE));
    const weight = () => (weighs ? weighs() : fixed ? fixedBytes : learned);
    // A route called with no response to watch (a suite dispatching a handler directly): its weight is given back as
    // soon as it is built.
    const watched = typeof res?.once === 'function';
    // A reader already gone (its connection closed before the route got here) gets nothing built. Its 'close' has fired
    // already, so nothing would ever give the weight back.
    if (watched && (res.destroyed || res.writableEnded)) return;

    // This answer: waiting in line, in flight holding `held` bytes of the budget, or out (refused, left or done).
    const ticket: Ticket = { phase: 'waiting', held: 0, shared: null, waiter: null, deadline: null };
    tickets.set(ctx, ticket);
    const take = () => {
        ticket.phase = 'in';
        ticket.held = weight();
        weighs = null;
        ticket.waiter = null;
        inFlightBytes += ticket.held;
        notePeak();
        admittedCount++;
        if (watched) ticket.deadline = setTimeout(cutOff, heavyReadSettings().deadlineMs).unref();
    };
    // Not sent by its deadline: the connection is closed, and the weight comes back now rather than whenever its reader
    // hangs up. The reader gets an answer cut short, and keeps what it had.
    const cutOff = () => {
        if (ticket.phase !== 'in') return;
        res.destroy();
        giveBack();
        noteCutOff();
    };
    const giveBack = () => {
        if (ticket.deadline) clearTimeout(ticket.deadline);
        if (ticket.phase === 'waiting') ticket.waiter?.leave();
        const wasIn = ticket.phase === 'in';
        ticket.phase = 'out';
        weighs = null;
        if (!wasIn) return;
        // Its size, for the next answer's weight: also from a reader who left mid-answer, whose headers were already set.
        const bytes = answerBytes(ctx);
        if (!fixed && bytes !== null && (watched ? res.statusCode : ctx.status) === 200) remember(key, bytes);
        inFlightBytes -= ticket.held;
        ticket.held = 0;
        if (ticket.shared) releaseShared(ticket.shared);
        ticket.shared = null;
        drain();
    };
    if (watched) {
        res.once('finish', giveBack);
        res.once('close', giveBack);
    }

    if (light || (line.length === 0 && fits(weight()))) {
        take();
    } else if (line.length >= heavyReadSettings().maxQueue) {
        ticket.phase = 'out';
        weighs = null;
        noteRefusal();
        refuse(ctx);
        return;
    } else {
        const admitted = await new Promise<boolean>((resolve) => {
            const waiter: Waiter = {
                weight,
                admit: () => { clearTimeout(timer); take(); resolve(true); },
                leave: () => {
                    clearTimeout(timer);
                    const at = line.indexOf(waiter);
                    if (at >= 0) line.splice(at, 1);
                    resolve(false);
                },
            };
            const timer = setTimeout(waiter.leave, heavyReadSettings().waitMs);
            ticket.waiter = waiter;
            line.push(waiter);
        });
        if (!admitted) {
            // Waited its time, or its reader left the line ('close', which set it out): either way it is answered as
            // busy, and only the first counts as a refusal (a reader who left hears nothing).
            if (ticket.phase !== 'out') noteRefusal();
            ticket.phase = 'out';
            weighs = null;
            ticket.waiter = null;
            refuse(ctx);
            // The one that left may have been holding up the line.
            drain();
            return;
        }
    }

    try {
        await build();
    } catch (e) {
        giveBack();
        throw e;
    }
    if (!watched) { giveBack(); return; }
    // Built: what is in flight is this answer as it is, not the last one's size, when its headers already say so. A
    // shared body it sends was counted as it began (holdSharedBody), once, and its size is still learned for the next build.
    const bytes = ticket.phase === 'in' && !light && !fixed ? answerBytes(ctx) : null;
    if (bytes !== null) {
        if (!ticket.shared) {
            inFlightBytes += bytes - ticket.held;
            ticket.held = bytes;
            notePeak();
        }
        if (ctx.status === 200) remember(key, bytes);
    }
    drain();
}
