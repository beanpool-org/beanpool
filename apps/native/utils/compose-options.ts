/**
 * The one way to post: the Market tab's + and the map's + open the SAME chooser, and this module is the
 * single source of truth for what that chooser offers.
 *
 * It lived inline in the Market tab, which is why the map's + still opened an Offer/Need-only sheet: two
 * entry points, two lists, and only one of them knew about polls and events. The list and the routing are
 * here, free of React Native imports, so vitest can hold both screens to the same four options.
 */

export type ComposePostType = 'offer' | 'need' | 'poll' | 'event';

/**
 * Which form a choice opens:
 * - `offer-need-form` — the map's own New Post sheet, with the type preselected
 * - `poll-modal` — NewPollModal
 * - `event-modal` — NewEventModal
 */
export type ComposeTarget = 'offer-need-form' | 'poll-modal' | 'event-modal';

export interface ComposeOption {
    id: ComposePostType;
    emoji: string;
    title: string;
    description: string;
}

/**
 * All four choices, in the order they are shown. The wording is the Market tab's, kept verbatim so the two
 * entry points read identically — a member who learns the list on one tab recognises it on the other.
 */
export const NEW_POST_TYPES: readonly ComposeOption[] = [
    {
        id: 'offer',
        emoji: '📦',
        title: 'Offer',
        description: 'List goods, skills, food, or tools on the map',
    },
    {
        id: 'need',
        emoji: '❤️',
        title: 'Need',
        description: 'Ask your neighbours for something you need',
    },
    {
        id: 'poll',
        emoji: '🗳️',
        title: 'Community Poll',
        description: 'Ask a question with 2–4 options in the feed',
    },
    {
        id: 'event',
        // Not 📅: Android draws that emoji with a date printed on it ("JUL 17"), which reads as the event's.
        emoji: '👥',
        title: 'Event',
        description: 'A gathering with a time and a place',
    },
] as const;

/** "Offer: List goods, skills, food, or tools on the map" — the row's screen-reader label. */
export function composeOptionA11yLabel(option: ComposeOption): string {
    return `${option.title}: ${option.description}`;
}

export function composeTargetFor(type: ComposePostType): ComposeTarget {
    if (type === 'poll') return 'poll-modal';
    if (type === 'event') return 'event-modal';
    return 'offer-need-form';
}

/**
 * Whether a pin the member has already dropped on the map carries into this form as the location. An Offer,
 * a Need and an Event all live at a place; a poll stays in the list and simply has no pin (maintainer's
 * decision, 2026-09-18), so it is offered on the map too but never inherits one.
 */
export function composeCarriesPin(type: ComposePostType): boolean {
    return type !== 'poll';
}

/**
 * What the map should open for a `?newPost=` deep link.
 *
 * `newPost=true` is the long-standing link the Market tab uses, and it opens the chooser. A named type
 * opens that form directly — which is what stops the Market tab's own Offer and Need rows from bouncing
 * the member into a second chooser, and what fixes those rows having silently dropped the type they chose
 * (both pushed a bare `newPost=true`, so choosing Need opened the form on Offer).
 */
export function parseNewPostParam(value: string | undefined | null): 'chooser' | ComposePostType | null {
    if (!value) return null;
    if (value === 'true') return 'chooser';
    const match = NEW_POST_TYPES.find(o => o.id === value);
    return match ? match.id : null;
}
