/**
 * The node copy's pure parts (scratch/tools/DESIGN-t04-node-copy-delete-fable.md §2, slice T0.4): the node's answer as the
 * sync rule reads it (today's node, which never says when a copy was deleted, and one of S2.1 that does), the owner's
 * path (never in a body), a taken copy through the tool's own read(), and the queue that runs one sync after a burst of
 * writes. The steps themselves are tested through each host's own store against one fake node
 * (apps/native/utils/__tests__/tool-node-copy.test.ts and apps/pwa/src/tools/__tests__/node-copy.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { word } from '../words.js';
import { TOOL_COPY_PUSH_MS, createToolCopyQueue, readTakenBody, toolCopyPath, toolRemoteOf, type ToolManifest } from '../tools/index.js';

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
