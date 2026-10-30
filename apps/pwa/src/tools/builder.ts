/**
 * The web's host builder: constructs the host given to a tool's screens (DESIGN-tool-template-fable.md §1.4, slice T0.3).
 *
 * Kept in this file, which the eslint fence refuses a tool (eslint.config.mjs), so a tool cannot build an un-narrowed
 * host or bypass its manifest's declared permissions. Tools import only types from tools/host.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    lendBackAroundOf, narrowHost, pricingHintFor, toolDocBytes, toolDocMaxBytes, toolPlaceOf,
    type PricingGuideItem, type ToolDealSummary, type ToolHost, type ToolHostBase, type ToolHostGrants, type ToolManifest, type ToolNeedDraft,
    type ToolOfferDraft, type ToolOwnOffer, type ToolPermission, type ToolPlace, type ToolPostStatus,
} from '@beanpool/core';
import {
    getHome, getMarketplacePosts, getMyMarketplaceTransactions, pauseMarketplacePost, request, resumeMarketplacePost, type MarketplacePost,
} from '../lib/api';
import { homeCacheKey, readCachedHome } from '../lib/home-cache';
import type { HomeAnswer } from '../lib/home-cards';
import { MARKETPLACE_CATEGORIES_BY_ID } from '../lib/marketplace';
import { chooseImageFile, keepChosen, toolPhotoToken } from './photos';
import { keepToolDoc, readToolPhoto, readToolRecord, removeToolPhoto, removeToolRecord } from './store';

/** What App gives the host: who the owner is, the node, and its doors. */
export interface WebHostContext {
    owner: { kind: 'member' | 'enterprise'; publicKey: string; name: string };
    node: { url: string | null; profile: string; features: Record<string, unknown> | null };
    /** Into another screen of this tool (the covered page's openTool state). */
    navigate(screen: string, params?: Record<string, string>): void;
    /** Back, as the page's Back goes: the screen this one was opened from, else out of the tool. */
    back(): void;
    /** The composer, opened prefilled; the member taps Post. */
    openComposer(draft: ComposerDraft): void;
    now?(): number;
    /** Whether the private copy on the node is on for this tool here (its setting, on a server that keeps copies). */
    nodeCopy?: boolean;
}

/** A document over its byte bound: set() refuses it whole, and the tool shows its own sentence. Nothing is written. */
export class ToolDocTooBig extends Error {
    readonly bytes: number;
    readonly max: number;
    constructor(bytes: number, max: number) {
        super(`The document is ${bytes} bytes; at most ${max} are kept.`);
        this.name = 'ToolDocTooBig';
        this.bytes = bytes;
        this.max = max;
    }
}

/** A write the browser didn't keep (no IndexedDB, a full disk, signed out in another tab): the screen is as it was. */
export class ToolDocNotKept extends Error {
    constructor() {
        super('The document was not kept in this browser.');
        this.name = 'ToolDocNotKept';
    }
}

/**
 * The most bytes a tool's document may be: its own bound, never past what the node keeps (core toolDocMaxBytes), nor
 * past `nodeMax`, what this community's server said it keeps of it (the settings' `nodeMax`, once heard).
 */
export const docMaxBytes = (m: ToolManifest<unknown>, nodeMax?: number): number => toolDocMaxBytes(m, nodeMax);

/** Any stored text as the tool's document: the manifest's read(), and its empty() for anything it can't read. */
export function readDoc<D>(m: ToolManifest<D>, body: string | null): D {
    let raw: unknown = null;
    if (body !== null) {
        try { raw = JSON.parse(body); } catch { raw = null; }
    }
    try {
        return m.doc.read(raw);
    } catch {
        return m.doc.empty();
    }
}

/** Whether a document is the tool's empty one: the frame shows the two doors over it. */
export function isEmptyDoc<D>(m: ToolManifest<D>, doc: D): boolean {
    try {
        return JSON.stringify(doc) === JSON.stringify(m.doc.empty());
    } catch {
        return false;
    }
}

