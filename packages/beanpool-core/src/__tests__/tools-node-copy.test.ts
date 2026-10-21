/**
 * The node copy's pure parts (scratch/tools/DESIGN-t04-node-copy-delete-fable.md §2, slice T0.4): the node's answer as the
 * sync rule reads it (today's node, which never says when a copy was deleted, and one of S2.1 that does), the owner's
 * path (never in a body), a taken copy through the tool's own read(), and the queue that runs one sync after a burst of
 * writes. The steps themselves are tested through each host's own store against one fake node
 * (apps/native/utils/__tests__/tool-node-copy.test.ts and apps/pwa/src/tools/__tests__/node-copy.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { word } from '../words.js';
import {
    TOOL_COPY_ANSWER_MS, TOOL_COPY_PUSH_MS, createToolCopyQueue, readTakenBody, removeToolCopy, syncToolCopy, toolCopyPath, toolRemoteOf,
    turnToolCopyOff, turnToolCopyOn, withinAnswerTime,
    type ToolCopyAlone, type ToolCopyDevice, type ToolCopyMarks, type ToolCopyNode, type ToolManifest, type ToolNodeAnswer,
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

describe("the owner's path: never a body field naming anyone", () => {
    it("the member's own route, or the enterprise's through its keeper route", () => {
        expect(toolCopyPath({ kind: 'member', publicKey: 'me' }, 'kit')).toBe('/api/tools/kit');
        expect(toolCopyPath({ kind: 'enterprise', publicKey: 'ab/cd' }, 'kit')).toBe('/api/treasury/ab%2Fcd/tools/kit');
    });
});

describe('a taken copy is read through the tool (readTakenBody)', () => {
    type Doc = { v: number; items: string[]; later?: unknown };
    const manifest = {
        id: 'kit', name: word('Sample tool'), line: word('A tool for the tests.'), icon: '🧪', shelf: 'stock', shopKinds: 'all', owner: 'member',
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
        let marks: ToolCopyMarks = {};
        const device: ToolCopyDevice = {
            read: async () => ({ body: '{"v":1}', updatedAt: T1, syncedAt: null }), take: async () => true, sent: async () => {},
            setting: async () => setting, setSetting: async (on: boolean) => { setting = on; },
            marks: async () => marks, mark: async (change) => { marks = change(marks, setting); },
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
    const T2 = '2026-10-20T02:00:00.000Z';
    const KIT = { id: 'kit', permissions: ['node-copy'], doc: { version: 1, empty: () => ({ v: 1 }), read: (r: unknown) => r } } as unknown as ToolManifest;

    /**
     * One server and the line to it, as the review measured: a PUT is taken when its body arrives, `putArrives` ms after
     * it is sent (whatever the host has stopped waiting for: `letGo`, the host letting it go at that time); a GET and a
     * DELETE at once, the DELETE's answer heard `deleteHeard` ms later.
     */
    class Line {
        row: Record<string, unknown> | null = null;
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
                    return this.down ? null : { status: 200, json: { doc: this.row, updatedAt: this.row ? T2 : null } };
                },
                put: (doc) => {
                    this.sent.push('PUT');
                    const arrives = new Promise<ToolNodeAnswer>((resolve) => setTimeout(() => {
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
                    this.row = null;
                    this.landed.push('DELETE');
                    if (this.deleteHeard) await new Promise((resolve) => setTimeout(resolve, this.deleteHeard));
                    return { status: 200, json: { success: true } };
                },
            };
        }
    }

    /** One device's store, which its tabs share: its copy (written, never synced), its setting and the marks beside it. */
    function deviceOf(setting?: boolean, marks: ToolCopyMarks = {}) {
        const d = { setting, marks, updatedAt: T1, syncedAt: null as string | null };
        const store: ToolCopyDevice = {
            read: async () => ({ body: '{"v":1,"secret":"garden"}', updatedAt: d.updatedAt, syncedAt: d.syncedAt }),
            take: async () => true,
            sent: async (_was, _body, at) => { d.updatedAt = at; d.syncedAt = at; },
            setting: async () => d.setting,
            setSetting: async (on) => { d.setting = on; },
            marks: async () => d.marks,
            mark: async (change) => { d.marks = change(d.marks, d.setting); },
        };
        return { d, store };
    }

    /** A node answering each route as given, and what was sent to it. */
    function answering(get: ToolNodeAnswer | null, other: { put?: ToolNodeAnswer | null; delete?: ToolNodeAnswer | null } = {}) {
        const sent: string[] = [];
        const node: ToolCopyNode = {
            get: async () => { sent.push('GET'); return get; },
            put: async () => { sent.push('PUT'); return other.put === undefined ? { status: 200, json: { updatedAt: T2 } } : other.put; },
            delete: async () => { sent.push('DELETE'); return other.delete === undefined ? { status: 200, json: { success: true } } : other.delete; },
        };
        return { sent, node };
    }
    const COPY = { status: 200, json: { doc: { v: 1, secret: 'garden' }, updatedAt: T2 } };
    const NONE = { status: 200, json: { doc: null, updatedAt: null } };

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
        // Its end went unheard (no one was listening by then): the next open asks once whether the copy is gone. It is.
        expect(d.marks.unsure).toBe('check');
        line.sent.length = 0;
        expect(await q.run('k', () => syncToolCopy(KIT, store, node))).toBe('off');
        expect(line.sent).toEqual(['GET']);
        expect(d.marks.unsure).toBeUndefined();
        line.sent.length = 0;
        expect(await q.run('k', () => syncToolCopy(KIT, store, node))).toBe('off');
        expect(line.sent).toEqual([]);
    });

    it('a PUT let go at the limit that reaches the node after the DELETE all the same: the next open, off, DELETEs it again', async () => {
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
        // The review's order: the DELETE landed, then the PUT, and the server holds the copy again.
        expect(line.landed).toEqual(['DELETE', 'PUT']);
        expect(line.row).toEqual({ v: 1, secret: 'garden' });
        expect([d.setting, d.marks.unsure]).toEqual([false, 'check']);
        line.sent.length = 0;
        expect(await q.run('k', () => syncToolCopy(KIT, store, node))).toBe('off');
        expect(line.sent).toEqual(['GET', 'DELETE']);
        expect(line.row).toBeNull();
        expect(d.marks.unsure).toBeUndefined();
    });

    it('marked and off, the next open asks once: a copy there is DELETEd; the mark goes only once the node says none', async () => {
        const DELETED = { status: 200, json: { doc: null, updatedAt: null, deletedAt: T2 } };
        for (const [name, get, sent, cleared] of [
            ['a copy there', COPY, ['GET', 'DELETE'], true],
            ['none', NONE, ['GET'], true],
            ['deleted (S2.1)', DELETED, ['GET'], true],
            ['an older node', { status: 404, json: null }, ['GET'], true],
            ['offline', null, ['GET'], false],
            ['refusing', { status: 500, json: null }, ['GET'], false],
        ] as const) {
            const { d, store } = deviceOf(false, { unsure: 'check' });
            const n = answering(get);
            expect(await syncToolCopy(KIT, store, n.node), name).toBe('off');
            expect(n.sent, name).toEqual(sent);
            expect(d.marks.unsure, name).toBe(cleared ? undefined : 'check');
        }
        // The copy there and its DELETE unanswered: the mark stays, for the open after.
        const { d, store } = deviceOf(false, { unsure: 'check' });
        const n = answering(COPY, { delete: null });
        expect(await syncToolCopy(KIT, store, n.node)).toBe('off');
        expect([n.sent, d.marks.unsure]).toEqual([['GET', 'DELETE'], 'check']);
        // A PUT still `out` (its tab closed before it ended) is a mark too.
        const closed = deviceOf(false, { unsure: 'out' });
        const m = answering(COPY);
        await syncToolCopy(KIT, closed.store, m.node);
        expect([m.sent, closed.d.marks.unsure]).toEqual([['GET', 'DELETE'], undefined]);
    });

    it("unmarked and off: the open sends nothing at all (the design's rule)", async () => {
        const { store } = deviceOf(false);
        const n = answering(COPY);
        expect(await syncToolCopy(KIT, store, n.node)).toBe('off');
        expect(await removeToolCopy(store, n.node)).toBe(true);
        expect(n.sent).toEqual([]);
    });

    it('a PUT the node answered leaves no mark (kept, or refused with a 4xx); one unheard (no answer, a 5xx) does', async () => {
        for (const [name, put, mark] of [
            ['kept', undefined, undefined],
            ['refused, 413', { status: 413, json: { error: 'Too big' } }, undefined],
            ['an older node', { status: 404, json: null }, undefined],
            ['no answer', null, 'check'],
            ['a proxy that gave up, 524', { status: 524, json: null }, 'check'],
        ] as const) {
            const { d, store } = deviceOf();
            const n = answering(NONE, { put });
            await syncToolCopy(KIT, store, n.node);
            expect(n.sent, name).toEqual(['GET', 'PUT']);
            expect(d.marks.unsure, name).toBe(mark);
            // Then off: the open after asks again only for the one unheard.
            expect(await turnToolCopyOff(store, n.node), name).toBe('off');
            expect(d.marks.deleting, name).toBeUndefined();
            n.sent.length = 0;
            await syncToolCopy(KIT, store, n.node);
            expect(n.sent, name).toEqual(mark ? ['GET'] : []);
        }
        // Turning on from off sends its PUT while the setting is still off: that is no off made meanwhile.
        const { d, store } = deviceOf(false);
        expect(await turnToolCopyOn(KIT, store, answering(NONE).node)).toBe('on');
        expect([d.setting, d.marks.unsure]).toEqual([true, undefined]);
        // A mark from a PUT unheard stays through later PUTs that are heard: only a node saying its copy is gone clears it.
        const marked = deviceOf(undefined, { unsure: 'check' });
        await syncToolCopy(KIT, marked.store, answering(NONE).node);
        expect(marked.d.marks.unsure).toBe('check');
    });

    it("another tab's off while this tab's PUT is out, with no lock between them: whichever is heard first, the next open DELETEs it", async () => {
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
            expect(await put).toBe('put');
            await vi.advanceTimersByTimeAsync(deleteHeard);
            expect(await off).toBe('off');
            expect(line.landed).toEqual(['DELETE', 'PUT']);
            expect(line.row).not.toBeNull();
            expect([d.setting, d.marks], `DELETE heard after ${deleteHeard} ms`).toEqual([false, { unsure: 'check', deleting: undefined }]);
            line.deleteHeard = 0;
            expect(await tabB.run('k', () => syncToolCopy(KIT, store, tabB.held('k', line.node())))).toBe('off');
            expect(line.row).toBeNull();
            expect(d.marks.unsure).toBeUndefined();
        }
    });

    it("with a lock between the tabs (the web's Web Locks), the other tab's off waits for this tab's PUT: no copy, and no mark", async () => {
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
        expect([d.setting, d.marks.unsure]).toEqual([false, undefined]);
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
        expect([line.row, d.setting, d.marks.unsure]).toEqual([null, false, undefined]);
        const down = deviceOf();
        expect(await removeToolCopy(down.store, answering(COPY, { delete: null }).node)).toBe(false);
        expect([down.d.setting, down.d.marks]).toEqual([undefined, { deleting: undefined }]);
        // Off and marked: Remove asks, as the open would, and is true only once the node's copy is gone.
        const marked = deviceOf(false, { unsure: 'check' });
        expect(await removeToolCopy(marked.store, answering(COPY, { delete: null }).node)).toBe(false);
        expect(await removeToolCopy(marked.store, answering(COPY).node)).toBe(true);
        expect(marked.d.marks.unsure).toBeUndefined();
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
});
