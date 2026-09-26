/**
 * The communities directory, mirrored (global node G5, design §3.2 and §3.5).
 *
 * The public directory registry (Supabase `directory_nodes`: every node's publisher writes to it, services/
 * directory-publisher.ts, and the website reads it) is fetched here, server-side, once at start and then hourly, into
 * `directory_cache` (engine/directory-cache.ts). GET /api/global/communities and the landing card read that table and
 * nothing else, so phones never talk to the registry and its key stays on this server.
 *
 * ## Where the registry and its key come from
 *
 * `DIRECTORY_MIRROR_URL` and `DIRECTORY_MIRROR_KEY` (env), read at every run, defaulting to the website's own public
 * values (apps/website/main.js): the same project, and the same publishable key every visitor's browser already
 * holds. Env, as the publisher's DIRECTORY_REGISTRY_URL is, because it is where this server reads from, not something
 * about the community: a stranger's global node works with nothing set, and a test points it at a fixture. Not
 * node_config, which travels in every backup and take-over: a fixture or a private mirror's address must never be
 * restored onto another server. The key is sent to the registry, in the `apikey` header, and nowhere else: no
 * response of this node carries it, and no app ships it.
 *
 * ## A run (runDirectoryMirror)
 *
 * Only on a main server (a standby copies, it never fetches) with the profile switch `directoryMirror` on (the global
 * profile's default; read at every run, so an operator's override needs no restart):
 *   1. GET the registry, a page of REGISTRY_PAGE_ROWS at a time. Any failure (nothing listening, too slow, a status
 *      other than 2xx, a body that is not a JSON array or is too big) changes nothing: the cache keeps what the last
 *      good fetch saw, and the status says what went wrong.
 *   2. Every row is checked (engine/directory-cache.ts normaliseRegistryRow); a row with no key is left out.
 *   3. One transaction writes the run (new, changed, gone), then the place watches (engine/place-watches.ts) tell each
 *      watcher what they are owed: the communities seen for the first time, and, when a push reaches them now, any an
 *      earlier run's notice could not reach them with (no phone of theirs registered here then). Each watcher hears
 *      about a community once.
 *
 * A phone registering its push token (routes/community.ts) tells its member what they are owed at once
 * (tellOwedWatcher), on the same conditions as a run: a main server with the switch on.
 */
import { getNodeRole, broadcast, dispatchPushNotification, isNodeMember, pushableMembers } from '../state-engine.js';
import { getProfileSwitches } from '../config/node-profile.js';
import {
    normaliseRegistryRow, writeDirectoryRows, writeMirrorStatus, MAX_DIRECTORY_ROWS, type DirectoryRow,
} from '../engine/directory-cache.js';
import { notifyPlaceWatchers, notifyOwedPlaceWatcher, type PlaceWatchNoticeCallbacks } from '../engine/place-watches.js';

/** How the place watches reach a member: their sockets, and their phones where a marketplace push reaches them. */
const watchNotices = (): PlaceWatchNoticeCallbacks => ({
    broadcast, dispatchPushNotification, isMember: isNodeMember, pushable: (pubkey) => pushableMembers('marketplace', pubkey),
});

export const DEFAULT_DIRECTORY_MIRROR_URL = 'https://dpemwoermzkaxoctafzg.supabase.co/rest/v1/directory_nodes?select=*';
/** The website's publishable key (apps/website/main.js): public by design, read-only under the registry's row rules. */
export const DEFAULT_DIRECTORY_MIRROR_KEY = 'sb_publishable_fmlYuaf6NCkTI2IwWnvZmw_bOzo-PrF';
export const DIRECTORY_MIRROR_INTERVAL_MS = 60 * 60 * 1000;
/** The first run, once the server is up. */
const FIRST_RUN_DELAY_MS = 10_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** The registry's (PostgREST's) default most rows in one answer: a full page means ask for the next. */
export const REGISTRY_PAGE_ROWS = 1000;

export type MirrorResult =
    | { ran: false; reason: 'not_primary' | 'switched_off' | 'in_progress' }
    | { ran: true; ok: false; error: string }
    | { ran: true; ok: true; rows: number; skipped: number; added: number; updated: number; removed: number; notified: number };

function mirrorUrl(): string {
    return (process.env.DIRECTORY_MIRROR_URL || '').trim() || DEFAULT_DIRECTORY_MIRROR_URL;
}

function mirrorKey(): string {
    return (process.env.DIRECTORY_MIRROR_KEY || '').trim() || DEFAULT_DIRECTORY_MIRROR_KEY;
}

/** The page at `offset`, as PostgREST pages: `limit` and `offset` on the query. */
function pageUrl(base: string, limit: number, offset: number): string {
    const u = new URL(base);
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('offset', String(offset));
    return u.toString();
}

/** Reads a response body up to `max` bytes, or throws. */
async function readCapped(res: Response, max: number): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) throw new Error(`the answer is too big (${declared} bytes)`);
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
            await reader.cancel().catch(() => { /* already failing */ });
            throw new Error(`the answer is too big (over ${max} bytes)`);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

async function fetchPage(url: string, key: string): Promise<unknown[]> {
    const headers: Record<string, string> = { apikey: key, Accept: 'application/json' };
    // A legacy anon key is a JWT and goes in Authorization too; a publishable key is not one and must not.
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) {
        await res.body?.cancel().catch(() => { /* the status says it */ });
        throw new Error(`HTTP ${res.status}`);
    }
    const text = await readCapped(res, MAX_RESPONSE_BYTES);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error('the answer is not JSON'); }
    if (!Array.isArray(parsed)) throw new Error('the answer is not a list of communities');
    return parsed;
}

