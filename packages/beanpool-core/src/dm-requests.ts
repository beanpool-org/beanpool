/**
 * Message requests: shared helpers for both phone and web (DESIGN-message-a-friend-fable.md §4).
 * Where the community's `dmRequests` switch is on, a member's first message to someone who hasn't
 * added them, written to them or traded with them waits as a request.
 */
import { t } from './words.js';
import { isBusyError, busyWords } from './busy-answer.js';

/**
 * What waits for a member in one community, in counts alone (GET /api/me/unread): both apps read it, and it names nobody
 * and no chat. `unread` is the lines in the chats their list shows, so the number can always be opened and cleared.
 * `requests` is the message requests waiting for them: never in `unread`, and no badge or alert is made of it
 * (Marty, 1 Nov 2026: nothing until accepted). Since 19 Nov 2026 (Marty) the phone shows it on Chat's line about another
 * community ("1 message request in {community}") and the row's count ({@link requestsRowCount}), and nowhere else. `asOf`
 * is when the node counted (ISO 8601).
 *
 * `alerts` is how many lines of `unread` the node would have sent this member a push about: never those of a chat they muted
 * (an @mention of them gets through, as it does a mute), none with their Direct Messages off, none of an event's chat, none
 * of someone they blocked in a group's chat. It is what a phone with no push tells them of itself, so a mute holds there too
 * (apps/native/utils/other-communities-unread.ts). The badge stays on `unread`. A node from before it doesn't send it.
 */
export interface UnreadAnswer {
    unread: number;
    requests: number;
    alerts?: number;
    /** The number of the member's locked contacts list this community keeps, or null (none, or the community keeps none):
     *  absent from a server from before private contacts (DESIGN-private-contacts-fable.md §4.4). */
    contacts?: { seq: number } | null;
    asOf: string;
}

/** The chat's request mode, for the reader. */
export type RequestMode =
    /** An ordinary chat: requests off, none on this chat, or accepted. */
    | 'none'
    /** A request waiting for the reader: they read it, then Accept, Ignore or Block; no composer until they accept. */
    | 'to-me'
    /** The reader's own request with no line of theirs in it yet (or one 30 days on): their next line is the request. */
    | 'mine-unsent'
    /** The reader's own request with their line in it: they can write more once it is accepted. */
    | 'mine-waiting'
    /** The reader's own waiting request while this chat's lines are still being read: whether their line is in it isn't
     *  known yet, so the page says neither, and offers nothing only an unsent request takes. */
    | 'mine-loading';

/** The most request cards one screen shows; the rest are counted ("and {n} more"), as the design's list. */
export const REQUEST_CARDS_SHOWN = 50;
/** Ignore all is offered when more than this many wait (design §4.5). */
export const IGNORE_ALL_FROM = 6;

export interface DmRequestCore {
    state: 'pending' | 'accepted' | 'ignored' | 'expired';
    from: string;
    at: string;
    nextLineIsRequest?: boolean;
}

/** The time a stamp names, or NaN. */
const at = (iso: string | null | undefined) => (typeof iso === 'string' ? Date.parse(iso) : NaN);

/**
 * The opener's lines in the chat since the request was made, for a node that doesn't say whether their next line is the
 * request (`nextLineIsRequest`): the node stamps the request at its line, so a line of theirs at or after `request.at` is
 * the request's (the server's OPENER_WROTE). Their own lines kept for them alone are among the lines the node gives them,
 * and count the same, as the node counts them while the block holds.
 */
function openerLinesSince(
    conv: { request?: DmRequestCore | null },
    lines: ReadonlyArray<{ authorPubkey?: string; senderId?: string; timestamp?: string | null; rawTimestamp?: string | null; type?: string | null }>
): number {
    const r = conv.request;
    if (!r) return 0;
    const since = at(r.at);
    return lines.filter((l) => {
        const author = l.authorPubkey ?? l.senderId;
        const ts = at(l.rawTimestamp ?? l.timestamp);
        return author === r.from && l.type !== 'system' && Number.isFinite(ts) && ts >= since;
    }).length;
}

/**
 * What request mode a direct chat is in for `me`, from the node's `request` on it and the lines loaded (null until this
 * chat's have been read: no lines is not the same as none read). A request that isn't accepted is the person's to decide,
 * whatever state the node names to them. The opener's own: waiting once their line is in it, by the node's count where it
 * gives one, not known before their lines are read; `expired` (30 days) makes their next line a new request.
 */
