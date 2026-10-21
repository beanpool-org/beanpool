/**
 * The node copy, switched on (scratch/tools/DESIGN-tool-template-fable.md §1.5, §1.6; DESIGN-t04-node-copy-delete-fable.md
 * §1, §2; slice T0.4): how both hosts keep a tool's document beside its private copy on the community's own server
 * (member_tool_state, apps/server/src/routes/tools.ts), by the one sync rule (reconcile.ts). The phone and the web each
 * hand in their store (a {@link ToolCopyDevice}) and their signed requests (a {@link ToolCopyNode}); this decides and
 * does the same steps for both.
 *
 * - Only a tool whose manifest asks for `node-copy`, and only while the member's setting is not off. The setting is the
 *   member's choice for that community and tool, which the node holds; each device's is a cache of it, corrected on open.
 * - On open (and once, five seconds after the last write: {@link createToolCopyQueue}): GET, then the step. A copy that
 *   is taken is read through the tool's own read() first, and one that isn't a document is never written over the
 *   device's. The sync after a write reconciles as an open does, so an off made on another device is heard before
 *   anything is sent.
 * - Switching it on is a GET, the step and a PUT; off is a DELETE. The setting moves only once the node has answered.
 * - Remove my data takes the node's copy first ({@link removeToolCopy}); if that fails, the host removes nothing.
 * - A request the node hasn't answered in {@link TOOL_COPY_ANSWER_MS} is no answer, so nothing waits on it for ever; the
 *   hosts let it go then ({@link withinAnswerTime}), and nothing else on that tool starts until it has (the queue).
 * - Off means gone, even when a slow PUT is still on its way: a PUT whose end the device never heard, or that ended while
 *   the copy was going off, leaves a mark ({@link ToolCopyMarks}); once off, the next open asks whether the node's copy
 *   is gone, and DELETEs it again if not.
 *
 * The owner is never in a body: a member's copy is the signer's own route, an enterprise's the treasury route of a keeper
 * ({@link toolCopyPath}), and a PUT carries the document alone, under `doc`. Nothing here needs any address but the
 * member's own community's. Pure but for what the host hands in: no platform imports (the barrel is bundled for the phone).
 */
import type { ToolManifest } from './manifest.js';
import { reconcile, type ToolLocalCopy, type ToolRemoteCopy, type ToolSyncIntent, type ToolSyncStep } from './reconcile.js';

/** Whose copy: the member's own, or an enterprise's (by a keeper of it). */
export interface ToolCopyOwner {
    kind: 'member' | 'enterprise';
    publicKey: string;
}

/** The node's path of the owner's copy of a tool: the signer's own for a member, the treasury's for an enterprise. */
export function toolCopyPath(owner: ToolCopyOwner, tool: string): string {
    const t = encodeURIComponent(tool);
    return owner.kind === 'enterprise' ? `/api/treasury/${encodeURIComponent(owner.publicKey)}/tools/${t}` : `/api/tools/${t}`;
}

/** A node's answer as the host's transport hands it over: its status and its JSON (null when it sent none). */
export interface ToolNodeAnswer {
    status: number;
    json: unknown;
}

/** The node's three routes for one owner's copy of one tool, signed by the host; null is no answer at all. */
export interface ToolCopyNode {
    get(): Promise<ToolNodeAnswer | null>;
    put(doc: Record<string, unknown>): Promise<ToolNodeAnswer | null>;
    delete(): Promise<ToolNodeAnswer | null>;
}