export type ToolDocState<D> =
    | { status: 'loading' }
    | { status: 'ready'; doc: D; updatedAt: string | null };

/**
 * The tool's one document for `owner`, from the store: loading, then ready (its empty one when nothing is kept).
 * `set` writes it whole (its last sync with the node kept, tools/store.ts keepToolDoc) and refuses one over the bound
 * that is bigger than the one it holds, then `afterWrite` (the node copy's sync); one the browser didn't keep is taken back off the screen and throws; `reload` reads it again (after the node's copy was taken); `remove` takes this
 * browser's copy away and leaves the empty one. The bound is `maxBytes()`: the tool's own, never past `nodeMax`, what
 * this community's server said it keeps (the settings' `nodeMax`, which the page hands in once it has heard it).
 */
export function useToolDoc<D>(m: ToolManifest<D> | undefined, owner: string | null, afterWrite?: () => void, nodeMax?: number) {
    const [state, setState] = useState<ToolDocState<D>>({ status: 'loading' });
    const current = useRef<D | null>(null);
    const heard = useRef(nodeMax);
    heard.current = nodeMax;
    // Which read is the current one: a read for another tool or owner, or after the page closed, is dropped.
    const generation = useRef(0);
    const id = m?.id ?? null;
    const load = useCallback(async (): Promise<void> => {
        if (!m || !owner) return;
        const g = generation.current;
        const rec = await readToolRecord(owner, m.id);
        if (g !== generation.current) return;
        const doc = readDoc(m, rec?.body ?? null);
        current.current = doc;
        setState({ status: 'ready', doc, updatedAt: rec?.updatedAt ?? null });
    }, [id, owner, m]);
    useEffect(() => {
        if (!m || !owner) return;
        generation.current++;
        setState({ status: 'loading' });
        void load();
        return () => { generation.current++; };
    }, [id, owner]);

    const set = useCallback(async (next: D): Promise<void> => {
        if (!m || !owner) throw new ToolDocNotKept();
        const max = docMaxBytes(m as ToolManifest<unknown>, heard.current);
        const bytes = toolDocBytes(next);
        // One no bigger than what it holds is taken: a document already past the bound can still be made smaller.
        if (bytes > max && (current.current === null || bytes > toolDocBytes(current.current))) throw new ToolDocTooBig(bytes, max);
        const updatedAt = new Date().toISOString();
        const was = current.current;
        let shown: ToolDocState<D> | null = null;
        current.current = next;
        setState((s) => { shown = s; return { status: 'ready', doc: next, updatedAt }; });
        const kept = await keepToolDoc(owner, m.id, JSON.stringify(next), updatedAt);
        if (!kept) {
            // Nothing changed: the screen and get() hold the document as it was, so a later write can't keep this one
            // either. A write or read since then is left as it is.
            if (current.current === next) {
                current.current = was;
                setState((s) => (s.status === 'ready' && s.doc === next && shown ? shown : s));
            }
            throw new ToolDocNotKept();
        }
        afterWrite?.();
    }, [id, owner, m, afterWrite]);

    const remove = useCallback(async (): Promise<boolean> => {
        if (!m || !owner) return false;
        const gone = await removeToolRecord(owner, m.id);
        if (gone) {
            const empty = m.doc.empty();
            current.current = empty;
            setState({ status: 'ready', doc: empty, updatedAt: null });
        }
        return gone;
    }, [id, owner, m]);

    const get = useCallback((): D => current.current ?? (m ? m.doc.empty() : (null as D)), [m]);
    // A new function when the server's bound moves, so the host, and the screens' room, are drawn again.
    const maxBytes = useCallback((): number => (m ? docMaxBytes(m as ToolManifest<unknown>, heard.current) : 0), [m, nodeMax]);
    return { state, get, set, maxBytes, remove, reload: load };
}

