/**
 * The words of Local knowledge's card on the Pulse, one table for both apps (slice KP; DESIGN-local-knowledge-amend-fable.md
 * §3.8). English is the key, the design's own sentences; each app shows them through t() (tn() for the counted ones) where it
 * draws the card, so the phone and the web say the same thing in the same order.
 *
 * One page: head "New local knowledge"; its row "by {name}" only where the node sent a name (a single page a member wrote).
 * Spoken: "New local knowledge: {title}. Opens it in Learn."
 * Several the same day: head "{n} new in Local knowledge"; the first three titles as rows; "and {n} more ›" to Learn.
 * Spoken: "{n} new in Local knowledge. Opens Learn."
 * The foot of both: "Open Learn ›". No ⚑ and no Hide: there is no item to hide or report (reported from inside the page).
 *
 * Pure and universal: words only.
 */
import { word, wordn } from './words.js';

export const PULSE_KNOWLEDGE_WORDS = Object.freeze({
    /** The head of a card with one page. */
    head: word('New local knowledge'),
    /** The head of a card with several pages from the same day. */
    headMany: wordn('{n} new in Local knowledge', '{n} new in Local knowledge'),
    /** Under a single page a member wrote: the writer's name, as plain words (no profile to open). */
    by: word('by {name}'),
    /** After the first three rows of a day with more: the rest are in Learn. */
    more: wordn('and {n} more ›', 'and {n} more ›'),
    /** What a screen reader says for "and {n} more ›". */
    moreSpoken: wordn('{n} more in Learn', '{n} more in Learn'),
    /** The foot of every knowledge card. */
    openLearn: word('Open Learn ›'),
    /** What a screen reader says for the foot. */
    openLearnSpoken: word('Open Learn'),
    /** A card with one page, spoken: the whole card opens that page. */
    spokenOne: word('New local knowledge: {title}. Opens it in Learn.'),
    /** A card with several, spoken: its head opens Learn. */
    spokenMany: wordn('{n} new in Local knowledge. Opens Learn.', '{n} new in Local knowledge. Opens Learn.'),
    /** One row of several, spoken: it opens that page. */
    rowSpoken: word('Local knowledge: {title}'),
});
