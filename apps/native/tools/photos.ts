/**
 * A tool's photos on the phone (scratch/tools/DESIGN-tool-template-fable.md §1.6, slice T0.2, PR #2267 finding 2):
 * files under the app's own document directory at `tools/<community>/<owner>/<tool>/<ref>.jpg`, 800 px wide (the Offer form's
 * downsize), never inside the document and never on the node until a thing is listed (then they are the Offer's).
 *
 * Keyed per community, owner and tool: "Remove my data" in one community removes only that community's photos; leaving
 * or deleting at a community removes all its photos; Sign Out removes the whole tools folder.
 */
import * as FileSystem from 'expo-file-system/legacy';
import type { ToolPhoto } from '@beanpool/core';

/** The folder of every tool's photos, under the app's document directory. */
export const TOOL_FILES_DIR = 'tools/';

/** A path segment from a key or id: letters, digits, `_` and `-` only, so no owner key, community or ref can climb out. */
const segment = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96) || '_';
const toolsRoot = () => `${FileSystem.documentDirectory ?? ''}${TOOL_FILES_DIR}`;
const communityDir = (community: string) => `${toolsRoot()}${segment(community)}/`;
const toolDir = (community: string, owner: string, tool: string) => `${communityDir(community)}${segment(owner)}/${segment(tool)}/`;

/** Where a photo's file is: what an Image draws. */
export const toolPhotoUri = (community: string, owner: string, tool: string, ref: string) =>
    `${toolDir(community, owner, tool)}${segment(ref)}.jpg`;

/**
 * A picked or taken image kept for a tool: already downsized to 800 px JPEG by the caller (`uri`), copied into the
 * tool's community-scoped folder under a new ref. The document keeps the ref only.
 */
export async function keepToolPhoto(
    community: string, owner: string, tool: string, image: { uri: string; width: number; height: number }, ref: string,
): Promise<ToolPhoto> {
    const dir = toolDir(community, owner, tool);
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    await FileSystem.copyAsync({ from: image.uri, to: toolPhotoUri(community, owner, tool, ref) });
    return { ref: segment(ref), width: image.width, height: image.height };
}

export async function removeToolPhoto(community: string, owner: string, tool: string, ref: string): Promise<void> {
    await FileSystem.deleteAsync(toolPhotoUri(community, owner, tool, ref), { idempotent: true });
}

/** A kept photo as a `data:` URI, for the Offer composer's draft (its photos are data URIs). Null when it can't be read. */
export async function toolPhotoDataUri(community: string, owner: string, tool: string, ref: string): Promise<string | null> {
    try {
        const b64 = await FileSystem.readAsStringAsync(toolPhotoUri(community, owner, tool, ref), { encoding: 'base64' });
        return b64 ? `data:image/jpeg;base64,${b64}` : null;
    } catch {
        return null;
    }
}

/** One tool's folder for one community and owner, and every photo in it. */
export async function removeToolFolder(community: string, owner: string, tool: string): Promise<void> {
    await FileSystem.deleteAsync(toolDir(community, owner, tool), { idempotent: true });
}

/** All photos for one community (when leaving or deleting at that community). */
export async function removeCommunityPhotos(community: string): Promise<void> {
    await FileSystem.deleteAsync(communityDir(community), { idempotent: true });
}

/** The whole tools folder: every community's, every owner's, every tool's, every photo. */
export async function removeEveryToolFolder(): Promise<void> {
    await FileSystem.deleteAsync(toolsRoot(), { idempotent: true });
}
