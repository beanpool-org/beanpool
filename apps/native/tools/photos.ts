/**
 * A tool's photos on the phone (scratch/tools/DESIGN-tool-template-fable.md §1.6, slice T0.2): files under the app's own
 * document directory at `tools/<owner>/<tool>/<ref>.jpg`, 800 px wide (the Offer form's downsize), never inside the
 * document and never on the node until a thing is listed (then they are the Offer's). The document keeps refs only.
 * tools/store.ts takes the folders off the phone with a tool's data, and every one as the account leaves.
 */
import * as FileSystem from 'expo-file-system/legacy';
import type { ToolPhoto } from '@beanpool/core';

/** The folder of every tool's photos, under the app's document directory. */
export const TOOL_FILES_DIR = 'tools/';

/** A path segment from a key or id: letters, digits, `_` and `-` only, so no owner key or ref can climb out. */
const segment = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96) || '_';
const toolsRoot = () => `${FileSystem.documentDirectory ?? ''}${TOOL_FILES_DIR}`;
const toolDir = (owner: string, tool: string) => `${toolsRoot()}${segment(owner)}/${segment(tool)}/`;

/** Where a photo's file is: what an Image draws. */
export const toolPhotoUri = (owner: string, tool: string, ref: string) => `${toolDir(owner, tool)}${segment(ref)}.jpg`;

/**
 * A picked or taken image kept for a tool: already downsized to 800 px JPEG by the caller (`uri`), copied into the
 * tool's folder under a new ref. The document keeps the ref only.
 */
export async function keepToolPhoto(owner: string, tool: string, image: { uri: string; width: number; height: number }, ref: string): Promise<ToolPhoto> {
    const dir = toolDir(owner, tool);
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    await FileSystem.copyAsync({ from: image.uri, to: toolPhotoUri(owner, tool, ref) });
    return { ref: segment(ref), width: image.width, height: image.height };
}

export async function removeToolPhoto(owner: string, tool: string, ref: string): Promise<void> {
    await FileSystem.deleteAsync(toolPhotoUri(owner, tool, ref), { idempotent: true });
}

/** A kept photo as a `data:` URI, for the Offer composer's draft (its photos are data URIs). Null when it can't be read. */
export async function toolPhotoDataUri(owner: string, tool: string, ref: string): Promise<string | null> {
    try {
        const b64 = await FileSystem.readAsStringAsync(toolPhotoUri(owner, tool, ref), { encoding: 'base64' });
        return b64 ? `data:image/jpeg;base64,${b64}` : null;
    } catch {
        return null;
    }
}

/** One tool's folder for one owner, and every photo in it. */
export async function removeToolFolder(owner: string, tool: string): Promise<void> {
    await FileSystem.deleteAsync(toolDir(owner, tool), { idempotent: true });
}

/** The whole tools folder: every owner's, every tool's, every photo. */
export async function removeEveryToolFolder(): Promise<void> {
    await FileSystem.deleteAsync(toolsRoot(), { idempotent: true });
}
