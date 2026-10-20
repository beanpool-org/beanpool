/**
 * The node copy on the web (scratch/tools/DESIGN-tool-template-fable.md §1.6, DESIGN-t04-node-copy-delete-fable.md §2
 * "Hosts", slice T0.4): a tool's private copy on the member's own community server, kept beside its IndexedDB record.
 * Core's tools/node-copy.ts decides and does the steps, as on the phone (apps/native/tools/node-copy.ts); this hands it
 * the browser's side (the record and the toggle's setting, tools/store.ts) and the node's routes, signed as the member
 * through the app's own helper (lib/api.ts signedFetch) to the community this page is on, whatever its address.
 *
 * Only for a tool whose manifest asks for `node-copy` ({@link keepsNodeCopy}). Every step for one community, owner and
 * tool runs in one queue, and none once the page has moved to another community or its account has changed
 * (lib/account-epoch.ts), not even the rest of one already under way ({@link heldTo}).
 *
 * Only the host (pages/ToolsPage.tsx, tools/builder.ts) calls this: the eslint fence refuses a tool any import of it.
 */
import {
    createToolCopyQueue, removeToolCopy, syncToolCopy, toolCopyPath, turnToolCopyOff, turnToolCopyOn,
    type ToolCopyDevice, type ToolCopyNode, type ToolCopyOutcome, type ToolCopyOwner, type ToolManifest, type ToolNodeAnswer,
} from '@beanpool/core';
import { accountEpoch, accountEpochHolds } from '../lib/account-epoch';
import { getNodeApiUrl, signedFetch } from '../lib/api';
import { patchToolSettings, readToolRecord, readToolSettings, takeToolRecord, toolRecordSent } from './store';

/** Whether a tool keeps a private copy on the node at all: only one whose manifest asks for it. */
export const keepsNodeCopy = (manifest: Pick<ToolManifest, 'permissions'>): boolean => manifest.permissions.includes('node-copy');

/** One tool's copy as the page knows it: the tool, whose copy, and the community it was opened in. */
export interface WebToolCopy {
    manifest: ToolManifest;
    owner: ToolCopyOwner;
    node: string;
}

/** The community this page is on now. */
export const pageNode = (): string => getNodeApiUrl() || (typeof window !== 'undefined' ? window.location.origin : '');

/** The node's routes for this owner's copy, signed as the member; a refusal comes back as answered, no answer as null. */
export function webToolNode(owner: ToolCopyOwner, tool: string): ToolCopyNode {
    const path = toolCopyPath(owner, tool);
    const ask = async (method: string, body?: unknown): Promise<ToolNodeAnswer | null> => {
        try {
            const res = await signedFetch(method, path, body);
            return { status: res.status, json: await res.json().catch(() => null) };
        } catch {
            return null;
        }
    };
    return { get: () => ask('GET'), put: (doc) => ask('PUT', { doc }), delete: () => ask('DELETE') };
}

/** The browser's side of one tool's copy: its record and its setting, the one writer of `nodeCopy`. */
export function webToolDevice(owner: string, tool: string): ToolCopyDevice {
    return {
        read: () => readToolRecord(owner, tool),
        take: (body, at, was) => takeToolRecord(owner, tool, body, at, was),
        sent: (was, body, at) => toolRecordSent(owner, tool, was, body, at),
        setting: async () => (await readToolSettings(owner, tool)).nodeCopy,
        // A browser that keeps nothing (no IndexedDB) asks the server again on each open, and its answer corrects it.
        setSetting: async (on) => { await patchToolSettings(owner, tool, { nodeCopy: on }); },
    };
}

const queue = createToolCopyQueue();
const keyOf = (c: WebToolCopy) => `${c.node}|${c.owner.publicKey}|${c.manifest.id}`;

/**
 * `device` and `node` held to what the page was on at `epoch` (lib/account-epoch.ts accountEpoch): the community the tool
 * was opened in, and the account, with no sign-out or clear since (here or in another tab). Checked before each request
 * and each write, so a step after a GET that waited (up to TOOL_COPY_ANSWER_MS) never goes to another community's server
 * or record, nor signed as the next account (signedFetch signs as whoever this browser holds then). A request held back
 * is no answer, a write held back none: tried again on the next open.
 */
function heldTo(c: WebToolCopy, epoch: number) {
    const holds = () => pageNode() === c.node && accountEpochHolds(epoch);
    const device = webToolDevice(c.owner.publicKey, c.manifest.id);
    const node = webToolNode(c.owner, c.manifest.id);
    return {
        holds,
        device: {
            ...device,
            take: async (body, at, was) => holds() && device.take(body, at, was),
            sent: async (was, body, at) => { if (holds()) await device.sent(was, body, at); },
            setSetting: async (on) => { if (holds()) await device.setSetting(on); },
        } satisfies ToolCopyDevice,
        node: {
            get: async () => (holds() ? node.get() : null),
            put: async (doc) => (holds() ? node.put(doc) : null),
            delete: async () => (holds() ? node.delete() : null),
        } satisfies ToolCopyNode,
    };
}

async function sync(c: WebToolCopy, epoch: number): Promise<ToolCopyOutcome> {
    const { holds, device, node } = heldTo(c, epoch);
    if (!keepsNodeCopy(c.manifest) || !holds()) return 'later';
    return syncToolCopy(c.manifest, device, node);
}

/** On a tool's open: the GET and the step, unless the setting is off. */
export function openToolCopy(c: WebToolCopy): Promise<ToolCopyOutcome> {
    const epoch = accountEpoch();
    return queue.run(keyOf(c), () => sync(c, epoch));
}

/**
 * After a write: one sync five seconds after the last (an open's rule, so an off made elsewhere is heard first). One
 * still waiting when the account signs out or is cleared is dropped: what it would have sent is still here, and goes on
 * that tool's next open.
 */
export function toolCopyAfterWrite(c: WebToolCopy, then: (outcome: ToolCopyOutcome) => void): void {
    if (!keepsNodeCopy(c.manifest)) return;
    const epoch = accountEpoch();
    queue.later(keyOf(c), async () => then(await sync(c, epoch)));
}

/** The member's toggle: on is the GET, the step and the PUT; off the DELETE. The setting moves only once the node answered. */
export function switchToolCopy(c: WebToolCopy, on: boolean): Promise<'on' | 'off' | 'older-node' | 'failed'> {
    if (!on) queue.cancel(keyOf(c));
    const epoch = accountEpoch();
    return queue.run(keyOf(c), async () => {
        const { holds, device, node } = heldTo(c, epoch);
        if (!holds()) return 'failed';
        return on ? turnToolCopyOn(c.manifest, device, node) : turnToolCopyOff(device, node);
    });
}

/** Remove my data, the node's part, first: true when the node keeps no copy now, and only then may the browser's go. */
export function removeToolCopyFirst(c: WebToolCopy): Promise<boolean> {
    if (!keepsNodeCopy(c.manifest)) return Promise.resolve(true);
    queue.cancel(keyOf(c));
    const epoch = accountEpoch();
    return queue.run(keyOf(c), async () => {
        const { holds, device, node } = heldTo(c, epoch);
        if (!holds()) return false;
        return removeToolCopy(device, node);
    });
}
