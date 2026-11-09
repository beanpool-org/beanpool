/**
 * The bell in the top bar, on the phone and the web (scratch/fable-design/DESIGN-web-notifications-fable.md §2.1, slice W0;
 * Marty, 9 Nov 2026). One control in place of the needs-you icons: a red count of the notices not yet opened, and a sheet
 * with what needs the member now (the open things, at the top) and what happened, newest first, with the real words.
 *
 * The list is the member's own server's (GET /api/notices/push?unseen=1): every push notice it kept for them, a phone or
 * not. A row leaves only when it is tapped (POST /api/notices/push/seen) or when its thing is opened (a chat read: the
 * server marks it); opening the sheet marks nothing, and there is no "Clear all" (its last line: "Older notices are gone
 * after 7 days."). The server tells the member's sockets
 * `push_notice` when one is kept and `push_notices_seen` when some are marked, so every open app's count follows.
 */
import { t, tn } from './words.js';

/** A row on the bell: what the server kept for its member (routes/notices.ts). */
export interface BellNotice {
    id: string;
    kind: string;
    /** What the sender wrote: shown in the sheet, never in a push. */
    title: string;
    body: string;
    /** Where a tap lands (a chat, a post, a group…), as the phone's push tap reads it. */
    data: Record<string, unknown>;
    /** Whole seconds. */
    sentAt: number;
    seenAt: number | null;
}

/** The socket events the bell listens for. */
export const BELL_EVENTS = { kept: 'push_notice', seen: 'push_notices_seen' } as const;
/** The web app's page event carrying one of them (`detail`: the socket event), from lib/sync to the bell. */
export const BELL_PAGE_EVENT = 'beanpool:bell';

/** The count on the bell: never more than "99+". */
export function bellBadge(unseen: number): string {
    return unseen > 99 ? '99+' : String(Math.max(0, Math.floor(unseen)));
}

/** The bell's name for a screen reader, with what it holds. */
export function bellLabel(unseen: number, needs: number): string {
    if (unseen > 0) return tn(unseen, 'Notifications: {n} new', 'Notifications: {n} new');
    if (needs > 0) return tn(needs, 'Notifications: {n} thing needs you', 'Notifications: {n} things need you');
    return t('Notifications');
}

/** A well-formed row from the server's answer, or null: the sheet shows only what it can read. */
export function asBellNotice(raw: unknown): BellNotice | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.kind !== 'string' || typeof r.title !== 'string' || typeof r.body !== 'string'
        || typeof r.sentAt !== 'number') return null;
    const data = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data as Record<string, unknown> : {};
    return { id: r.id, kind: r.kind, title: r.title, body: r.body, data, sentAt: r.sentAt, seenAt: typeof r.seenAt === 'number' ? r.seenAt : null };
}

/** The unseen rows of an answer, newest first. */
export function unseenBellNotices(answer: unknown): BellNotice[] {
    const list = answer && typeof answer === 'object' && Array.isArray((answer as { notices?: unknown }).notices)
        ? (answer as { notices: unknown[] }).notices : [];
    return list.map(asBellNotice).filter((n): n is BellNotice => !!n && n.seenAt === null).sort((a, b) => b.sentAt - a.sentAt);
}

/** The rows left once these ids are marked: a tap, or the server's `push_notices_seen`. */
export function withoutBellNotices(list: readonly BellNotice[], ids: readonly unknown[]): BellNotice[] {
    const gone = new Set(ids.filter((id): id is string => typeof id === 'string'));
    return gone.size === 0 ? [...list] : list.filter(n => !gone.has(n.id));
}
