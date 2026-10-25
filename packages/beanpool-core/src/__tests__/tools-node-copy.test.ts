/**
 * The node copy's pure parts (scratch/tools/DESIGN-t04-node-copy-delete-fable.md §2, slice T0.4): the node's answer as the
 * sync rule reads it (today's node, which never says when a copy was deleted, and one of S2.1 that does), the owner's
 * path (never in a body), a taken copy through the tool's own read(), and the queue that runs one sync after a burst of
 * writes, and "off means gone" for a late PUT against fake nodes that order the writes as S2.2's does
 * (scratch/tools/DESIGN-t04-late-put-fable.md §5 tests 8–17). The steps themselves are tested through each host's own
 * store against one fake node (apps/native/utils/__tests__/tool-node-copy.test.ts and
 * apps/pwa/src/tools/__tests__/node-copy.test.ts).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { word } from '../words.js';
import {
    TOOL_COPY_ANSWER_MS, TOOL_COPY_PUSH_MS, createToolCopyQueue, readTakenBody, removeToolCopy, syncToolCopy, toolCopyPath, toolRemoteOf,
    turnToolCopyOff, turnToolCopyOn, withinAnswerTime,
    type ToolCopyAlone, type ToolCopyDevice, type ToolCopyNode, type ToolLocalCopy, type ToolManifest, type ToolNodeAnswer,
} from '../tools/index.js';

const T1 = '2026-10-20T01:00:00.000Z';

describe("the node's answer (toolRemoteOf)", () => {
    it('a copy, none, and none with a deletedAt (a node of S2.1) as deleted', () => {
        expect(toolRemoteOf({ status: 200, json: { tool: 'kit', doc: { v: 1, a: [1] }, updatedAt: T1, bytes: 13, max: 65536 } }))
            .toEqual({ kind: 'copy', body: '{"v":1,"a":[1]}', updatedAt: T1 });
        // Today's node: no field at all.
        expect(toolRemoteOf({ status: 200, json: { tool: 'kit', doc: null, updatedAt: null, bytes: 0, max: 65536 } })).toEqual({ kind: 'none' });
        expect(toolRemoteOf({ status: 200, json: { tool: 'kit', doc: null, updatedAt: null, deletedAt: null } })).toEqual({ kind: 'none' });
        expect(toolRemoteOf({ status: 200, json: { tool: 'kit', doc: null, updatedAt: null, deletedAt: T1 } })).toEqual({ kind: 'deleted', deletedAt: T1 });
    });

    it('a 404 is an older node; no answer, any other refusal or an answer that is no copy is offline', () => {
        expect(toolRemoteOf({ status: 404, json: null })).toEqual({ kind: 'older-node' });
        expect(toolRemoteOf({ status: 404, json: { error: 'Not a treasury' } })).toEqual({ kind: 'older-node' });
        for (const answer of [
            null, { status: 500, json: null }, { status: 401, json: { error: 'A signed request is required' } }, { status: 403, json: {} },
            { status: 200, json: null }, { status: 200, json: 'text' }, { status: 200, json: { doc: [1], updatedAt: T1 } },
            { status: 200, json: { doc: { v: 1 }, updatedAt: null } }, { status: 200, json: { doc: 'x', updatedAt: T1 } },
        ]) {
            expect(toolRemoteOf(answer), JSON.stringify(answer)).toEqual({ kind: 'offline' });
        }
    });
});

describe("the most the node keeps of a tool's document: its answers' `max`", () => {
    const KIT = { id: 'kit', permissions: ['node-copy'], doc: { version: 1, empty: () => ({ v: 1 }), read: (r: unknown) => r } } as unknown as ToolManifest;
    const T2 = '2026-10-20T02:00:00.000Z';
    /** A device holding a document of `bytes` bytes, never sent, and each `max` it heard. */
    function holding(bytes: number, setting?: boolean) {
        const body = JSON.stringify({ v: 1, pad: 'x'.repeat(bytes - '{"v":1,"pad":""}'.length) });
        expect(body.length).toBe(bytes);
        const d = { setting, heard: [] as number[], sent: 0 };
        const device: ToolCopyDevice = {
            read: async () => ({ body, updatedAt: T1, syncedAt: null }),
            take: async () => true,
            sent: async () => { d.sent++; },
            setting: async () => d.setting,
            setSetting: async (on) => { d.setting = on; },
            heardMax: async (max) => { d.heard.push(max); },
        };
        return { d, device };
    }
    /** A node that keeps nothing yet, answering `max` (or none) to a GET and a PUT, and what was sent to it. */
    function keeping(max: unknown) {
        const sent: string[] = [];
        const node: ToolCopyNode = {
            get: async () => { sent.push('GET'); return { status: 200, json: { tool: 'kit', doc: null, updatedAt: null, deletedAt: null, bytes: 0, ...(max === undefined ? {} : { max }) } }; },
            put: async (doc, turnOn) => { sent.push(turnOn ? 'PUT turn-on' : 'PUT'); return { status: 200, json: { success: true, tool: 'kit', updatedAt: T2, bytes: JSON.stringify(doc).length, ...(max === undefined ? {} : { max }) } }; },
            delete: async () => { sent.push('DELETE'); return { status: 200, json: { success: true } }; },
        };
        return { sent, node };
    }

    it("each GET's and PUT's `max` is handed to the device: the host's bound from then on", async () => {
        const { d, device } = holding(1_000);
        const { sent, node } = keeping(131_072);
        expect(await syncToolCopy(KIT, device, node)).toBe('put');
        expect(sent).toEqual(['GET', 'PUT']);
        expect(d.heard).toEqual([131_072, 131_072]);
    });

    it('a node that says no max, or one no node would say, is heard as nothing', async () => {
        for (const max of [undefined, null, 0, -5, '65536', 1.5, Number.POSITIVE_INFINITY]) {
            const { d, device } = holding(1_000);
            expect(await syncToolCopy(KIT, device, keeping(max).node), String(max)).toBe('put');
            expect(d.heard, String(max)).toEqual([]);
        }
    });

    it("never a PUT past the node's max: an older node's 64 KB keeps a 70 KB shed on the device, and nothing is sent", async () => {
        const { d, device } = holding(70_000);
        const old = keeping(65_536);
        // Said as what it is, too big for this node, never as no answer: the node answered.
        expect(await syncToolCopy(KIT, device, old.node)).toBe('too-big');
        expect(old.sent).toEqual(['GET']);
        expect(d.heard).toEqual([65_536]);
        expect(d.sent).toBe(0);
        // The member's switch-on there is too big, not "failed" (that is the offline line), and the setting is not written.
        const off = holding(70_000, false);
        const again = keeping(65_536);
        expect(await turnToolCopyOn(KIT, off.device, again.node)).toBe('too-big');
        expect(again.sent).toEqual(['GET']);
        expect(off.d.setting).toBe(false);
        // No answer at all is still "failed", whatever the device holds.
        const away = holding(70_000, false);
        const down: ToolCopyNode = { get: async () => null, put: async () => null, delete: async () => null };
        expect(await turnToolCopyOn(KIT, away.device, down)).toBe('failed');
        expect(away.d.setting).toBe(false);
        // A node that keeps 128 KB of it takes the same document.
        const { device: same } = holding(70_000);
        const now = keeping(131_072);
        expect(await syncToolCopy(KIT, same, now.node)).toBe('put');
        expect(now.sent).toEqual(['GET', 'PUT']);
        // Exactly at the max is not past it.
        const { device: edge } = holding(65_536);
        const at = keeping(65_536);
        expect(await syncToolCopy(KIT, edge, at.node)).toBe('put');
        expect(at.sent).toEqual(['GET', 'PUT']);
    });
});

