/**
 * The floor under push: notices from the app's own background sync (scratch/global-node/DESIGN-push-relay-fable.md
 * §4.5). No push service, no token, nothing of BeanPool's or Expo's: when the background sync runs
 * (services/background-task.ts; the phone's system decides when, 15 minutes at best), the app asks the community it is
 * set to for the notices its member has not seen (`GET /api/notices?unseen=1`, signed: routes/notices.ts on the
 * server) and posts a notice on this phone for each one it has not shown before. It is what a member still gets when
 * Expo, or BeanPool's Expo account, is unavailable, and on any node anywhere.
 *
 * - **The real words.** The text comes from the member's own node over the signed channel and never leaves the phone,
 *   so it says what the node kept (what happened to a post, and why), not a push's fixed sentence.
 * - **Once each, matched by the notice's id.** Each id is written down before its notice is posted, so none is posted
 *   twice; one the app showed live while open (the socket's alert carries the same id, app/_layout.tsx) is written
 *   down too ({@link markNoticeShown}), and the sync never posts it again.
 * - **Recent ones only.** A row older than {@link SYNC_NOTICE_MAX_AGE_MS} is left alone: a phone that first syncs after
 *   a while away isn't buried under weeks of old news. The node keeps them, and the web app shows them.
 * - **Not marked seen.** Posting a notice is not the member reading it, so the node's rows stay unseen for the web app.
 *
 * Which notices these are is the server's: today the moderation notices it keeps for each member
 * (engine/kept-notices.ts). A push's own details (engine/push-notices.ts) have no list a phone can read, so a push
 * missed while the phone was off is not repeated here.
 */
import { buildSignedHeaders } from './crypto';
import type { BeanPoolIdentity } from './identity';
import { LOCAL_NOTICE_DATA } from './push-notice-check';
import { communityAddress } from './push-pins';

const ANCHOR_STORE_KEY = 'beanpool_anchor_url';
const UNSEEN_NOTICES_PATH = '/api/notices?unseen=1';

/** The notice ids this phone has shown or posted: id → when it was written down (ms). */
export const SYNC_NOTICES_LEDGER_STORE_KEY = 'beanpool_sync_notices_posted';
/** How old a node's row may be and still be posted. */
export const SYNC_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long an id stays written down: longer than a row can be posted for, whatever the two clocks say. */
const LEDGER_KEEP_MS = 2 * SYNC_NOTICE_MAX_AGE_MS;
/** The most ids kept; the oldest go first. A member's node keeps 50. */
const LEDGER_MAX = 300;
/** How long the node has to answer, inside the background task's 30 seconds. */
export const SYNC_NOTICES_TIMEOUT_MS = 8000;
/** The longest title and text the node keeps (server engine/kept-notices.ts NOTICE_LIMITS). */
const TITLE_MAX = 80;
const BODY_MAX = 400;
/** How far ahead of the phone's clock a row's time may be: a node's clock that runs a little fast. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

interface Storage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

type Account = Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>;

/** A notice the app posts on the phone. */
export interface LocalNotice {
    title: string;
    body: string;
    data: Record<string, unknown>;
}

interface Row { id: string; title: string; body: string; createdAt: number }

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function parseRows(body: unknown): Row[] | null {
    const notices = body && typeof body === 'object' ? (body as { notices?: unknown }).notices : undefined;
    if (!Array.isArray(notices)) return null;
    const rows: Row[] = [];
    for (const n of notices) {
        if (!n || typeof n !== 'object') continue;
        const { id, title, body: text, createdAt } = n as Record<string, unknown>;
        const at = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
        if (typeof id !== 'string' || id.length === 0 || id.length > 64 || typeof title !== 'string' || !title.trim()
            || typeof text !== 'string' || !text.trim() || !Number.isFinite(at)) continue;
        rows.push({ id, title: clip(title.trim(), TITLE_MAX), body: clip(text.trim(), BODY_MAX), createdAt: at });
    }
    return rows;
}

