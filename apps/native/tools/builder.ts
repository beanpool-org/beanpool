/**
 * The phone's host builder: constructs the host given to a tool's screens (DESIGN-tool-template-fable.md §1.4, slice T0.2).
 *
 * Kept in this file, which the eslint fence refuses a tool (eslint.config.mjs), so a tool cannot build an un-narrowed
 * host or bypass its manifest's declared permissions. Tools import only types from tools/host.ts.
 */
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    TOOL_PERMISSION_GRANTS, lendBackAroundOf, narrowHost, pricingHintFor, toolPlaceOf, withinAnswerTime,
    type PricingGuideItem, type ToolDealSummary, type ToolHost, type ToolHostBase, type ToolHostGrants, type ToolManifest, type ToolOfferDraft,
    type ToolOwnOffer, type ToolPermission, type ToolPlace, type ToolPostStatus,
} from '@beanpool/core';
import { getMyPosts, getPost, pausePost, resumePost, signedGet } from '../utils/db';
import { viewOf } from '../utils/posts-view';
import { keepPicked, openNeedComposer } from './doors';
import { removeToolPhoto, toolPhotoUri } from './photos';
import { communityKey } from './community';
import { homeAnswerStoreKey } from '../utils/storage-keys';

/** What the route knows when it builds a tool's host. */
export interface PhoneHostContext<D> {
    manifest: ToolManifest<D>;
    owner: { kind: 'member' | 'enterprise'; publicKey: string; name: string };
    node: { url: string | null; profile: string; features: Record<string, unknown> | null };
    doc: ToolHostBase<D>['doc'];
    navigate(screen: string, params?: Record<string, string>): void;
    back(): void;
    now(): number;
    /** The List sheet, opened with the tool's draft (the route draws it). */
    openListSheet(draft: ToolOfferDraft): void;
    /** Whether the private copy on the node is on for this tool here (its setting, on a server that keeps copies). */
    nodeCopy?: boolean;
}

/**
 * The app's whole host for one tool: every function this build has, before narrowing. A function a permission would
 * grant but this build doesn't have is left out, and {@link ungrantedPermissions} reports it.
 */
export function phoneHost<D>(ctx: PhoneHostContext<D>): ToolHostBase<D> & Partial<ToolHostGrants> {
    const owner = ctx.owner.publicKey;
    const tool = ctx.manifest.id;
    const community = communityKey(ctx.node.url);
    return {
        owner: ctx.owner,
        node: ctx.node,
        doc: ctx.doc,
        navigate: ctx.navigate,
        back: ctx.back,
        now: ctx.now,
        photos: {
            pick: async () => keepPicked(community, owner, tool, await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, defaultTab: 'albums' })),
            remove: (ref) => removeToolPhoto(community, owner, tool, ref),
            uri: (ref) => toolPhotoUri(community, owner, tool, ref),
        },
        camera: {
            take: async () => {
                const perm = await ImagePicker.requestCameraPermissionsAsync();
                if (!perm.granted) return null;
                return keepPicked(community, owner, tool, await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 }));
            },
        },
        place: () => phonePlace(owner, ctx.node.url),
        offerDoor: (draft) => ctx.openListSheet(draft),
        needDoor: (draft) => { void openNeedComposer(owner, tool, draft); },
        deals: () => ownerDeals(owner),
        pricingGuide: (category, words) => pricingGuideHint(ctx.node.url, category, words),
        posts: {
            pause: async (id) => { await mustBeOwnOffer(owner, id); await pausePost(id); },
            resume: async (id) => { await mustBeOwnOffer(owner, id); await resumePost(id); },
            status: async (id) => postStatus(await ownOffer(owner, id)),
            mine: () => ownOffers(owner),
        },
        nodeCopy: { on: ctx.nodeCopy ?? false },
    };
}

/**
 * `place`: a place the phone already holds, never asked for and never sent (core toolPlaceOf): the community's own place
 * and the member's rough area from the Home answer this phone kept for this account and community (utils/home-store.ts
 * writes it under this key; read here as it is stored, so the host never loads Home's modules), else the phone's last
 * known place where location is already allowed (as Home's own lastKnownPlace: never a permission prompt). The location
 * module loads on first ask, so a tool that never asks costs app start nothing. Null for none.
 */