describe("the owner's path: never a body field naming anyone", () => {
    it("the member's own route, or the enterprise's through its keeper route", () => {
        expect(toolCopyPath({ kind: 'member', publicKey: 'me' }, 'kit')).toBe('/api/tools/kit');
        expect(toolCopyPath({ kind: 'enterprise', publicKey: 'ab/cd' }, 'kit')).toBe('/api/treasury/ab%2Fcd/tools/kit');
    });
});

describe('a taken copy is read through the tool (readTakenBody)', () => {
    type Doc = { v: number; items: string[]; later?: unknown };
    const manifest = {
        id: 'kit', name: word('Sample tool'), line: word('A tool for the tests.'), icon: '🧪', shelf: 'stock', categories: 'all', owner: 'member',
        permissions: ['node-copy'], screens: ['main'], row: () => null, examples: [word('An example')],
        doc: {
            version: 2,
            empty: () => ({ v: 2, items: [] }),
            // Version 1 kept one name; version 2 a list. A newer version is kept whole.
            read: (raw: unknown): Doc => {
                const r = raw as Record<string, unknown>;
                if (r.v === 1) return { v: 2, items: typeof r.name === 'string' ? [r.name] : [] };
                if (typeof r.v === 'number' && r.v > 2) return r as unknown as Doc;
                return { v: 2, items: Array.isArray(r.items) ? r.items as string[] : [] };
            },
        },
    } as unknown as ToolManifest<Doc>;

    it('an older version is upgraded; a newer one is kept whole', () => {
        expect(readTakenBody(manifest, '{"v":1,"name":"Ladder"}')).toBe('{"v":2,"items":["Ladder"]}');
        expect(readTakenBody(manifest, '{"v":3,"items":[],"later":true}')).toBe('{"v":3,"items":[],"later":true}');
    });

    it("no document (not JSON, no numeric v: what the node answers for a row it couldn't read, or a read() that throws): null", () => {
        expect(readTakenBody(manifest, 'not json')).toBeNull();
        expect(readTakenBody(manifest, '{}')).toBeNull();
        expect(readTakenBody(manifest, '[1]')).toBeNull();
        expect(readTakenBody(manifest, '{"v":"1"}')).toBeNull();
        const throwing = { ...manifest, doc: { ...manifest.doc, read: () => { throw new Error('bad'); } } } as unknown as ToolManifest<Doc>;
        expect(readTakenBody(throwing, '{"v":1}')).toBeNull();
    });
});

describe('a server that never answers', () => {
    afterEach(() => { vi.useRealTimers(); });

    it("is no answer after TOOL_COPY_ANSWER_MS: the open is tried later, a toggle fails, and the tool's queue moves on", async () => {
        vi.useFakeTimers();
        const manifest = { id: 'kit', permissions: ['node-copy'], doc: { version: 1, empty: () => ({ v: 1 }), read: (r: unknown) => r } } as unknown as ToolManifest;
        const hangs = { get: () => new Promise<never>(() => {}), put: () => new Promise<never>(() => {}), delete: () => new Promise<never>(() => {}) };
        let setting: boolean | undefined;
        const device: ToolCopyDevice = {
            read: async () => ({ body: '{"v":1}', updatedAt: T1, syncedAt: null }), take: async () => true, sent: async () => {},
            setting: async () => setting, setSetting: async (on: boolean) => { setting = on; }, heardMax: async () => {},
        };
        // A node not handed through the queue's held(): the next job waits for no request of this one's (the hosts' do,
        // and let each go at the limit: below).
        const q = createToolCopyQueue();
        const open = q.run('k', () => syncToolCopy(manifest, device, hangs));
        const off = q.run('k', () => turnToolCopyOff(device, hangs));
        await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS - 1);
        let settled = false;
        void open.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await open).toBe('later');
        await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS);
        expect(await off).toBe('failed');
        expect(setting).toBeUndefined();
        const failing = { ...hangs, get: () => Promise.reject(new TypeError('Failed to fetch')) };
        expect(await syncToolCopy(manifest, device, failing)).toBe('later');
    });
});

