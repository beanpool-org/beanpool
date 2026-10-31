/**
 * The place circle (Lounge L2 with doors S8, scratch/fable-design/DESIGN-global-lounge-fable.md §3.3): people waiting for a
 * community in the same place, put in one group once three of them said they'd help start one. One definition of its
 * words and its counts for the server and both apps. The rule the counts live by: nobody is ever told a number below
 * {@link CIRCLE_MIN_PEOPLE}, and what is told is never a place (the server's engine/place-circles.ts says why).
 */

import { t, tn, word } from './words.js';

/** The fewest people a circle is made for, and the smallest number any count here says. */
export const CIRCLE_MIN_PEOPLE = 3;

/** A group's `kind` when the node made it as a place circle. */
export const GROUP_KIND_CIRCLE = 'circle';

/** How many people are waiting near a point, each null below {@link CIRCLE_MIN_PEOPLE}. */
export interface CircleDemand {
    /** People with a place watch there. */
    waiting: number | null;
    /** Those of them who said they'd help start one. */
    helping: number | null;
}

/** The community that retired a circle, as the directory has it now: the card's line and where a knock goes. */
export interface CircleCommunity {
    key: string;
    name: string | null;
    url: string | null;
    /** False when it takes no requests to join (its door is its admins'). */
    acceptingKnocks: boolean | null;
}

/** What a member of a circle reads about it (GET /api/groups/:id `circle`, the Find card's `circle`). */
export interface CircleCard {
    /** The circle's own count; null below {@link CIRCLE_MIN_PEOPLE}. */
    people: number | null;
    /** Who said "I'm starting one here": this member, someone else in it, or nobody. */
    starting: 'you' | 'someone' | null;
    /** When a listed community retired it, or null while it is still waiting for one. */
    doneAt: string | null;
    /** That community while it is still listed, or null. */
    community: CircleCommunity | null;
}

export const PLACE_CIRCLE_WORDS = {
    /** The group's name and purpose. Stored in English on the row; both apps show them through t() by `kind`. */
    name: word('Starting a community near you'),
    purpose: word("People within about 25 km who said they'd help start a community here. Say hello, meet in a public place first, and when one of you runs a server, everyone here is told."),
    /**
     * The Find card's button, beside "Tell me when one starts here". It has no spoken name of its own: someone using voice
     * control says what they see, so what is said must hold these words, in every language (WCAG 2.5.3).
     */
    help: word("I'd help start one here"),
    helpDone: word("Thanks. When three of you are near each other, you'll be introduced."),
    /** The circle's own rows. */
    starting: word("I'm starting one here"),
    notStarting: word("I'm not starting one after all"),
    someoneStarting: word('Someone is starting a community near you.'),
    youAreStarting: word("You said you're starting one here."),
    joinWhenStarts: word('Join when it starts'),
    joinWhenStartsOn: word('Your app will ask to join when it starts. Tap to stop.'),
    meetThem: word('Meet them ›'),
    /** How a circle ends. */
    startedNear: word('A community has started near you: {name}.'),
    startedNearNoName: word('A community has started near you.'),
    done: word('This circle did its job. Its chat stays for 30 days.'),
    /** A finished circle's group, read-only for good: no vote closed it, so it must not say one did. */
    closed: word('This circle has finished. Its chat stays to read.'),
    /** What a phone's own knock says when a community it was waiting for starts. */
    knockMessage: word('I asked to be told when a community started here.'),
    /** "Join when it starts" when the knock didn't go: {@link circleKnockLine}. */
    knockLater: word("Your app couldn't ask to join yet. It will try again."),
    knockRefused: word("Your app couldn't ask to join for you. You can ask them yourself."),
} as const;

/** A group's name as a member reads it: a circle's in their language, any other group's as its members wrote it. */
export function groupNameShown(group: { name: string; kind?: string | null }): string {
    return group.kind === GROUP_KIND_CIRCLE ? t(PLACE_CIRCLE_WORDS.name) : group.name;
}

