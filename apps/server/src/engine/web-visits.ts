/**
 * Web app visits: how many times a day the web app was opened on this server, and by about how many people. Counted here,
 * where the page is served, because a browser beacon (Cloudflare's) stays blocked: no cookie, no script, nothing the
 * visitor's browser keeps or sends for it.
 *
 * What is stored is `web_visit_days` (schema.sql 20b): one row per UTC day, `(day, visits, uniques)`, and nothing else:
 * no address, no browser, no hash, no member. Rows older than 400 days are deleted with no tombstone. The table stays on
 * this server (engine/replication-manifest.ts: local): a standby counts the page loads it serves itself.
 *
 * A visit is one GET of the web app's page where it is served (countWebAppPageLoad: routes/settings.ts for `/app`,
 * https-server.ts's SPA fallback for `/app/…`; `/` redirects to `/app`, so a browser that opens `/` is one visit, not two)
 * that a person's browser asked for to show (isWebAppPageLoad). Its files (scripts, styles, pictures), API calls, the Settings and
 * manager pages, a sign-in's return to the app, HEAD requests, prefetches, and requests from crawlers, link previews,
 * uptime checks and scripts are not.
 *
 * `uniques` is how many different visitors that day, told apart without identifying anyone: each visit's address (by
 * client-ip.ts `limiterKeyForIp`, so an IPv6 subscriber is its /64) and browser (User-Agent) are hashed with HMAC-SHA-256
 * under 32 random bytes made for the current UTC day, and the first 16 characters kept in a set in this process's memory.
 * The key and the set are never in the database, a file or a log, and both are dropped when the day ends (a timer at UTC
 * midnight, and the day's first visit after it if the timer ran late). Only the count reaches the database. Without the
 * key, a tag cannot be matched to an address by trying every IPv4 address; after the day nobody has the key. Same shape as
 * log-address.ts, with its own domain and its own key.
 *
 * So `uniques` is an estimate, and the manual says so: people behind one address with the same browser count once, and a
 * restart starts a new key and set, so someone who comes back after it counts again. The set holds at most
 * MAX_VISITORS_PER_DAY tags: past that (a flood of made-up addresses, not a community), `uniques` stops rising and
 * `visits` goes on.
 */

import crypto from 'node:crypto';
import type Koa from 'koa';
import { db } from '../db/db.js';
import { clientLimiterKey } from '../client-ip.js';

/** How many days of rows are kept: today and the 399 before it. */
export const VISIT_RETENTION_DAYS = 400;
/** The most visitors one day's set holds: about 3 MB of memory at most. */
export const MAX_VISITORS_PER_DAY = 50_000;

const DOMAIN = 'beanpool-web-visit/v1';
const DAY_MS = 24 * 60 * 60 * 1000;
/** 16 base64url characters: 96 bits, so two visitors in one day never share a tag. */
const TAG_CHARS = 16;
/** A browser's User-Agent is a few hundred characters; anything past this is not one. */
const MAX_AGENT_CHARS = 512;

export interface VisitDay {
    /** YYYY-MM-DD, UTC. */
    day: string;
    visits: number;
    uniques: number;
}

export function utcDay(now = Date.now()): string {
    return new Date(now).toISOString().slice(0, 10);
}

/** The current day's key and the tags of the visitors it has seen. Only one day's at a time. */
let current: { day: string; key: Buffer; seen: Set<string>; dropsAt: number; timer: NodeJS.Timeout } | null = null;

/** Drops the day's key and tags. The timer at UTC midnight calls it; so does a new day's first visit. */
function forgetDay(): void {
    if (current) clearTimeout(current.timer);
    current = null;
}

function dayFor(now: number): NonNullable<typeof current> {
    const day = utcDay(now);
    if (!current || current.day !== day) {
        forgetDay();
        const nextMidnight = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
        // unref: a timer waiting for midnight must not keep the process (or a test) alive.
        const timer = setTimeout(forgetDay, nextMidnight - now);
        timer.unref();
        current = { day, key: crypto.randomBytes(32), seen: new Set(), dropsAt: nextMidnight, timer };
        // The first visit of a day prunes, as the server's start does (state-engine.ts): the table never outgrows its
        // retention by more than the days a server went without a visit.
        pruneWebVisits(now);
    }
    return current;
}

function tagOf(key: Buffer, addressKey: string, userAgent: string): string {
    return crypto.createHmac('sha256', key)
        .update(`${DOMAIN}|${addressKey}|${userAgent.slice(0, MAX_AGENT_CHARS)}`, 'utf-8')
        .digest('base64url')
        .slice(0, TAG_CHARS);
}

/**
 * Counts one visit to the web app from the address `addressKey` (client-ip.ts `clientLimiterKey`) with the browser
 * `userAgent`. Never throws: a count that broke the page would be worse than no count.
 */
export function recordWebVisit(addressKey: string, userAgent: string, now = Date.now()): void {
    try {
        const today = dayFor(now);
        let newVisitor = 0;
        if (today.seen.size < MAX_VISITORS_PER_DAY) {
            const tag = tagOf(today.key, addressKey, userAgent);
            if (!today.seen.has(tag)) {
                today.seen.add(tag);
                newVisitor = 1;
            }
        }
        db.prepare(`
            INSERT INTO web_visit_days (day, visits, uniques) VALUES (?, 1, ?)
            ON CONFLICT(day) DO UPDATE SET visits = visits + 1, uniques = uniques + excluded.uniques
        `).run(today.day, newVisitor);
    } catch (e) {
        // The error is SQLite's or the clock's: it names no address or browser.
        console.error('web visits: failed to count a visit', e instanceof Error ? e.message : e);
    }
}