describe('the queue (createToolCopyQueue)', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('one sync five seconds after the last write of a burst; another key waits on its own', async () => {
        vi.useFakeTimers();
        const q = createToolCopyQueue();
        const ran: string[] = [];
        for (let i = 0; i < 20; i++) {
            if (i > 0) await vi.advanceTimersByTimeAsync(400);
            q.later('a', async () => { ran.push(`a${i}`); });
        }
        q.later('b', async () => { ran.push('b'); });
        expect(ran).toEqual([]);
        await vi.advanceTimersByTimeAsync(TOOL_COPY_PUSH_MS - 1);
        expect(ran).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(ran).toEqual(['a19', 'b']);
        expect(q.waiting('a')).toBe(false);
    });

    it('a sync waiting is dropped by cancel; work for one key runs one after another, a failure not stopping the next', async () => {
        vi.useFakeTimers();
        const q = createToolCopyQueue();
        const ran: string[] = [];
        q.later('a', async () => { ran.push('dropped'); });
        expect(q.waiting('a')).toBe(true);
        q.cancel('a');
        await vi.advanceTimersByTimeAsync(TOOL_COPY_PUSH_MS * 2);
        expect(ran).toEqual([]);
        vi.useRealTimers();
        let release!: () => void;
        const first = q.run('k', () => new Promise<void>((r) => { release = () => { ran.push('first'); r(); }; }));
        const failing = q.run('k', async () => { ran.push('second'); throw new Error('refused'); });
        const third = q.run('k', async () => { ran.push('third'); return 3; });
        await new Promise((r) => setTimeout(r, 0));
        expect(ran).toEqual([]);
        release();
        await first;
        await expect(failing).rejects.toThrow('refused');
        expect(await third).toBe(3);
        expect(ran).toEqual(['first', 'second', 'third']);
    });
});