/**
 * What is said of a closed group: `byVote`, the words that place uses for any other group, or a circle's own. A vote closes
 * a group; a circle closes by itself 30 days after a community retires it, on a node that may have no votes at all.
 */
export function groupClosedShown(group: { kind?: string | null }, byVote: string): string {
    return group.kind === GROUP_KIND_CIRCLE ? t(PLACE_CIRCLE_WORDS.closed) : byVote;
}

/** A group's description as a member reads it, as {@link groupNameShown}. */
export function groupDescriptionShown(group: { description?: string | null; kind?: string | null }): string | undefined {
    return group.kind === GROUP_KIND_CIRCLE ? t(PLACE_CIRCLE_WORDS.purpose) : group.description ?? undefined;
}

/** A count as it may be said: a whole number from {@link CIRCLE_MIN_PEOPLE}, else nothing. */
export function shownCount(n: unknown): number | null {
    return typeof n === 'number' && Number.isInteger(n) && n >= CIRCLE_MIN_PEOPLE ? n : null;
}

/** A circle's own count: "{n} people here", or null below {@link CIRCLE_MIN_PEOPLE}. */
export function circlePeopleLine(n: unknown): string | null {
    const count = shownCount(n);
    return count === null ? null : tn(count, '{n} person here', '{n} people here', { n: count });
}

/** The Find card's line: who would help, else who is waiting, or null with nothing that may be said. */
export function circleDemandLine(demand: CircleDemand | null | undefined): string | null {
    const helping = shownCount(demand?.helping);
    if (helping !== null) return tn(helping, '{n} person near you would help start a community.', '{n} people near you would help start a community.', { n: helping });
    return circleWaitingLine(demand);
}

/** "{n} people near you are waiting for a community too", or null with nothing that may be said. */
export function circleWaitingLine(demand: CircleDemand | null | undefined): string | null {
    const waiting = shownCount(demand?.waiting);
    return waiting === null ? null : tn(waiting, '{n} person near you is waiting for a community too.', '{n} people near you are waiting for a community too.', { n: waiting });
}

/** The line a retired circle's card opens with. */
export function circleStartedLine(community: Pick<CircleCommunity, 'name'> | null | undefined): string {
    return community?.name ? t(PLACE_CIRCLE_WORDS.startedNear, { name: community.name }) : t(PLACE_CIRCLE_WORDS.startedNearNoName);
}

/** Whether a phone or browser holding "Join when it starts" should send its knock now: a live, reachable community that takes them. */
export function circleKnockReady(card: Pick<CircleCard, 'community'> | null | undefined): card is { community: CircleCommunity & { url: string } } {
    return !!card?.community?.url && card.community.acceptingKnocks !== false;
}

/** Why "Join when it starts" didn't go: `later` is kept for the next read, `refused` is the community's answer and final. */
export type CircleKnockTrouble = 'later' | 'refused';

/**
 * What a knock's answer means for the wish, or null when nothing went wrong (it went, or the person is already known there).
 * A 429 or a 5xx says nothing about this person: a proxy's 502, a 503 while a new server boots, a day's limit. A community
 * that has only just started is the one most likely to answer that way, so those stay for the next read. An address
 * that can't be used may be mended in the directory, and a retry of it costs nothing.
 */
export function circleKnockTrouble(sent: { kind: string; status?: number }): CircleKnockTrouble | null {
    if (sent.kind === 'unreachable' || sent.kind === 'no_address') return 'later';
    if (sent.kind !== 'refused') return null;
    return sent.status === 429 || (sent.status ?? 0) >= 500 ? 'later' : 'refused';
}

/** The retired card's line about a knock that didn't go, or null. */
export function circleKnockLine(trouble: CircleKnockTrouble | null | undefined): string | null {
    if (!trouble) return null;
    return t(trouble === 'later' ? PLACE_CIRCLE_WORDS.knockLater : PLACE_CIRCLE_WORDS.knockRefused);
}
