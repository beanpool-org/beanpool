/**
 * A member's copy of an in-person event, an Offer or a Need on the global community, as both apps read it
 * (DESIGN-list-on-global-fable.md §6, slices G2′ and G1′; the node's half is apps/server engine/event-copy.ts). A copy names no
 * author, takes no RSVP and no deal: what stands in their place is where it is from and the way there, drawn from the
 * directory row global holds, never from anyone's phone. An Offer's or Need's price is words and nothing else: `credits` is
 * 0, and only {@link copyPriceLine} reads it.
 */
import { COMMUNITY_CARD_WORDS } from './community-card.js';
import { t, tn } from './words.js';

/** A copy's from-line and its door, as the node sends them on `shownFrom`. */
export interface ShownFromLine {
    host: string;
    postId: string | null;
    name: string;
    url: string;
    /** `ask`: the community takes requests to join. `invite`: new members come by invite. */
    door: 'ask' | 'invite';
}

/** An Offer's or Need's price at home, as a listing's own price is: Beans, and what they are for. */
export interface CopyPrice {
    beans: number;
    per: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly';
}

/** Null for any other post. `from` is null where the directory shows no community for it: no line and no door. */
export interface EventCopy {
    from: ShownFromLine | null;
    /** An Offer's or Need's price at home; null on an event. */
    price?: CopyPrice | null;
}

/** How a price is kept and sent: '20 fixed'. */
export function copyPriceText(price: CopyPrice): string {
    return `${price.beans} ${price.per}`;
}

/** {@link copyPriceText} read back. Anything else is no price: a card says less, and says nothing false. */
export function copyPriceOf(raw: unknown): CopyPrice | null {
    const [beans, per, more] = typeof raw === 'string' ? raw.split(' ') : [];
    const n = Number(beans);
    if (more !== undefined || !beans || !Number.isFinite(n) || n < 0) return null;
    return per === 'fixed' || per === 'hourly' || per === 'daily' || per === 'weekly' || per === 'monthly' ? { beans: n, per } : null;
}

function fromLineOf(raw: unknown): ShownFromLine | null {
    const f = raw as Partial<ShownFromLine> | null | undefined;
    if (!f || typeof f.name !== 'string' || !f.name || typeof f.url !== 'string' || !f.url.startsWith('https://') || typeof f.host !== 'string') return null;
    return { host: f.host, postId: typeof f.postId === 'string' ? f.postId : null, name: f.name, url: f.url, door: f.door === 'invite' ? 'invite' : 'ask' };
}

/** What a post row says of being a copy: the node's own read (`shownCopy`, `shownFrom`, `shownPrice`), or the phone's cached column. */
export function eventCopyOf(post: { shownCopy?: unknown; shownFrom?: unknown; shownPrice?: unknown; shown_from?: unknown } | null | undefined): EventCopy | null {
    if (post?.shownCopy === true) return { from: fromLineOf(post.shownFrom), price: copyPriceOf(post.shownPrice) };
    if (typeof post?.shown_from !== 'string' || !post.shown_from) return null;
    try {
        const kept = JSON.parse(post.shown_from);
        return { from: fromLineOf(kept), price: copyPriceOf(kept?.price) };
    } catch {
        return { from: null, price: null };
    }
}

/** A phone's cached column for a post from the node: the line and the price, `{}` for a copy with neither, null for any other post. */
export function eventCopyColumn(post: { shownCopy?: unknown; shownFrom?: unknown; shownPrice?: unknown; shown_from?: unknown }): string | null {
    if (typeof post.shown_from === 'string') return post.shown_from;
    if (post.shownCopy !== true) return null;
    return JSON.stringify({ ...(post.shownFrom ?? {}), ...(typeof post.shownPrice === 'string' ? { price: post.shownPrice } : {}) });
}

/** A price in Beans, in words: 'Free' at nothing, as a listing with no price reads. */
export function beansPriceWords(price: CopyPrice): string {
    const n = price.beans;
    if (!n) return t('Free', undefined, 'price');
    switch (price.per) {
        case 'hourly': return tn(n, '{n} Beans an hour', '{n} Beans an hour');
        case 'daily': return tn(n, '{n} Beans a day', '{n} Beans a day');
        case 'weekly': return tn(n, '{n} Beans a week', '{n} Beans a week');
        case 'monthly': return tn(n, '{n} Beans a month', '{n} Beans a month');
        default: return tn(n, '{n} Beans', '{n} Beans');
    }
}

/**
 * An Offer's or Need's line on a copy, on its card and its page: "20 Beans in Mullumbimby · You can't buy or take this until
 * Mullumbimby welcomes you." The name is the directory row's. With no row there is no name and no door, so it says neither.
 */
export function copyPriceLine(copy: EventCopy): string {
    if (!copy.from) {
        return copy.price
            ? t("{price} in another community · You can't buy or take this here.", { price: beansPriceWords(copy.price) })
            : t("This is from another community, so you can't buy or take it here.");
    }
    return copy.price
        ? t("{price} in {community} · You can't buy or take this until {community} welcomes you.", { price: beansPriceWords(copy.price), community: copy.from.name })
        : t("You can't buy or take this until {community} welcomes you.", { community: copy.from.name });
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
