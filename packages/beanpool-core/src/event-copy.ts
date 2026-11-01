/**
 * A member's copy of an in-person event on the global community, as both apps read it (DESIGN-list-on-global-fable.md §6,
 * slice G2′; the node's half is apps/server engine/event-copy.ts). A copy names no author and takes no RSVP: what stands in
 * their place is where it is from and the way there, drawn from the directory row global holds, never from anyone's phone.
 */
import { COMMUNITY_CARD_WORDS } from './community-card.js';
import { t } from './words.js';

/** A copy's from-line and its door, as the node sends them on `shownFrom`. */
export interface ShownFromLine {
    host: string;
    postId: string | null;
    name: string;
    url: string;
    /** `ask`: the community takes requests to join. `invite`: new members come by invite. */
    door: 'ask' | 'invite';
}

/** Null for any other post. `from` is null where the directory shows no community for it: no line and no door. */
export interface EventCopy {
    from: ShownFromLine | null;
}

function fromLineOf(raw: unknown): ShownFromLine | null {
    const f = raw as Partial<ShownFromLine> | null | undefined;
    if (!f || typeof f.name !== 'string' || !f.name || typeof f.url !== 'string' || !f.url.startsWith('https://') || typeof f.host !== 'string') return null;
    return { host: f.host, postId: typeof f.postId === 'string' ? f.postId : null, name: f.name, url: f.url, door: f.door === 'invite' ? 'invite' : 'ask' };
}

/** What a post row says of being a copy: the node's own read (`shownCopy`, `shownFrom`), or the phone's cached column. */
export function eventCopyOf(post: { shownCopy?: unknown; shownFrom?: unknown; shown_from?: unknown } | null | undefined): EventCopy | null {
    if (post?.shownCopy === true) return { from: fromLineOf(post.shownFrom) };
    if (typeof post?.shown_from !== 'string' || !post.shown_from) return null;
    try {
        return { from: fromLineOf(JSON.parse(post.shown_from)) };
    } catch {
        return { from: null };
    }
}

/** A phone's cached column for a post from the node: the line, `{}` for a copy with none, null for any other post. */
export function eventCopyColumn(post: { shownCopy?: unknown; shownFrom?: unknown; shown_from?: unknown }): string | null {
    if (typeof post.shown_from === 'string') return post.shown_from;
    return post.shownCopy === true ? JSON.stringify(post.shownFrom ?? {}) : null;
}

/** "from Mullumbimby", in place of who hosts it. */
export function copyFromLine(from: ShownFromLine): string {
    return t('from {community}', { community: from.name });
}

/** A card's line: where it is from, and the door's word. */
export function copyCardLine(from: ShownFromLine): string {
    return t('{from} · {door}', { from: copyFromLine(from), door: from.door === 'invite' ? t(COMMUNITY_CARD_WORDS.invite) : t(COMMUNITY_CARD_WORDS.ask) });
}

/** Where the Going buttons would be. */
export function copyDoorLine(copy: EventCopy): string {
    if (!copy.from) return t('This event is run by another community, so you can\'t say you are going from here.');
    return copy.from.door === 'invite'
        ? t('To go, ask someone in {community}. It takes new members by invite.', { community: copy.from.name })
        : t('To go, ask to join {community}', { community: copy.from.name });
}

/** The words of the door's button, where there is one to press. */
export function copyDoorButton(copy: EventCopy): string | null {
    return copy.from?.door === 'ask' ? t('Ask to join {name}', { name: copy.from.name }) : null;
}
