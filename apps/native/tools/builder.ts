/**
 * The phone's host builder: constructs the host given to a tool's screens (DESIGN-tool-template-fable.md §1.4, slice T0.2).
 *
 * Kept in this file, which the eslint fence refuses a tool (eslint.config.mjs), so a tool cannot build an un-narrowed
 * host or bypass its manifest's declared permissions. Tools import only types from tools/host.ts.
 */
import * as ImagePicker from 'expo-image-picker';
import {
    TOOL_PERMISSION_GRANTS, narrowHost,
    type ToolHost, type ToolHostBase, type ToolHostGrants, type ToolManifest, type ToolOfferDraft, type ToolPermission,
    type ToolPostStatus,
} from '@beanpool/core';
import { getPost, pausePost, resumePost } from '../utils/db';
import { keepPicked, openNeedComposer } from './doors';
import { removeToolPhoto, toolPhotoUri } from './photos';
import { NODE_COPY_BUILT } from './store';
import { communityKey } from './community';

export { NODE_COPY_BUILT };

/** What the route knows when it builds a tool's host. */
export interface PhoneHostContext<D> {
    manifest: ToolManifest<D>;
    owner: { kind: 'member' | 'enterprise'; publicKey: string; name: string };
    node: { url: string | null; profile: string; features: Record<string, unknown> | null };
    doc: { get(): D; set(next: D): Promise<void> };
    navigate(screen: string, params?: Record<string, string>): void;
    now(): number;
    /** The List sheet, opened with the tool's draft (the route draws it). */
    openListSheet(draft: ToolOfferDraft): void;
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
        posts: {
            pause: async (id) => { await mustBeOwnOffer(owner, id); await pausePost(id); },
            resume: async (id) => { await mustBeOwnOffer(owner, id); await resumePost(id); },
            status: async (id) => postStatus(await ownOffer(owner, id)),
        },
        nodeCopy: { on: NODE_COPY_BUILT },
    };
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
