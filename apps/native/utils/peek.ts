/**
 * The peek ticket, the phone's half (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §3.4; the node's
 * apps/server engine/peek-tickets.ts and routes/peek.ts; the shape, the link and the words are core's peek-ticket.ts):
 *
 *   - Share outside the community, on a listing or an event: the member's own community makes the ticket (a signed
 *     `POST /api/peek`) and the link is that community's address with `?post=<id>&peek=<ticket>`;
 *   - Settings → Shared outside: the member's open links (`GET /api/peek/mine`) and Stop sharing (`POST /api/peek/stop`);
 *   - the peek screen (app/peek.tsx): a link opened on this phone, the one post read from its community as a visitor,
 *     unsigned (`GET /api/marketplace/posts/:id?peek=`).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { peekLink, readCommunityCard, readPeekShares, t, type PeekShare } from '@beanpool/core';
import { signedGet, signedRequestWithMethod } from './db';

const TIMEOUT_MS = 15_000;

/** A post as the node answers a ticket: guestPost's fields (the listing, its area, nobody). Only what the screen draws. */
export interface PeekPost {
    id: string;
    type: 'offer' | 'need' | 'event' | 'poll' | string;
    title: string;
    description?: string;
    category?: string;
    credits?: number;
    priceType?: string;
    photos?: string[];
    status?: string;
    eventStartAt?: string | null;
    eventEndAt?: string | null;
    eventStartLocal?: string | null;
    eventTz?: string | null;
    eventOnline?: boolean;
}

/** One answer's post, checked: a node is someone else's server, so only the fields the screen draws, each its own type. */
export function readPeekPost(raw: unknown, postId: string): PeekPost | null {
    const p = raw && typeof raw === 'object' ? (raw as { post?: unknown }).post : null;
    if (!p || typeof p !== 'object') return null;
    const o = p as Record<string, unknown>;
    if (o.id !== postId || typeof o.title !== 'string' || typeof o.type !== 'string') return null;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return {
        id: postId, type: o.type, title: o.title.slice(0, 200),
        description: str(o.description)?.slice(0, 4000), category: str(o.category),
        credits: typeof o.credits === 'number' && Number.isFinite(o.credits) ? o.credits : undefined,
        priceType: str(o.priceType),
        // Only the node's own photo paths: a photo is fetched from the community the link named, never from anywhere else.
        photos: Array.isArray(o.photos) ? o.photos.filter((x): x is string => typeof x === 'string' && x.startsWith('/api/')).slice(0, 6) : [],
        status: str(o.status),
        eventStartAt: str(o.eventStartAt) ?? null, eventEndAt: str(o.eventEndAt) ?? null,
        eventStartLocal: str(o.eventStartLocal) ?? null, eventTz: str(o.eventTz) ?? null,
        eventOnline: o.eventOnline === true,
    };
}

/**
 * The post a ticket opens, read from its community as a visitor (unsigned: the ticket is what lets it through), or
 * `stopped` where the community answers that the link opens nothing now (stopped, run out, the post gone, sharing outside
 * turned off: it answers all of those alike), or `unreachable` where it couldn't be asked.
 */
export async function fetchPeekPost(origin: string, postId: string, ticket: string, fetchImpl: typeof fetch = fetch): Promise<PeekPost | 'stopped' | 'unreachable'> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const res = await fetchImpl(`${origin}/api/marketplace/posts/${encodeURIComponent(postId)}?peek=${encodeURIComponent(ticket)}`, {
            method: 'GET', headers: { Accept: 'application/json' }, signal: ctl.signal,
        });
        if (res.status === 401 || res.status === 403 || res.status === 404) return 'stopped';
        if (!res.ok) return 'unreachable';
        return readPeekPost(await res.json(), postId) ?? 'stopped';
    } catch {
        return 'unreachable';
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The community's name as its public card gives it, or its host: the host is always the one the link named, and a card
 * that names another host is shown by that host alone, as the card screen does (app/community-card.tsx).
 */
export async function fetchPeekCommunityName(origin: string, fetchImpl: typeof fetch = fetch): Promise<string> {
    const host = origin.replace(/^https:\/\//, '');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const res = await fetchImpl(`${origin}/api/community/card`, { headers: { Accept: 'application/json' }, signal: ctl.signal });
        const card = res.ok ? readCommunityCard(await res.json()) : null;
        const claimed = card?.host?.replace(/:443$/, '') ?? null;
        return card?.name && claimed === host ? card.name : host;
    } catch {
        return host;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * A signed write to this phone's community. An answer without the node's words (`unsaid`: a proxy's 502 page, an empty
 * 500) is "Request failed: 502", in English: said in words instead, as utils/shop.ts says it, with its status, code and
 * `unsaid` kept, so a screen can still tell it from a refusal. A refusal keeps the node's own words.
 */
async function signedWrite(path: string, body: unknown): Promise<any> {
    try {
        return await signedRequestWithMethod('POST', path, body, { withStatus: true });
    } catch (e) {
        const err = e as { unsaid?: unknown; status?: unknown; code?: unknown } | null;
        if (err?.unsaid !== true) throw e;
        throw Object.assign(new Error(t("Your community couldn't be reached. Try again.")), { status: err.status, unsaid: true }, typeof err.code === 'string' ? { code: err.code } : {});
    }
}

/** A new link to share `postId` outside this phone's community. Throws the node's refusal in its own words. */
export async function makePeekLink(postId: string): Promise<{ link: string; expiresAt: string }> {
    const anchor = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchor) throw new Error('You are off-grid. Please connect to a BeanPool Node.');
    const made = await signedWrite('/api/peek', { postId }) as { ticket: string; postId: string; expiresAt: string };
    return { link: peekLink(anchor, made.postId || postId, made.ticket), expiresAt: made.expiresAt };
}

/** The member's open links on this phone's community, newest first. */
export async function fetchPeekShares(): Promise<PeekShare[]> {
    const res = await signedGet('/api/peek/mine');
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return readPeekShares(await res.json());
}

let stopsHere = 0;

/**
 * How many links Stop sharing has stopped from this app. A link Share outside kept unsent (components/SharePost.tsx) is
 * handed over only while this is unchanged: the post screen stays open under Settings → Shared outside, and the link
 * stopped there may be that one.
 */
export function peekStopsHere(): number {
    return stopsHere;
}

/** Stop one of them: it opens nothing from now. Counted even where no answer came: the node may have stopped it. */
export async function stopPeekShare(id: string): Promise<void> {
    try {
        await signedWrite('/api/peek/stop', { id });
    } finally {
        stopsHere += 1;
    }
}