/** What the composer is opened with: an Offer or a Need, its fields held to the composer's own. */
export interface ComposerDraft {
    type: 'offer' | 'need';
    title: string;
    description: string;
    category: string | null;
    credits: number | null;
    priceType: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly' | null;
    repeatable: boolean;
    cashAlsoNeeded: boolean;
    /** Whether the tool's draft asked for "Put this in your shop". */
    shop?: boolean;
    /** The tool's photos for an Offer, as the composer keeps them (JPEG data URLs at 800 px); absent when it has none. */
    photos?: string[];
}

/** The composer keeps at most this many photos. */
const COMPOSER_PHOTOS = 5;

const PRICE_TYPES = new Set(['fixed', 'hourly', 'daily', 'weekly', 'monthly']);
export const COMPOSER_TITLE_CHARS = 120;
export const COMPOSER_DESCRIPTION_CHARS = 2000;
const clip = (s: unknown, n: number) => (typeof s === 'string' ? [...s].slice(0, n).join('') : '');

export function composerDraft(type: 'offer', draft: ToolOfferDraft): ComposerDraft;
export function composerDraft(type: 'need', draft: ToolNeedDraft): ComposerDraft;
export function composerDraft(type: 'offer' | 'need', draft: ToolOfferDraft | ToolNeedDraft): ComposerDraft {
    const d = (draft ?? {}) as Partial<ToolOfferDraft>;
    const category = typeof d.category === 'string' && MARKETPLACE_CATEGORIES_BY_ID.has(d.category) ? d.category : null;
    const offer = type === 'offer';
    const credits = offer && typeof d.credits === 'number' && Number.isSafeInteger(d.credits) && d.credits >= 0 ? d.credits : null;
    const priceType = offer && typeof d.priceType === 'string' && PRICE_TYPES.has(d.priceType) ? d.priceType as ComposerDraft['priceType'] : null;
    return {
        type,
        title: clip(d.title, COMPOSER_TITLE_CHARS),
        description: clip(d.description, COMPOSER_DESCRIPTION_CHARS),
        category,
        credits,
        priceType,
        repeatable: offer && d.repeatable === true,
        cashAlsoNeeded: offer && d.cashAlsoNeeded === true,
        ...(offer && d.shop !== undefined ? { shop: d.shop } : {}),
    };
}

/** A post as the host says it to a tool: live, in a deal, paused, or gone (ended, deleted, or not the owner's). */
export function postStatusOf(post: Pick<MarketplacePost, 'status'> | null | undefined): ToolPostStatus {
    switch (post?.status) {
        case 'active': return 'active';
        case 'pending': return 'pending';
        case 'paused': return 'paused';
        default: return 'gone';
    }
}

/**
 * The owner's own Offer as the node has it, else null: `posts` reaches no other post. A server that can't be reached
 * throws, so a tool says it couldn't check rather than that the Offer has gone.
 */
async function ownOffer(owner: string, id: string): Promise<MarketplacePost | null> {
    const [post] = await getMarketplacePosts({ id });
    return post && post.id === id && post.authorPublicKey === owner && post.type === 'offer' ? post : null;
}

/** The most rows the node gives in one page (MAX_PAGE_LIMIT in https-server.ts); asked for no number, it gives 50. */
const PAGE_ROWS = 200;

/**
 * Every row of a list the node pages, newest first: page after page until a short one, so the older rows don't fall off
 * the first page. A page with nothing new in it (a node that took no offset) ends it too; a row seen twice, pushed down a
 * page by a new one meanwhile, is kept once.
 */
async function everyPage<T extends { id: string }>(read: (limit: number, offset: number) => Promise<T[]>): Promise<T[]> {
    const rows = new Map<string, T>();
    for (let offset = 0; ; offset += PAGE_ROWS) {
        const page = await read(PAGE_ROWS, offset);
        const list = Array.isArray(page) ? page : [];
        const before = rows.size;
        for (const row of list) if (row && typeof row.id === 'string' && !rows.has(row.id)) rows.set(row.id, row);
        if (list.length < PAGE_ROWS || rows.size === before) return [...rows.values()];
    }
}

