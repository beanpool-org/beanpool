/**
 * A community's public card (front doors S15, scratch/fable-design/DESIGN-doors-follow-through-fable.md §4.2): what a
 * stranger at a local community's address reads in place of a sign-in form, from the node's public read
 * `GET /api/community/card` (apps/server routes/community-card.ts). One shape and one wording for the node's own page,
 * the web app's welcome page and the phone's card screen, so the three say the same thing in every language.
 *
 * Nothing in it names a member, a listing, a balance or a point (Marty, 28 Sep): the node decides each field by the
 * same switches the directory reads, and the apps show only what it sends.
 */
import { word, wordn, type TFunction, type TnFunction } from './words.js';

/** What a stranger reads about a community. Every field is said, null where it isn't shown. */
export interface CommunityCard {
    /** The community's own name, or null where it has none of its own: the apps then show `host`. */
    name: string | null;
    /** The host of the address it publishes, or null where it knows none. */
    host: string | null;
    /** How many members, only where the community shares its member count. */
    members: number | null;
    /** The town or area in the owner's words and the service area's radius in km, only while the community shares its place. */
    area: { name: string; radiusKm: number | null } | null;
    /** `requests`: it takes requests to join; `open`: anyone may join; `invite`: new members come by invite. */
    joining: 'requests' | 'open' | 'invite';
    /** The global community's lobby with this community first (`…/?ask=<host>`), or null. */
    askUrl: string | null;
    /** "Look around the global community": the global community the node names, or null for none. */
    globalUrl: string | null;
}

/** The card's words, marked here and shown with t() where each is drawn (the node's page, both apps). */
export const COMMUNITY_CARD_WORDS = {
    kicker: word('A BeanPool community'),
    members: wordn('{n} member', '{n} members'),
    areaWithin: word('{area}, within about {km} km'),
    requests: word('Takes requests to join'),
    open: word('Anyone can join'),
    invite: word('Takes new members by invite'),
    ask: word('Ask to join'),
    /** Under Ask to join where it opens the global community's lobby. */
    askViaGlobal: word('Look around global first, join there to get an account, then find {name} in Find a community.'),
    /** Where Ask to join has nowhere to go from a browser: the node names no global community, or isn't listed. */
    askInApp: word('Ask to join from the BeanPool app.'),
    join: word('Join', 'button: join a community anyone may join'),
    haveInvite: word('I have an invite'),
    member: word('Already a member'),
    lookAround: word('🌍 Look around the global community'),
} as const;

type CardWords = { t: TFunction; tn: TnFunction };

/** The name a card shows: the community's own, else its host, else "A BeanPool community". */
export function communityCardName(card: Pick<CommunityCard, 'name' | 'host'>, w: Pick<CardWords, 't'>): string {
    return card.name ?? card.host ?? w.t(COMMUNITY_CARD_WORDS.kicker);
}

/** The lines under the name: members, the area, how it takes new members. Null where the card says none. */
export function communityCardFacts(card: CommunityCard, w: CardWords): { members: string | null; area: string | null; joining: string } {
    const W = COMMUNITY_CARD_WORDS;
    return {
        members: card.members === null ? null : w.tn(card.members, W.members.one, W.members.other),
        area: !card.area ? null : card.area.radiusKm
            ? w.t(W.areaWithin, { area: card.area.name, km: Math.max(1, Math.round(card.area.radiusKm)) })
            : card.area.name,
        joining: w.t(card.joining === 'requests' ? W.requests : card.joining === 'open' ? W.open : W.invite),
    };
}

const MAX_TEXT = 200;
const text = (v: unknown, max = MAX_TEXT): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const https = (v: unknown): string | null => {
    const s = text(v, 400);
    if (!s) return null;
    try {
        return new URL(s).protocol === 'https:' ? s : null;
    } catch {
        return null;
    }
};

/**
 * A node's answer as a card, or null when it isn't one: each field checked, anything else dropped. A node is someone
 * else's server, so an app reads its card as it reads any of its answers: only https links, text cut to size.
 */
export function readCommunityCard(raw: unknown): CommunityCard | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (r.joining !== 'requests' && r.joining !== 'open' && r.joining !== 'invite') return null;
    const area = r.area && typeof r.area === 'object' ? r.area as Record<string, unknown> : null;
    const areaName = area ? text(area.name, 120) : null;
    const host = text(r.host, 253);
    return {
        name: text(r.name, 120),
        host: host && askHost(host) === host.toLowerCase() ? host.toLowerCase() : null,
        members: typeof r.members === 'number' && Number.isInteger(r.members) && r.members >= 0 ? r.members : null,
        area: areaName
            ? { name: areaName, radiusKm: typeof area!.radiusKm === 'number' && Number.isFinite(area!.radiusKm) && area!.radiusKm > 0 ? area!.radiusKm : null }
            : null,
        joining: r.joining,
        askUrl: https(r.askUrl),
        globalUrl: https(r.globalUrl),
    };
}

/**
 * A community's host as `?ask=<host>` names it (a community's card links the global community's lobby so), or null: a
 * host name or a public IPv4 address, with an optional port, nothing else (no scheme, path, user or space), lowercased.
 */
export function askHost(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim().toLowerCase();
    if (s.length === 0 || s.length > 253) return null;
    return /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/.test(s) ? s : null;
}
