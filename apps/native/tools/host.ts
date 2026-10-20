/**
 * The phone's host: the only door from a tool to the app (scratch/tools/DESIGN-tool-template-fable.md §1.4, slice T0.2).
 * The host route (app/tool/[id].tsx) builds the app's whole host for one tool and hands the tool {@link hostFor}'s
 * narrowing of it: the base (owner, node, its document, navigation, the time) and exactly the functions its manifest's
 * permissions grant (core's narrowHost). An undeclared function is absent at runtime (`'offerDoor' in host` is false) and
 * a type error at build (ToolHost<D, P>).
 *
 * What this build grants: `photos`, `camera`, `offer-door` (through the List sheet), `need-door`, `posts` (the member's
 * own Offers: pause, resume, status) and `node-copy` (read-only, and off: the node copy is T0.4). `reminders` grants no
 * function (tools/reminders.ts schedules due()). Not yet: `place`, `event-door`, `deals` and `pricing-guide`; a tool that
 * declares one of those is not this build's tool, and its route says "This tool isn't in this version of the app"
 * ({@link ungrantedPermissions}), never a function that is missing when called.
 *
 * A tool may import this file (the eslint fence lets it), so what it exports gives nothing a manifest didn't ask for:
 * the doors' own writers are in tools/doors.ts, which the fence refuses a tool.
 *
 * The doors never post: `offerDoor` opens the List sheet, whose button writes the Offer composer's draft (the map's own
 * draft key) and opens the composer (`/(tabs)/map?newPost=offer`), where the member checks it and taps Post; the node's
 * refusals (no profile photo, probation, the day limit) are the composer's, in the node's words. No edit to the map.
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
    return {
        owner: ctx.owner,
        node: ctx.node,
        doc: ctx.doc,
        navigate: ctx.navigate,
        now: ctx.now,
        photos: {
            pick: async () => keepPicked(owner, tool, await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 })),
            remove: (ref) => removeToolPhoto(owner, tool, ref),
            uri: (ref) => toolPhotoUri(owner, tool, ref),
        },
        camera: {
            take: async () => {
                const perm = await ImagePicker.requestCameraPermissionsAsync();
                if (!perm.granted) return null;
                return keepPicked(owner, tool, await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 }));
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

