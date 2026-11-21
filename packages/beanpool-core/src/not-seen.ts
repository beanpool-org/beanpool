/**
 * "Not seen yet": the sender is told what the read tick already says, later and in words (DESIGN-notify-and-backup-asks-fable
 * §4.5; amendment 2 §12.3, slice N4).
 *
 *   Is the sourdough still going?            ✓
 *   Not seen yet.                                        after 24 hours
 *   Not seen in 3 days. You could try Sam another way.   after 3 days
 *
 * Worked out on the sender's own app from the tick (✓ / ✓✓, the other person's read cursor) and the times it already has.
 * Nothing new is asked of the node and nothing is sent. The same line whoever the other person is: it never reads their
 * settings (whether a phone can notify them, whether they turned notifications off), so it can't be used to test who has
 * notifications off, as a "they may be slow to see this" line would (an oracle, like the broadcast reach one, #1965).
 *
 * A deal request sits unseen the same way: still asked and unanswered, and the other person's read cursor in the one chat
 * the two of them share (the node keeps one DM per pair) is from before the request was made. Their chat shows the request
 * on its strip, so a cursor past the request's time is the request seen.
 *
 * Pure and universal: no Node built-ins, no Intl, no React; both apps load it.
 */

import { t, tn } from './words.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** "Not seen yet." from 24 hours after the line was sent. */
export const NOT_SEEN_AFTER_MS = 24 * HOUR_MS;
/** "Not seen in {n} days. You could try {name} another way." from 3 days after. */
export const NOT_SEEN_ANOTHER_WAY_AFTER_MS = 3 * DAY_MS;

/** What the sender is told: nothing, "Not seen yet.", or the days and the other way. */
export type NotSeen =
    | { state: 'none' }
    | { state: 'not-seen' }
    | { state: 'another-way'; days: number };

const NONE: NotSeen = Object.freeze({ state: 'none' });

/** A time as the node or the app wrote it (an ISO string or milliseconds); null for none or one that doesn't read. */
function msOf(at: string | number | null | undefined): number | null {
    if (typeof at === 'number') return Number.isFinite(at) ? at : null;
    if (typeof at !== 'string' || !at) return null;
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * One thing sent at `sentAt` that the other person has (`seen`) or hasn't seen, at `now`. A time that doesn't read, or one
 * still in the future on this clock, says nothing.
 */
export function notSeenOf(sentAt: string | number | null | undefined, seen: boolean, now: number): NotSeen {
    if (seen) return NONE;
    const sent = msOf(sentAt);
    if (sent == null || !Number.isFinite(now)) return NONE;
    const waited = now - sent;
    if (waited >= NOT_SEEN_ANOTHER_WAY_AFTER_MS) return { state: 'another-way', days: Math.floor(waited / DAY_MS) };
    if (waited >= NOT_SEEN_AFTER_MS) return { state: 'not-seen' };
    return NONE;
}

/** One line of a direct chat, as the rule reads it. */
export interface NotSeenLine {
    /** The reader's own line. */
    mine: boolean;
    /** The node's time for it. */
    at: string | number | null | undefined;
    /** Its tick has turned (✓✓): the other person's read cursor is at or past it. */
    seen: boolean;
    /** The node took it: not still sending, not failed (those have their own marks and were never delivered). */
    delivered: boolean;
    /**
     * A person's line. False for what is nobody's words or not a line at all: a notice of the app's own (the key changed),
     * a node's notice (a deal's step), a line shown as nobody's. Those are passed over.
     */
    counts: boolean;
}

/** The line that carries the words, by its index in the thread, and what they say. */
export interface NotSeenAt {
    index: number;
    notSeen: Exclude<NotSeen, { state: 'none' }>;
}

/**
 * Where in a direct chat (lines oldest first) the words go, and which: under the newest line of the reader's own that the
 * node took, when the other person has neither seen it nor written since. The time counted is that of the oldest of the
 * reader's lines still unseen since the other person's last line: they have waited that long. null: nothing to say.
 *
 * The other person writing after the reader's line ends it, whatever the cursor says: they were in the chat.
 */
export function notSeenInThread(lines: readonly NotSeenLine[], now: number): NotSeenAt | null {
    let index = -1;
    let oldest: number | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.counts) continue;
        if (!line.mine) break;
        if (!line.delivered) continue;
        if (line.seen) break;
        if (index < 0) index = i;
        const at = msOf(line.at);
        if (at != null) oldest = at;
    }
    if (index < 0 || oldest == null) return null;
    const notSeen = notSeenOf(oldest, false, now);
    return notSeen.state === 'none' ? null : { index, notSeen };
}

/** A deal request as the one who asked holds it. */
export interface NotSeenDeal {
    /** The reader asked and it is still waiting for the other person's answer (core dealStep's 'asked'). */
    asked: boolean;
    /** When the request was made (the node's time). */
    createdAt: string | number | null | undefined;
    /**
     * The two share a chat (the node keeps one DM per pair). Without one there is no tick to go by and the request is shown
     * on no chat of theirs: nothing is said.
     */
    chat: boolean;
    /** The other person's read cursor in that chat; null when they have never read it. */
    peerReadAt: string | number | null | undefined;
}

/** A deal request that sits unseen: still asked, and the other person hasn't been in the chat since it was made. */
export function notSeenOfDeal(deal: NotSeenDeal, now: number): NotSeen {
    if (!deal.asked || !deal.chat) return NONE;
    const made = msOf(deal.createdAt);
    const read = msOf(deal.peerReadAt);
    return notSeenOf(made, made != null && read != null && read >= made, now);
}

/**
 * The words, in the reader's language: "Not seen yet." or "Not seen in {n} days. You could try {name} another way."
 * `name`: the other person's, as the chat names them; without one, "them". null when there is nothing to say.
 */
export function notSeenWords(notSeen: NotSeen, name?: string | null): string | null {
    if (notSeen.state === 'none') return null;
    if (notSeen.state === 'not-seen') return t('Not seen yet.');
    const n = notSeen.days;
    const who = typeof name === 'string' ? name.trim() : '';
    return who
        ? tn(n, 'Not seen in {n} day. You could try {name} another way.', 'Not seen in {n} days. You could try {name} another way.', { name: who })
        : tn(n, 'Not seen in {n} day. You could try them another way.', 'Not seen in {n} days. You could try them another way.');
}
