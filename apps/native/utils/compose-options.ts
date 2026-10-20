/**
 * The one way to post: the Market tab's + and the map's + open the SAME chooser, and this module is the
 * single source of truth for what that chooser offers.
 *
 * It lived inline in the Market tab, which is why the map's + still opened an Offer/Need-only sheet: two
 * entry points, two lists, and only one of them knew about polls and events. The list and the routing are
 * here, free of React Native imports, so vitest can hold both screens to the same four options.
 */

import { t, word, type WordKey } from '@beanpool/core';

export type ComposePostType = 'offer' | 'need' | 'poll' | 'event';

/**
 * Which form a choice opens:
 * - `offer-need-form` — the map's own New Post sheet, with the type preselected
 * - `poll-modal` — NewPollModal
 * - `event-modal` — NewEventModal
 */
export type ComposeTarget = 'offer-need-form' | 'poll-modal' | 'event-modal';

/** The words are word() keys: the chooser shows them through t(), in the member's language. */
export interface ComposeOption {
    id: ComposePostType;
    emoji: string;
    title: WordKey;
    description: WordKey;
}

/**
 * All four choices, in the order they are shown. The wording is the Market tab's, kept verbatim so the two
 * entry points read identically — a member who learns the list on one tab recognises it on the other.
 */
export const NEW_POST_TYPES: readonly ComposeOption[] = [
    {
        id: 'offer',
        emoji: '📦',
        title: word('Offer'),
        description: word('List goods, skills, food, or tools on the map'),
    },
    {
        id: 'need',
        emoji: '❤️',
        title: word('Need'),
        description: word('Ask your neighbours for something you need'),
    },
    {
        id: 'poll',
        emoji: '🗳️',
        title: word('Community Poll'),
        description: word('Ask a question with 2–4 options in the feed'),
    },
    {
        id: 'event',
        // Not 📅: Android draws that emoji with a date printed on it ("JUL 17"), which reads as the event's.
        emoji: '👥',
        title: word('Event'),
        description: word('A gathering with a time and a place'),
    },
] as const;

/** "Offer: List goods, skills, food, or tools on the map" — the row's screen-reader label. */
export function composeOptionA11yLabel(option: ComposeOption): string {
    return t('{title}: {description}', { title: t(option.title), description: t(option.description) });
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

/**
 * Whether a draft in storage was written by a tool door (source: 'tool' and a non-empty tool id).
 * Set only by the tool host's doors (apps/native/tools/doors.ts).
 */
export function isToolDraft(draft: unknown): boolean {
    if (!draft || typeof draft !== 'object') return false;
    const d = draft as Record<string, unknown>;
    const tool = d.tool ?? d.toolId;
    return d.source === 'tool' && typeof tool === 'string' && tool.trim().length > 0;
}

/**
 * Strip the tool marker from a draft so that subsequent opens ask "Unfinished post?"
 * as a member's own draft would.
 */
export function clearDraftToolMarker<T extends Record<string, unknown>>(draft: T): T {
    const next = { ...draft };
    delete next.source;
    delete next.tool;
    delete next.toolId;
    return next;
}

/**
 * Whether a draft is restorable on the current community (has matching anchorUrl and some content).
 */
export function isRestorableDraft(draft: unknown, anchorUrl: string | null): boolean {
    if (!draft || typeof draft !== 'object') return false;
    const d = draft as Record<string, unknown>;
    if (d.anchorUrl !== anchorUrl) return false;
    const title = typeof d.postTitle === 'string' ? d.postTitle.trim() : '';
    const desc = typeof d.postDescription === 'string' ? d.postDescription.trim() : '';
    const photos = Array.isArray(d.postPhotos) ? d.postPhotos.length : (d.postPhotos ? 1 : 0);
    return !!(title || desc || photos);
}

export type DraftOpenDecision = 'open-tool' | 'ask-unfinished' | 'start-fresh';

/**
 * What `openComposer` in map.tsx should do with a saved draft:
 * - `open-tool` — the draft came from a tool door, open it immediately without asking
 * - `ask-unfinished` — the draft is a member's unfinished post, ask whether to continue or start fresh
 * - `start-fresh` — no restorable draft for this community, start a fresh composer
 */
export function decideDraftOpen(draft: unknown, anchorUrl: string | null): DraftOpenDecision {
    if (!isRestorableDraft(draft, anchorUrl)) return 'start-fresh';
    if (isToolDraft(draft)) return 'open-tool';
    return 'ask-unfinished';
}