describe('off means gone, even when a slow PUT is on its way (PR #2297, the deciding review at d4fcc070)', () => {
    afterEach(() => { vi.useRealTimers(); });
    const T0 = '2026-10-20T00:00:00.000Z';
    const T2 = '2026-10-20T02:00:00.000Z';
    const T3 = '2026-10-20T03:00:00.000Z';
    const KIT = { id: 'kit', permissions: ['node-copy'], doc: { version: 1, empty: () => ({ v: 1 }), read: (r: unknown) => r } } as unknown as ToolManifest;

    /**
     * One server and the line to it, as the review measured: a PUT is taken when its body arrives, `putArrives` ms after
     * it is sent (whatever the host has stopped waiting for: `letGo`, the host letting it go at that time); a GET and a
     * DELETE at once, the DELETE's answer heard `deleteHeard` ms later. The server orders the writes as S2.2's does
     * (scratch/tools/DESIGN-t04-late-put-fable.md §3): a DELETE leaves a tombstone, with a copy or without; an ordinary PUT
     * arriving with no copy kept and a tombstone is refused 410 and writes nothing; a turn-on PUT writes. `oldNode` is a
     * node before S2.2 (S2.1: a tombstone only for a copy removed, and every PUT writes).
     */
    class Line {
        row: Record<string, unknown> | null = null;
        tomb = false;
        oldNode = false;
        sent: string[] = [];
        landed: string[] = [];
        down = false;
        putStatus = 200;
        deleteHeard = 0;
        constructor(public putArrives = 0, public letGo: number | null = null) {}
        node(): ToolCopyNode {
            return {
                get: async () => {
                    this.sent.push('GET');
                    if (this.down) return null;
                    return { status: 200, json: { doc: this.row, updatedAt: this.row ? T2 : null, deletedAt: !this.row && this.tomb ? T2 : null } };
                },
                put: (doc, turnOn) => {
                    this.sent.push(turnOn ? 'PUT turn-on' : 'PUT');
                    const arrives = new Promise<ToolNodeAnswer>((resolve) => setTimeout(() => {
                        if (!turnOn && !this.row && this.tomb && !this.oldNode) {
                            this.landed.push('PUT refused');
                            resolve({ status: 410, json: { error: 'tool_copy_off', deletedAt: T2 } });
                            return;
                        }
                        this.row = doc;
                        this.landed.push('PUT');
                        resolve({ status: this.putStatus, json: this.putStatus === 200 ? { updatedAt: T2 } : { error: 'Bad gateway' } });
                    }, this.putArrives));
                    const letGo = this.letGo;
                    return letGo === null ? arrives : Promise.race([arrives, new Promise<null>((resolve) => setTimeout(() => resolve(null), letGo))]);
                },
                delete: async () => {
                    this.sent.push('DELETE');
                    if (this.down) return null;
                    if (this.row || !this.oldNode) this.tomb = true;
                    this.row = null;
                    this.landed.push('DELETE');
                    if (this.deleteHeard) await new Promise((resolve) => setTimeout(resolve, this.deleteHeard));
                    return { status: 200, json: { success: true } };
                },
            };
        }
    }

    /** One device's store, which its tabs share: its copy (written, never synced) and its setting. */
    function deviceOf(setting?: boolean) {
        const d = { setting, updatedAt: T1, syncedAt: null as string | null };
        const store: ToolCopyDevice = {
            read: async () => ({ body: '{"v":1,"secret":"garden"}', updatedAt: d.updatedAt, syncedAt: d.syncedAt }),
            take: async () => true,
            sent: async (_was, _body, at) => { d.updatedAt = at; d.syncedAt = at; },
            setting: async () => d.setting,
            setSetting: async (on) => { d.setting = on; },
            heardMax: async () => {},
        };
        return { d, store };
    }

    /** A device holding `local` (never changed here), its setting, and each write to its copy (`wrote`). */
    function deviceHolding(local: ToolLocalCopy | null, setting?: boolean) {
        const d = { setting, wrote: [] as string[] };
        const store: ToolCopyDevice = {
            read: async () => local,
            take: async () => { d.wrote.push('take'); return true; },
            sent: async () => { d.wrote.push('sent'); },
            setting: async () => d.setting,
            setSetting: async (on) => { d.setting = on; },
            heardMax: async () => {},
        };
        return { d, store };
    }

    /** A node answering each route as given, and what was sent to it (a PUT with its kind). */
    function answering(get: ToolNodeAnswer | null, other: { put?: ToolNodeAnswer | null; delete?: ToolNodeAnswer | null } = {}) {
        const sent: string[] = [];
        const node: ToolCopyNode = {
            get: async () => { sent.push('GET'); return get; },
            put: async (_doc, turnOn) => {
                sent.push(turnOn ? 'PUT turn-on' : 'PUT');
                return other.put === undefined ? { status: 200, json: { updatedAt: T2 } } : other.put;
            },
            delete: async () => { sent.push('DELETE'); return other.delete === undefined ? { status: 200, json: { success: true } } : other.delete; },
        };
        return { sent, node };
    }
    const COPY = { status: 200, json: { doc: { v: 1, secret: 'garden' }, updatedAt: T2 } };
    const NONE = { status: 200, json: { doc: null, updatedAt: null } };
    const DELETED = { status: 200, json: { doc: null, updatedAt: null, deletedAt: T2 } };
    const GONE = { status: 410, json: { error: 'tool_copy_off', deletedAt: T2 } };
    /** A copy written here since its last sync (T0), later than the node's (T2). */
    const NEWER = { body: '{"v":1,"secret":"shed"}', updatedAt: T3, syncedAt: T0 };
    const UNSYNCED = { body: '{"v":1,"secret":"garden"}', updatedAt: T1, syncedAt: null };

    it('a PUT slower than the limit: no answer on time, the off waits for it, and the node ends with no copy', async () => {
        vi.useFakeTimers();
        const line = new Line(45_000);
        const { d, store } = deviceOf();
        const q = createToolCopyQueue();
        const node = q.held('k', line.node());
        const sync = q.run('k', () => syncToolCopy(KIT, store, node));
        const off = q.run('k', () => turnToolCopyOff(store, node));
        await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS);
        expect(await sync).toBe('later');
        expect(line.sent).toEqual(['GET', 'PUT']);
        await vi.advanceTimersByTimeAsync(45_000 - TOOL_COPY_ANSWER_MS);
        expect(await off).toBe('off');
        expect(line.landed).toEqual(['PUT', 'DELETE']);
        expect(line.row).toBeNull();
        expect(d.setting).toBe(false);
        // Off: the next open sends nothing at all.
        line.sent.length = 0;
        expect(await q.run('k', () => syncToolCopy(KIT, store, node))).toBe('off');
        expect(line.sent).toEqual([]);
    });

    it('a PUT let go at the limit that reaches the node after the DELETE all the same: the node refuses it, and the next open, off, sends nothing', async () => {
        vi.useFakeTimers();
        const line = new Line(45_000, TOOL_COPY_ANSWER_MS);
        const { d, store } = deviceOf();
        const q = createToolCopyQueue();
        const node = q.held('k', line.node());
        const sync = q.run('k', () => syncToolCopy(KIT, store, node));
        const off = q.run('k', () => turnToolCopyOff(store, node));
        await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS);
        expect(await sync).toBe('later');
        expect(await off).toBe('off');
        await vi.advanceTimersByTimeAsync(45_000 - TOOL_COPY_ANSWER_MS);
        // The review's order: the DELETE landed, then the PUT, an ordinary one over a removed copy: refused, nothing kept.
        expect(line.landed).toEqual(['DELETE', 'PUT refused']);
        expect(line.row).toBeNull();
        expect(d.setting).toBe(false);
        line.sent.length = 0;
        expect(await q.run('k', () => syncToolCopy(KIT, store, node))).toBe('off');
        expect(line.sent).toEqual([]);
        expect(line.row).toBeNull();
    });

    it('residual 1, a node before S2.2: the same late PUT is kept, and the next open, off, sends nothing (stated: it closes as nodes update)', async () => {
        vi.useFakeTimers();
        const line = new Line(45_000, TOOL_COPY_ANSWER_MS);
        line.oldNode = true;
        const { d, store } = deviceOf();
        const q = createToolCopyQueue();
        const node = q.held('k', line.node());
        void q.run('k', () => syncToolCopy(KIT, store, node));
        const off = q.run('k', () => turnToolCopyOff(store, node));
        await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS);
        expect(await off).toBe('off');
        await vi.advanceTimersByTimeAsync(45_000 - TOOL_COPY_ANSWER_MS);
        expect(line.landed).toEqual(['DELETE', 'PUT']);
        expect(line.row).toEqual({ v: 1, secret: 'garden' });
        expect(d.setting).toBe(false);
        line.sent.length = 0;
        expect(await q.run('k', () => syncToolCopy(KIT, store, node))).toBe('off');
        expect(line.sent).toEqual([]);
        expect(line.row).toEqual({ v: 1, secret: 'garden' });
    });

    it('a PUT answered 410 (its owner removed the copy): switched off, its copy here untouched, and the next open sends nothing', async () => {
        for (const [name, get, local] of [
            ["a default-on device's first PUT", NONE, UNSYNCED],
            ['an open whose copy here is newer', COPY, NEWER],
        ] as const) {
            const { d, store } = deviceHolding(local);
            const n = answering(get, { put: GONE });
            expect(await syncToolCopy(KIT, store, n.node), name).toBe('switched-off');
            expect(n.sent, name).toEqual(['GET', 'PUT']);
            expect([d.setting, d.wrote], name).toEqual([false, []]);
            n.sent.length = 0;
            expect(await syncToolCopy(KIT, store, n.node), name).toBe('off');
            expect(n.sent, name).toEqual([]);
        }
        // The member's switch-on writes over the removal: the node never refuses it.
        const line = new Line();
        line.tomb = true;
        const { d, store } = deviceOf(false);
        expect(await turnToolCopyOn(KIT, store, line.node())).toBe('on');
        expect([line.sent, line.landed, line.row, d.setting]).toEqual([['GET', 'PUT turn-on'], ['PUT'], { v: 1, secret: 'garden' }, true]);
    });

    it("the kind on the wire: every PUT of the member's switch-on says turnOn; an open's, a sync after a write's and a default-on device's first never do", async () => {
        vi.useFakeTimers();
        const q = createToolCopyQueue();
        const kinds = async (run: (node: ToolCopyNode) => Promise<unknown>, get: ToolNodeAnswer) => {
            const n = answering(get);
            await run(q.held('k', n.node));
            return n.sent;
        };
        // Switching on: the empty document or the device's (the node says none, or deleted), and a device-newer PUT.
        expect(await kinds((node) => turnToolCopyOn(KIT, deviceHolding(null, false).store, node), NONE)).toEqual(['GET', 'PUT turn-on']);
        expect(await kinds((node) => turnToolCopyOn(KIT, deviceHolding(UNSYNCED, false).store, node), DELETED)).toEqual(['GET', 'PUT turn-on']);
        expect(await kinds((node) => turnToolCopyOn(KIT, deviceHolding(NEWER, false).store, node), COPY)).toEqual(['GET', 'PUT turn-on']);
        // An open, and a default-on device's first-ever PUT: a default is not the member's act.
        expect(await kinds((node) => syncToolCopy(KIT, deviceHolding(NEWER, true).store, node), COPY)).toEqual(['GET', 'PUT']);
        expect(await kinds((node) => syncToolCopy(KIT, deviceHolding(UNSYNCED).store, node), NONE)).toEqual(['GET', 'PUT']);
        // The sync after a write.
        const n = answering(COPY);
        q.later('k', () => syncToolCopy(KIT, deviceHolding(NEWER, true).store, q.held('k', n.node)));
        await vi.advanceTimersByTimeAsync(TOOL_COPY_PUSH_MS);
        expect(n.sent).toEqual(['GET', 'PUT']);
    });

    it('off: an open and Remove my data send nothing at all; on, Remove is the DELETE, then the setting off', async () => {
        const { store } = deviceOf(false);
        const n = answering(COPY);
        expect(await syncToolCopy(KIT, store, n.node)).toBe('off');
        expect(await removeToolCopy(store, n.node)).toBe(true);
        expect(n.sent).toEqual([]);
        const on = deviceOf(true);
        expect(await removeToolCopy(on.store, n.node)).toBe(true);
        expect([n.sent, on.d.setting]).toEqual([['DELETE'], false]);
    });

    it("another tab's off while this tab's PUT is out, with no lock between them: the PUT lands after the DELETE and is refused; no copy, and both off", async () => {
        vi.useFakeTimers();
        for (const deleteHeard of [0, 20_000]) {
            const line = new Line(10_000);
            line.deleteHeard = deleteHeard;
            const { d, store } = deviceOf();
            const tabA = createToolCopyQueue();
            const tabB = createToolCopyQueue();
            const put = tabA.run('k', () => syncToolCopy(KIT, store, tabA.held('k', line.node())));
            await vi.advanceTimersByTimeAsync(0);
            expect(line.sent).toEqual(['GET', 'PUT']);
            const off = tabB.run('k', () => turnToolCopyOff(store, tabB.held('k', line.node())));
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await put).toBe('switched-off');
            await vi.advanceTimersByTimeAsync(deleteHeard);
            expect(await off).toBe('off');
            expect(line.landed).toEqual(['DELETE', 'PUT refused']);
            expect(line.row).toBeNull();
            // Nothing kept beside the setting, and the copy here as it was.
            expect(d, `DELETE heard after ${deleteHeard} ms`).toEqual({ setting: false, updatedAt: T1, syncedAt: null });
            line.sent.length = 0;
            expect(await tabB.run('k', () => syncToolCopy(KIT, store, tabB.held('k', line.node())))).toBe('off');
            expect(line.sent).toEqual([]);
        }
    });

    it("with a lock between the tabs (the web's Web Locks), the other tab's off waits for this tab's PUT: no copy", async () => {
        vi.useFakeTimers();
        const held = new Map<string, Promise<unknown>>();
        const lock: ToolCopyAlone = (key, turn) => {
            const next = (held.get(key) ?? Promise.resolve()).then(turn);
            held.set(key, next.catch(() => undefined));
            return next;
        };
        const line = new Line(10_000);
        const { d, store } = deviceOf();
        const tabA = createToolCopyQueue(TOOL_COPY_PUSH_MS, lock);
        const tabB = createToolCopyQueue(TOOL_COPY_PUSH_MS, lock);
        const put = tabA.run('k', () => syncToolCopy(KIT, store, tabA.held('k', line.node())));
        await vi.advanceTimersByTimeAsync(0);
        const off = tabB.run('k', () => turnToolCopyOff(store, tabB.held('k', line.node())));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(line.sent).toEqual(['GET', 'PUT']);
        await vi.advanceTimersByTimeAsync(5_000);
        expect([await put, await off]).toEqual(['put', 'off']);
        expect(line.landed).toEqual(['PUT', 'DELETE']);
        expect(line.row).toBeNull();
        expect(d.setting).toBe(false);
        // A lock that fails runs the job all the same, in the queue's own order.
        const failing = createToolCopyQueue(TOOL_COPY_PUSH_MS, () => Promise.reject(new Error('SecurityError')));
        expect(await failing.run('k', async () => 'ran')).toBe('ran');
    });

    it('Remove my data with a PUT out: its DELETE goes once the PUT has settled; refused, it says so and the setting stays', async () => {
        vi.useFakeTimers();
        const line = new Line(10_000);
        const { d, store } = deviceOf();
        const q = createToolCopyQueue();
        const node = q.held('k', line.node());
        void q.run('k', () => syncToolCopy(KIT, store, node));
        const removed = q.run('k', () => removeToolCopy(store, node));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(line.sent).toEqual(['GET', 'PUT']);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await removed).toBe(true);
        expect(line.landed).toEqual(['PUT', 'DELETE']);
        expect([line.row, d.setting]).toEqual([null, false]);
        const down = deviceOf();
        expect(await removeToolCopy(down.store, answering(COPY, { delete: null }).node)).toBe(false);
        expect(down.d.setting).toBeUndefined();
    });

    it("withinAnswerTime: the host's request gets the signal, let go at the limit; one answered in time is never let go", async () => {
        vi.useFakeTimers();
        let signal!: AbortSignal;
        const hung = withinAnswerTime((s) => {
            signal = s;
            return new Promise((_, reject) => s.addEventListener('abort', () => reject(new Error('aborted'))));
        });
        const failed = expect(hung).rejects.toThrow('aborted');
        await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS - 1);
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal.aborted).toBe(true);
        await failed;
        let quick!: AbortSignal;
        expect(await withinAnswerTime(async (s) => { quick = s; return 'answered'; })).toBe('answered');
        await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS * 2);
        expect(quick.aborted).toBe(false);
    });

    it("the marks are gone (scratch/tools/DESIGN-t04-late-put-fable.md §1): none on the device, none in the barrel, no hash in the node copy's file", async () => {
        // tsc refuses this line while ToolCopyDevice has either.
        const noMarks: 'marks' | 'mark' extends keyof ToolCopyDevice ? never : true = true;
        expect(noMarks).toBe(true);
        const barrel: Record<string, unknown> = await import('../tools/index.js');
        for (const name of ['toolCopyDigest', 'keptMarks', 'toolCopyMarksOf', 'checkGone']) expect(name in barrel, name).toBe(false);
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../tools/node-copy.ts'), 'utf8');
        expect(source).not.toMatch(/@noble\/hashes/);
        expect(source).not.toMatch(/ToolCopyMarks|nodeCopyMarks|digest/);
    });
});