export function requestModeOf(
    conv: { type?: string | null; request?: DmRequestCore | null } | null | undefined,
    me: string,
    lines: ReadonlyArray<{ authorPubkey?: string; senderId?: string; timestamp?: string | null; rawTimestamp?: string | null; type?: string | null }> | null,
): RequestMode {
    const r = conv?.type === 'dm' ? conv.request : null;
    if (!r || r.state === 'accepted') return 'none';
    // The node's state is the authority (Marty, 28 Oct 2026, PR #2540): a request someone else made is the reader's to
    // decide, even once its opener withdrew every line of it (Cancel request). The page never makes it an ordinary chat:
    // its Accept finds no request then (404, which drops it), and nothing of the reader's accepts it at the node.
    if (r.from !== me) return 'to-me';
    if (r.state === 'expired') return 'mine-unsent';
    if (!lines) return 'mine-loading';
    // The node's count, not the page's (PR #2404 review 4356625513): a line kept for the opener while they were blocked is
    // among their lines here, and once the block is lifted it is no request's line. The page can't tell it apart, and
    // mustn't, so it reads the node's word.
    if (typeof r.nextLineIsRequest === 'boolean') return r.nextLineIsRequest ? 'mine-unsent' : 'mine-waiting';
    return openerLinesSince(conv!, lines) > 0 ? 'mine-waiting' : 'mine-unsent';
}

/**
 * Whether the chat takes a photo now (📎, a paste or a drop): not while a request waits for the reader to decide, nor
 * while theirs waits for the other to accept, nor while the opener's chat is still being read.
 */
export function requestTakesPhoto(mode: RequestMode): boolean {
    return mode !== 'to-me' && mode !== 'mine-waiting' && mode !== 'mine-loading';
}

/**
 * The open chat's request once the node has taken a new line of the reader's (200): where the node said their next line
 * was the request's, that line was it, so the one after waits, whether or not the read after it comes back. The next read
 * replaces it with the node's word (requestAfterRead). Anything else is as it was.
 */
export function requestAfterOwnLine<T extends DmRequestCore>(r: T | null | undefined, me: string): T | null | undefined {
    if (!r || r.from !== me || r.state !== 'pending' || r.nextLineIsRequest !== true) return r;
    return { ...r, nextLineIsRequest: false };
}

/**
 * The open chat's request after a new read from the node: the node's, or null when the read names none (requests are off,
 * or it is an ordinary chat). One exception: an acceptance is never undone by a read of the same request that still names
 * it waiting, which was asked before the acceptance landed. The node never takes an acceptance back from either person.
 */
export function requestAfterRead<T extends DmRequestCore, R extends DmRequestCore = T>(prev: T | null | undefined, read: { request?: R | null }): T | R | null {
    const next = read.request ?? null;
    if (prev?.state === 'accepted' && next && next.state !== 'accepted' && next.from === prev.from && next.at === prev.at) return prev;
    return next;
}

/** What a request card or the chat's request bar says when Accept or Ignore didn't go through. */
export function decisionFailureWords(e: unknown): string {
    // A busy network (HTTP 429 from the proxy in front of the node) is not "out of reach" and not the node's refusal: it says
    // so in its one sentence, and the card stays for a second try.
    if (isBusyError(e)) return busyWords();
    const err = e as { status?: unknown; message?: unknown; unsaid?: unknown } | null | undefined;
    // The node answered and refused (a standby, a request that is gone): its own words. A page that wasn't the node's (a
    // proxy's), or no answer at all, is the community out of reach.
    if (err && typeof err.status === 'number' && err.status > 0 && !err.unsaid && typeof err.message === 'string' && err.message.trim()) return err.message;
    return t('Connect to your community to accept or decline.');
}

/**
 * What became of Report on a request: `reported`, or why the message's own report didn't go. Every one of them blocks the
 * sender: Report always does. `refused` (the node turned the message's report down) and `no_line` (nothing is left to hand
 * over, because its sender deleted the line) report the person instead, with the member's reason, as a block from a request
 * always did: Child safety still alerts, and a report that can't be sent yet is queued. `over_limit` (the moderators' hourly
 * limit) reports nobody.
 */
export type RequestReportOutcome = 'reported' | 'over_limit' | 'refused' | 'no_line';

/**
 * A report's failure, as Report on a request reads it: the node's refusal, which never costs a member their block, or null
 * for no answer from it (offline, a 5xx, or a busy network's 429), which throws as ever: the card stays and a second try
 * sends the report.
 *
 * A busy network's 429 (`isBusyError`: the proxy in front of the node answered, not the node) is NOT the moderators' hourly
 * limit. Read as `over_limit` it would block the sender with no report at all (Child safety included) and tell the member
 * a falsehood, with no second try. The node's own report limit is its JSON 429 (`{ error: 'rate_limited', message }`),
 * which is no busy error and stays `over_limit`.
 */
export function requestReportRefused(e: unknown): 'over_limit' | 'refused' | null {
    if (isBusyError(e)) return null;
    const status = (e as { status?: unknown } | null | undefined)?.status;
    if (status === 429) return 'over_limit';
    return typeof status === 'number' && status >= 400 && status < 500 ? 'refused' : null;
}

/** What Report on a request says when the message's report didn't go, in place of "Reported". The block went through. */
export function requestReportNotSentWords(outcome: Exclude<RequestReportOutcome, 'reported'>): string {
    if (outcome === 'over_limit') return t('You have sent a lot of reports recently, so this one did not go. They are blocked.');
    if (outcome === 'no_line') return t('That message was deleted, so your report of them goes without its words. They are blocked.');
    return t('Your community did not take that message, so your report of them goes without its words. They are blocked.');
}

