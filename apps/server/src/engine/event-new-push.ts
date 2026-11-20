/**
 * "There is a new event in your community." (`event.new`; scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md
 * §9 question 6, §12.3 slice NEa. Marty, 21 Nov 2026, "yes all ten": small and capped, at most one a day, its own switch,
 * on by default.) Built on the model of the push when a neighbour asks (engine/asked-push.ts).
 *
 * When someone posts an event for the whole community, its members are told, with the push kind `event.new`. Its words
 * are fixed (@beanpool/core push-notice.ts): no title, no host, no place, no time, so a lock screen anyone reads shows
 * nothing of the event. A tap opens the event through the notice's details, which only the recipient reads
 * (engine/push-notices.ts) and which hold the event's id and nothing else.
 *
 * Which events and whom are core's rules (@beanpool/core new-event-push.ts: newEventSilence, newEventRecipientRefusal),
 * read here from this server's own tables:
 *  - the event as stored, read back by its id after createPost made it: its type, status, audience, whether it is a copy
 *    (`shown_from_host`, `origin_node`) or an owner's assistant's (`created_via`), whether it is hidden (`active` 0, or
 *    hidden by reports), and when it is over (its end, or its start when it has none); and the community's profile;
 *  - each member's row: status, a visitor's row, an enterprise's account; holiday mode; their `notify_new_events` and
 *    `notify_marketplace`; a block either way with the host or the member who posted it for an enterprise; a phone
 *    (push_tokens) or a browser with notifications on (web_push_subscriptions, a member's) here; and when they were last
 *    told of a new event.
 *
 * The daily cap is a stamp per recipient, kept with their preferences ({@link NEW_EVENT_PUSH_STAMP_KEY}, whole seconds),
 * written for everyone chosen in the same transaction that chose them and before anything is sent: two events at once
 * never both reach one member, and a send that fails costs that member a push, never adds one. Not a setting: no app can
 * send it (setMemberPreferences refuses any key it doesn't name), nobody is served it, and it goes with the member's other
 * preferences on a re-key or a deletion. Not the notices kept for the recipient (push_notices): those are thinned to a
 * member's newest hundred.
 */
import {
    NEW_EVENT_PUSH_PREF, newEventRecipientRefusal, newEventSilence, pushNoticeWords, type NewEventFacts, type PushNoticeKind,
} from '@beanpool/core';
import { db } from '../db/db.js';
import { getNodeProfile } from '../config/node-profile.js';
import { getNodeRole } from '../config/node-role.js';
import { blockersOf, listBlocks } from './member-blocks.js';

/** When this member was last told of a new event, in whole seconds: the daily cap. Written here alone. */
export const NEW_EVENT_PUSH_STAMP_KEY = 'event_new_push.sentAt';

type PushFn = (
    targetPubkeys: string[], actorPubkey: string, title: string, body: string, data: Record<string, any>,
    categoryId: 'marketplace', kind: PushNoticeKind,
) => number;

/** A new post, as createPost made it: its id, and who posted it. */
export interface NewEventPost {
    id: string;
    /** The account it is posted under: a member's, or an enterprise's. */
    author: string;
    /** The member who posted it for an enterprise, when one did. */
    actor?: string | null;
    /** Made from a member's copy of an event in another community (engine/event-copy.ts), whatever the row says. */
    copied?: boolean;
}

interface StoredEvent {
    type: string;
    status: string | null;
    audience_scope: string | null;
    created_via: string | null;
    hidden_by_reports_at: string | null;
    active: number | null;
    shown_from_host: string | null;
    origin_node: string | null;
    event_start_at: string | null;
    event_end_at: string | null;
}

/** When a stored time is, in milliseconds; null when it can't be read. */
function whenMs(stored: string | null): number | null {
    if (!stored) return null;
    const ms = Date.parse(stored);
    return Number.isFinite(ms) ? ms : null;
}

/** The facts core's newEventSilence reads, from the event as stored; null when there is no such post. */
export function storedEventFacts(post: NewEventPost): NewEventFacts | null {
    const row = db.prepare(`
        SELECT type, status, audience_scope, created_via, hidden_by_reports_at, active, shown_from_host, origin_node, event_start_at, event_end_at
        FROM posts WHERE id = ?
    `).get(post.id) as StoredEvent | undefined;
    if (!row) return null;
    return {
        type: row.type,
        status: row.status,
        audienceScope: row.audience_scope,
        copied: !!post.copied || !!row.shown_from_host || !!row.origin_node,
        createdVia: row.created_via,
        hidden: row.active === 0 || !!row.hidden_by_reports_at,
        overAtMs: whenMs(row.event_end_at) ?? whenMs(row.event_start_at),
    };
}

