/**
 * What the app does with a push before it acts on it (scratch/global-node/DESIGN-push-relay-fable.md §4.3; the notice
 * format and its check are @beanpool/core push-notice.ts).
 *
 * A push with words is shown by the phone's system before any app code runs, so whoever holds this phone's push token
 * can put words on its lock screen. What the app controls is what happens next:
 *
 * - **While the app is open** ({@link checkWhileOpen}), a push is shown only when it carries a notice signed by a
 *   community this phone keeps, for the account on it, no older than the notice's lifetime (7 days, the time the node
 *   keeps its details), and not shown before. It is shown with its kind's fixed words. Anything else is dropped and
 *   counted ({@link droppedNoticeCounts}).
 * - **On a tap** ({@link checkTap}), the same check. A valid notice is opened: the app asks its community where it lands
 *   (`GET /api/notices/push/<id>`) and goes there only through {@link noticeRoute}, which builds the route from a fixed
 *   list and lets an id through only in the shape the node issues them. Not valid: the app goes nowhere and shows
 *   {@link FORGED_NOTICE_LINE} once ({@link warnAboutNotice}).
 * - **No string from a push reaches a route.** The kind picks a tab from core's fixed table; the notice id goes only into
 *   the details request, and only in its fixed shape. A push's own `screen`, `postId` or `conversationId` (what servers
 *   sent before signed notices) is never read.
 *
 * ## Notices newer than this build
 *
 * A community's server updates on its own schedule, and an app in the field can't be changed, so a server can send what
 * this build doesn't know. A genuine notice must never be called a forgery for that:
 *
 * - **A kind not in this build's table** (core `PUSH_NOTICE_KINDS` grows) is checked all the same: the signature over
 *   the same bytes, with the kind as sent, by the pinned key, for this account, and the same times. Valid: shown while
 *   open with general words ({@link UNSIGNED_NOTICE_WORDS}), and a tap opens what its community answers, through the
 *   same fixed list, else the Market tab ({@link noticeRoute}), with no warning. Not valid: refused as any forgery is.
 * - **A newer format** (`data.bp` above {@link PUSH_NOTICE_VERSION}) is treated as unsigned, exactly as a push with no
 *   signature (below). It can't be checked here, and exempting it from the warning would let every forger write `bp: 2`
 *   (this code is public) and escape it. Instead the server keeps a rule (core push-notice.ts): it sends a format above 1
 *   only to a phone whose push registration declared it reads that format. This build declares nothing, so it only ever
 *   gets format 1, and its warning never fires on a genuine notice.
 *
 * ## Pushes no community signed
 *
 * A server from before signed notices (or one with no node key yet) sends pushes with nothing to check, and its
 * registration answer names no key (push-pins.ts). The phone can't tell one of its pushes from anyone else's, so:
 *
 * - While a community this phone keeps and sent its token to has pinned no key, an unsigned push is shown with fixed
 *   words ({@link UNSIGNED_NOTICE_WORDS}, or its kind's when it names one) instead of its own, and a tap on it opens the
 *   app where it was: no navigation, and no warning (it may well be that community's). So is a signed notice from a
 *   community the phone pinned no key for: that community may sign by now, and the phone learns its key only from its
 *   next registration answer there.
 * - Once every such community has pinned a key, an unsigned push comes from none of them: dropped while open, and a tap
 *   on it gets the warning.
 * - A community the phone has forgotten has no pin: its signed notices do nothing, and a tap on one gets the warning.
 *
 * BeanPool's key vault sends its own notices (apps/vault api/push.ts, `data.type`), not yet signed. Each is honoured
 * only on a phone that gave the vault its push token for the account on it: shown while open with its type's fixed
 * words ({@link VAULT_NOTICE_WORDS}), never its own, and a tap (on it, or on the app's copy) opens Settings, where the
 * recovery banner reads what is really waiting from the vault. On any other phone it is an unsigned push.
 *
 * The app's own notices (a push shown with fixed words in its place, and the sync's notices, sync-notices.ts) are told
 * apart by how they arrived: the phone's push service marks a push it delivered (trigger `push`), and nothing a sender
 * puts in a push can change that.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
    isPushNoticeId, isPushNoticeKind, PUSH_COMMUNITY_TAG_PATTERN, PUSH_NOTICE_CLOCK_SKEW_SECONDS, PUSH_NOTICE_KINDS,
    PUSH_NOTICE_LIFETIME_SECONDS, PUSH_NOTICE_VERSION, pushNoticeBytes, pushNoticeWords, verifyPushNotice, type PushNoticeKind,
    type PushNoticeRefusal, type PushNoticeTab,
} from '@beanpool/core';
import { buildSignedHeaders } from './crypto';
import type { BeanPoolIdentity } from './identity';
import { readPushPins, type PushPin, type PushPins } from './push-pins';
import { vaultPushTokenStoreKey } from './storage-keys';

/** What a tap on a notice the phone can't trust shows, once. */
export const FORGED_NOTICE_LINE =
    "That notification didn't come from your community. Ignore what it said. BeanPool never asks for your 12 words or a password in a notification.";