describe('two devices on one node that orders the writes (S2.2): the four review sequences of PR #2297, with no mark', () => {
    const KIT = { id: 'kit', permissions: ['node-copy'], doc: { version: 1, empty: () => ({ v: 1 }), read: (r: unknown) => r } } as unknown as ToolManifest;

    /**
     * One server for every device, as engine/tool-state.ts keeps it with S2.2 (scratch/tools/DESIGN-t04-late-put-fable.md
     * §3): one row, stamped from its clock (which the devices' writes share, so later is later), its tombstone (a DELETE
     * leaves one, with a copy or without, and the GET says when), and what each device sent. An ordinary PUT arriving with
     * no row and a tombstone is refused 410 and writes nothing; a turn-on PUT writes. `oldNode` is a node before S2.2
     * (S2.1: a tombstone only for a copy removed, and every PUT writes). The next PUT can be `unheard` (the server takes
     * it and its answer is lost), `lost` (it never arrives) or `late` (it arrives when {@link land} is called, long after
     * the device let it go); `meanwhile` runs as the next PUT is on its way, before the server reads it.
     */
    class Server {
        row: { doc: Record<string, unknown>; updatedAt: string } | null = null;
        deletedAt: string | null = null;
        oldNode = false;
        clock = Date.parse('2026-10-21T08:00:00.000Z');
        sent: string[] = [];
        nextPut: Array<'unheard' | 'lost' | 'late'> = [];
        arriving: Array<{ doc: Record<string, unknown>; turnOn: boolean }> = [];
        meanwhile: (() => Promise<unknown>) | null = null;
        stamp() { return new Date(this.clock += 1000).toISOString(); }
        /** A PUT as the server reads it once its body has arrived. */
        write(doc: Record<string, unknown>, turnOn: boolean): ToolNodeAnswer {
            if (!turnOn && !this.row && this.deletedAt && !this.oldNode) return { status: 410, json: { error: 'tool_copy_off', deletedAt: this.deletedAt } };
            this.row = { doc, updatedAt: this.stamp() };
            return { status: 200, json: { success: true, updatedAt: this.row.updatedAt } };
        }
        node(name: string): ToolCopyNode {
            return {
                get: async () => {
                    this.sent.push(`${name} GET`);
                    return { status: 200, json: { doc: this.row?.doc ?? null, updatedAt: this.row?.updatedAt ?? null, deletedAt: this.row ? null : this.deletedAt } };
                },
                put: async (doc, turnOn) => {
                    this.sent.push(`${name} PUT${turnOn ? ' turn-on' : ''}`);
                    const how = this.nextPut.shift();
                    const body = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
                    if (how === 'lost') return null;
                    if (how === 'late') { this.arriving.push({ doc: body, turnOn }); return null; }
                    const meanwhile = this.meanwhile;
                    this.meanwhile = null;
                    if (meanwhile) await meanwhile();
                    const answer = this.write(body, turnOn);
                    return how === 'unheard' ? null : answer;
                },
                delete: async () => {
                    this.sent.push(`${name} DELETE`);
                    if (this.row || !this.oldNode) this.deletedAt = this.stamp();
                    this.row = null;
                    return { status: 200, json: { success: true } };
                },
            };
        }
        /** The `late` PUT sent `nth` (from 0) arrives now: the server's answer, which no device hears. */
        land(nth = 0) { return this.write(this.arriving[nth].doc, this.arriving[nth].turnOn); }
    }

    /** One device on the server: its copy and its setting; `write` is the member's edit there. */
    function device(server: Server, name: string, body: string) {
        const d = { body, updatedAt: server.stamp(), syncedAt: null as string | null, setting: undefined as boolean | undefined };
        const store: ToolCopyDevice = {
            read: async () => ({ body: d.body, updatedAt: d.updatedAt, syncedAt: d.syncedAt }),
            take: async (b, at) => { Object.assign(d, { body: b, updatedAt: at, syncedAt: at }); return true; },
            sent: async (_was, _b, at) => { Object.assign(d, { updatedAt: at, syncedAt: at }); },
            setting: async () => d.setting,
            setSetting: async (on) => { d.setting = on; },
            heardMax: async () => {},
        };
        const node = server.node(name);
        return {
            d,
            write: (b: string) => { Object.assign(d, { body: b, updatedAt: server.stamp() }); },
            open: () => syncToolCopy(KIT, store, node),
            on: () => turnToolCopyOn(KIT, store, node),
            off: () => turnToolCopyOff(store, node),
            remove: () => removeToolCopy(store, node),
        };
    }

    it("the review's seven steps (8a48f318): one PUT unheard and one heard since, off on A, on again on B; A's open sends nothing, B stays on", async () => {
        const server = new Server();
        const A = device(server, 'A', '{"v":1,"beds":["a"]}');
        const B = device(server, 'B', '{"v":1,"beds":["mine"]}');
        expect(await A.on()).toBe('on');
        // A's sync after a write: the server takes the PUT, and its answer is lost.
        A.write('{"v":1,"beds":["a","b"]}');
        server.nextPut.push('unheard');
        expect(await A.open()).toBe('later');
        A.write('{"v":1,"beds":["a","b","c"]}');
        expect(await A.open()).toBe('put');
        expect(await A.off()).toBe('off');
        expect(await B.on()).toBe('on');
        expect(server.row?.doc).toEqual({ v: 1, beds: ['mine'] });
        // A, still off, is opened: it does nothing until its member turns it on (design §1, "On again on B").
        server.sent.length = 0;
        expect(await A.open()).toBe('off');
        expect(server.sent).toEqual([]);
        expect(server.row?.doc).toEqual({ v: 1, beds: ['mine'] });
        expect(await B.open()).toBe('nothing');
        expect(B.d.setting).toBe(true);
    });

    it("B takes A's unheard PUT, then switches it off; A's open switches A off: B on again, unedited, stays on (review at be7ee9ed)", async () => {
        const server = new Server();
        const A = device(server, 'A', '{"v":1,"beds":["a"]}');
        const B = device(server, 'B', '{"v":1,"beds":["old"]}');
        expect(await A.on()).toBe('on');
        A.write('{"v":1,"beds":["a","b"]}');
        server.nextPut.push('unheard');
        expect(await A.open()).toBe('later');
        // B opens and takes that very copy (the node's is newer than B's own), then the member switches it off there.
        expect(await B.open()).toBe('taken');
        expect(await B.off()).toBe('off');
        expect(await A.open()).toBe('switched-off');
        // Later the member switches the copy on again on B, unedited: B's body is A's old one.
        expect(await B.on()).toBe('on');
        expect(server.row?.doc).toEqual({ v: 1, beds: ['a', 'b'] });
        server.sent.length = 0;
        expect(await A.open()).toBe('off');
        expect(server.sent).toEqual([]);
        expect(server.row?.doc).toEqual({ v: 1, beds: ['a', 'b'] });
        expect(await B.open()).toBe('nothing');
        expect(B.d.setting).toBe(true);
    });

    it("A's unheard PUT landed, B and A both take it, off on A, on again on B unedited: A's open and Remove my data send nothing, B stays on (review at 8f50f26d)", async () => {
        for (const how of ['open', 'remove'] as const) {
            const server = new Server();
            const A = device(server, 'A', '{"v":1,"beds":["a"]}');
            const B = device(server, 'B', '{"v":1,"beds":["old"]}');
            expect(await A.on(), how).toBe('on');
            A.write('{"v":1,"beds":["a","b"]}');
            server.nextPut.push('unheard');
            expect(await A.open(), how).toBe('later');
            expect(await B.open(), how).toBe('taken');
            // A is opened again: the node's copy (A's own PUT, stamped as it arrived) is newer than A's write, so A takes it.
            expect(await A.open(), how).toBe('taken');
            expect(await A.open(), how).toBe('nothing');
            expect(await A.off(), how).toBe('off');
            expect(await B.on(), how).toBe('on');
            expect(server.row?.doc, how).toEqual({ v: 1, beds: ['a', 'b'] });
            server.sent.length = 0;
            expect(await (how === 'open' ? A.open() : A.remove()), how).toBe(how === 'open' ? 'off' : true);
            expect(server.sent, how).toEqual([]);
            expect(server.row?.doc, how).toEqual({ v: 1, beds: ['a', 'b'] });
            expect(await B.open(), how).toBe('nothing');
            expect(B.d.setting, how).toBe(true);
        }
    });

    it("the trade-off at 8f50f26d: A's let-go PUT lands after B's DELETE and A's GET; the node refuses it, so no copy is left while every device is off", async () => {
        for (const oldNode of [false, true]) {
            const server = new Server();
            server.oldNode = oldNode;
            const A = device(server, 'A', '{"v":1,"beds":["a"]}');
            const B = device(server, 'B', '{"v":1,"beds":["old"]}');
            expect(await A.on()).toBe('on');
            A.write('{"v":1,"beds":["a","b"]}');
            server.nextPut.push('late');
            expect(await A.open()).toBe('later');
            expect(await B.open()).toBe('taken');
            expect(await B.off()).toBe('off');
            expect(await A.open()).toBe('switched-off');
            const landed = server.land(0);
            if (!oldNode) {
                expect(landed).toEqual({ status: 410, json: { error: 'tool_copy_off', deletedAt: server.deletedAt } });
                expect(server.row).toBeNull();
            } else {
                // Residual 1: a node before S2.2 keeps it, and no device asks about it while off.
                expect(server.row?.doc).toEqual({ v: 1, beds: ['a', 'b'] });
            }
            server.sent.length = 0;
            expect([await A.open(), await B.open()], `oldNode ${oldNode}`).toEqual(['off', 'off']);
            expect(server.sent, `oldNode ${oldNode}`).toEqual([]);
        }
    });

    it("A's own late PUT, either of two let go in a row, lands after A's off: refused, no copy, and A's open sends nothing", async () => {
        for (const nth of [0, 1]) {
            const server = new Server();
            const A = device(server, 'A', '{"v":1,"beds":["a"]}');
            expect(await A.on()).toBe('on');
            A.write('{"v":1,"beds":["a","b"]}');
            server.nextPut.push('late');
            expect(await A.open()).toBe('later');
            A.write('{"v":1,"beds":["a","b","c"]}');
            server.nextPut.push('late');
            expect(await A.open()).toBe('later');
            expect(await A.off()).toBe('off');
            expect(server.land(nth).status, `PUT ${nth}`).toBe(410);
            expect(server.row, `PUT ${nth}`).toBeNull();
            server.sent.length = 0;
            expect(await A.open(), `PUT ${nth}`).toBe('off');
            expect(server.sent, `PUT ${nth}`).toEqual([]);
        }
    });

    it("A off with a PUT unheard, B on with its own document: A's open (or Remove my data) sends nothing and leaves B's copy; B stays on", async () => {
        for (const how of ['open', 'remove'] as const) {
            const server = new Server();
            const A = device(server, 'A', '{"v":1,"beds":["a"]}');
            const B = device(server, 'B', '{"v":1,"beds":["mine"]}');
            expect(await A.on(), how).toBe('on');
            A.write('{"v":1,"beds":["a","b"]}');
            server.nextPut.push('unheard');
            expect(await A.open(), how).toBe('later');
            expect(await A.off(), how).toBe('off');
            expect(await B.on(), how).toBe('on');
            server.sent.length = 0;
            expect(await (how === 'open' ? A.open() : A.remove()), how).toBe(how === 'open' ? 'off' : true);
            expect(server.sent, how).toEqual([]);
            expect(server.row?.doc, how).toEqual({ v: 1, beds: ['mine'] });
            expect(await B.open(), how).toBe('nothing');
            expect(B.d.setting, how).toBe(true);
        }
    });

    it('a PUT unheard (taken or lost), then a later one heard; once off, the open sends nothing', async () => {
        for (const how of ['unheard', 'lost'] as const) {
            const server = new Server();
            const A = device(server, 'A', '{"v":1,"beds":["a"]}');
            expect(await A.on(), how).toBe('on');
            A.write('{"v":1,"beds":["a","b"]}');
            server.nextPut.push(how);
            expect(await A.open(), how).toBe('later');
            A.write('{"v":1,"beds":["a","b","c"]}');
            expect(await A.open(), how).toBe('put');
            expect(await A.off(), how).toBe('off');
            server.sent.length = 0;
            expect(await A.open(), how).toBe('off');
            expect(server.sent, how).toEqual([]);
        }
    });

    it("another device's DELETE between this device's GET and its PUT: the PUT is refused, this device switches off, and no copy comes back", async () => {
        for (const oldNode of [false, true]) {
            const server = new Server();
            server.oldNode = oldNode;
            const A = device(server, 'A', '{"v":1,"beds":["a"]}');
            const B = device(server, 'B', '{"v":1,"beds":["b"]}');
            expect(await A.on()).toBe('on');
            A.write('{"v":1,"beds":["a","b"]}');
            server.sent.length = 0;
            server.meanwhile = () => B.off();
            if (!oldNode) {
                expect(await A.open()).toBe('switched-off');
                expect(server.sent).toEqual(['A GET', 'A PUT', 'B DELETE']);
                expect([server.row, A.d.setting, B.d.setting]).toEqual([null, false, false]);
                expect(A.d.body).toBe('{"v":1,"beds":["a","b"]}');
            } else {
                // A node before S2.2 took that PUT and put the copy back while B was off (what the marks never covered).
                expect(await A.open()).toBe('put');
                expect([server.row?.doc, A.d.setting, B.d.setting]).toEqual([{ v: 1, beds: ['a', 'b'] }, true, false]);
            }
        }
    });

    it("residual 2: A's let-go PUT lands after B's off and B's on again: the node keeps A's body (a copy is on, as asked), and B's next open takes it (stated)", async () => {
        const server = new Server();
        const A = device(server, 'A', '{"v":1,"beds":["a"]}');
        const B = device(server, 'B', '{"v":1,"beds":["mine"]}');
        expect(await A.on()).toBe('on');
        A.write('{"v":1,"beds":["a","b"]}');
        server.nextPut.push('late');
        expect(await A.open()).toBe('later');
        expect(await B.off()).toBe('off');
        expect(await B.on()).toBe('on');
        expect(server.row?.doc).toEqual({ v: 1, beds: ['mine'] });
        expect(server.land(0).status).toBe(200);
        expect(server.row?.doc).toEqual({ v: 1, beds: ['a', 'b'] });
        expect(await B.open()).toBe('taken');
        expect(B.d.body).toBe('{"v":1,"beds":["a","b"]}');
        expect([A.d.setting, B.d.setting]).toEqual([true, true]);
    });

    it("residual 3: a turn-on PUT let go that lands anyway: the toggle failed and stays off, the node keeps the copy asked for, and the next on takes it (stated)", async () => {
        const server = new Server();
        const A = device(server, 'A', '{"v":1,"beds":["a"]}');
        expect(await A.on()).toBe('on');
        expect(await A.off()).toBe('off');
        server.nextPut.push('late');
        expect(await A.on()).toBe('failed');
        expect(A.d.setting).toBe(false);
        // It lands over the tombstone: a turn-on writes.
        expect(server.land(0).status).toBe(200);
        expect(server.row?.doc).toEqual({ v: 1, beds: ['a'] });
        server.sent.length = 0;
        expect(await A.open()).toBe('off');
        expect(server.sent).toEqual([]);
        expect(await A.on()).toBe('on');
        expect(server.sent).toEqual(['A GET']);
        expect(A.d.syncedAt).toBe(server.row?.updatedAt);
    });
});