/** The device's side of one tool's copy, for one owner in one community: the host's store and its setting. */
export interface ToolCopyDevice {
    /** The device's copy, or null when it keeps none. */
    read(): Promise<ToolLocalCopy | null>;
    /**
     * Keep `body` (this build's, from {@link readTakenBody}) with updatedAt and syncedAt `at`, unless the device's copy is
     * no longer `was` (a write landed meanwhile): false then, and nothing written.
     */
    take(body: string, at: string, was: ToolLocalCopy | null): Promise<boolean>;
    /**
     * The node keeps `body` as of `at`: syncedAt becomes `at`, and updatedAt too unless the device wrote again since `was`.
     * `was` null: the device kept nothing and sent the empty document, which it keeps now.
     */
    sent(was: ToolLocalCopy | null, body: string, at: string): Promise<void>;
    /** The setting as this device last heard it: false is off; true or never set (undefined) is on. */
    setting(): Promise<boolean | undefined>;
    setSetting(on: boolean): Promise<void>;
    /** The node copy's marks, kept beside the setting in the same record (so they go wherever it goes). */
    marks(): Promise<ToolCopyMarks>;
    /**
     * The marks `change` makes of them and of the setting as they stand, read and written as one step, so another tab's
     * write between is never lost.
     */
    mark(change: (marks: ToolCopyMarks, setting: boolean | undefined) => ToolCopyMarks): Promise<void>;
}

/**
 * What a device keeps so that off means gone even when a PUT is slower than its DELETE (PR #2297's deciding review):
 * a PUT the node takes after the DELETE that follows it puts the copy back, and a device whose setting is off never asks
 * again. Each host's queue keeps its own PUT and DELETE apart, but a PUT let go at the limit may still reach the node, and
 * another tab of the same browser has a queue of its own. So:
 * - `unsure`: `out` while a PUT is on its way; `check` once one ended unheard (no answer in time, let go, the network, a
 *   5xx), or heard while the copy was going off. With the setting off, the next open asks once whether the node's copy
 *   is gone ({@link syncToolCopy}), and only a node that says so clears it. Never cleared by a later PUT.
 * - `deleting`: a DELETE is on its way (off, Remove my data). A PUT that ends meanwhile may land after it: `check`.
 */
export interface ToolCopyMarks {
    unsure?: 'out' | 'check';
    deleting?: boolean;
}

/** The marks as a host keeps them in its settings record: only those set, and no field at all (undefined) once none is. */
export function keptMarks(marks: ToolCopyMarks): ToolCopyMarks | undefined {
    const kept: ToolCopyMarks = {};
    if (marks.unsure === 'out' || marks.unsure === 'check') kept.unsure = marks.unsure;
    if (marks.deleting === true) kept.deleting = true;
    return kept.unsure || kept.deleting ? kept : undefined;
}

/** The marks a host's settings record holds, whatever was stored there (anything else is none). */
export const toolCopyMarksOf = (raw: unknown): ToolCopyMarks => (raw && typeof raw === 'object' ? keptMarks(raw as ToolCopyMarks) ?? {} : {});

/**
 * How long the node has to answer one request: past it, no answer (offline), so a request that never comes back (a
 * browser's fetch waits minutes) never holds the tool's queue. Long enough for a 64 KB copy on a slow mobile line.
 */
export const TOOL_COPY_ANSWER_MS = 30_000;

/**
 * A host's request, let go at {@link TOOL_COPY_ANSWER_MS}: `send` passes the signal on to its fetch, so one the network
 * never answers settles then and frees the tool's queue. Letting go doesn't say the node never got it: the marks do.
 */
export async function withinAnswerTime<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const letGo = new AbortController();
    const timer = setTimeout(() => letGo.abort(), TOOL_COPY_ANSWER_MS);
    try {
        return await send(letGo.signal);
    } finally {
        clearTimeout(timer);
    }
}

/** The node's answer, or null once it has taken too long or failed. */
function answered(request: () => Promise<ToolNodeAnswer | null>): Promise<ToolNodeAnswer | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), TOOL_COPY_ANSWER_MS);
        const done = (a: ToolNodeAnswer | null) => { clearTimeout(timer); resolve(a); };
        try {
            request().then(done, () => done(null));
        } catch {
            done(null);
        }
    });
}