/** The words shown, while the app is open, in place of an unsigned push's own, when it names no kind. */
export const UNSIGNED_NOTICE_WORDS = { title: 'BeanPool', body: 'There is news from your community.' } as const;

/** `data` of a notice the app posts itself: one shown in a push's place, and the sync's (sync-notices.ts). */
export const LOCAL_NOTICE_DATA = { bpLocal: 1 } as const;

/** Which notice ids this phone has shown while open, and which it has opened from a tap: id → the notice's time. */
export const NOTICE_LEDGER_STORE_KEY = 'beanpool_push_notice_ledger';
/** As long as a notice can pass the check: its lifetime, and the clock skew a newer one is allowed. */
const LEDGER_KEEP_SECONDS = PUSH_NOTICE_LIFETIME_SECONDS + PUSH_NOTICE_CLOCK_SKEW_SECONDS;
/** The most ids kept in each list; the oldest go first. More than the 100 a member's node keeps for 7 days. */
const LEDGER_MAX = 500;

/**
 * The words the app shows, while open, for each of the key vault's notices (apps/vault api/push.ts `PushKind`), in
 * place of the push's own: the vault's notices aren't signed yet, so their words could be anyone's. The vault's own
 * sentences (`noticeFor`), less the sign-in provider's name, which only the vault knows.
 */
export const VAULT_NOTICE_WORDS = {
    'vault-hold': {
        title: 'Someone is getting back into your BeanPool account',
        body: 'Someone is getting back into your BeanPool account on another device. Open BeanPool: tap "Yes, it\'s me" if it was you, or Stop if it wasn\'t.',
    },
    'vault-released': {
        title: 'Your BeanPool account was restored',
        body: "Your BeanPool account was just restored on another device. If that wasn't you, open BeanPool now.",
    },
    'vault-replaced': {
        title: 'Sign-in recovery moved to another account',
        body: 'Your sign-in now protects a different BeanPool account. This one has only its 12 words.',
    },
} as const;

type VaultNoticeType = keyof typeof VAULT_NOTICE_WORDS;

/**
 * A kind this build's table doesn't have, in the shape every kind in core's table takes (`chat.message`,
 * `account.recovery-started`): lower-case words joined by dots, at most 64 characters. Nothing else is a kind, so no
 * newline or other separator of the signed bytes can be one.
 */
