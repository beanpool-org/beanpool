/**
 * The node copy on the phone (scratch/tools/DESIGN-tool-template-fable.md §1.6, DESIGN-t04-node-copy-delete-fable.md §2
 * "Hosts", slice T0.4): a tool's private copy on the member's own community server, kept beside its `tool_docs` row.
 * Core's tools/node-copy.ts decides and does the steps; this hands it the phone's side (the row in the community's
 * SQLite file and the toggle's setting in app storage) and the node's routes, signed as the member through the app's own
 * helpers (utils/db.ts signedGet and signedRequestWithMethod) to the community this phone is on, whatever its address.
 *
 * Only for a tool whose manifest asks for `node-copy` ({@link keepsNodeCopy}). Every step for one community, owner and
 * tool runs in one queue, and the next starts only once each request of the one before has settled; each is let go at
 * TOOL_COPY_ANSWER_MS (core withinAnswerTime), so a sync after a write never lands after the DELETE that follows it; one
 * let go that the node takes anyway is refused there (an ordinary PUT over a removed copy, 410), and only the toggle's
 * PUT says `turnOn`. None runs once the phone has moved to another community, whose file and server are another's, or
 * its account has changed: not even the rest of one already under way (each request and write first asks whether the job
 * still holds: {@link parts}). The phone is one process: no other queue sends for the same copy.
 *
 * Only the host route (app/tool/[id].tsx) calls this: the eslint fence refuses a tool any import of it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    createToolCopyQueue, removeToolCopy, syncToolCopy, toolCopyPath, turnToolCopyOff, turnToolCopyOn, withinAnswerTime,
    type ToolCopyDevice, type ToolCopyNode, type ToolCopyOutcome, type ToolCopyOwner, type ToolManifest, type ToolNodeAnswer,
} from '@beanpool/core';
import { getDb, signedGet, signedRequestWithMethod } from '../utils/db';
import { onAccountOnPhone } from '../utils/account-on-phone';
import { notifyToolStore, patchToolSettings, readToolCopy, readToolSettings } from './store';
import { communityKey } from './community';

/** Whether a tool keeps a private copy on the node at all: only one whose manifest asks for it. */
export const keepsNodeCopy = (manifest: Pick<ToolManifest, 'permissions'>): boolean => manifest.permissions.includes('node-copy');

/** One tool's copy as the host route knows it: the tool, whose copy, and the community it was opened in. */
export interface PhoneToolCopy {
    manifest: ToolManifest;
    owner: ToolCopyOwner;
    url: string | null;
}

/** Whether the job a device or node is for may still go on (see {@link parts}). */
type Holds = () => Promise<boolean>;

/**
 * The node's routes for this owner's copy, signed as the member; a refusal comes back as answered, no answer as null, and
 * a request the job may no longer send (`holds`) as no answer, unsent. Each is let go at the answer limit, its reading
 * of the answer too, so one the network never answers settles then. A PUT's body is `{ doc, turnOn: true }` from the
 * toggle and `{ doc }` from every other (a 410 comes back as answered, its status kept).
 */
export function phoneToolNode(owner: ToolCopyOwner, tool: string, holds: Holds): ToolCopyNode {
    const path = toolCopyPath(owner, tool);
    const write = async (method: 'PUT' | 'DELETE', payload?: unknown): Promise<ToolNodeAnswer | null> => {
        if (!await holds()) return null;
        try {
            return { status: 200, json: await withinAnswerTime((signal) => signedRequestWithMethod(method, path, payload, { withStatus: true, signal })) };
        } catch (e) {
            const status = (e as { status?: unknown } | null)?.status;
            return typeof status === 'number' ? { status, json: { error: e instanceof Error ? e.message : '' } } : null;
        }
    };
    return {
        get: async () => {
            if (!await holds()) return null;
            try {
                return await withinAnswerTime(async (signal) => {
                    const res = await signedGet(path, { signal });
                    return { status: res.status, json: await res.json().catch(() => null) };
                });
            } catch {
                return null;
            }
        },
        put: (doc, turnOn) => write('PUT', turnOn ? { doc, turnOn: true } : { doc }),
        delete: () => write('DELETE'),
    };
}

/**
 * The phone's side of one tool's copy: its row (a take or a sent copy changes it only if no write landed meanwhile) and
 * its setting, the one writer of `nodeCopy`. Nothing is written once the job may no longer go on (`holds`), asked after
 * the file is opened, so the file written is the community's that was asked about.
 */
