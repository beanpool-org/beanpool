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
    /** The Find card's button, beside "Tell me when one starts here". */
    help: word("I'd help start one here"),
    helpA11y: word("I'd help start a community near here"),
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
    /** What a phone's own knock says when a community it was waiting for starts. */
    knockMessage: word('I asked to be told when a community started here.'),
} as const;

/** A group's name as a member reads it: a circle's in their language, any other group's as its members wrote it. */
export function groupNameShown(group: { name: string; kind?: string | null }): string {
    return group.kind === GROUP_KIND_CIRCLE ? t(PLACE_CIRCLE_WORDS.name) : group.name;
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
