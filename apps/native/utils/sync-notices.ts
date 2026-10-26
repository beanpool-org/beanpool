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
import { PUSH_NOTICE_TITLE, pushNoticeWords, t } from '@beanpool/core';
import { buildSignedHeaders } from './crypto';
import type { BeanPoolIdentity } from './identity';
import { LOCAL_NOTICE_DATA } from './push-notice-check';
import { communityAddress } from './push-pins';
import { KNOCKS_STORE_KEY, PUSH_REGISTERED_AT_STORE_KEY } from './storage-keys';

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
/**
 * How long the node has to answer, inside the background task's 30 seconds (services/background-task.ts: iOS's, after the
 * sync's own 20-second fail-fast). Every read the sync's notices make shares it ({@link postAllNoticesFromSync}).
 */
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

/** What each of the sync's notice checks is handed. `signal`: the shared deadline ({@link postAllNoticesFromSync}). */
export interface SyncNoticeDeps {
    storage: Storage;
    account: Account | null;
    post: (notice: LocalNotice) => Promise<unknown>;
    now?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
}

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

/** Aborted after `timeoutMs`, or as soon as `outer` is (the sync's shared deadline). `done` stops the timer. */
function bounded(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const stop = () => controller.abort();
    const timer = setTimeout(stop, timeoutMs);
    if (outer?.aborted) stop();
    else outer?.addEventListener('abort', stop);
    return { signal: controller.signal, done: () => { clearTimeout(timer); outer?.removeEventListener('abort', stop); } };
}

/**
 * `url` read with a GET signed by `account`: its JSON body, or null for any refusal, no answer in `timeoutMs` (or by
 * `outer`), or an unreadable body. Never throws.
 */
async function signedRead(url: string, account: Account, timeoutMs: number, outer?: AbortSignal): Promise<unknown> {
    const { signal, done } = bounded(timeoutMs, outer);
    try {
        const headers = await buildSignedHeaders('GET', url, '', account.privateKey, account.publicKey);
        const res = await fetch(url, { method: 'GET', headers, signal });
        if (!res.ok) return null;
        return await res.json().catch(() => null);
    } catch (e) {
        console.log(`[Notices] ${url} did not answer: ${e instanceof Error ? e.message : e}`);
        return null;
    } finally {
        done();
    }
}