/** Every registry row, paged; a repeated key keeps its last row. Throws on any failure. */
async function fetchRegistry(pageRows: number): Promise<{ rows: DirectoryRow[]; skipped: number }> {
    const base = mirrorUrl();
    const key = mirrorKey();
    const byKey = new Map<string, DirectoryRow>();
    let skipped = 0;
    let seen = 0;
    for (let offset = 0; seen < MAX_DIRECTORY_ROWS; offset += pageRows) {
        const page = await fetchPage(pageUrl(base, pageRows, offset), key);
        for (const raw of page) {
            if (seen >= MAX_DIRECTORY_ROWS) break;
            seen++;
            const row = normaliseRegistryRow(raw);
            if (row) byKey.set(row.key, row);
            else skipped++;
        }
        // A short page is the last. A page longer than asked for is an endpoint that doesn't page: it gave everything.
        if (page.length !== pageRows) break;
    }
    if (seen >= MAX_DIRECTORY_ROWS) console.warn(`[Directory mirror] ⚠️ The registry holds ${MAX_DIRECTORY_ROWS} rows or more; only the first ${MAX_DIRECTORY_ROWS} are mirrored.`);
    return { rows: [...byKey.values()], skipped };
}

let running: Promise<MirrorResult> | null = null;

/** One run (see the header). Never throws: a failure is `{ ok: false }`, and the cache stands. */
export async function runDirectoryMirror(opts: { pageRows?: number } = {}): Promise<MirrorResult> {
    if (getNodeRole() !== 'primary') return { ran: false, reason: 'not_primary' };
    if (!getProfileSwitches().directoryMirror) return { ran: false, reason: 'switched_off' };
    if (running) return { ran: false, reason: 'in_progress' };
    running = (async (): Promise<MirrorResult> => {
        const attemptAt = new Date().toISOString();
        let fetched: { rows: DirectoryRow[]; skipped: number };
        try {
            fetched = await fetchRegistry(Math.max(1, opts.pageRows ?? REGISTRY_PAGE_ROWS));
        } catch (e: any) {
            const cause = e?.cause?.code ? ` (${e.cause.code})` : '';
            const error = e?.name === 'TimeoutError' ? 'the registry did not answer in time' : `${String(e?.message || e)}${cause}`;
            writeMirrorStatus({ lastAttemptAt: attemptAt, lastError: error });
            console.warn(`[Directory mirror] ❌ Fetch failed, keeping the cache as it was: ${error}`);
            return { ran: true, ok: false, error };
        }
        const now = new Date().toISOString();
        let written: ReturnType<typeof writeDirectoryRows>;
        try {
            // One transaction: a failure here leaves the cache exactly as the last good run wrote it.
            written = writeDirectoryRows(fetched.rows, now);
        } catch (e: any) {
            const error = `could not write the cache: ${String(e?.message || e)}`;
            writeMirrorStatus({ lastAttemptAt: attemptAt, lastError: error });
            console.error(`[Directory mirror] ❌ ${error}`);
            return { ran: true, ok: false, error };
        }
        const changed = written.added.length > 0 || written.updated > 0 || written.removed > 0;
        writeMirrorStatus({ fetchedAt: now, lastAttemptAt: attemptAt, lastError: null });
        let notified = 0;
        try {
            notified = notifyPlaceWatchers(watchNotices(), written.added, now);
        } catch (e: any) {
            // The cache is written; the communities are on the card. Nothing was stamped for a watcher not told: the next
            // run tells them.
            console.error('[Directory mirror] Telling watchers failed:', e?.message || e);
        }
        // Quiet when nothing changed: an unchanged directory is most hours.
        if (changed) {
            const skipped = fetched.skipped ? `, ${fetched.skipped} ${fetched.skipped === 1 ? 'row' : 'rows'} with no id left out` : '';
            console.log(`[Directory mirror] ✅ ${fetched.rows.length} communities: ${written.added.length} new, ${written.updated} changed, `
                + `${written.removed} gone${skipped}; ${notified} ${notified === 1 ? 'watcher' : 'watchers'} told.`);
        }
        return {
            ran: true, ok: true, rows: fetched.rows.length, skipped: fetched.skipped,
            added: written.added.length, updated: written.updated, removed: written.removed, notified,
        };
    })();
    try {
        return await running;
    } finally {
        running = null;
    }
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * A member's phone registered its push token here: they are told now what they are owed (engine/place-watches.ts),
 * rather than at the next run. After a take-over this is how most watchers hear: the new main server has no phone's
 * token until the app starts again. Only where a run would tell them: a main server with the switch on.
 */
export function tellOwedWatcher(pubkey: string): boolean {
    if (getNodeRole() !== 'primary' || !getProfileSwitches().directoryMirror) return false;
    return notifyOwedPlaceWatcher(watchNotices(), pubkey);
}

/**
 * At boot: once shortly after start (FIRST_RUN_DELAY_MS), then hourly. Every node sets the timer and each run reads the
 * role and the switch, so a local node's or a standby's hourly tick does nothing and never contacts the registry, and
 * an operator's override takes effect at the next tick. A take-over restarts the server (services/takeover.ts), so a
 * promoted standby's first run comes 10 s after it boots as the main server, before any phone has registered with it.
 */
export function initDirectoryMirror(): void {
    if (timer) clearInterval(timer);
    const tick = () => {
        runDirectoryMirror().catch((e) => console.error('[Directory mirror] Unhandled error:', e?.message || e));
    };
    timer = setInterval(tick, DIRECTORY_MIRROR_INTERVAL_MS);
    timer.unref?.();
    setTimeout(tick, FIRST_RUN_DELAY_MS).unref?.();
    if (getNodeRole() === 'primary' && getProfileSwitches().directoryMirror) console.log('[Directory mirror] 🧭 Mirroring the communities directory hourly.');
}