/** The owner's own Offers, live, in a deal or paused (the node shows its author the paused ones), every one of them. */
async function ownOffers(owner: string): Promise<MarketplacePost[]> {
    const posts = await everyPage((limit, offset) => getMarketplacePosts({ author: owner, type: 'offer', limit, offset }));
    return posts.filter((p) => p && p.authorPublicKey === owner && p.type === 'offer' && postStatusOf(p) !== 'gone');
}

/** `posts`: pause and resume the owner's own Offers only, say how one stands, and list them. */
export function webPosts(owner: string): ToolHostGrants['posts'] {
    const mustBeOwn = async (id: string) => {
        if (!await ownOffer(owner, id)) throw new Error('Not one of your Offers.');
    };
    return {
        pause: async (id) => { await mustBeOwn(id); await pauseMarketplacePost(id, owner); },
        resume: async (id) => { await mustBeOwn(id); await resumeMarketplacePost(id, owner); },
        status: async (id) => postStatusOf(await ownOffer(owner, id)),
        mine: async (): Promise<ToolOwnOffer[]> => (await ownOffers(owner)).map((p) => ({ id: p.id, title: p.title, status: postStatusOf(p) })),
    };
}

/**
 * `deals`: the owner's deals where they are the seller or lender (on their own Offers; the tool matches the ones its
 * records are linked to), never one they are buying in, every one of them: the node's one page would let newer deals push
 * an older loan still out off it. A loan that is out says when it is due back, from its Offer's hand-over and the deal's
 * days (core's lendBackAroundOf).
 */
export async function webDeals(owner: string): Promise<ToolDealSummary[]> {
    const [deals, offers] = await Promise.all([
        everyPage((limit, offset) => getMyMarketplaceTransactions(owner, undefined, limit, offset)),
        ownOffers(owner).catch(() => [] as MarketplacePost[]),
    ]);
    const byId = new Map(offers.map((p) => [p.id, p]));
    return deals.filter((d) => d && d.sellerPublicKey === owner).map((d): ToolDealSummary => {
        const post = byId.get(d.postId);
        const backAround = d.status === 'pending' && post?.lendable ? lendBackAroundOf(post.acceptedAt, post.priceType, d.hours) : null;
        const updatedAt = (d.status === 'pending' && post?.acceptedAt) || d.completedAt || d.createdAt;
        return { postId: d.postId, transactionId: d.id, status: d.status, updatedAt, ...(backAround ? { backAround } : {}) };
    });
}

/**
 * `pricingGuide`: the community's price guide (its public GET /api/pricing-guide) on one thing, through core's
 * pricingHintFor. Null when it can't be read or nothing matches: a hint, never a price set for the member.
 */
export async function webPricingHint(category: string, words: string): Promise<{ credits: number; priceType: string } | null> {
    const data = await request<{ items?: unknown }>('GET', '/api/pricing-guide').catch(() => null);
    return Array.isArray(data?.items) ? pricingHintFor(data.items as PricingGuideItem[], category, words) : null;
}

/** A new photo's ref. */
const newPhotoRef = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/** How long `place` waits for a place: past it, none (a tool offers its own way on, as the guide's Choose your climate). */
export const PLACE_WAIT_MS = 8_000;

const placeInAnswer = (answer: HomeAnswer | null | undefined) => toolPlaceOf({ community: answer?.cards?.community?.place, area: answer?.me?.area });