export async function phonePlace(owner: string, url: string | null): Promise<ToolPlace | null> {
    const base = (url ?? await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null) ?? '').trim();
    const kept = base ? keptHomePlace(owner, base, await AsyncStorage.getItem(homeAnswerStoreKey(owner, base)).catch(() => null)) : null;
    if (kept) return kept;
    try {
        const Location = await import('expo-location');
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted') return null;
        const last = await Location.getLastKnownPositionAsync();
        return last ? toolPlaceOf({ device: { lat: last.coords.latitude, lng: last.coords.longitude } }) : null;
    } catch {
        return null;
    }
}

/** The place in a kept Home answer, only for this account and community (as readStoredHome holds it); null for none. */
export function keptHomePlace(owner: string, url: string, raw: string | null): ToolPlace | null {
    try {
        const kept = raw ? JSON.parse(raw) : null;
        const same = (u: unknown) => typeof u === 'string' && u.trim().replace(/\/+$/, '').toLowerCase() === url.trim().replace(/\/+$/, '').toLowerCase();
        if (!kept || kept.publicKey !== owner || !same(kept.url)) return null;
        return toolPlaceOf({ community: kept.answer?.cards?.community?.place, area: kept.answer?.me?.area });
    } catch {
        return null;
    }
}

/** The most rows the node gives in one page (MAX_PAGE_LIMIT in https-server.ts); asked for no number, it gives 50. */
const PAGE_ROWS = 200;

/** A deal as the node's GET /api/marketplace/transactions answers it, every field unchecked. */
interface NodeDeal { id?: unknown; postId?: unknown; sellerPublicKey?: unknown; status?: unknown; hours?: unknown; createdAt?: unknown; completedAt?: unknown }

/**
 * Every deal of the owner's, newest first, as the node answers them, signed as the member: page after page until a short
 * one, a row seen twice (pushed down a page by a new one meanwhile) kept once, and a page with nothing new in it ends it.
 * No answer, a refusal or one that isn't a list rejects; each page is let go at core's withinAnswerTime.
 */
async function nodeDeals(owner: string): Promise<NodeDeal[]> {
    const rows = new Map<string, NodeDeal>();
    for (let offset = 0; ; offset += PAGE_ROWS) {
        const query = new URLSearchParams({ publicKey: owner, limit: String(PAGE_ROWS), offset: String(offset) });
        const page = await withinAnswerTime(async (signal) => {
            const res = await signedGet(`/api/marketplace/transactions?${query}`, { signal });
            if (!res.ok) throw new Error(`The deals weren't read (${res.status}).`);
            return res.json() as Promise<unknown>;
        });
        if (!Array.isArray(page)) throw new Error("The deals weren't read.");
        const before = rows.size;
        for (const row of page as NodeDeal[]) if (row && typeof row.id === 'string' && !rows.has(row.id)) rows.set(row.id, row);
        if (page.length < PAGE_ROWS || rows.size === before) return [...rows.values()];
    }
}

/**
 * `deals`: the owner's deals where they are the seller or lender (on their own Offers; the tool matches the ones its
 * records are linked to), never one they are buying in, every one of them, asked of the community's server each time as
 * the web asks it. Not the phone's own table: the sync fills that with the newest 50 deals only, so a phone just set up
 * wouldn't hold an older loan still out, and a row that has since dropped out of those 50 is never brought up to date. A
 * loan that is out says when it is due back, from its Offer's hand-over and the deal's days (core's lendBackAroundOf),
 * when the phone holds the Offer. Deals that can't be read (offline, no answer, a refusal) reject, so a screen says it
 * couldn't check rather than that nothing is out.
 */
export async function ownerDeals(owner: string): Promise<ToolDealSummary[]> {
    const rows = await nodeDeals(owner);
    const mine = rows.filter((r): r is NodeDeal & { id: string; postId: string } =>
        r.sellerPublicKey === owner && typeof r.postId === 'string' && typeof r.id === 'string');
    return Promise.all(mine.map(async (r): Promise<ToolDealSummary> => {
        const post = r.status === 'pending' ? await getPost(r.postId).catch(() => null) : null;
        const hours = typeof r.hours === 'number' ? r.hours : null;
        const backAround = post?.lendable ? lendBackAroundOf(post.accepted_at, post.price_type, hours) : null;
        const updatedAt = (r.status === 'pending' && typeof post?.accepted_at === 'string' && post.accepted_at)
            || (typeof r.completedAt === 'string' && r.completedAt) || String(r.createdAt ?? '');
        return { postId: r.postId, transactionId: r.id, status: String(r.status), updatedAt, ...(backAround ? { backAround } : {}) };
    }));
}