/** The unseen notices `community` keeps for `account`, or null when it didn't answer with them. Never throws. */
async function unseenNotices(community: string, account: Account, timeoutMs: number, outer?: AbortSignal): Promise<Row[] | null> {
    const body = await signedRead(`${community}${UNSEEN_NOTICES_PATH}`, account, timeoutMs, outer);
    return body === null ? null : parseRows(body);
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
export async function postNoticesFromSync(deps: SyncNoticeDeps): Promise<number> {
    const now = deps.now ?? Date.now();
    try {
        const community = communityAddress(await deps.storage.getItem(ANCHOR_STORE_KEY));
        if (!community || !deps.account?.publicKey || !deps.account.privateKey) return 0;
        const rows = await unseenNotices(community, deps.account, deps.timeoutMs ?? SYNC_NOTICES_TIMEOUT_MS, deps.signal);
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

// ── Requests to join (front doors S1, design §5.2 and §5.5) ────────────────────────────────────────────────────

/**
 * What this phone last saw of its community's open requests to join, for the account on it (`{ community, publicKey,
 * count }`). A notice is posted only when the count rose since; the first look only writes it down.
 */
export const ADMIN_KNOCKS_COUNT_STORE_KEY = 'beanpool_admin_knocks_last_count';
/** The account's role on that community as `GET /api/node-admin/me` last said it, and when (`{ community, publicKey, role, at }`). */
export const KNOCK_ROLE_STORE_KEY = 'beanpool_knock_role_checked';
/** How long that answer stands before it is asked again: a member made an admin is told from the next day at the latest. */
export const KNOCK_ROLE_RECHECK_MS = 24 * 60 * 60 * 1000;

const KNOCK_STATUS_PATH = '/api/join/knock/status';

function parseJson(raw: string | null): Record<string, unknown> | null {
    try {
        const v = JSON.parse(raw ?? 'null');
        return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/**
 * The answers to this phone's requests to join (utils/knock.ts remembers them): each community asked at once, under the
 * one deadline, and a notice posted for each that said yes, once each ("A community answered your request."). The
 * phone's own poll, since no community has the asker's push token (design §5.5). Never throws.
 */
export async function postKnockStatusNoticesFromSync(deps: SyncNoticeDeps): Promise<number> {
    const now = deps.now ?? Date.now();
    const account = deps.account;
    if (!account?.publicKey || !account.privateKey) return 0;
    try {
        const stored = parseJson(await deps.storage.getItem(KNOCKS_STORE_KEY));
        if (!stored || stored.pubkey !== account.publicKey || !Array.isArray(stored.knocks)) return 0;
        // A request this key cancelled is no longer waiting for an answer.
        const waiting = (stored.knocks as Array<{ url?: unknown; cancelledAt?: unknown }>)
            .filter((k): k is { url: string } => !!k && typeof k.url === 'string' && !!communityAddress(k.url) && !k.cancelledAt);
        const said = await Promise.all(waiting.map(async (k) => ({
            url: k.url,
            body: await signedRead(`${k.url}${KNOCK_STATUS_PATH}`, account, deps.timeoutMs ?? SYNC_NOTICES_TIMEOUT_MS, deps.signal),
        })));
        let posted = 0;
        for (const { url, body } of said) {
            const answer = body as { status?: unknown; invite?: unknown } | null;
            if (answer?.status !== 'approved') continue;
            const id = `knock-answer:${url}:${typeof answer.invite === 'string' ? answer.invite : 'approved'}`;
            if ((await claim([id], deps.storage, now)).length === 0) continue;
            try {
                await deps.post({ title: PUSH_NOTICE_TITLE, body: t('A community answered your request.'), data: { ...LOCAL_NOTICE_DATA, type: 'knock-answer', url } });
                posted++;
            } catch (e) {
                console.warn('[Notices] Could not post a knock answer', e);
            }
        }
        return posted;
    } catch (e) {
        console.warn('[Notices] Failed to check knock status in sync', e);
        return 0;
    }
}

/** Whether this phone sent its push token to `community` for the account on it (utils/push-registrations.ts). */
async function pushRegisteredWith(storage: Storage, community: string): Promise<boolean> {
    try {
        const list = JSON.parse((await storage.getItem(PUSH_REGISTERED_AT_STORE_KEY)) ?? '[]');
        return Array.isArray(list) && list.some((c) => communityAddress(c) === community);
    } catch {
        return false;
    }
}

/** The account's node role on `community`, from the day's remembered answer or a fresh `GET /api/node-admin/me`; null when unknown. */
async function knockRole(deps: SyncNoticeDeps, community: string, account: Account, now: number): Promise<string | null> {
    const kept = parseJson(await deps.storage.getItem(KNOCK_ROLE_STORE_KEY));
    if (kept && kept.community === community && kept.publicKey === account.publicKey && typeof kept.at === 'number'
        && kept.at <= now && now - kept.at < KNOCK_ROLE_RECHECK_MS) {
        return typeof kept.role === 'string' ? kept.role : null;
    }
    const me = await signedRead(`${community}/api/node-admin/me`, account, deps.timeoutMs ?? SYNC_NOTICES_TIMEOUT_MS, deps.signal) as { role?: unknown } | null;
    if (!me || typeof me !== 'object') return null;
    const role = typeof me.role === 'string' ? me.role : null;
    await deps.storage.setItem(KNOCK_ROLE_STORE_KEY, JSON.stringify({ community, publicKey: account.publicKey, role, at: now }));
    return role;
}

/**
 * The floor under the `community.knock` push for an owner or admin (design §5.2 floor 1): when the community's count of
 * open requests to join rose since the last look, one notice ("Someone asked to join your community.", the push's own
 * words, in the phone's language). Only where this phone has no push from that community (GrapheneOS, no Play services;
 * or a registration that never landed): a phone with push is told by the push, never twice. The admin-only queue is read
 * only for an account the community says is an owner or admin, asked once a day (`GET /api/node-admin/me`, any member's),
 * so a member's sync never reads it. Never throws.
 */
export async function postAdminKnockNoticesFromSync(deps: SyncNoticeDeps): Promise<number> {
    const now = deps.now ?? Date.now();
    const account = deps.account;
    if (!account?.publicKey || !account.privateKey) return 0;
    try {
        const community = communityAddress(await deps.storage.getItem(ANCHOR_STORE_KEY));
        if (!community) return 0;
        if (await pushRegisteredWith(deps.storage, community)) {
            // The push tells this phone. What was last seen is dropped, so a phone that loses its push starts afresh.
            await deps.storage.setItem(ADMIN_KNOCKS_COUNT_STORE_KEY, '');
            return 0;
        }
        const role = await knockRole(deps, community, account, now);
        if (role !== 'owner' && role !== 'admin') return 0;
        const queue = await signedRead(`${community}/api/node-admin/queue`, account, deps.timeoutMs ?? SYNC_NOTICES_TIMEOUT_MS, deps.signal) as { items?: unknown } | null;
        if (!queue || !Array.isArray(queue.items)) return 0;
        const item = (queue.items as Array<{ kind?: unknown; count?: unknown }>).find((i) => i?.kind === 'knocks');
        const count = typeof item?.count === 'number' && item.count > 0 ? item.count : 0;

        const last = parseJson(await deps.storage.getItem(ADMIN_KNOCKS_COUNT_STORE_KEY));
        await deps.storage.setItem(ADMIN_KNOCKS_COUNT_STORE_KEY, JSON.stringify({ community, publicKey: account.publicKey, count }));
        // The first look on this phone, for this account and community, only writes the count down: no notice for old news.
        if (!last || last.community !== community || last.publicKey !== account.publicKey || typeof last.count !== 'number') return 0;
        if (count <= last.count) return 0;
        const words = pushNoticeWords('community.knock');
        await deps.post({ title: words.title, body: words.body, data: { ...LOCAL_NOTICE_DATA, type: 'admin-knocks' } });
        return 1;
    } catch (e) {
        console.warn('[Notices] Failed to check admin knocks in sync', e);
        return 0;
    }
}

/**
 * Every notice the background sync posts (services/push-notifications.ts postNoticesAfterSync): the community's unseen
 * notices, the answers to this phone's requests to join, and new requests for an owner or admin without push, all asked
 * at once under one deadline (`timeoutMs`), so a slow or unreachable community can't take the task past iOS's ~30
 * seconds. Returns how many were posted. Never throws.
 */
export async function postAllNoticesFromSync(deps: Omit<SyncNoticeDeps, 'signal'>): Promise<number> {
    const { signal, done } = bounded(deps.timeoutMs ?? SYNC_NOTICES_TIMEOUT_MS);
    try {
        const shared = { ...deps, signal };
        const counts = await Promise.all([postNoticesFromSync(shared), postKnockStatusNoticesFromSync(shared), postAdminKnockNoticesFromSync(shared)]);
        return counts.reduce((a, b) => a + b, 0);
    } finally {
        done();
    }
}