const ok = (a: ToolNodeAnswer | null): a is ToolNodeAnswer => !!a && a.status >= 200 && a.status < 300;
/** An answer that says what became of the request: a 5xx (the node's, or a proxy's that gave up waiting) may not. */
const heard = (a: ToolNodeAnswer | null): boolean => !!a && a.status < 500;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The GET's answer as the sync rule reads it. A 404 is a node older than the store (or no such enterprise there):
 * this device only. Any other refusal, and no answer, is offline: tried again on the next open. `doc: null` with a
 * `deletedAt` is a copy its owner deleted (a node of S2.1 on); without one, none (today's node never says when).
 */
export function toolRemoteOf(answer: ToolNodeAnswer | null): ToolRemoteCopy {
    if (answer?.status === 404) return { kind: 'older-node' };
    if (!ok(answer) || !isObject(answer.json)) return { kind: 'offline' };
    const { doc, updatedAt, deletedAt } = answer.json;
    if (isObject(doc) && typeof updatedAt === 'string' && updatedAt) return { kind: 'copy', body: JSON.stringify(doc), updatedAt };
    if (doc !== null && doc !== undefined) return { kind: 'offline' };
    return typeof deletedAt === 'string' && deletedAt ? { kind: 'deleted', deletedAt } : { kind: 'none' };
}

/**
 * The node's copy as this build keeps it: through the tool's own read(), as any stored value (an older version upgraded,
 * a newer one kept whole), or null when it is no tool's document (not JSON, not an object with a numeric `v` at its top,
 * which is what the node answers for a row it couldn't read, or a read() that throws). Null is never written.
 */
export function readTakenBody<D>(manifest: ToolManifest<D>, body: string): string | null {
    let raw: unknown;
    try {
        raw = JSON.parse(body);
    } catch {
        return null;
    }
    if (!isObject(raw) || typeof raw.v !== 'number') return null;
    try {
        const read = manifest.doc.read(raw);
        return isObject(read) ? JSON.stringify(read) : null;
    } catch {
        return null;
    }
}

/**
 * What a sync did:
 * - `off`: the setting is off, so the node was asked nothing (or, with a mark, only whether its copy is gone).
 * - `nothing`, `taken` (the device now holds the node's copy: the screen redraws), `put` (the node now holds the device's).
 * - `switched-off`: the node keeps no copy any more; the setting is off now and the device's copy stays: say so once.
 * - `older-node`: this server keeps no copies yet: on this device only, and nothing sent.
 * - `later`: no answer, a refusal, or a write landed meanwhile: tried again on the next open, or after the next write.
 * - `unreadable`: the node's copy is no tool's document: the device's is kept, and the next write here replaces it.
 */
export type ToolCopyOutcome = 'off' | 'nothing' | 'taken' | 'put' | 'switched-off' | 'older-node' | 'later' | 'unreadable';

/** The `updatedAt` of a PUT the node kept, or null. */
function keptAt(answer: ToolNodeAnswer | null): string | null {
    if (!ok(answer) || !isObject(answer.json)) return null;
    const at = answer.json.updatedAt;
    return typeof at === 'string' && at ? at : null;
}

async function runStep<D>(manifest: ToolManifest<D>, device: ToolCopyDevice, node: ToolCopyNode, local: ToolLocalCopy | null, step: ToolSyncStep): Promise<ToolCopyOutcome> {
    switch (step.do) {
        case 'later': return 'later';
        case 'device-only': return 'older-node';
        case 'nothing': return 'nothing';
        case 'switch-off':
            await device.setSetting(false);
            return 'switched-off';
        case 'take': {
            const body = readTakenBody(manifest, step.body);
            if (body === null) return 'unreadable';
            return (await device.take(body, step.updatedAt, local)) ? 'taken' : 'later';
        }
        case 'put': {
            const body = local?.body ?? JSON.stringify(manifest.doc.empty());
            let doc: unknown;
            try { doc = JSON.parse(body); } catch { doc = null; }
            if (!isObject(doc)) return 'later';
            // Off as it goes is turning on; off only by its end is another device's or tab's off, made meanwhile.
            let offBefore = false;
            await device.mark((m, setting) => {
                offBefore = setting === false;
                return { ...m, unsure: m.unsure === 'check' ? 'check' : 'out' };
            });
            const answer = await answered(() => node.put(doc as Record<string, unknown>));
            // Going off meanwhile, it may have landed after the DELETE; unheard, it may land yet.
            await device.mark((m, setting) => (m.deleting || (setting === false && !offBefore) || !heard(answer)
                ? { ...m, unsure: 'check' }
                : m.unsure === 'out' ? { ...m, unsure: undefined } : m));
            if (answer?.status === 404) return 'older-node';
            const at = keptAt(answer);
            if (!at) return 'later';
            await device.sent(local, body, at);
            return 'put';
        }
    }
}

async function syncWith<D>(manifest: ToolManifest<D>, device: ToolCopyDevice, node: ToolCopyNode, intent: ToolSyncIntent): Promise<ToolCopyOutcome> {
    const local = await device.read();
    const remote = toolRemoteOf(await answered(() => node.get()));
    return runStep(manifest, device, node, local, reconcile(local, remote, intent));
}

/**
 * A tool's open, or the sync after a write: the GET and the step. While the setting is off, nothing; but a mark
 * ({@link ToolCopyMarks}) asks once whether the node's copy is gone, and DELETEs it again if not.
 */
export async function syncToolCopy<D>(manifest: ToolManifest<D>, device: ToolCopyDevice, node: ToolCopyNode): Promise<ToolCopyOutcome> {
    if (await device.setting() === false) {
        if ((await device.marks()).unsure) await checkGone(device, node);
        return 'off';
    }
    return syncWith(manifest, device, node, 'open');
}

/**
 * Off, with a PUT that may have landed after its DELETE: one GET, and the DELETE again if the node holds a copy. The mark
 * goes only once the node has said its copy is gone (none, deleted, or an older node, which keeps none); else it stays.
 */
async function checkGone(device: ToolCopyDevice, node: ToolCopyNode): Promise<boolean> {
    const remote = toolRemoteOf(await answered(() => node.get()));
    const gone = remote.kind === 'copy' ? deleted(await answered(() => node.delete()))
        : remote.kind === 'none' || remote.kind === 'deleted' || remote.kind === 'older-node';
    if (gone) await device.mark((m) => ({ ...m, unsure: undefined }));
    return gone;
}

/**
 * The member switches the copy on: the GET and the step as for turning on (the device's copy is sent, or the empty one
 * when it holds none, unless the node holds a newer one, which is taken), and only then the setting, on. `older-node`:
 * this server keeps no copies yet; `failed`: no answer or a refusal. Either way the setting is not written.
 */
export async function turnToolCopyOn<D>(manifest: ToolManifest<D>, device: ToolCopyDevice, node: ToolCopyNode): Promise<'on' | 'older-node' | 'failed'> {
    const done = await syncWith(manifest, device, node, 'turn-on');
    if (done === 'older-node') return 'older-node';
    if (done === 'later' || done === 'switched-off') return 'failed';
    await device.setSetting(true);
    return 'on';
}

/** A DELETE the node answered: it keeps no copy now (a 404: an older node, which never kept one). */
const deleted = (answer: ToolNodeAnswer | null): boolean => answer?.status === 404 || ok(answer);

/**
 * The DELETE, marked `deleting` while it is on its way (a PUT that ends meanwhile, in another tab, marks itself); once the
 * node has answered, the setting off. An `unsure` mark stays: the PUT it stands for may land after this DELETE too.
 */
async function deleteCopy(device: ToolCopyDevice, node: ToolCopyNode): Promise<boolean> {
    await device.mark((m) => ({ ...m, deleting: true }));
    const gone = deleted(await answered(() => node.delete()));
    if (gone) await device.setSetting(false);
    await device.mark((m) => ({ ...m, deleting: undefined }));
    return gone;
}

/** The member switches the copy off: the DELETE, then the setting, off. `failed`: the setting is not written. */
export async function turnToolCopyOff(device: ToolCopyDevice, node: ToolCopyNode): Promise<'off' | 'failed'> {
    return (await deleteCopy(device, node)) ? 'off' : 'failed';
}

/**
 * Remove my data, the node's part, first: the DELETE while the setting is on, and the setting off once it is answered
 * (off, the node keeps none, unless a mark says a PUT may have landed since: then it is asked, as an open would). True
 * when the node keeps no copy now: the host removes the device's and keeps the setting off, the one setting kept (with
 * the marks). False: the host removes nothing, so nothing removed comes back from the server on the next open.
 */
export async function removeToolCopy(device: ToolCopyDevice, node: ToolCopyNode): Promise<boolean> {
    if (await device.setting() === false) return !(await device.marks()).unsure || checkGone(device, node);
    return deleteCopy(device, node);
}

/** How long after the last write the sync runs: one PUT for a burst of typing, not one a keystroke. */
export const TOOL_COPY_PUSH_MS = 5_000;

/**
 * How a host keeps one key's work to one at a time beyond its own queue: the web's other tabs (Web Locks). It runs
 * `turn` once, holding the key until `turn` settles.
 */
export type ToolCopyAlone = (key: string, turn: () => Promise<void>) => Promise<unknown>;

/**
 * Each host's one queue of node-copy work, by a key of community, owner and tool: an open, a toggle and a removal run
 * one after another, and the sync after a write waits until no write has come for {@link TOOL_COPY_PUSH_MS}. A job's
 * caller hears its answer when the job has one (a request past {@link TOOL_COPY_ANSWER_MS} is no answer), but the next
 * job on the key starts only once every request of the one before has settled ({@link held}: the hosts let one go at the
 * limit), so a PUT in flight never lands after the DELETE that follows it. One the node may still take after being let
 * go is the marks' ({@link ToolCopyMarks}). `alone` holds the key beyond this queue too (the web's other tabs).
 */
export function createToolCopyQueue(delayMs: number = TOOL_COPY_PUSH_MS, alone?: ToolCopyAlone) {
    const chains = new Map<string, Promise<unknown>>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const out = new Map<string, Set<Promise<unknown>>>();
    const settled = async (key: string) => {
        for (let requests = out.get(key); requests?.size; requests = out.get(key)) await Promise.allSettled([...requests]);
    };
    const run = <T>(key: string, job: () => Promise<T>): Promise<T> => {
        let answer!: (result: Promise<T>) => void;
        const result = new Promise<T>((resolve) => { answer = resolve; });
        let ran = false;
        const turn = async () => {
            if (ran) return;
            ran = true;
            const done = Promise.resolve().then(job);
            answer(done);
            await done.catch(() => undefined);
            await settled(key);
        };
        const next = (chains.get(key) ?? Promise.resolve()).then(async () => {
            // A lock that fails, or answers without calling back, still lets the job run here, in this queue's order.
            if (alone) await Promise.resolve().then(() => alone(key, turn)).catch(() => undefined);
            await turn();
        });
        chains.set(key, next);
        void next.then(() => { if (chains.get(key) === next) chains.delete(key); });
        return result;
    };
    /**
     * `node` with each request held on `key` until it has settled, answered or not: the job after waits for it. The hosts
     * hand every job's node through here.
     */
    const held = (key: string, node: ToolCopyNode): ToolCopyNode => {
        const track = (request: () => Promise<ToolNodeAnswer | null>): Promise<ToolNodeAnswer | null> => {
            const sent = request();
            let requests = out.get(key);
            if (!requests) out.set(key, (requests = new Set()));
            const mine = requests;
            mine.add(sent);
            void sent.catch(() => undefined).then(() => {
                mine.delete(sent);
                if (!mine.size && out.get(key) === mine) out.delete(key);
            });
            return sent;
        };
        return { get: () => track(() => node.get()), put: (doc) => track(() => node.put(doc)), delete: () => track(() => node.delete()) };
    };
    const cancel = (key: string) => {
        const timer = timers.get(key);
        if (timer !== undefined) clearTimeout(timer);
        timers.delete(key);
    };
    return {
        run,
        held,
        /** After a write: `job` once, `delayMs` after the last call for this key. */
        later(key: string, job: () => Promise<unknown>): void {
            cancel(key);
            timers.set(key, setTimeout(() => {
                timers.delete(key);
                void run(key, job).catch(() => undefined);
            }, delayMs));
        },
        /** A sync after a write not yet run is dropped (turned off, removed). */
        cancel,
        /** Whether a sync after a write is waiting for this key. */
        waiting: (key: string) => timers.has(key),
    };
}
export type ToolCopyQueue = ReturnType<typeof createToolCopyQueue>;