/** `posts.mine`: the owner's own Offers the phone holds, live, in a deal or paused. */
export async function ownOffers(owner: string): Promise<ToolOwnOffer[]> {
    const rows = await getMyPosts(owner).catch(() => []);
    return rows
        .filter((p) => p && p.type === 'offer' && p.author_pubkey === owner && typeof p.id === 'string')
        .map((p) => ({ id: p.id, title: typeof p.title === 'string' ? p.title : '', status: postStatus(p) }))
        .filter((o) => o.status !== 'gone');
}

/** How long the pricing guide is asked for before the hint is left out. */
const PRICING_GUIDE_TIMEOUT_MS = 8_000;

/**
 * `pricingGuide`: the community's price guide (its public GET /api/pricing-guide, as the Pricing Guide sheet reads it)
 * on one thing, through core's pricingHintFor. Null when the server can't be reached, has no guide, or no item matches:
 * a hint, never a price set for the member.
 */
export async function pricingGuideHint(url: string | null, category: string, words: string): Promise<{ credits: number; priceType: string } | null> {
    const base = (url ?? await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null) ?? '').trim().replace(/\/+$/, '');
    if (!base) return null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PRICING_GUIDE_TIMEOUT_MS);
    try {
        const res = await fetch(`${base}/api/pricing-guide`, { signal: abort.signal });
        if (!res.ok) return null;
        const data = await res.json() as { items?: unknown };
        return Array.isArray(data?.items) ? pricingHintFor(data.items as PricingGuideItem[], category, words) : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The member's own Offer as the community's server has it now, else null: `posts` reaches no other post, so a tool can't
 * learn whether someone else's is there or what state it is in (its status says 'gone'). Asked of the server, signed as
 * the member, as the web asks it, not read from the phone's own row: a shop closed for now pauses its Offers on the
 * server, and the row says so only after the next sync. No answer, a refusal, or the visitors' view (no author in it)
 * rejects, so a screen says it couldn't check rather than that the Offer has gone. Let go at core's withinAnswerTime.
 */
async function ownOffer(owner: string, id: string): Promise<{ status?: unknown } | null> {
    const rows = await withinAnswerTime(async (signal) => {
        const res = await signedGet(`/api/marketplace/posts?id=${encodeURIComponent(id)}`, { signal });
        if (!res.ok || viewOf(res) === 'guest') throw new Error(`The Offer wasn't read (${res.status}).`);
        return res.json() as Promise<unknown>;
    });
    if (!Array.isArray(rows)) throw new Error("The Offer wasn't read.");
    const post = (rows as Array<Record<string, unknown> | null>).find((p) => p?.id === id);
    return post && post.authorPublicKey === owner && post.type === 'offer' ? post : null;
}

async function mustBeOwnOffer(owner: string, id: string): Promise<void> {
    if (!await ownOffer(owner, id)) throw new Error('Not one of your Offers.');
}

/** A post as the host says it: live, in a deal, paused, or gone. */
export function postStatus(post: { status?: unknown } | null | undefined): ToolPostStatus {
    switch (post?.status) {
        case 'active': return 'active';
        case 'pending': return 'pending';
        case 'paused': return 'paused';
        default: return 'gone';
    }
}

/** The permissions a manifest declares whose function this build's host doesn't have: its route won't open it. */
export function ungrantedPermissions(manifest: Pick<ToolManifest, 'permissions'>, full: Partial<ToolHostGrants>): ToolPermission[] {
    return manifest.permissions.filter((p) => {
        const key = TOOL_PERMISSION_GRANTS[p];
        return key !== null && full[key] === undefined;
    });
}

/** What a tool is given: the base and exactly what its manifest's permissions grant. */
export function hostFor<D, P extends ToolPermission>(manifest: ToolManifest<D> & { permissions: readonly P[] }, ctx: PhoneHostContext<D>): ToolHost<D, P> {
    return narrowHost<D, P>(phoneHost(ctx), manifest.permissions);
}