/** The members to tell of this new event, with nothing stamped and nothing sent (the module's header). Reads only. */
export function newEventRecipients(post: NewEventPost, now: number = Math.floor(Date.now() / 1000)): string[] {
    const rows = db.prepare(`
        SELECT m.public_key AS pk, m.status AS status, COALESCE(m.is_visitor, 0) AS visitor, COALESCE(m.is_treasury, 0) AS treasury,
               holiday.pref_value AS holiday, own.pref_value AS own, mkt.pref_value AS mkt, told.pref_value AS told,
               (EXISTS (SELECT 1 FROM push_tokens pt WHERE pt.public_key = m.public_key)
                OR EXISTS (SELECT 1 FROM web_push_subscriptions wp WHERE wp.public_key = m.public_key AND wp.kind = 'member')) AS reachable
        FROM members m
        LEFT JOIN member_preferences holiday ON holiday.public_key = m.public_key AND holiday.pref_key = 'holiday_mode'
        LEFT JOIN member_preferences own ON own.public_key = m.public_key AND own.pref_key = ?
        LEFT JOIN member_preferences mkt ON mkt.public_key = m.public_key AND mkt.pref_key = 'notify_marketplace'
        LEFT JOIN member_preferences told ON told.public_key = m.public_key AND told.pref_key = ?
    `).all(NEW_EVENT_PUSH_PREF, NEW_EVENT_PUSH_STAMP_KEY) as {
        pk: string; status: string | null; visitor: number; treasury: number; holiday: string | null;
        own: string | null; mkt: string | null; told: string | null; reachable: number;
    }[];
    const posters = [...new Set([post.author, post.actor].filter((k): k is string => typeof k === 'string' && k !== ''))];
    // Both ways: whoever blocked the host (or the member who posted it), and whoever they blocked. Read once, not per member.
    const blocked = new Set(posters.flatMap(k => [...blockersOf(k), ...listBlocks(k).map(b => b.publicKey)]));
    const chosen: string[] = [];
    for (const r of rows) {
        const told = r.told != null && /^\d+$/.test(r.told) ? Number(r.told) : null;
        const refusal = newEventRecipientRefusal({
            host: posters.includes(r.pk),
            status: r.status,
            visitor: r.visitor === 1,
            enterprise: r.treasury === 1,
            onHoliday: r.holiday === 'true',
            blocked: blocked.has(r.pk),
            newEventsSwitch: r.own,
            marketplaceSwitch: r.mkt,
            reachable: r.reachable === 1,
            lastToldAt: told,
        }, now);
        if (refusal === null) chosen.push(r.pk);
    }
    return chosen;
}

/**
 * Tells the community of this new event (the module's header): reads it back as stored, chooses whom and stamps each in
 * one transaction, then hands them to the dispatcher. Answers how many were chosen. A standby sends nothing and stamps
 * nothing. Never throws: an event is posted whatever happens here.
 */
export function noticeNewEvent(post: NewEventPost, push: PushFn, now: number = Math.floor(Date.now() / 1000)): number {
    try {
        if (getNodeRole() === 'backup') return 0;
        const facts = storedEventFacts(post);
        if (!facts || newEventSilence(facts, getNodeProfile(), now * 1000) !== null) return 0;
        const stamp = db.prepare('INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?)');
        const chosen = db.transaction(() => {
            const pks = newEventRecipients(post, now);
            for (const pk of pks) stamp.run(pk, NEW_EVENT_PUSH_STAMP_KEY, String(now));
            return pks;
        })();
        if (chosen.length === 0) return 0;
        const { title, body } = pushNoticeWords('event.new');
        // The details hold where a tap lands and nothing else: no title, no host, no place, no time.
        push(chosen, post.actor || post.author, title, body, { screen: 'post', postId: post.id }, 'marketplace', 'event.new');
        // A count only: who was told stays out of the log.
        console.log(`[Push] A new event told ${chosen.length} member(s)`);
        return chosen.length;
    } catch (e: any) {
        console.warn('[Push] Could not tell the community of a new event:', e?.message || e);
        return 0;
    }
}
