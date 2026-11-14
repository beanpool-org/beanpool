/**
 * Local knowledge's card on the Pulse, for both apps (slice KP, apps; DESIGN-local-knowledge-amend-fable.md §2.12, §3.8):
 * the words it says, what it draws from one feed item, and how a list read page by page keeps one card a day.
 *
 * - One page: head "New local knowledge", the page's topic as the chip, a row (title, first line, "by {name}" on a page a
 *   member wrote). Spoken: "New local knowledge: {title}. Opens it in Learn."
 * - Several the same day: head "{n} new in Local knowledge", the first three as rows (each opens its page), "and {n} more ›"
 *   to Learn, no chip and no name. Spoken: "{n} new in Local knowledge. Opens Learn."
 * - Foot "Open Learn ›". No face, no profile, no ⚑, no Hide: there is no Pulse item behind the card.
 *
 * English is the key; each app shows these through t() / tn() where it draws them, so the phone and the web say the same
 * thing in the same order. Pure and universal.
 */
import { PULSE_KNOWLEDGE_ID_PREFIX, PULSE_KNOWLEDGE_ROWS, type PulseKnowledgeCard, type PulseKnowledgePost } from './knowledge.js';
import { t as activeT, tn as activeTn, word, wordn, type Words } from './words.js';

export const PULSE_KNOWLEDGE_CARD_WORDS = Object.freeze({
    /** The head on a card with one page. */
    headOne: word('New local knowledge'),
    /** The head on a card with several the same day (two or more: English has one form; others may need theirs). */
    headMany: wordn('{n} new in Local knowledge', '{n} new in Local knowledge'),
    /** A screen reader's line for the one page's row: the row opens the page in Learn. */
    spokenOne: word('New local knowledge: {title}. Opens it in Learn.'),
    /** A screen reader's line for a card with several: it opens Learn. */
    spokenMany: wordn('{n} new in Local knowledge. Opens Learn.', '{n} new in Local knowledge. Opens Learn.'),
    /** Under the one page a member wrote; never when gathered with the assistant, never when grouped. */
    by: word('by {name}'),
    /** After the first three rows, to Learn: the pages left over. The app draws " ›" after it, outside the words. */
    more: wordn('and {n} more', 'and {n} more'),
    /** The foot, to Learn. The app draws " ›" after it, outside the words. */
    openLearn: word('Open Learn'),
});

/** What a card draws, worked out once so both apps draw the same thing (the words already in the reader's language). */
export interface PulseKnowledgeCardLines {
    /** One page that day (its row carries the spoken line) or several (the card's foot carries it). */
    single: boolean;
    head: string;
    spoken: string;
    /** The rows, newest first, at most PULSE_KNOWLEDGE_ROWS. */
    rows: PulseKnowledgePost[];
    /** The topic chip right of the head: the one page's topic id; null on a card with several. */
    topic: string | null;
    /** "by Ada": the one page a member wrote, or null. */
    by: string | null;
    /** "and 5 more": the day's pages past the rows, or null. */
    more: string | null;
}

/** The card's lines, or null when the item carries no page to show (an app never draws an empty card). */
export function pulseKnowledgeCardLines(
    card: PulseKnowledgeCard,
    words: Pick<Words, 't' | 'tn'> = { t: activeT, tn: activeTn },
): PulseKnowledgeCardLines | null {
    const posts = Array.isArray(card?.knowledge?.posts) ? card.knowledge.posts : [];
    const rows = posts.slice(0, PULSE_KNOWLEDGE_ROWS);
    if (rows.length === 0) return null;
    const count = Math.max(Number.isFinite(card.knowledge.count) ? Math.floor(card.knowledge.count) : 0, posts.length);
    const W = PULSE_KNOWLEDGE_CARD_WORDS;
    if (count <= 1) {
        const page = rows[0];
        const name = !page.gathered && typeof page.by === 'string' ? page.by.trim() : '';
        return {
            single: true,
            head: words.t(W.headOne),
            spoken: words.t(W.spokenOne, { title: page.title }),
            rows,
            topic: page.topic || null,
            by: name ? words.t(W.by, { name }) : null,
            more: null,
        };
    }
    const rest = count - rows.length;
    return {
        single: false,
        head: words.tn(count, W.headMany.one, W.headMany.other, { n: count }),
        spoken: words.tn(count, W.spokenMany.one, W.spokenMany.other, { n: count }),
        rows,
        topic: null,
        by: null,
        more: rest > 0 ? words.tn(rest, W.more.one, W.more.other, { n: rest }) : null,
    };
}

/** Whether a feed item's id is a knowledge card's (`know_<local date>`): one id a day. */
export function isPulseKnowledgeId(id: unknown): boolean {
    return typeof id === 'string' && id.startsWith(PULSE_KNOWLEDGE_ID_PREFIX);
}

/**
 * The next page of the Pulse feed added to the items a list already shows (the KP node review note). A day's knowledge card
 * is worked out at each read, so it can move between two reads: a newer page that day moves it up, a takedown moves it older
 * and onto a later page. So a knowledge card the next page carries replaces the copy already shown (the newest copy wins, in
 * the place the newer read gives it), and a list never holds two cards for one day. A creator's item a page repeats keeps
 * the place it already has. Neither list is changed.
 */
export function mergePulseFeedPages<T extends { id: string }>(shown: readonly T[], next: readonly T[]): T[] {
    const moved = new Set(next.filter((i) => isPulseKnowledgeId(i.id)).map((i) => i.id));
    const out = shown.filter((i) => !moved.has(i.id));
    const seen = new Set(out.map((i) => i.id));
    for (const item of next) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
    }
    return out;
}