/**
 * `place`: a place the community's server already tells this member (core toolPlaceOf): the community's own place and
 * the member's rough area, from its Home answer's Your community card. First the answer this browser kept for this
 * member and community (lib/home-cache.ts, as the phone reads the one it kept): with a place in it, nothing is sent.
 * Only without one there is the server asked (GET /api/home, as Home reads it; nothing is sent with it).
 * The browser's own position is never asked for. Null for none, when the server can't be reached, or at
 * {@link PLACE_WAIT_MS}, when a request still out is let go: a read that never comes back never holds a screen.
 */
export function webPlace(owner: string): Promise<ToolPlace | null> {
    const letGo = new AbortController();
    const known = async () => {
        const kept = placeInAnswer((await readCachedHome(homeCacheKey(owner)).catch(() => null))?.answer);
        if (kept) return kept;
        const read = await getHome({ cards: ['community'] }, null, letGo.signal);
        return read.notModified ? null : placeInAnswer(read.answer);
    };
    return new Promise((resolve) => {
        const timer = setTimeout(() => { letGo.abort(); resolve(null); }, PLACE_WAIT_MS);
        const done = (p: ToolPlace | null) => { clearTimeout(timer); resolve(p); };
        known().then(done, () => done(null));
    });
}

function webGrants(ctx: WebHostContext, tool: string): Partial<ToolHostGrants> {
    const owner = ctx.owner.publicKey;
    const photo = async (capture: boolean) => keepChosen(owner, tool, await chooseImageFile(capture), newPhotoRef());
    return {
        // The draft's photos are the tool's refs: read from this browser's store into the composer's own form. A draft
        // with none opens the composer at once.
        offerDoor: (draft: ToolOfferDraft) => {
            const refs = (Array.isArray(draft?.photos) ? draft.photos : []).filter((r): r is string => typeof r === 'string').slice(0, COMPOSER_PHOTOS);
            if (refs.length === 0) { ctx.openComposer(composerDraft('offer', draft)); return; }
            void Promise.all(refs.map((ref) => readToolPhoto(owner, tool, ref))).then((read) => {
                const photos = read.filter((p): p is string => !!p);
                ctx.openComposer({ ...composerDraft('offer', draft), ...(photos.length > 0 ? { photos } : {}) });
            });
        },
        needDoor: (draft: ToolNeedDraft) => ctx.openComposer(composerDraft('need', draft)),
        place: () => webPlace(owner),
        photos: {
            pick: () => photo(false),
            remove: async (ref: string) => { await removeToolPhoto(owner, tool, ref); },
            uri: (ref: string) => toolPhotoToken(owner, tool, ref),
        },
        camera: { take: () => photo(true) },
        posts: webPosts(owner),
        deals: () => webDeals(owner),
        pricingGuide: (category: string, words: string) => webPricingHint(category, words),
        nodeCopy: { on: ctx.nodeCopy ?? false },
    };
}

/**
 * The host given to the tool `m`: the base and the grants its permissions name, through core's narrowHost, so a function
 * it never declared is absent ('deals' in host is false) and a type error in its screens.
 */
export function webHostFor<D, P extends ToolPermission>(
    m: ToolManifest<D> & { permissions: readonly P[] }, ctx: WebHostContext, doc: ToolHostBase<D>['doc'],
): ToolHost<D, P> {
    const full: ToolHostBase<D> & Partial<ToolHostGrants> = {
        owner: ctx.owner,
        node: ctx.node,
        doc,
        navigate: (screen, params) => ctx.navigate(screen, params),
        back: () => ctx.back(),
        now: () => (ctx.now ? ctx.now() : Date.now()),
        ...webGrants(ctx, m.id),
    };
    return narrowHost(full, m.permissions);
}

/** The host for a screen, made once per tool, context and document handle. */
export function useWebHost<D>(m: ToolManifest<D> | undefined, ctx: WebHostContext, doc: ToolHostBase<D>['doc']): ToolHost<D, ToolPermission> | null {
    return useMemo(() => (m ? webHostFor(m, ctx, doc) : null), [m, ctx, doc]);
}
