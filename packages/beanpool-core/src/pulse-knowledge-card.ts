/**
 * Local knowledge's card on the Pulse, what it draws (slice KP, apps; DESIGN-local-knowledge-amend-fable.md §2.12, §3.8): the
 * lines one feed item gives, in the words of PULSE_KNOWLEDGE_WORDS (the one table both apps read), and how a list read page by
 * page keeps one card a day.
 *
 * - One page: head "New local knowledge", the page's topic as the chip, a row (title, first line, "by {name}" on a page a
 *   member wrote). The head and the row are one tap to the page. Spoken: "New local knowledge: {title}. Opens it in Learn."
 * - Several the same day: head "{n} new in Local knowledge", one tap to Learn, spoken "{n} new in Local knowledge. Opens
 *   Learn."; the first three as rows, each to its page, spoken "Local knowledge: {title}"; "and {n} more ›" to Learn, spoken
 *   "{n} more in Learn". No chip and no name.
 * - Foot "Open Learn ›", spoken "Open Learn". No face, no profile, no ⚑, no Hide: there is no Pulse item behind the card.
 *
 * Pure and universal.
 */
import { PULSE_KNOWLEDGE_ROWS, type PulseKnowledgeCard, type PulseKnowledgePost } from './knowledge.js';
import { PULSE_KNOWLEDGE_WORDS as W } from './pulse-knowledge-words.js';
import { formatCount, t as activeT, tn as activeTn, type Words } from './words.js';

/** A thing to tap: what it shows and what a screen reader says for it. */
export interface PulseKnowledgeTap {
    text: string;
    spoken: string;
}

/** What a card draws, worked out once so both apps draw the same thing (the words already in the reader's language). */
export interface PulseKnowledgeCardLines {
    /** One page that day (the head and its row are one tap to the page) or several (the head is a tap to Learn). */
    single: boolean;
    /** The head's words, and what a screen reader says for the tap the head is part of. */
    head: PulseKnowledgeTap;
    /** The rows, newest first, at most PULSE_KNOWLEDGE_ROWS; `spoken` for a row of several (one page: the head's). */
    rows: { post: PulseKnowledgePost; spoken: string }[];
    /** The topic chip right of the head: the one page's topic id; null on a card with several. */
    topic: string | null;
    /** "by Ada": the one page a member wrote, or null. */
    by: string | null;
    /** "and 5 more ›": the day's pages past the rows, or null. */
    more: PulseKnowledgeTap | null;
    /** "Open Learn ›". */
    foot: PulseKnowledgeTap;
}

/** The card's lines, or null when the item carries no page to show (an app never draws an empty card). */
export function pulseKnowledgeCardLines(
    card: PulseKnowledgeCard,
    words: Pick<Words, 't' | 'tn'> = { t: activeT, tn: activeTn },
): PulseKnowledgeCardLines | null {
    const posts = Array.isArray(card?.knowledge?.posts) ? card.knowledge.posts : [];
    const shown = posts.slice(0, PULSE_KNOWLEDGE_ROWS);
    if (shown.length === 0) return null;
    const count = Math.max(Number.isFinite(card.knowledge.count) ? Math.floor(card.knowledge.count) : 0, posts.length);
    const foot = { text: words.t(W.openLearn), spoken: words.t(W.openLearnSpoken) };
    if (count <= 1) {
        const page = shown[0];
        const name = !page.gathered && typeof page.by === 'string' ? page.by.trim() : '';
        const spoken = words.t(W.spokenOne, { title: page.title });
        return {
            single: true,
            head: { text: words.t(W.head), spoken },
            rows: [{ post: page, spoken }],
            topic: page.topic || null,
            by: name ? words.t(W.by, { name }) : null,
            more: null,
            foot,
        };
    }
    const rest = count - shown.length;
    return {
        single: false,
        head: {
            text: words.tn(count, W.headMany.one, W.headMany.other, { n: formatCount(count) }),
            spoken: words.tn(count, W.spokenMany.one, W.spokenMany.other, { n: formatCount(count) }),
        },
        rows: shown.map((post) => ({ post, spoken: words.t(W.rowSpoken, { title: post.title }) })),
        topic: null,
        by: null,
        more: rest > 0
            ? { text: words.tn(rest, W.more.one, W.more.other, { n: formatCount(rest) }), spoken: words.tn(rest, W.moreSpoken.one, W.moreSpoken.other, { n: formatCount(rest) }) }
            : null,
        foot,
    };
}

/**
 * The next page of the Pulse feed added to the items a list already shows (the KP node review note), as the phone's
 * utils/pulse.ts mergePulsePage does. A day's knowledge card is worked out at each read, so it can move between two reads: a
 * takedown moves it older and a later page carries the same `know_<day>` id again; a page published today moves it newer, out
 * of a scroll already past it (the list keeps its copy until a refresh). So an id the list already holds is not added twice:
 * the page's copy replaces the one shown, where it stands. The newest copy wins (a taken-down page's title leaves the card),
 * and it keeps the place the member already scrolled past, so nothing above them jumps. One id is one day, so a list never
 * holds two cards for one day. A creator's item that comes again is the same item. Neither list is changed.
 */
export function mergePulseFeedPages<T extends { id: string }>(shown: readonly T[], next: readonly T[]): T[] {
    const out = [...shown];
    const at = new Map(out.map((item, i) => [item.id, i]));
    for (const item of next) {
        const i = at.get(item.id);
        if (i === undefined) {
            at.set(item.id, out.length);
            out.push(item);
        } else {
            out[i] = item;
        }
    }
    return out;
}
