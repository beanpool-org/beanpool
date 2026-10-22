/**
 * The phone's host builder: constructs the host given to a tool's screens (DESIGN-tool-template-fable.md §1.4, slice T0.2).
 *
 * Kept in this file, which the eslint fence refuses a tool (eslint.config.mjs), so a tool cannot build an un-narrowed
 * host or bypass its manifest's declared permissions. Tools import only types from tools/host.ts.
 */
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    TOOL_PERMISSION_GRANTS, lendBackAroundOf, narrowHost, pricingHintFor,
    type PricingGuideItem, type ToolDealSummary, type ToolHost, type ToolHostBase, type ToolHostGrants, type ToolManifest, type ToolOfferDraft,
    type ToolOwnOffer, type ToolPermission, type ToolPostStatus,
} from '@beanpool/core';
import { getMarketplaceTransactions, getMyPosts, getPost, pausePost, resumePost } from '../utils/db';
import { keepPicked, openNeedComposer } from './doors';
import { removeToolPhoto, toolPhotoUri } from './photos';
import { communityKey } from './community';

/** What the route knows when it builds a tool's host. */
export interface PhoneHostContext<D> {
    manifest: ToolManifest<D>;
    owner: { kind: 'member' | 'enterprise'; publicKey: string; name: string };
    node: { url: string | null; profile: string; features: Record<string, unknown> | null };
    doc: { get(): D; set(next: D): Promise<void> };
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
            pick: async () => keepPicked(community, owner, tool, await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 })),
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
 * `deals`: the owner's deals as the phone holds them where the owner is the seller or lender (on their own Offers; the
 * tool matches the ones its records are linked to), never a deal they are buying in. A loan that is out says when it is
 * due back, from its Offer's hand-over and the deal's days (core's lendBackAroundOf), when the phone holds both.
 */
export async function ownerDeals(owner: string): Promise<ToolDealSummary[]> {
    const rows = await getMarketplaceTransactions(owner, undefined, 200).catch(() => []);
    const mine = rows.filter((r) => r && r.sellerPublicKey === owner && typeof r.postId === 'string' && typeof r.id === 'string');
    return Promise.all(mine.map(async (r): Promise<ToolDealSummary> => {
        const post = r.status === 'pending' ? await getPost(r.postId).catch(() => null) : null;
        const backAround = post?.lendable ? lendBackAroundOf(post.accepted_at, post.price_type, r.hours) : null;
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
 * The member's own Offer as the phone holds it, else null: `posts` reaches no other post, so a tool can't learn whether
 * someone else's is there or what state it is in (its status says 'gone').
 */
async function ownOffer(owner: string, id: string): Promise<{ status?: unknown } | null> {
    const post = await getPost(id).catch(() => null);
    return post && post.author_pubkey === owner && post.type === 'offer' ? post : null;
}

async function mustBeOwnOffer(owner: string, id: string): Promise<void> {
    if (!await ownOffer(owner, id)) throw new Error('Not one of your Offers on this phone.');
}

/** A post the phone holds as the host says it: live, in a deal, paused, or gone. */
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
