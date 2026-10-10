/**
 * This server's own alerts to its owners (design scratch/global-node/DESIGN-alerts-fable.md §3, slice S3): the vault's
 * alert book (apps/vault/src/api/alerts.ts) on a community server.
 *
 * ## What it watches
 *
 * Every minute the server looks at its own state: the disk (80, 90 and 95 % full, three minutes running, cleared three
 * points below), backups going off the box (failing twice, none for two intervals, or none sent at all: destinations set
 * with no recovery code, or none of them usable), backups not leaving at all (no destination and no recovery code: the
 * owners only, once a week), scheduled snapshots failing twice in a row, a crash
 * loop (three starts after unclean stops in 15 minutes, told at the third start so it gets out before the next crash), an unclean stop (a
 * failed integrity check is urgent), the host watchdog restarting a frozen server or going quiet, the standby needing its
 * owners (services/standby-health.ts), and a public server whose Let's Encrypt certificate fell back to self-signed.
 *
 * A condition that starts is told once (raised), again every 24 hours while it lasts (still), and once when it has been
 * over for 15 minutes (resolved). Back within those 15 minutes, nothing is told: the condition just goes on. One that
 * starts again within 6 hours of a told end is told as `still`, not as new. So a condition that swings back within 15
 * minutes sends nothing more; one that stays off longer than that is told each time it ends (under the hourly cap). While
 * an end is being held, the condition no longer counts in the banner or shows as active: the owner already fixed it.
 *
 * ## Who is told, and how
 *
 * 1. The owners, in the app: one `owner.alert` push per minute at most, for whatever started (each condition at most
 *    once a day, the disk's levels as one: the highest; the words are fixed, packages/beanpool-core push-notice.ts), and the admin queue's `server_alert` banner (engine/admin-queue.ts) while anything is active. Admins
 *    and moderators are not told: the Alerts panel is the owners' (routes/alerts.ts).
 * 2. Optionally, one channel the operator chooses: an ntfy topic, or any URL that takes a JSON POST. Nothing goes through
 *    BeanPool's servers: with none set, the push and the banner still work and nothing leaves the server. A channel
 *    that fails keeps what it missed (up to 50 events) and is tried again every 5 minutes, with all of it in one message.
 *    At most 20 messages an hour; high and urgent ones are never held by that, only by a hard ceiling of 60. A redirect
 *    is a failed send, never followed: the address the owner gave is the only one the alerts go to.
 *
 * ## The channel's secret
 *
 * The URL (an ntfy topic's name is its secret) and an optional token are kept in .env (ALERTS_WEBHOOK_URL,
 * ALERTS_WEBHOOK_FORMAT, ALERTS_WEBHOOK_TOKEN), or in data/alerts.json (mode 600) when set in Settings, as off-box backup
 * keys are: never in the database, so never in a snapshot, a backup or a standby's copy; never logged; never shown back
 * (the scheme and registrable domain are shown, never a subdomain, the path or the token). A standby that takes over has no channel until its owner sets one.
 *
 * ## What an alert says
 *
 * The community's name, the condition in plain words, since when, and counts. Never a member's name or key, an address,
 * anything a member wrote, a destination's key or the channel's URL.
 */

import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/db.js';
import { writeFileAtomic } from '../write-file-atomic.js';
import { logger } from '../logger.js';
import { errorMessage } from '../error-message.js';
import { getNodeRole } from '../config/node-role.js';
import { getLocalConfig } from '../config/local-config.js';
import { NODE_ROLE_ACTS } from '../engine/node-roles.js';
import { getDiskHealth } from '../engine/storage-health.js';
import { getShutdownStatus } from '../engine/shutdown-recovery.js';
import { dispatchPushNotification, readWatchdogStatus, resolvePublicNodeUrl } from '../state-engine.js';
import { getOffboxStatus } from './offbox-backups.js';
import { backupLockState } from './sealed-backup.js';
import { standbyIncidentOpen } from './standby-health.js';
import { snapshotFailuresInARow } from './snapshot-scheduler.js';
import { tlsFellBackToSelfSigned } from './tls.js';

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

/** The channel set in Settings: its URL and token, so mode 600 and never in a backup. */
export const ALERTS_SETTINGS_FILE = 'alerts.json';
/** What the alert book holds between starts: conditions, waiting events, history. Our own words only, never a secret. */
export const ALERTS_STATE_FILE = 'alerts-state.json';
/** The last starts of this server that followed an unclean stop, for the crash-loop row. */
export const BOOTS_FILE = 'boots.json';

export const ALERT_TICK_MS = 60_000;
export const ALERT_REMIND_MS = 24 * 60 * 60_000;
export const ALERT_RETRY_MS = 5 * 60_000;
/** A condition back this soon after it ended is told as `still`, not as new. */
export const ALERT_FLAP_MS = 6 * 60 * 60_000;
/**
 * An end is told only once it has lasted this long; back before that, nothing is told at all (the condition just goes
 * on). A disk swinging 81 % ↔ 76 % every 5 minutes is one condition, not 288 messages a day.
 */
