/**
 * The peek ticket (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §2.5 C, §3.4): a member shares ONE
 * listing or event outside their community, and whoever holds the link reads that one post under the
 * visitors' rules (the engine's guestPost: the listing and its rough area, nobody in it) for seven days, or until the
 * member stops sharing it or the community turns outside sharing off.
 *
 * The link is the community's own address: `https://<community>/?post=<id>&peek=<ticket>`. Path `/` is the one the
 * phone's Android app links claim on every node host, so the same link opens the app where it is installed and the
 * node's share page everywhere else (apps/server routes/peek.ts).
 *
 * The ticket is made by the community's node when a member asks for it (`POST /api/peek`, signed by the member's key
 * through the node's signature middleware, so the member's key signs `{postId}` and the node records who shared what and
 * until when). It is 16 random bytes in base64url: it carries no key, no name and no post id, so a forwarded link says
 * nothing about who shared it, and nothing in it can be forged or edited into another post's (the node keeps only its
 * hash, beside the one post it opens). One shape, one link and one set of words for the node, the web app and the phone.
 */
import { word, wordn } from './words.js';

/** How long a ticket opens its post, in days (design §3.4: 7 days). */
export const PEEK_TICKET_DAYS = 7;

/** The most links one member may have open at once on a community (each one a row on its node until it ends). */
export const PEEK_TICKETS_LIVE_MAX = 50;

/** A ticket's shape: 16 random bytes in base64url, unpadded (22 characters). Nothing else is ever looked up. */
const TICKET = /^[A-Za-z0-9_-]{22}$/;

/** Whether `v` has a ticket's shape. A shape only: whether it opens anything is the node's to say. */
export function isPeekTicket(v: unknown): v is string {
    return typeof v === 'string' && TICKET.test(v);
}

/** A post id as a link may carry it: what the node's ids are (UUIDs, `sample-…`), never a path or a query. */
const POST_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function isPeekPostId(v: unknown): v is string {
    return typeof v === 'string' && POST_ID.test(v);
}

/** The link a member shares outside: the community's address (any trailing slashes dropped), the post and the ticket. */
export function peekLink(origin: string, postId: string, ticket: string): string {
    return `${origin.replace(/\/+$/, '')}/?post=${encodeURIComponent(postId)}&peek=${encodeURIComponent(ticket)}`;
}

/**
 * The post and the ticket a link or a query string carries (`?post=<id>&peek=<t>`, in either order, anywhere in the
 * query), or null unless both have their shapes. Each is read once: a link that names either twice is no peek.
 */
export function peekFromLink(link: string | null | undefined): { postId: string; ticket: string } | null {
    if (!link) return null;
    const q = link.indexOf('?');
    if (q < 0) return null;
    const query = link.slice(q + 1).split('#')[0];
    const values = (name: string) => query.split('&').filter(p => p.split('=')[0] === name).map(p => {
        try { return decodeURIComponent(p.slice(name.length + 1)); } catch { return ''; }
    });
    const posts = values('post');
    const tickets = values('peek');
    if (posts.length !== 1 || tickets.length !== 1) return null;
    return isPeekPostId(posts[0]) && isPeekTicket(tickets[0]) ? { postId: posts[0], ticket: tickets[0] } : null;
}

/**
 * One of the member's open links, as the node lists them (`GET /api/peek/mine`): which post, when it was made and when
 * it stops. The ticket itself is never listed (the node keeps only its hash): Stop sharing names the row's `id`.
 */
export interface PeekShare {
    id: string;
    postId: string;
    /** The post's title as it is now, or null where the post is gone (its link then opens nothing). */
    title: string | null;
    createdAt: string;
    expiresAt: string;
}

/** A node's list as the apps read it: each row checked, anything else dropped. */
export function readPeekShares(raw: unknown): PeekShare[] {
    const rows = raw && typeof raw === 'object' && Array.isArray((raw as { shares?: unknown }).shares)
        ? (raw as { shares: unknown[] }).shares : [];
    const out: PeekShare[] = [];
    for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const o = r as Record<string, unknown>;
        if (typeof o.id !== 'string' || !isPeekPostId(o.postId) || typeof o.createdAt !== 'string' || typeof o.expiresAt !== 'string') continue;
        out.push({
            id: o.id.slice(0, 64), postId: o.postId,
            title: typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 200) : null,
            createdAt: o.createdAt, expiresAt: o.expiresAt,
        });
    }
    return out;
}

/** The peek's words, marked here and shown with t() where each is drawn (the node's share page, both apps). */
export const PEEK_WORDS = {
    /** Above the post, on the share page and both apps' peek. Never the sharer's name: a peek names nobody. */
    sharedWithYou: word('A member of {community} shared this with you'),
    /** The page's line under the title, and its preview's (Open Graph) description. */
    onBeanPool: word('On BeanPool, in {community}'),
    /** Under the post: why there is no name or face. */
    namesWhenJoin: word('Names and faces appear when you join {community}.'),
    openInApp: word('Open in the BeanPool app'),
    getApp: word('Get the app'),
    seeInBrowser: word('See it in your browser'),
    /** A link that opens nothing now: stopped, run out, the post gone, or the community turned outside sharing off. */
    stopped: word('This link has stopped working. Ask the member who sent it for a new one.'),
    // The member's side.
    shareWithMembers: word('Share with members'),
    shareOutside: word('Share outside the community'),
    /** Under Share outside, before the link is made. */
    shareOutsideNote: word('Anyone with the link sees this post for 7 days, without names or faces. You can stop it any time.'),
    sharedOutside: word('Shared outside'),
    sharedOutsideNone: word('Nothing shared outside right now.'),
    stopSharing: word('Stop sharing'),
    stoppedNow: word('This link stops working now.'),
    worksUntil: word('Works until {date}'),
    postGone: word('This post is gone'),
    /** The community's rule (How this community works), in the owners' Settings. */
    rule: word('Members may share listings outside the community'),
    notShared: word('Not shared'),
    // What the post is, on the share page (the apps draw their own cards).
    kindOffer: word('Offer', 'a kind of post'),
    kindNeed: word('Need', 'a kind of post'),
    kindEvent: word('Event', 'a kind of post'),
    kindPoll: word('Poll', 'a kind of post'),
    beans: wordn('{n} Bean', '{n} Beans'),
} as const;

/** The word for what a post is (an Offer, a Need, an Event, a Poll), or null for a kind the page has no word for. */
export function peekKindWord(type: unknown): (typeof PEEK_WORDS)['kindOffer'] | null {
    return type === 'offer' ? PEEK_WORDS.kindOffer : type === 'need' ? PEEK_WORDS.kindNeed
        : type === 'event' ? PEEK_WORDS.kindEvent : type === 'poll' ? PEEK_WORDS.kindPoll : null;
}