/** The node's refusal of the opener's second line, or reaction, while their request waits (403 `dm_request_pending`). */
export function requestPendingRefusal(e: unknown): string | null {
    const err = e as { code?: unknown; message?: unknown } | null | undefined;
    return err?.code === 'dm_request_pending' && typeof err.message === 'string' && err.message.trim() ? err.message : null;
}

/**
 * The one "Message requests" row at the top of Chat (both apps): how many wait behind it, and whether any came since the
 * member last opened the list (the small red dot). Marty, 19 Nov 2026, after a global test where a first message waited as a
 * request and the person it was for never saw it: the plain row read as a heading, not a button. It replaced his 1 Nov 2026
 * rule (no count and no badge until one is accepted) for the row alone: still NO push, and nothing in the app-icon badge,
 * the tab's badge or the unread count, because a stranger's line must not ring a phone set to another community.
 *
 * What it counts, each kind waiting behind the row: the node's own requests for the member here (`here.count`, the node's
 * total, which may be more than it lists), those waiting on global for a member who ticked a door (`onGlobal`, a count
 * only), a request from someone in another community kept on this device (`outside`), and an invitation to a group chat
 * hosted elsewhere (`guestInvites`). Each is someone waiting for an answer, and the row's tap shows every one of them.
 */
export interface RequestsWaiting {
    here: { count: number; conversations: ReadonlyArray<{ request?: { at?: string | null } | null }> } | null | undefined;
    onGlobal: number;
    outside: ReadonlyArray<{ lastAt?: number | null; updatedAt?: number | null }>;
    guestInvites: ReadonlyArray<{ updatedAt?: number | null }>;
}

/**
 * Where the member had opened the list up to, kept per account and community on the device: for each kind, the newest time
 * it had then (each from its own clock: the node's for `here`, this device's for the others, so none is compared with
 * another's), and the count waiting on global then, which has no time.
 */
export interface RequestsSeen { here: number; outside: number; guest: number; global: number }

const NO_SEEN: RequestsSeen = { here: 0, outside: 0, guest: 0, global: 0 };

const whole = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);

/** How many wait behind the row, all kinds added up. */
export function requestsRowCount(w: RequestsWaiting): number {
    return whole(w.here?.count) + whole(w.onGlobal) + w.outside.length + w.guestInvites.length;
}

/** The newest of each kind now, as {@link RequestsSeen} keeps it. */
export function requestsNewest(w: RequestsWaiting): RequestsSeen {
    const most = (xs: number[]) => xs.reduce((m, x) => (Number.isFinite(x) && x > m ? x : m), 0);
    return {
        here: most((w.here?.conversations ?? []).map((c) => at(c.request?.at))),
        outside: most(w.outside.map((c) => Number(c.lastAt ?? c.updatedAt ?? NaN))),
        guest: most(w.guestInvites.map((c) => Number(c.updatedAt ?? NaN))),
        global: whole(w.onGlobal),
    };
}

/**
 * The red dot: something waits that came after the member last opened the list. With no mark kept (never opened on this
 * device, or a mark that can't be read), anything waiting is new.
 */
export function requestsUnseen(w: RequestsWaiting, seen: RequestsSeen | null): boolean {
    if (requestsRowCount(w) === 0) return false;
    if (!seen) return true;
    const now = requestsNewest(w);
    return now.here > seen.here || now.outside > seen.outside || now.guest > seen.guest || now.global > seen.global;
}

/**
 * The mark to keep, or null when nothing changes (so nothing is written). `opened`: the list shows, so everything in it is
 * seen (each kind's newest, never moving back). Otherwise only the global count follows a fall (an answer given on global
 * itself), so the next one there shows the dot.
 */
export function requestsSeenNext(w: RequestsWaiting, seen: RequestsSeen | null, opened: boolean): RequestsSeen | null {
    const now = requestsNewest(w);
    if (!opened) return seen && now.global < seen.global ? { ...seen, global: now.global } : null;
    const s = seen ?? NO_SEEN;
    const next = { here: Math.max(s.here, now.here), outside: Math.max(s.outside, now.outside), guest: Math.max(s.guest, now.guest), global: now.global };
    const same = !!seen && next.here === seen.here && next.outside === seen.outside && next.guest === seen.guest && next.global === seen.global;
    return same ? null : next;
}

/** A kept mark, as storage gave it; null for none or one that can't be read. */
export function parseRequestsSeen(raw: string | null | undefined): RequestsSeen | null {
    try {
        const v = JSON.parse(raw ?? 'null') as Partial<Record<keyof RequestsSeen, unknown>> | null;
        if (!v || typeof v !== 'object') return null;
        const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
        if (!ok(v.here) || !ok(v.outside) || !ok(v.guest) || !ok(v.global)) return null;
        return { here: v.here, outside: v.outside, guest: v.guest, global: v.global };
    } catch {
        return null;
    }
}

/** The row's count as its pill shows it. */
export function requestsPillText(n: number): string {
    return n > 99 ? '99+' : String(n);
}
