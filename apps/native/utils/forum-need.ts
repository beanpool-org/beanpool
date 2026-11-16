/**
 * Make this a Need (slice F9 part 3, the phone; DESIGN-forums-fable.md §10.2): on their own topic, its writer taps Make this a
 * Need in the topic's ⋯. The Market's own Need form opens (app/new-listing.tsx) with the topic's title and opening words in
 * it, cut to the form's limits; the photo and everything else are asked for as on any Need, and every rule of the Market applies
 * there (Beans and Offer-first on a local community, no price on the worldwide one). Once posted, the Need is linked to the
 * topic (POST /api/forum/topics/:id/links, kind listing), the topic shows "Posted as a Need ›" and the listing "Talked about in
 * the forum". The forum moves nothing itself.
 *
 * The words travel in this module, not in the route (up to 5,000 characters), handed over once and taken once by the form that
 * names the same topic; a form opened any other way finds nothing here.
 */
import { LISTING_DESCRIPTION_LIMIT } from '@beanpool/core';

/** The phone's Need form's title field stops at 50 (app/new-listing.tsx maxLength). */
export const NEED_TITLE_MAX = 50;

export interface NeedSeed { topicId: string; title: string; words: string }

/** `s` cut to at most `max` UTF-16 units (what a field's maxLength counts), never through a character. */
export function cutTo(s: string, max: number): string {
    let out = '';
    for (const ch of Array.from(s)) {
        if (out.length + ch.length > max) break;
        out += ch;
    }
    return out;
}

/** What the Need form opens with, from a topic's title and opening words, cut to the form's limits. */
export function needSeedFrom(topicId: string, title: string, words: string): NeedSeed {
    return { topicId, title: cutTo(title.trim(), NEED_TITLE_MAX), words: cutTo(words.trim(), LISTING_DESCRIPTION_LIMIT.chars) };
}

let held: NeedSeed | null = null;
/** Hands the seed to the Need form about to open. */
export function handNeedSeed(seed: NeedSeed): void { held = seed; }
/** The seed for the form opened from topic `topicId`, once; any other form (or a second ask) gets nothing. */
export function takeNeedSeed(topicId: string | null | undefined): NeedSeed | null {
    if (!topicId || !held || held.topicId !== topicId) return null;
    const seed = held;
    held = null;
    return seed;
}

let linkedTopic: string | null = null;
/** The Need form linked a Need to topic `topicId` (or tried): the topic, shown again, reads itself again. */
export function noteNeedLinked(topicId: string): void { linkedTopic = topicId; }
/** Whether topic `topicId` should read itself again for that, once. */
export function takeNeedLinked(topicId: string): boolean {
    if (linkedTopic !== topicId) return false;
    linkedTopic = null;
    return true;
}

/**
 * Links the Need just posted to its topic. The Need stands whatever the answer: a refusal (the topic gone, three links already)
 * comes back as the node's sentence for the form to say; null when it is linked.
 */
export async function linkPostedNeed(topicId: string, listingId: string): Promise<string | null> {
    try {
        // Read when first needed: the Need form loads none of the forum's calls as it opens.
        await (await import('./forum')).linkForumTarget(topicId, 'listing', listingId);
        return null;
    } catch (e) {
        return (e as Error)?.message || '';
    }
}