export const ALERT_CLEAR_HOLD_MS = 15 * 60_000;
export const ALERT_HOURLY_CAP = 20;
/** Even urgent ones stop here: a loop that raises and clears must not flood the operator's phone. */
export const ALERT_HOURLY_CEILING = 60;
const MAX_WAITING = 50;
const MAX_HISTORY = 50;
const WEBHOOK_TIMEOUT_MS = 15_000;
const DISK_TICKS = 3;
const DISK_HYSTERESIS = 3;
const CRASH_LOOP_STARTS = 3;
const CRASH_LOOP_WINDOW_MS = 15 * 60_000;
const CRASH_LOOP_CLEAR_MS = 60 * 60_000;
const WATCHDOG_QUIET_MS = 10 * 60_000;
const MAX_BOOTS = 20;

/** ntfy's priorities: 1 min, 2 low, 3 default, 4 high, 5 urgent. */
export type AlertPriority = 1 | 2 | 3 | 4 | 5;

export type AlertKey =
    | 'disk.80' | 'disk.90' | 'disk.95'
    | 'backups.offbox' | 'backups.none'
    | 'snapshots.failed'
    | 'boot.crashloop' | 'boot.unclean'
    | 'freeze.recovered' | 'freeze.nowatchdog'
    | 'standby.incident'
    | 'tls.fallback';

interface Row {
    title: string;
    priority: AlertPriority;
    /** Sent to the operator's channel. `backups.none` is a nudge to the owners only. */
    webhook: boolean;
    /** How often at most the owners are pushed for it; 0 = never (standby-health pushes its own). */
    pushEveryMs: number;
    /** Counted in the admin queue's `server_alert` banner (the standby and an unclean stop have banners of their own). */
    banner: boolean;
}

const DAY = 24 * 60 * 60_000;
const ROWS: Record<AlertKey, Row> = {
    'disk.80': { title: 'disk 80% full', priority: 3, webhook: true, pushEveryMs: DAY, banner: true },
    'disk.90': { title: 'disk 90% full', priority: 4, webhook: true, pushEveryMs: DAY, banner: true },
    'disk.95': { title: 'disk 95% full', priority: 5, webhook: true, pushEveryMs: DAY, banner: true },
    'backups.offbox': { title: 'off-box backups not leaving', priority: 4, webhook: true, pushEveryMs: DAY, banner: true },
    'backups.none': { title: 'backups stay on this server', priority: 2, webhook: false, pushEveryMs: 7 * DAY, banner: true },
    'snapshots.failed': { title: 'snapshots failing', priority: 3, webhook: true, pushEveryMs: DAY, banner: true },
    'boot.crashloop': { title: 'restarting again and again', priority: 5, webhook: true, pushEveryMs: DAY, banner: true },
    'boot.unclean': { title: 'restarted after an unclean stop', priority: 3, webhook: true, pushEveryMs: DAY, banner: false },
    'freeze.recovered': { title: 'restarted by its watchdog', priority: 4, webhook: true, pushEveryMs: DAY, banner: true },
    'freeze.nowatchdog': { title: 'watchdog quiet', priority: 2, webhook: true, pushEveryMs: 0, banner: true },
    'standby.incident': { title: 'standby needs attention', priority: 3, webhook: true, pushEveryMs: 0, banner: false },
    'tls.fallback': { title: 'certificate fell back to self-signed', priority: 4, webhook: true, pushEveryMs: DAY, banner: true },
};

export const ALERT_KEYS = Object.keys(ROWS) as AlertKey[];

export interface Condition {
    key: AlertKey;
    active: boolean;
    /** The condition in the server's own words, with counts: nothing per member. */
    detail: string;
    since?: number;
    /** Overrides the row's priority (an unclean stop whose integrity check failed is urgent). */
    priority?: AlertPriority;
    /** Told once and not kept active (the watchdog restarted us). */
    oneShot?: boolean;
}

export interface AlertEvent {
    key: AlertKey;
    kind: 'raised' | 'still' | 'cleared';
    at: number;
    since: number;
    priority: AlertPriority;
    detail: string;
}

interface Raised {
    since: number;
    detail: string;
    toldAt: number;
    priority: AlertPriority;
    /** When it was first seen over, while that end waits ALERT_CLEAR_HOLD_MS to be told. */
    endedAt?: number;
}

interface ChannelState {
    lastOkAt: number | null;
    lastTriedAt: number | null;
    failedInARow: number;
    error: string | null;
    nextTryAt: number;
}

interface BookState {
    raised: Partial<Record<AlertKey, Raised>>;
    clearedAt: Partial<Record<AlertKey, number>>;
    waiting: AlertEvent[];
    history: AlertEvent[];
    pushedAt: Partial<Record<AlertKey, number>>;
    sentAt: number[];
    channel: ChannelState;
    dropped: number;
    diskTicks: Record<'80' | '90' | '95', number>;
    watchdogRecoveries: number | null;
}