/** The unseen notices `community` keeps for `account`, or null when it didn't answer with them. Never throws. */
async function unseenNotices(community: string, account: Account, timeoutMs: number): Promise<Row[] | null> {
    const url = `${community}${UNSEEN_NOTICES_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = await buildSignedHeaders('GET', url, '', account.privateKey, account.publicKey);
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (!res.ok) return null;
        return parseRows(await res.json().catch(() => null));
    } catch (e) {
        console.log(`[Notices] ${community} did not answer for unseen notices: ${e instanceof Error ? e.message : e}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** The ledger as written: `[[id, ms], …]`. Anything else is an empty one. */
function parseLedger(raw: string | null): Map<string, number> {
    try {
        const parsed = JSON.parse(raw ?? '[]');
        if (!Array.isArray(parsed)) return new Map();
        return new Map(parsed.filter((e): e is [string, number] =>
            Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number' && Number.isFinite(e[1])));
    } catch {
        return new Map();
    }
}

let ledgerWrites: Promise<unknown> = Promise.resolve();

/**
 * Write `ids` down, after any write under way, and return those that weren't already: each of these is now the
 * caller's to show, and no one else's. Throws when the ledger can't be read or written, and then none is the caller's.
 */
function claim(ids: readonly string[], storage: Storage, now: number): Promise<string[]> {
    const next = ledgerWrites.then(async () => {
        const ledger = parseLedger(await storage.getItem(SYNC_NOTICES_LEDGER_STORE_KEY));
        const fresh = [...new Set(ids)].filter((id) => !ledger.has(id));
        if (fresh.length === 0) return [];
        for (const id of fresh) ledger.set(id, now);
        const kept = [...ledger].filter(([, at]) => now - at <= LEDGER_KEEP_MS).sort((a, b) => b[1] - a[1]).slice(0, LEDGER_MAX);
        await storage.setItem(SYNC_NOTICES_LEDGER_STORE_KEY, JSON.stringify(kept));
        return fresh;
    });
    ledgerWrites = next.catch(() => {});
    return next;
}

/**
 * A notice the app showed live while open (the socket's alert names its id): written down, so the sync never posts it
 * as well. Never throws.
 */
export async function markNoticeShown(id: unknown, storage: Storage, now = Date.now()): Promise<void> {
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) return;
    try {
        await claim([id], storage, now);
    } catch (e) {
        console.warn('[Notices] Could not write down a notice shown live', e);
    }
}

/**
 * The background sync's notices: the community the phone is set to asked for its member's unseen notices, and a notice
 * posted (`post`) for each recent one this phone hasn't shown, oldest first. Returns how many were posted. Nothing
 * without a community or an account on the phone. Never throws.
 */
export async function postNoticesFromSync(deps: {
    storage: Storage;
    account: Account | null;
    post: (notice: LocalNotice) => Promise<unknown>;
    now?: number;
    timeoutMs?: number;
}): Promise<number> {
    const now = deps.now ?? Date.now();
    try {
        const community = communityAddress(await deps.storage.getItem(ANCHOR_STORE_KEY));
        if (!community || !deps.account?.publicKey || !deps.account.privateKey) return 0;
        const rows = await unseenNotices(community, deps.account, deps.timeoutMs ?? SYNC_NOTICES_TIMEOUT_MS);
        if (!rows) return 0;
        const recent = rows
            .filter((r) => now - r.createdAt <= SYNC_NOTICE_MAX_AGE_MS && r.createdAt - now <= CLOCK_SKEW_MS)
            .sort((a, b) => a.createdAt - b.createdAt);
        if (recent.length === 0) return 0;
        const mine = new Set(await claim(recent.map((r) => r.id), deps.storage, now));
        let posted = 0;
        for (const r of recent.filter((row) => mine.has(row.id))) {
            try {
                await deps.post({ title: r.title, body: r.body, data: { ...LOCAL_NOTICE_DATA } });
                posted++;
            } catch (e) {
                console.warn('[Notices] Could not post a notice from the sync', e);
            }
        }
        return posted;
    } catch (e) {
        console.warn('[Notices] The sync\'s notices could not be posted', e);
        return 0;
    }
}