const UNKNOWN_KIND = /^(?=.{1,64}$)[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/** A post or conversation id in the shape the node issues them: a UUID (utils/events.ts POST_ID_RE). */
const NODE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Storage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

/** A notification as the app received it, whatever library delivered it. */
export interface IncomingNotice {
    /** The notification request's identifier. */
    identifier: string;
    /** Delivered by the phone's push service (expo-notifications trigger `push`), not posted by this app. */
    remote: boolean;
    title: string | null;
    body: string | null;
    data: unknown;
}

export interface NoticeContext {
    storage: Storage;
    /** The public key of the account on this phone, or null with none. */
    recipient: string | null;
    /** Whole seconds; the phone's clock when absent. */
    now?: number;
}

export type DropReason = PushNoticeRefusal | 'repeated' | 'unsigned' | 'newer-format' | 'no-account' | 'unreadable';

export type OpenDecision =
    /** Show it as it came. */
    | { kind: 'show' }
    /** Show these words instead of its own (the app posts them as its own notice). */
    | { kind: 'replace'; title: string; body: string; data: Record<string, unknown> }
    | { kind: 'drop'; reason: DropReason };

export type TapDecision =
    /**
     * A notice its community signed for this account: ask it where the tap lands. `active`: the community the phone is
     * set to. `noticeKind`: null for a kind this build doesn't know (a server newer than the app).
     */
    | { kind: 'open'; community: string; id: string; noticeKind: PushNoticeKind | null; active: boolean }
    /** The key vault's notice, on a phone that gave the vault its token. */
    | { kind: 'settings' }
    /** Open the app where it was. */
    | { kind: 'nothing'; reason: DropReason | 'local' }
    /** Go nowhere, and show {@link FORGED_NOTICE_LINE}. */
    | { kind: 'warn'; reason: DropReason };

// ── Counting what was dropped ──────────────────────────────────────────────────────────────────────────────────

const dropped = new Map<string, number>();

function count(reason: string): void {
    dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
}

/** How many pushes this run dropped while open, or refused on a tap, by reason. */
export function droppedNoticeCounts(): Record<string, number> {
    return Object.fromEntries(dropped);
}

// ── The warning line ───────────────────────────────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
let warningPending = false;

/**
 * A tap on a notice the phone can't trust: {@link FORGED_NOTICE_LINE} goes up once. Held until the line's component
 * takes it, so a tap that launched the app is shown once the app has drawn (components/PushNoticeWarning.tsx).
 */
export function warnAboutNotice(): void {
    warningPending = true;
    for (const listener of listeners) listener();
}

/** Whether a warning is waiting to be shown; taking it clears it. */
export function takeNoticeWarning(): boolean {
    const pending = warningPending;
    warningPending = false;
    return pending;
}

/** Called each time a warning comes in. Returns the unsubscribe. */
export function onNoticeWarning(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

// ── What a push carries ────────────────────────────────────────────────────────────────────────────────────────

function asObject(data: unknown): Record<string, unknown> | null {
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
}

/** Whole digits for a number, as a push service may hand them over: the signed bytes spell `t` the same either way. */
function wholeNumber(v: unknown): unknown {
    return typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : v;
}

/** The push's data as a signed notice, or null when it carries no signature at all (an unsigned push). */
function signedNotice(data: unknown): Record<string, unknown> | null {
    const d = asObject(data);
    if (!d || wholeNumber(d.bp) !== PUSH_NOTICE_VERSION || typeof d.s !== 'string') return null;
    return { ...d, bp: PUSH_NOTICE_VERSION, t: wholeNumber(d.t) };
}

/** The key vault's notice type a push (or the app's own copy of one) names, or null. */
function vaultNoticeType(data: unknown): VaultNoticeType | null {
    const type = asObject(data)?.type;
    return typeof type === 'string' && Object.prototype.hasOwnProperty.call(VAULT_NOTICE_WORDS, type) ? type as VaultNoticeType : null;
}

async function vaultHasToken(ctx: NoticeContext): Promise<boolean> {
    if (!ctx.recipient) return false;
    try {
        return !!(await ctx.storage.getItem(vaultPushTokenStoreKey(ctx.recipient)));
    } catch {
        return false;
    }
}

/** The pin whose community signed with this tag: the community the phone is set to first. */
function pinFor(pins: PushPins, tag: unknown): PushPin | undefined {
    const matches = pins.pinned.filter((p) => p.tag === tag);
    return matches.find((p) => p.community === pins.anchor) ?? matches[0];
}

type Checked =
    /** `kind`: null for a kind this build doesn't know. */
    | { ok: true; pin: PushPin; kind: PushNoticeKind | null; id: string; sentAt: number; pins: PushPins }
    | { ok: false; reason: DropReason };

type Verified = { ok: true; kind: PushNoticeKind | null; id: string; sentAt: number } | { ok: false; reason: PushNoticeRefusal };

/**
 * A notice of a kind this build's table doesn't have, checked as core `verifyPushNotice` checks one it has: the same
 * fields in the same shapes, the signature over the same bytes (core `pushNoticeBytes`, with the kind as sent) by the
 * pinned key, and the same times. Servers and apps update apart, and a build in the field can't be changed, so a
 * genuine notice of a kind added later must not be taken for a forgery. A forger gains nothing: a changed kind breaks
 * the signature like any other changed field.
 */
function verifyUnknownKind(d: Record<string, unknown>, recipient: string, pushKey: string, now: number): Verified {
    if (!isPushNoticeId(d.i) || typeof d.t !== 'number' || !Number.isSafeInteger(d.t) || d.t <= 0
        || typeof d.c !== 'string' || !PUSH_COMMUNITY_TAG_PATTERN.test(d.c)
        || typeof d.s !== 'string' || !/^[0-9a-f]{128}$/.test(d.s)
        || typeof d.k !== 'string' || !UNKNOWN_KIND.test(d.k)) {
        return { ok: false, reason: 'not-a-notice' };
    }
    let valid: boolean;
    try {
        // pushNoticeBytes is typed for the kinds core knows; the bytes are the kind's text either way.
        const fields = { c: d.c, k: d.k as PushNoticeKind, i: d.i, t: d.t };
        valid = ed25519.verify(hexToBytes(d.s), pushNoticeBytes(fields, recipient), hexToBytes(pushKey), { zip215: false });
    } catch {
        valid = false;
    }
    if (!valid) return { ok: false, reason: 'bad-signature' };
    if (now - d.t > PUSH_NOTICE_LIFETIME_SECONDS) return { ok: false, reason: 'too-old' };
    if (d.t - now > PUSH_NOTICE_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'from-the-future' };
    return { ok: true, kind: null, id: d.i, sentAt: d.t };
}

/** A signed notice checked against the pins and the account on the phone. */
async function checkSigned(notice: Record<string, unknown>, ctx: NoticeContext): Promise<Checked> {
    if (!ctx.recipient) return { ok: false, reason: 'no-account' };
    let pins: PushPins;
    try {
        pins = await readPushPins(ctx.storage);
    } catch {
        return { ok: false, reason: 'unreadable' };
    }
    const pin = pinFor(pins, notice.c);
    if (!pin) return { ok: false, reason: 'other-community' };
    const check: Verified = isPushNoticeKind(notice.k)
        ? verifyPushNotice(notice, { recipient: ctx.recipient, pushKey: pin.pushKey, now: ctx.now })
        : verifyUnknownKind(notice, ctx.recipient, pin.pushKey, nowSeconds(ctx));
    if (!check.ok) return { ok: false, reason: check.reason };
    return { ok: true, pin, kind: check.kind, id: check.id, sentAt: check.sentAt, pins };
}

// ── The ledger of ids seen ─────────────────────────────────────────────────────────────────────────────────────

interface Ledger { shown: Record<string, number>; tapped: Record<string, number> }

function parseLedger(raw: string | null): Ledger {
    const ledger: Ledger = { shown: {}, tapped: {} };
    try {
        const parsed = asObject(JSON.parse(raw ?? '{}'));
        for (const list of ['shown', 'tapped'] as const) {
            for (const [id, t] of Object.entries(asObject(parsed?.[list]) ?? {})) {
                if (typeof t === 'number' && Number.isSafeInteger(t)) ledger[list][id] = t;
            }
        }
    } catch {
        // An unreadable ledger is an empty one.
    }
    return ledger;
}

function tidy(list: Record<string, number>, now: number): Record<string, number> {
    const kept = Object.entries(list).filter(([, t]) => now - t <= LEDGER_KEEP_SECONDS).sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(kept.slice(0, LEDGER_MAX));
}

let ledgerWrites: Promise<unknown> = Promise.resolve();

/**
 * Note `id` in `list`, after any note under way. True the first time; false when it was noted before. A ledger that
 * can't be read or written counts as first time: a notice shown twice is better than one never acted on.
 */
function noteOnce(storage: Storage, list: keyof Ledger, id: string, sentAt: number, now: number): Promise<boolean> {
    const next = ledgerWrites.then(async () => {
        let raw: string | null;
        try {
            raw = await storage.getItem(NOTICE_LEDGER_STORE_KEY);
        } catch {
            return true;
        }
        const ledger = parseLedger(raw);
        if (id in ledger[list]) return false;
        ledger[list][id] = sentAt;
        const tidied: Ledger = { shown: tidy(ledger.shown, now), tapped: tidy(ledger.tapped, now) };
        try {
            await storage.setItem(NOTICE_LEDGER_STORE_KEY, JSON.stringify(tidied));
        } catch (e) {
            console.warn('[Push] Could not note a notice as handled', e);
        }
        return true;
    });
    ledgerWrites = next.catch(() => {});
    return next;
}

const nowSeconds = (ctx: NoticeContext) => ctx.now ?? Math.floor(Date.now() / 1000);

// ── While the app is open ──────────────────────────────────────────────────────────────────────────────────────

function drop(reason: DropReason): OpenDecision {
    count(reason);
    console.log(`[Push] A notification was not shown: ${reason}`);
    return { kind: 'drop', reason };
}

/** What the app does with a push that arrives while it is open. Never throws. */
export async function checkWhileOpen(n: IncomingNotice, ctx: NoticeContext): Promise<OpenDecision> {
    // The app's own: nothing from outside can post one.
    if (!n.remote) return { kind: 'show' };
    try {
        const notice = signedNotice(n.data);
        if (notice) {
            const checked = await checkSigned(notice, ctx);
            if (checked.ok) {
                if (!(await noteOnce(ctx.storage, 'shown', checked.id, checked.sentAt, nowSeconds(ctx)))) return drop('repeated');
                // A kind this build doesn't know has no words here: the general ones.
                const words = checked.kind ? pushNoticeWords(checked.kind) : UNSIGNED_NOTICE_WORDS;
                if (checked.kind && n.title === words.title && n.body === words.body) return { kind: 'show' };
                // The words aren't signed: shown with the kind's, and the notice kept, so a tap on it opens as this would.
                return { kind: 'replace', title: words.title, body: words.body, data: { ...notice, ...LOCAL_NOTICE_DATA } };
            }
            // Signed by no community this phone pinned: from one it sent its token to but hasn't learnt the key of yet,
            // perhaps, so it goes as an unsigned push would below. Any other refusal is final.
            if (checked.reason !== 'other-community') return drop(checked.reason);
        } else {
            // The vault's notice, on a phone that gave the vault its token: its type's fixed words, never its own (it
            // isn't signed yet), and a copy that names only its type, so a tap on it opens Settings (checkTap).
            const type = vaultNoticeType(n.data);
            if (type && await vaultHasToken(ctx)) {
                return { kind: 'replace', ...VAULT_NOTICE_WORDS[type], data: { ...LOCAL_NOTICE_DATA, type } };
            }
        }
        const pins = await readPushPins(ctx.storage);
        if (pins.unpinnedRegistered.length === 0) return drop(notice ? 'other-community' : 'unsigned');
        const named = asObject(n.data)?.k;
        const words = isPushNoticeKind(named) ? pushNoticeWords(named) : UNSIGNED_NOTICE_WORDS;
        return { kind: 'replace', title: words.title, body: words.body, data: { ...LOCAL_NOTICE_DATA } };
    } catch (e) {
        console.warn('[Push] Could not check a notification', e);
        return drop('unreadable');
    }
}

// ── On a tap ───────────────────────────────────────────────────────────────────────────────────────────────────

function refuse(reason: DropReason): TapDecision {
    count(`tap:${reason}`);
    console.log(`[Push] A tapped notification was not followed: ${reason}`);
    return { kind: 'warn', reason };
}

/**
 * What a tap on a notification does (and the notification that launched the app). Never throws. A `warn` has not been
 * shown yet: the caller calls {@link warnAboutNotice}.
 */
export async function checkTap(n: IncomingNotice, ctx: NoticeContext): Promise<TapDecision> {
    try {
        const notice = signedNotice(n.data);
        if (notice) {
            const checked = await checkSigned(notice, ctx);
            if (checked.ok) {
                if (!(await noteOnce(ctx.storage, 'tapped', checked.id, checked.sentAt, nowSeconds(ctx)))) return { kind: 'nothing', reason: 'repeated' };
                return {
                    kind: 'open', community: checked.pin.community, id: checked.id, noticeKind: checked.kind,
                    active: checked.pin.community === checked.pins.anchor,
                };
            }
            // Signed by its community for this account, only late (or the phone's clock is off): not a forgery.
            if (checked.reason === 'too-old' || checked.reason === 'from-the-future') return { kind: 'nothing', reason: checked.reason };
            // Signed by no community this phone pinned: as an unsigned push, below (checkWhileOpen). Any other is refused.
            if (checked.reason !== 'other-community') return refuse(checked.reason);
        }
        // The app's own notices carry no target: it opens where it was. The copy it showed of the vault's notice opens
        // Settings, as the vault's own push does; nothing from outside can post a notice of the app's own.
        if (!n.remote) return vaultNoticeType(n.data) ? { kind: 'settings' } : { kind: 'nothing', reason: 'local' };
        if (!notice && vaultNoticeType(n.data) && await vaultHasToken(ctx)) return { kind: 'settings' };
        const pins = await readPushPins(ctx.storage);
        const reason: DropReason = notice ? 'other-community' : 'unsigned';
        return pins.unpinnedRegistered.length > 0 ? { kind: 'nothing', reason } : refuse(reason);
    } catch (e) {
        console.warn('[Push] Could not check a tapped notification', e);
        return { kind: 'nothing', reason: 'unreadable' };
    }
}

// ── Where a tap lands ──────────────────────────────────────────────────────────────────────────────────────────

export type NoticeRoute = '/(tabs)' | '/(tabs)/chats' | '/(tabs)/settings' | `/post/${string}` | `/chat/${string}`;

const TAB_ROUTES: Record<PushNoticeTab, NoticeRoute> = {
    home: '/(tabs)',
    market: '/(tabs)',
    chats: '/(tabs)/chats',
    settings: '/(tabs)/settings',
};

/**
 * Where a valid notice's tap lands, from what its community answered for it (`data` of `GET /api/notices/push/<id>`,
 * or nothing when it couldn't be had): a post or a chat when the answer names one by an id in the node's own shape,
 * Settings when it says so, and otherwise the tab for the notice's kind; the Market tab for a kind this build doesn't
 * know (`kind` null). Every route is one of a fixed few; the only text taken from the answer is an id that matched
 * {@link NODE_ID}.
 */
export function noticeRoute(kind: PushNoticeKind | null, details: unknown): NoticeRoute {
    const d = asObject(details) ?? {};
    if (d.screen === 'post' && typeof d.postId === 'string' && NODE_ID.test(d.postId)) return `/post/${d.postId}`;
    if (d.screen === 'chat' && typeof d.conversationId === 'string' && NODE_ID.test(d.conversationId)) return `/chat/${d.conversationId}`;
    if (d.screen === 'settings') return '/(tabs)/settings';
    const tab = kind && isPushNoticeKind(kind) ? PUSH_NOTICE_KINDS[kind].tab : 'market';
    return TAB_ROUTES[tab] ?? TAB_ROUTES.market;
}

// ── Following a tap ────────────────────────────────────────────────────────────────────────────────────────────

/** How long a community has to say where a tap lands before the app opens the tab for the notice's kind. */
export const NOTICE_DETAILS_TIMEOUT_MS = 8000;

type Account = Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>;

/**
 * What `community` answers for notice `id` (`GET /api/notices/push/<id>`, signed by the account it was sent to): its
 * `data`, or null when it can't be had (no answer within `timeoutMs`, a refusal, a node that forgot it, an answer for
 * another id). Never throws.
 */
export async function noticeDetails(community: string, id: string, account: Account, timeoutMs = NOTICE_DETAILS_TIMEOUT_MS): Promise<unknown> {
    if (!isPushNoticeId(id)) return null;
    const url = `${community}/api/notices/push/${id}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = await buildSignedHeaders('GET', url, '', account.privateKey, account.publicKey);
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (!res.ok) return null;
        const body = asObject(await res.json().catch(() => null));
        return body?.id === id ? body.data ?? null : null;
    } catch (e) {
        console.log(`[Push] Where a notice lands could not be had from ${community}: ${e instanceof Error ? e.message : e}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * A tap on a notification (or the one that launched the app), followed: {@link checkTap}, then for a valid notice from
 * the community the phone is set to, its details and {@link noticeRoute}; Settings for the key vault's; the warning for
 * one the phone can't trust. A valid notice from another community the phone keeps opens nothing: the screens show the
 * community the phone is set to. Returns what was decided. Never throws.
 */
export async function followTap(
    n: IncomingNotice,
    ctx: Omit<NoticeContext, 'recipient'> & { account: Account | null; detailsTimeoutMs?: number },
    navigate: (route: NoticeRoute) => void,
): Promise<TapDecision> {
    const decision = await checkTap(n, { storage: ctx.storage, recipient: ctx.account?.publicKey ?? null, now: ctx.now });
    try {
        if (decision.kind === 'open' && ctx.account) {
            if (!decision.active) {
                console.log(`[Push] A notice from ${decision.community}, which the phone is not set to: nothing opened`);
                return decision;
            }
            const details = await noticeDetails(decision.community, decision.id, ctx.account, ctx.detailsTimeoutMs);
            navigate(noticeRoute(decision.noticeKind, details));
        } else if (decision.kind === 'settings') {
            navigate('/(tabs)/settings');
        } else if (decision.kind === 'warn') {
            warnAboutNotice();
        }
    } catch (e) {
        console.warn('[Push] Could not follow a tapped notification', e);
    }
    return decision;
}