/** Deletes the rows older than VISIT_RETENTION_DAYS days, with no tombstone: the table is this server's own. */
export function pruneWebVisits(now = Date.now()): number {
    const oldestKept = utcDay(now - (VISIT_RETENTION_DAYS - 1) * DAY_MS);
    return db.prepare('DELETE FROM web_visit_days WHERE day < ?').run(oldestKept).changes;
}

/** A `days` query value as a window: a whole number from 1 to VISIT_RETENTION_DAYS, 30 when it is not a number. */
export function clampVisitDays(value: unknown): number {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return 30;
    return Math.min(VISIT_RETENTION_DAYS, Math.max(1, n));
}

/**
 * The last `days` days, oldest first and ending today (UTC), a day with no row as zeros: always `days` entries, so the
 * last one is today. Reading deletes nothing.
 */
export function getWebVisits(days: number, now = Date.now()): VisitDay[] {
    const window = clampVisitDays(days);
    const first = utcDay(now - (window - 1) * DAY_MS);
    const rows = db.prepare('SELECT day, visits, uniques FROM web_visit_days WHERE day >= ? AND day <= ?')
        .all(first, utcDay(now)) as VisitDay[];
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const out: VisitDay[] = [];
    for (let i = window - 1; i >= 0; i--) {
        const day = utcDay(now - i * DAY_MS);
        const row = byDay.get(day);
        out.push({ day, visits: row?.visits ?? 0, uniques: row?.uniques ?? 0 });
    }
    return out;
}

/**
 * User-Agents that are not a person opening the app: crawlers, link previews, uptime checks, headless browsers and
 * scripts. A word ending in `bot` counts only with a `/` or `-` after it (Googlebot/2.1, Slackbot-LinkExpanding), so a
 * phone's model (CUBOT J3, CUBOT_X19, CUBOT)) is still a person; the previews that write `…Bot (` or `…bot 1.0` are named.
 */
const NOT_A_PERSON = new RegExp([
    '\\bbot\\b', '[a-z]bot[/-]', 'telegrambot', 'twitterbot', 'slackbot', 'discordbot', 'crawl', 'spider', 'slurp', '\\+https?:',
    'facebookexternalhit', 'facebookcatalog', 'meta-externalagent', 'whatsapp/', 'skypeuripreview', 'embedly', 'preview',
    'uptime', 'monitor', 'pingdom', 'statuscake', 'site24x7', 'cloudflare',
    'headless', 'lighthouse', 'pagespeed', 'phantomjs', 'selenium', 'puppeteer', 'playwright',
    'curl/', 'wget/', 'python', 'go-http', 'java/', 'okhttp', 'axios', 'node-fetch', 'undici', 'libwww', 'httpie',
    'postman', 'insomnia', 'scrapy',
].join('|'), 'i');

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string {
    const v = headers[name];
    return (Array.isArray(v) ? v[0] : v) ?? '';
}

/**
 * Whether a GET for the web app's page at `path` is a person's browser opening it: a document it will show
 * (Sec-Fetch-Dest `document`; a browser too old to send that asks for text/html), not a prefetch or prerender, from a
 * User-Agent that is not a crawler, a preview, a check or a script. A sign-in's return to the app (`/app/auth/…`) is the
 * same visit going on, not a new one.
 */
export function isWebAppPageLoad(path: string, headers: Headers): boolean {
    if (path.startsWith('/app/auth/')) return false;
    const purpose = `${header(headers, 'sec-purpose')} ${header(headers, 'purpose')} ${header(headers, 'x-moz')}`.toLowerCase();
    if (purpose.includes('prefetch') || purpose.includes('prerender')) return false;
    const dest = header(headers, 'sec-fetch-dest').toLowerCase();
    if (dest ? dest !== 'document' : !header(headers, 'accept').toLowerCase().includes('text/html')) return false;
    const agent = header(headers, 'user-agent');
    return agent.trim() !== '' && !NOT_A_PERSON.test(agent);
}

/**
 * Counts the request as a visit when it is a person's browser opening the web app. Called only where the app's page is
 * served, just before it is: a GET (koa-router answers a HEAD with the GET's handler, and a HEAD shows nothing).
 */
export function countWebAppPageLoad(ctx: Koa.Context): void {
    if (ctx.method !== 'GET' || !isWebAppPageLoad(ctx.path, ctx.headers)) return;
    recordWebVisit(clientLimiterKey(ctx), ctx.get('user-agent'));
}

/** Tests only: what the day's memory holds (its day, how many tags, when it is dropped), or null when nothing. */
export function webVisitMemoryForTests(): { day: string; visitors: number; dropsAt: number } | null {
    return current ? { day: current.day, visitors: current.seen.size, dropsAt: current.dropsAt } : null;
}

/** Tests only: the tag a visit would leave in memory today, to look for it in the database and the logs. */
export function webVisitTagForTests(addressKey: string, userAgent: string): string | null {
    return current ? tagOf(current.key, addressKey, userAgent) : null;
}

/** Tests only: drop the day's memory now, as midnight does. */
export function forgetWebVisitDayForTests(): void {
    forgetDay();
}