const emptyChannel = (): ChannelState => ({ lastOkAt: null, lastTriedAt: null, failedInARow: 0, error: null, nextTryAt: 0 });
const emptyState = (): BookState => ({
    raised: {}, clearedAt: {}, waiting: [], history: [], pushedAt: {}, sentAt: [], channel: emptyChannel(), dropped: 0,
    diskTicks: { '80': 0, '90': 0, '95': 0 }, watchdogRecoveries: null,
});

let clockOffsetMs = 0;
const now = () => Date.now() + clockOffsetMs;

/** A suite moves the alert clock forward (a day of reminders, an hour of the cap) in a second. */
export function setAlertsClockForTests(offsetMs: number): void {
    clockOffsetMs = offsetMs;
}

let state: BookState | null = null;

function stateFile(): string {
    return path.join(dataDir(), ALERTS_STATE_FILE);
}

function readState(): BookState {
    if (state) return state;
    try {
        const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
        state = { ...emptyState(), ...parsed, channel: { ...emptyChannel(), ...(parsed?.channel ?? {}) } };
    } catch {
        state = emptyState();
    }
    return state!;
}

function writeState(): void {
    if (!state) return;
    try {
        writeFileAtomic(stateFile(), JSON.stringify(state), { mode: 0o600 });
    } catch (e) {
        logger.warn('SYS', `[Alerts] Could not keep the alert book: ${errorMessage(e)}`);
    }
}

/** Forget everything (a suite starting a step from nothing). */
export function resetAlertsForTests(): void {
    state = emptyState();
    writeState();
}

// ── The channel ─────────────────────────────────────────────────────────────────────────────

export type AlertFormat = 'ntfy' | 'json';

export interface AlertChannel {
    source: 'env' | 'settings';
    url: string;
    format: AlertFormat;
    token: string | null;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Why a URL can't be the channel, in words that never repeat it; null when it can. */
export function checkChannelUrl(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw.trim()) return 'The address is empty';
    if (raw.length > 2048) return 'The address is longer than 2048 characters';
    let u: URL;
    try { u = new URL(raw.trim()); } catch { return 'The address is not a URL'; }
    if (u.username || u.password) return 'Put no name or password in the address: use the token field';
    if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) return 'The address must start with https:// (http:// only on this machine)';
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The address must start with https://';
    return null;
}

function checkToken(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string' || raw.length > 512 || !/^[\x21-\x7e]+$/.test(raw)) return 'The token must be up to 512 visible characters, no spaces';
    return null;
}

function settingsFile(): string {
    return path.join(dataDir(), ALERTS_SETTINGS_FILE);
}

/** The channel: .env's when its URL is set there, else the one set in Settings, else none. */
export function readAlertChannel(env: NodeJS.ProcessEnv = process.env): AlertChannel | null {
    const envUrl = env.ALERTS_WEBHOOK_URL?.trim();
    if (envUrl) {
        if (checkChannelUrl(envUrl) || checkToken(env.ALERTS_WEBHOOK_TOKEN?.trim())) return null;
        return { source: 'env', url: envUrl, format: env.ALERTS_WEBHOOK_FORMAT?.trim() === 'json' ? 'json' : 'ntfy', token: env.ALERTS_WEBHOOK_TOKEN?.trim() || null };
    }
    try {
        const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
        if (typeof s?.url !== 'string' || checkChannelUrl(s.url)) return null;
        return { source: 'settings', url: s.url, format: s.format === 'json' ? 'json' : 'ntfy', token: typeof s.token === 'string' && s.token ? s.token : null };
    } catch {
        return null;
    }
}

/** A .env channel that can't be used, by setting name, never its value; else a Settings one that can't be. */
function envChannelProblem(env: NodeJS.ProcessEnv = process.env): string | null {
    const envUrl = env.ALERTS_WEBHOOK_URL?.trim();
    if (!envUrl) return settingsChannelProblem();
    const bad = checkChannelUrl(envUrl);
    if (bad) return `ALERTS_WEBHOOK_URL in .env can't be used: ${bad.toLowerCase()}.`;
    const badToken = checkToken(env.ALERTS_WEBHOOK_TOKEN?.trim());
    if (badToken) return `ALERTS_WEBHOOK_TOKEN in .env can't be used: ${badToken.toLowerCase()}.`;
    return null;
}

/** A channel file that is there but can't be used (unreadable, not JSON, a bad address), never repeating what it holds. */
function settingsChannelProblem(): string | null {
    const lead = "The alert channel kept in Settings (data/alerts.json)";
    let raw: string;
    try {
        raw = fs.readFileSync(settingsFile(), 'utf8');
    } catch (e) {
        return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : `${lead} can't be read: set it again.`;
    }
    let s: any;
    try { s = JSON.parse(raw); } catch { return `${lead} is not readable: set it again.`; }
    const bad = checkChannelUrl(s?.url);
    return bad ? `${lead} can't be used: ${bad.toLowerCase()}. Set it again.` : null;
}

