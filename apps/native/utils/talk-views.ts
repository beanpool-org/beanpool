/**
 * Which view Talk and People start on, from the route's `view` param. The param outlives the landing that
 * set it (the header's unread landing sends view=messages), so each screen accepts only its own values and
 * falls back to its default rather than starting on a view it has no page for.
 */

export type TalkView = 'messages' | 'groups' | 'people';
export type PeopleView = 'friends' | 'community' | 'invites';

const PEOPLE_VIEWS: readonly string[] = ['friends', 'community', 'invites'];

export function isPeopleView(v: unknown): v is PeopleView {
    return typeof v === 'string' && PEOPLE_VIEWS.includes(v);
}

/**
 * Talk opens on Groups or People only when asked for it by name (groups decision 6: Messages | Groups | People);
 * anything else, including a stale value, is Messages.
 */
export function initialTalkView(param: unknown): TalkView {
    return param === 'people' || param === 'groups' ? param : 'messages';
}

/** People opens on the pill the param names, else on its default, Community. */
export function initialPeopleView(param: unknown): PeopleView {
    return isPeopleView(param) ? param : 'community';
}