export function phoneToolDevice(owner: string, tool: string, url: string | null, holds: Holds): ToolCopyDevice {
    return {
        read: () => readToolCopy(owner, tool),
        take: async (body, at, was) => {
            const db = await getDb();
            if (!await holds()) return false;
            const r = was
                ? await db.runAsync('UPDATE tool_docs SET body = ?, updated_at = ?, synced_at = ? WHERE owner = ? AND tool = ? AND body = ? AND updated_at = ?',
                    [body, at, at, owner, tool, was.body, was.updatedAt])
                : await db.runAsync('INSERT INTO tool_docs (owner, tool, body, updated_at, synced_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner, tool) DO NOTHING',
                    [owner, tool, body, at, at]);
            if (!r?.changes) return false;
            notifyToolStore(owner, tool);
            return true;
        },
        sent: async (was, body, at) => {
            const db = await getDb();
            if (!await holds()) return;
            if (was) {
                await db.runAsync('UPDATE tool_docs SET synced_at = ?, updated_at = CASE WHEN body = ? AND updated_at = ? THEN ? ELSE updated_at END WHERE owner = ? AND tool = ?',
                    [at, was.body, was.updatedAt, at, owner, tool]);
            } else {
                // Switched on with nothing kept here: the empty document the node now keeps is this phone's too.
                await db.runAsync(`INSERT INTO tool_docs (owner, tool, body, updated_at, synced_at) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(owner, tool) DO UPDATE SET synced_at = excluded.synced_at`, [owner, tool, body, at, at]);
                notifyToolStore(owner, tool);
            }
        },
        setting: async () => (await readToolSettings(owner, tool, url)).nodeCopy,
        setSetting: async (on) => { if (await holds()) await patchToolSettings(owner, tool, { nodeCopy: on }, url); },
    };
}

const queue = createToolCopyQueue();
const keyOf = (c: PhoneToolCopy) => `${communityKey(c.url)}|${c.owner.publicKey}|${c.manifest.id}`;

/**
 * Moved on each time the phone's account changes (Sign Out, Replace, another account signing in): a sync after a write
 * that was waiting from before is dropped, so it is never signed as the account that holds the phone now. What it would
 * have sent is still on the phone and goes on that tool's next open.
 */
let accountTurn = 0;
let accountHeld: string | null | undefined;
onAccountOnPhone((key) => {
    if (key === accountHeld) return;
    accountHeld = key;
    accountTurn++;
});

/**
 * The account turn a job is made in. Until an account has been announced since this build started, a member's own copy
 * says which the phone holds (the host route's owner is the phone's account), so that account announced again (a name
 * change, its words added) drops nothing; any other still does, Replace included, which announces no Sign Out between.
 */
function turnFor(c: PhoneToolCopy): number {
    if (accountHeld === undefined && c.owner.kind === 'member') accountHeld = c.owner.publicKey;
    return accountTurn;
}

/** Whether the phone is still on the community the tool was opened in: its file and its server are the copy's. */
async function stillHere(url: string | null): Promise<boolean> {
    const now = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
    return communityKey(now) === communityKey(url);
}

/**
 * One job's device and node, held to what the phone was on as the job was made (`turn`, {@link accountTurn}): the
 * community the tool was opened in, and the same account. Asked before each request and each write, so a step after a
 * GET that waited (up to TOOL_COPY_ANSWER_MS) never lands in another community's file or on its server (getDb and the
 * signed helpers follow the community the phone is on then), nor goes signed as the next account. A request held back
 * is no answer, a write held back none: tried again on the next open. The node is the queue's held one: the job after
 * this one starts only once each of its requests has settled.
 */
function parts(c: PhoneToolCopy, turn: number) {
    const holds = async () => turn === accountTurn && await stillHere(c.url);
    const node = queue.held(keyOf(c), phoneToolNode(c.owner, c.manifest.id, holds));
    return { holds, device: phoneToolDevice(c.owner.publicKey, c.manifest.id, c.url, holds), node };
}

async function sync(c: PhoneToolCopy, turn: number): Promise<ToolCopyOutcome> {
    const { holds, device, node } = parts(c, turn);
    if (!keepsNodeCopy(c.manifest) || !await holds()) return 'later';
    return syncToolCopy(c.manifest, device, node);
}

/** On a tool's open: the GET and the step, unless the setting is off. */
export function openToolCopy(c: PhoneToolCopy): Promise<ToolCopyOutcome> {
    const turn = turnFor(c);
    return queue.run(keyOf(c), () => sync(c, turn));
}

/** After a write: one sync five seconds after the last (an open's rule, so an off made elsewhere is heard first). */
export function toolCopyAfterWrite(c: PhoneToolCopy, then: (outcome: ToolCopyOutcome) => void): void {
    if (!keepsNodeCopy(c.manifest)) return;
    const turn = turnFor(c);
    queue.later(keyOf(c), async () => then(await sync(c, turn)));
}

/** The member's toggle: on is the GET, the step and the PUT; off the DELETE. The setting moves only once the node answered. */
export function switchToolCopy(c: PhoneToolCopy, on: boolean): Promise<'on' | 'off' | 'older-node' | 'failed'> {
    if (!on) queue.cancel(keyOf(c));
    const turn = turnFor(c);
    return queue.run(keyOf(c), async () => {
        const { holds, device, node } = parts(c, turn);
        if (!await holds()) return 'failed';
        return on ? turnToolCopyOn(c.manifest, device, node) : turnToolCopyOff(device, node);
    });
}

/** Remove my data, the node's part, first: true when the node keeps no copy now, and only then may the phone's go. */
export function removeToolCopyFirst(c: PhoneToolCopy): Promise<boolean> {
    if (!keepsNodeCopy(c.manifest)) return Promise.resolve(true);
    queue.cancel(keyOf(c));
    const turn = turnFor(c);
    return queue.run(keyOf(c), async () => {
        const { holds, device, node } = parts(c, turn);
        if (!await holds()) return false;
        return removeToolCopy(device, node);
    });
}