/** Set (or with `remove`, take away) the channel kept in Settings. A token left out keeps the stored one for the same URL. */
export function updateAlertChannel(input: { url?: unknown; format?: unknown; token?: unknown; remove?: unknown }):
    { ok: true } | { ok: false; error: string } {
    if (process.env.ALERTS_WEBHOOK_URL?.trim()) return { ok: false, error: 'The alert channel is set in .env (ALERTS_WEBHOOK_URL): change it there' };
    const file = settingsFile();
    if (input.remove === true) {
        try {
            fs.unlinkSync(file);
        } catch (e) {
            if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                return { ok: false, error: "The channel kept in Settings (data/alerts.json) could not be removed: remove that file by hand" };
            }
        }
        return { ok: true };
    }
    const bad = checkChannelUrl(input.url);
    if (bad) return { ok: false, error: bad };
    if (input.format !== undefined && input.format !== 'ntfy' && input.format !== 'json') return { ok: false, error: "The format is 'ntfy' or 'json'" };
    const badToken = checkToken(input.token);
    if (badToken) return { ok: false, error: badToken };
    const url = (input.url as string).trim();
    const before = readAlertChannel();
    const token = typeof input.token === 'string' && input.token ? input.token
        : input.token === undefined && before?.source === 'settings' && before.url === url ? before.token : null;
    writeFileAtomic(file, JSON.stringify({ url, format: input.format === 'json' ? 'json' : 'ntfy', token }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* the rename kept the temp file's mode */ }
    const s = readState();
    s.channel = emptyChannel();
    writeState();
    return { ok: true };
}

/** Two letters of a country under which names are registered a level down (example.co.uk, example.com.au). */
const SECOND_LEVEL = /^(com|co|net|org|gov|edu|ac|or|ne|go|gob|nic|ltd|plc|sch|mil|nom|id)$/;

/**
 * The part of a host a screen may show: its registrable domain (ntfy.sh, example.co.uk), with `…` for any subdomain
 * left out, since webhook services key a channel by its subdomain. An IP address is shown as it is; never a port.
 */
export function shownHost(hostname: string): string {
    if (LOOPBACK.has(hostname) || hostname.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;
    const labels = hostname.replace(/\.$/, '').split('.');
    const n = labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.test(labels[labels.length - 2]) ? 3 : 2;
    return labels.length > n ? `….${labels.slice(-n).join('.')}` : labels.join('.');
}

/** The channel as a screen may show it: the scheme and registrable domain, never a subdomain, the path (an ntfy topic's name is its secret) or the token. */
export function describeChannel(c: AlertChannel): { source: AlertChannel['source']; format: AlertFormat; where: string; tokenSet: boolean } {
    let where = 'set';
    try {
        const u = new URL(c.url);
        where = `${u.protocol}//${shownHost(u.hostname)}/…`;
    } catch { /* checked when set */ }
    return { source: c.source, format: c.format, where, tokenSet: !!c.token };
}

// ── Words ──────────────────────────────────────────────────────────────────────────────────

function when(ms: number): string {
    return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function communityName(): string {
    try {
        const lc = getLocalConfig() as any;
        const name = (lc.communityName || lc.callsign || '').toString().trim();
        return name ? name.slice(0, 60) : 'Your BeanPool server';
    } catch {
        return 'Your BeanPool server';
    }
}

function settingsLink(): string | null {
    try {
        const base = resolvePublicNodeUrl();
        return base ? `${base}/settings#section=home` : null;
    } catch {
        return null;
    }
}

export interface AlertMessage {
    subject: string;
    text: string;
    priority: AlertPriority;
    click: string | null;
    events: AlertEvent[];
}

/** One message for `events`: the community's name, each condition, since when, what to do. Nothing about any member. */
export function composeAlert(community: string, events: AlertEvent[], click: string | null = settingsLink()): AlertMessage {
    const first = events[0];
    const head = first.kind === 'cleared' ? `${ROWS[first.key].title}: resolved` : ROWS[first.key].title;
    const subject = `${community}: ${head}${events.length > 1 ? ` (+${events.length - 1} more)` : ''}`;
    const lines = events.map((e) => {
        const title = ROWS[e.key].title;
        if (e.kind === 'cleared') return `- RESOLVED (${title}, since ${when(e.since)}): ${e.detail}`;
        return `- ${e.kind === 'still' ? 'STILL ' : ''}${title.toUpperCase()} since ${when(e.since)}: ${e.detail}`;
    });
    const text = [
        `${community}, its BeanPool server:`,
        '',
        ...lines,
        '',
        click ? `Open Settings: ${click}` : 'Open Settings on this server to see more.',
        'This message names no member.',
    ].join('\n');
    const priority = Math.max(...events.map((e) => (e.kind === 'cleared' ? 2 : e.priority))) as AlertPriority;
    return { subject, text, priority, click, events };
}

// ── Sending ────────────────────────────────────────────────────────────────────────────────

/** A header value as ntfy reads it: plain ASCII as it is, anything else as an RFC 2047 encoded word. */
function headerText(s: string): string {
    const flat = s.replace(/[\r\n]+/g, ' ');
    return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`;
}

const NTFY_TAGS: Record<AlertPriority, string> = { 1: 'bar_chart', 2: 'white_check_mark', 3: 'warning', 4: 'warning', 5: 'rotating_light' };

/**
 * One POST to the channel. A 2xx is delivered; anything else, a redirect included (never followed: `redirect: 'manual'`),
 * is a failure in a few words that never repeat the address or the token.
 */
export async function sendToChannel(c: AlertChannel, m: AlertMessage): Promise<{ ok: true; status: number } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
        const headers: Record<string, string> = {};
        let body: string;
        if (c.format === 'ntfy') {
            body = m.text;
            headers['Content-Type'] = 'text/plain; charset=utf-8';
            headers.Title = headerText(m.subject);
            headers.Priority = String(m.priority);
            headers.Tags = m.events.every((e) => e.kind === 'cleared') ? 'white_check_mark' : NTFY_TAGS[m.priority];
            if (m.click) headers.Click = m.click;
        } else {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify({
                subject: m.subject, text: `${m.subject}\n\n${m.text}`, content: `${m.subject}\n\n${m.text}`.slice(0, 2000),
                priority: m.priority, click: m.click,
                events: m.events.map((e) => ({ condition: e.key, state: e.kind, priority: e.priority, since: new Date(e.since).toISOString(), detail: e.detail })),
            });
        }
        if (c.token) headers.Authorization = `Bearer ${c.token}`;
        const res = await fetch(c.url, { method: 'POST', body, headers, signal: controller.signal, redirect: 'manual' });
        // Only the status counts: the answer itself is never read, so a huge one (the channel is the owner's choice, and
        // may misbehave) costs the node nothing.
        await res.body?.cancel().catch(() => undefined);
        if (res.status >= 300 && res.status < 400) return { ok: false, error: `redirected (HTTP ${res.status}); a redirect is not followed` };
        if (res.status < 200 || res.status >= 300) return { ok: false, error: `HTTP ${res.status}` };
        return { ok: true, status: res.status };
    } catch {
        return { ok: false, error: controller.signal.aborted ? 'timed out' : 'unreachable' };
    } finally {
        clearTimeout(timer);
    }
}

function sentThisHour(s: BookState, t: number): number {
    s.sentAt = s.sentAt.filter((x) => t - x < 60 * 60_000);
    return s.sentAt.length;
}

let sending: Promise<void> | null = null;

/** Sends what waits, when a channel is set and a try is due, inside the hourly cap. One send at a time. */
export function flushAlerts(): Promise<void> {
    if (sending) return sending;
    const s = readState();
    const c = readAlertChannel();
    const t = now();
    if (!c || s.waiting.length === 0 || t < s.channel.nextTryAt) return Promise.resolve();
    const events = s.waiting.slice();
    const top = Math.max(...events.map((e) => (e.kind === 'cleared' ? 2 : e.priority)));
    const count = sentThisHour(s, t);
    // Held, not dropped: they go together once the hour's oldest message is an hour old, or with the next high one. Worked
    // out at every flush, never kept as a retry time, so a high alert is never waiting behind a hold.
    if (count >= ALERT_HOURLY_CEILING || (count >= ALERT_HOURLY_CAP && top < 4)) return Promise.resolve();
    sending = (async () => {
        const result = await sendToChannel(c, composeAlert(communityName(), events));
        const after = now();
        s.channel.lastTriedAt = after;
        if (result.ok) {
            s.waiting = s.waiting.filter((e) => !events.includes(e));
            s.channel = { ...s.channel, lastOkAt: after, failedInARow: 0, error: null, nextTryAt: 0 };
            s.sentAt.push(after);
        } else {
            s.channel.failedInARow++;
            s.channel.error = result.error;
            s.channel.nextTryAt = after + ALERT_RETRY_MS;
            logger.warn('SYS', `[Alerts] The alert channel did not take ${events.length} event(s): ${result.error}. Next try in 5 minutes.`);
        }
        writeState();
    })().finally(() => {
        sending = null;
    });
    return sending;
}

/** The owners' "Send a test": straight to the channel, outside the book, under the hard ceiling. */
export async function sendTestAlert(): Promise<{ ok: true; status: number } | { ok: false; error: string }> {
    const c = readAlertChannel();
    if (!c) return { ok: false, error: envChannelProblem() ?? 'No alert channel is set' };
    const s = readState();
    if (sentThisHour(s, now()) >= ALERT_HOURLY_CEILING) return { ok: false, error: `${ALERT_HOURLY_CEILING} messages went in the last hour: try again later` };
    const community = communityName();
    const t = now();
    const result = await sendToChannel(c, {
        subject: `Test from ${community}`, priority: 3, click: settingsLink(), events: [],
        text: `Test from ${community}, its BeanPool server: alerts reach this channel. Sent ${when(t)}.`,
    });
    if (result.ok) s.sentAt.push(now());
    s.channel.lastTriedAt = now();
    if (result.ok) s.channel = { ...s.channel, lastOkAt: now(), failedInARow: 0, error: null };
    else s.channel.error = result.error;
    writeState();
    return result;
}

// ── The book ───────────────────────────────────────────────────────────────────────────────

function owners(): string[] {
    return (db.prepare(
        `SELECT nr.member_pubkey AS pk FROM node_roles nr JOIN members m ON nr.member_pubkey = m.public_key
         WHERE nr.role = 'owner' AND ${NODE_ROLE_ACTS}`,
    ).all() as { pk: string }[]).map((r) => r.pk);
}

const DISK_LEVEL: Partial<Record<AlertKey, number>> = { 'disk.80': 80, 'disk.90': 90, 'disk.95': 95 };

/**
 * One push to the owners for everything this tick told that may push: each condition at most once per its interval, and
 * the disk as one condition (a level under a higher one that is active is counted as told, never named).
 */
function pushOwners(s: BookState, events: readonly AlertEvent[], t: number): void {
    if (getNodeRole() !== 'primary') return;
    const due = events.filter((e) => {
        const every = ROWS[e.key].pushEveryMs;
        const last = s.pushedAt[e.key];
        return every > 0 && e.kind !== 'cleared' && (last === undefined || t - last >= every);
    });
    if (!due.length) return;
    for (const e of due) s.pushedAt[e.key] = t;
    const topDisk = Math.max(0, ...(Object.keys(s.raised) as AlertKey[]).map((k) => DISK_LEVEL[k] ?? 0));
    const shown = due.filter((e) => (DISK_LEVEL[e.key] ?? topDisk) >= topDisk).sort((a, b) => b.priority - a.priority);
    if (!shown.length) return;
    const first = shown[0];
    try {
        const to = owners();
        if (to.length) {
            dispatchPushNotification(to, 'SYSTEM', `${communityName()}: ${ROWS[first.key].title}${shown.length > 1 ? ` (+${shown.length - 1} more)` : ''}`,
                first.detail, { kind: 'server_alert', alert: first.key, section: 'home' }, 'marketplace', 'owner.alert');
        }
    } catch (err) {
        logger.warn('SYS', `[Alerts] The owners' push failed: ${errorMessage(err)}`);
    }
}

/**
 * Applies the conditions: raises what started, reminds of what lasted a day, clears what ended, and sends what waits.
 * Conditions not in `conditions` are left as they are.
 */
export async function updateAlerts(conditions: readonly Condition[]): Promise<AlertEvent[]> {
    const s = readState();
    const t = now();
    const told: AlertEvent[] = [];
    const tell = (e: AlertEvent) => {
        told.push(e);
        s.history.push(e);
        if (s.history.length > MAX_HISTORY) s.history.splice(0, s.history.length - MAX_HISTORY);
        if (ROWS[e.key].webhook) {
            s.waiting.push(e);
            if (s.waiting.length > MAX_WAITING) {
                s.waiting.shift();
                s.dropped++;
            }
        }
    };
    for (const c of conditions) {
        const r = s.raised[c.key];
        const priority = c.priority ?? ROWS[c.key].priority;
        if (c.active && c.oneShot) {
            tell({ key: c.key, kind: 'raised', at: t, since: c.since ?? t, priority, detail: c.detail });
        } else if (c.active && !r) {
            const since = c.since ?? t;
            s.raised[c.key] = { since, detail: c.detail, toldAt: t, priority };
            const cleared = s.clearedAt[c.key];
            tell({ key: c.key, kind: cleared !== undefined && t - cleared < ALERT_FLAP_MS ? 'still' : 'raised', at: t, since, priority, detail: c.detail });
        } else if (c.active && r) {
            // Back before its end was told: nothing to tell, it just goes on.
            delete r.endedAt;
            r.detail = c.detail;
            if (priority > r.priority) {
                // Worse than when it was told (an unclean stop whose check then failed): told again now.
                r.priority = priority;
                r.toldAt = t;
                tell({ key: c.key, kind: 'raised', at: t, since: r.since, priority, detail: c.detail });
            } else if (t - r.toldAt >= ALERT_REMIND_MS) {
                r.toldAt = t;
                tell({ key: c.key, kind: 'still', at: t, since: r.since, priority: r.priority, detail: c.detail });
            }
        } else if (!c.active && r) {
            if (r.endedAt === undefined) {
                r.endedAt = t;
            } else if (t - r.endedAt >= ALERT_CLEAR_HOLD_MS) {
                delete s.raised[c.key];
                s.clearedAt[c.key] = t;
                tell({ key: c.key, kind: 'cleared', at: t, since: r.since, priority: r.priority, detail: c.detail });
            }
        }
    }
    pushOwners(s, told, t);
    writeState();
    await flushAlerts();
    return told;
}

// ── The conditions ─────────────────────────────────────────────────────────────────────────

function bootsFile(): string {
    return path.join(dataDir(), BOOTS_FILE);
}

function readBoots(): number[] {
    try {
        const b = JSON.parse(fs.readFileSync(bootsFile(), 'utf8'));
        return Array.isArray(b) ? b.filter((x) => Number.isFinite(x)) : [];
    } catch {
        return [];
    }
}

/**
 * This start, kept with the last 19 when it followed an unclean stop (a crash, a kill, power: index.ts calls it once, at
 * the start, with engine/shutdown-recovery.ts's answer). A clean restart (docker compose up -d) is no crash.
 */
export function recordBoot(unclean: boolean, at = now()): void {
    if (!unclean) return;
    const boots = [...readBoots(), at].slice(-MAX_BOOTS);
    try { writeFileAtomic(bootsFile(), JSON.stringify(boots)); } catch (e) { logger.warn('SYS', `[Alerts] Could not note this start: ${errorMessage(e)}`); }
}

const startedAt = Date.now();

function diskConditions(s: BookState): Condition[] {
    let used: number;
    try { used = getDiskHealth().usedPercent; } catch { return []; }
    const out: Condition[] = [];
    for (const level of [80, 90, 95] as const) {
        const key = `disk.${level}` as AlertKey;
        const k = String(level) as '80' | '90' | '95';
        s.diskTicks[k] = used >= level ? s.diskTicks[k] + 1 : 0;
        const active = !!s.raised[key];
        const detail = `The disk is ${used}% full. Open Settings → Diagnostics to see what uses it.`;
        if (!active && s.diskTicks[k] >= DISK_TICKS) out.push({ key, active: true, detail });
        else if (active && used < level - DISK_HYSTERESIS) out.push({ key, active: false, detail: `The disk is ${used}% full.` });
        else if (active) out.push({ key, active: true, detail });
    }
    return out;
}

function backupConditions(): Condition[] {
    let status: ReturnType<typeof getOffboxStatus>;
    try { status = getOffboxStatus(now()); } catch { return []; }
    if (status.state === 'standby' || status.state === 'replaced') {
        return [{ key: 'backups.offbox', active: false, detail: 'This server no longer sends backups off the box.' }, { key: 'backups.none', active: false, detail: '' }];
    }
    const failing = status.destinations.filter((d) => d.health === 'failing' && d.failures >= 2).length;
    const stale = status.destinations.filter((d) => d.health === 'stale').length;
    const usable = status.destinations.filter((d) => d.health !== 'broken').length;
    const bad = status.state === 'sending' ? failing + stale : 0;
    // The owner set destinations and none is sent to: as bad as failing, and told the same way.
    const offbox: Condition = status.state === 'not-locked'
        ? {
            key: 'backups.offbox', active: true,
            detail: 'Off-box destinations are set, but nothing goes to them: this server has no recovery code, and only a locked '
                + 'backup may leave it. Make a recovery code (Settings → Who can unlock this community).',
        }
        : status.destinations.length > 0 && usable === 0
        ? {
            key: 'backups.offbox', active: true,
            detail: `${status.destinations.length === 1 ? 'The off-box destination' : `All ${status.destinations.length} off-box destinations`} `
                + `can't be used (a setting is missing or wrong), so no backup leaves this server. Open Settings → Backups.`,
        }
        : bad > 0
        ? {
            key: 'backups.offbox', active: true,
            detail: `${bad} of ${usable} off-box destination${usable === 1 ? '' : 's'} ${bad === 1 ? 'is' : 'are'} `
                + `${failing && stale ? 'failing or behind' : failing ? 'failing' : 'behind'}. Open Settings → Backups.`,
        }
        : { key: 'backups.offbox', active: false, detail: 'Off-box backups are arriving again.' };
    let locked = true;
    try { locked = backupLockState().locked; } catch { /* unknown: no nudge */ }
    const none: Condition = status.destinations.length === 0 && !locked
        ? { key: 'backups.none', active: true, detail: 'No backup leaves this server, and backups are not locked to a recovery code. Open Settings → Backups.' }
        : { key: 'backups.none', active: false, detail: 'Backups are set up.' };
    return [offbox, none];
}

function snapshotCondition(): Condition {
    const n = snapshotFailuresInARow();
    return n >= 2
        ? { key: 'snapshots.failed', active: true, detail: `The last ${n} scheduled snapshots failed. Open Settings → Backups.` }
        : { key: 'snapshots.failed', active: false, detail: 'Scheduled snapshots work again.' };
}

function bootConditions(t: number): Condition[] {
    const boots = readBoots().filter((b) => b <= t);
    const recent = boots.filter((b) => t - b < CRASH_LOOP_WINDOW_MS);
    const lastBoot = boots.length ? boots[boots.length - 1] : startedAt;
    const loop: Condition = recent.length >= CRASH_LOOP_STARTS
        ? { key: 'boot.crashloop', active: true, since: recent[0], detail: `This server stopped without shutting down and started again ${recent.length} times in 15 minutes. Its logs say why.` }
        : { key: 'boot.crashloop', active: !!readState().raised['boot.crashloop'] && t - lastBoot < CRASH_LOOP_CLEAR_MS, detail: 'Up for an hour without a restart.' };
    const sd = getShutdownStatus();
    const unclean: Condition = sd?.uncleanShutdown && !sd.acknowledged
        ? {
            key: 'boot.unclean', active: true,
            priority: sd.ok === false ? 5 : 3,
            detail: sd.ok === false
                ? 'It stopped without shutting down, and the database check after it FAILED. Open Settings → Home now.'
                : 'It stopped without shutting down (power, a kill or a crash); the database check after it passed.',
        }
        : { key: 'boot.unclean', active: false, detail: 'The unclean stop was acknowledged.' };
    return [loop, unclean];
}

function watchdogConditions(s: BookState, t: number): Condition[] {
    let w: ReturnType<typeof readWatchdogStatus>;
    try { w = readWatchdogStatus(); } catch { return []; }
    const out: Condition[] = [];
    const before = s.watchdogRecoveries;
    s.watchdogRecoveries = w.recoveries;
    if (before !== null && w.recoveries > before) {
        out.push({
            key: 'freeze.recovered', active: true, oneShot: true,
            detail: `The host watchdog restarted this server after it froze (${w.recoveries} time${w.recoveries === 1 ? '' : 's'} in all). `
                + 'Its report is in the data folder (report.*.json).',
        });
    }
    const seen = w.lastSeenAt ? Date.parse(w.lastSeenAt) : NaN;
    const quiet = w.present && Number.isFinite(seen) && t - seen > WATCHDOG_QUIET_MS;
    out.push(quiet
        ? { key: 'freeze.nowatchdog', active: true, detail: 'The host watchdog has been quiet for over 10 minutes: a freeze would not be restarted.' }
        : { key: 'freeze.nowatchdog', active: false, detail: 'The host watchdog is back.' });
    return out;
}

function standbyCondition(): Condition {
    return standbyIncidentOpen()
        ? { key: 'standby.incident', active: true, detail: 'The standby server needs attention. Open Settings → Home.' }
        : { key: 'standby.incident', active: false, detail: 'The standby is healthy again.' };
}

function tlsCondition(): Condition {
    return tlsFellBackToSelfSigned()
        ? { key: 'tls.fallback', active: true, detail: "The Let's Encrypt certificate could not be renewed: browsers now see a self-signed one. It is retried every 2 hours." }
        : { key: 'tls.fallback', active: false, detail: "Let's Encrypt certificate in use again." };
}

/** One tick: every row looked at, the book updated, what waits sent. */
export async function checkServerAlerts(): Promise<AlertEvent[]> {
    try {
        const s = readState();
        const t = now();
        const conditions: Condition[] = [
            ...diskConditions(s),
            ...backupConditions(),
            snapshotCondition(),
            ...bootConditions(t),
            ...watchdogConditions(s, t),
            standbyCondition(),
            tlsCondition(),
        ];
        return await updateAlerts(conditions);
    } catch (e) {
        logger.warn('SYS', `[Alerts] Check failed: ${errorMessage(e)}`);
        return [];
    }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Every minute on every server, from the start: a crash loop's third start is told before it can crash again. */
export function startServerAlerts(): void {
    if (timer) return;
    void checkServerAlerts();
    timer = setInterval(() => { void checkServerAlerts(); }, ALERT_TICK_MS);
    timer.unref?.();
}

export function stopServerAlerts(): void {
    if (timer) clearInterval(timer);
    timer = null;
}

// ── What Settings and the admin queue read ─────────────────────────────────────────────────

/** How many conditions the `server_alert` banner counts (the standby and an unclean stop have banners of their own). */
export function serverAlertCount(): number {
    try {
        const s = readState();
        return (Object.keys(s.raised) as AlertKey[]).filter((k) => ROWS[k]?.banner && s.raised[k]?.endedAt === undefined).length;
    } catch {
        return 0;
    }
}

export interface AlertsStatus {
    channel: ReturnType<typeof describeChannel> | null;
    channelProblem: string | null;
    lastOkAt: number | null;
    lastTriedAt: number | null;
    failedInARow: number;
    error: string | null;
    nextTryAt: number | null;
    waiting: number;
    dropped: number;
    sentLastHour: number;
    hourlyCap: number;
    active: Array<{ key: AlertKey; title: string; priority: AlertPriority; since: number; detail: string }>;
    history: Array<AlertEvent & { title: string }>;
}

export function getAlertsStatus(): AlertsStatus {
    const s = readState();
    const c = readAlertChannel();
    const t = now();
    return {
        channel: c ? describeChannel(c) : null,
        channelProblem: envChannelProblem(),
        lastOkAt: s.channel.lastOkAt, lastTriedAt: s.channel.lastTriedAt, failedInARow: s.channel.failedInARow, error: s.channel.error,
        nextTryAt: s.waiting.length && s.channel.nextTryAt > t ? s.channel.nextTryAt : null,
        waiting: c ? s.waiting.length : 0, dropped: s.dropped,
        sentLastHour: sentThisHour(s, t), hourlyCap: ALERT_HOURLY_CAP,
        active: (Object.entries(s.raised) as Array<[AlertKey, Raised]>).filter(([, r]) => r.endedAt === undefined).map(([key, r]) => ({ key, title: ROWS[key].title, priority: r.priority, since: r.since, detail: r.detail })),
        history: s.history.slice().reverse().map((e) => ({ ...e, title: ROWS[e.key].title })),
    };
}
