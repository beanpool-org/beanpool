/**
 * "There is a new event in your community." (`event.new`): which new events tell the community, and which members they
 * tell. scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md §9 question 6 and §12.3 slice NEa (Marty,
 * 21 Nov 2026, "yes all ten"): small and capped, at most one a day for each member, its own switch, on by default, and it
 * names nothing. Built on the model of the push when a neighbour asks (`market.asked`, the server's engine/asked-push.ts).
 *
 * The rules are here, pure, so the server that sends and the apps that explain it read one definition; the server
 * (engine/event-new-push.ts) gathers the facts from its own tables, asks these, stamps whom it chose and sends.
 *
 * Which events ({@link newEventSilence}): an event, live, for the whole community (never a group's own or one person's,
 * whose existence a push to others would tell), made here by a person's own hand (not a copy of an event from another
 * community, not an owner's assistant), not hidden, not already over, on a local community (the global community is
 * no one's neighbourhood: its members see events on Home and the map, never a buzz).
 *
 * Whom ({@link newEventRecipientRefusal}): a member here (status active; not a visitor's row, not an enterprise's
 * account), not on holiday, never its host nor the member who posted it for an enterprise, nobody with a block either
 * way between them and either of those, with this switch on and Marketplace Activity on (the category the push rides,
 * as every event push does), with a phone or a browser here that can be told, and told of no other new event in the
 * last {@link NEW_EVENT_PUSH_GAP_SECONDS}.
 */

/** The member's switch for this push (Settings → Notifications, slice NEb): on unless they turned it off. */
export const NEW_EVENT_PUSH_PREF = 'notify_new_events';
/** At most one `event.new` a member in this long, in seconds. */
export const NEW_EVENT_PUSH_GAP_SECONDS = 24 * 60 * 60;

/**
 * Whether a community sends `event.new` at all: a local one, never the global one. The server's own rule, which it says to
 * the apps as `features.newEventPush` (push-notice.ts newEventPushOn).
 */
export function newEventPushSent(profile: unknown): boolean {
    return profile === 'local';
}

/** What of a new post decides whether it tells the community. */
export interface NewEventFacts {
    type: string;
    status?: string | null;
    /** 'public' (or nothing) for the whole community; 'group' and 'direct' are for those they name. */
    audienceScope?: string | null;
    /** A copy of an event from another community (the server's engine/event-copy.ts), or a linked community's. */
    copied: boolean;
    /** `assistant:<grant id>` when an owner's assistant made it; nothing when a person did. */
    createdVia?: string | null;
    /** Taken off by reports (G3) or by a moderator. */
    hidden: boolean;
    /** When it is over, in milliseconds since 1970: its end, or its start when it has no end. Null or NaN: not known. */
    overAtMs: number | null;
}

/** Why a new post tells nobody; null when it tells the community. */
export type NewEventSilence =
    | 'not-an-event' | 'not-live' | 'not-for-everyone' | 'a-copy' | 'an-assistant' | 'hidden' | 'over' | 'not-local';

/**
 * Why this new post tells nobody, or null when it tells the community (the module's header). `profile`: the community's
 * (the server's getNodeProfile, 'local' or 'global'). `nowMs`: milliseconds since 1970. A time not known reads as over:
 * an event nobody can place in time is no news to buzz a whole community with.
 */
export function newEventSilence(event: NewEventFacts, profile: unknown, nowMs: number): NewEventSilence | null {
    if (event.type !== 'event') return 'not-an-event';
    if (event.status != null && event.status !== 'active') return 'not-live';
    if ((event.audienceScope ?? 'public') !== 'public') return 'not-for-everyone';
    if (event.copied) return 'a-copy';
    if (typeof event.createdVia === 'string' && event.createdVia !== '') return 'an-assistant';
    if (event.hidden) return 'hidden';
    if (event.overAtMs == null || !Number.isFinite(event.overAtMs) || event.overAtMs <= nowMs) return 'over';
    if (!newEventPushSent(profile)) return 'not-local';
    return null;
}

/** What of one member decides whether a new event tells them. */
export interface NewEventRecipientFacts {
    /** They are the event's host, or the member who posted it for an enterprise. */
    host: boolean;
    /** Their `members.status`. */
    status?: string | null;
    /** A visitor's row. */
    visitor: boolean;
    /** An enterprise's account. */
    enterprise: boolean;
    onHoliday: boolean;
    /** Their {@link NEW_EVENT_PUSH_PREF} as stored: 'false' is off; anything else, or never set, is on. */
    newEventsSwitch?: string | null;
    /** Their Marketplace Activity (`notify_marketplace`) as stored: the same reading. */
    marketplaceSwitch?: string | null;
    /** A block, either way, between them and the host or the member who posted it. */
    blocked: boolean;
    /** A phone, or a browser with notifications on, registered here. */
    reachable: boolean;
    /** When they were last told of a new event, in whole seconds since 1970; null for never. */
    lastToldAt: number | null;
}

/** Why a new event does not tell this member; null when it does. */
export type NewEventRecipientRefusal =
    | 'host' | 'not-active' | 'visitor' | 'enterprise' | 'on-holiday' | 'blocked'
    | 'switch-off' | 'marketplace-off' | 'no-device' | 'told-today';

/**
 * Why a new event (one {@link newEventSilence} lets through) does not tell this member, or null when it does (the
 * module's header). `nowSeconds`: whole seconds since 1970. A stamp from the future (a clock moved back) reads as told
 * today: the cap errs towards silence, never a second push.
 */
export function newEventRecipientRefusal(member: NewEventRecipientFacts, nowSeconds: number): NewEventRecipientRefusal | null {
    if (member.host) return 'host';
    if (member.status !== 'active') return 'not-active';
    if (member.visitor) return 'visitor';
    if (member.enterprise) return 'enterprise';
    if (member.onHoliday) return 'on-holiday';
    if (member.blocked) return 'blocked';
    if (member.newEventsSwitch === 'false') return 'switch-off';
    if (member.marketplaceSwitch === 'false') return 'marketplace-off';
    if (!member.reachable) return 'no-device';
    if (member.lastToldAt != null && nowSeconds - member.lastToldAt < NEW_EVENT_PUSH_GAP_SECONDS) return 'told-today';
    return null;
}
