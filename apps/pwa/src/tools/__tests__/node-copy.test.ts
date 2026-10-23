/**
 * The node copy on the web, two browsers against one community server (scratch/tools/DESIGN-tool-template-fable.md §1.6,
 * DESIGN-t04-node-copy-delete-fable.md §5 tests 5–12, slice T0.4): the phone's list (apps/native/utils/__tests__/
 * tool-node-copy.test.ts) again, through tools/node-copy.ts with the web's real store (each browser its own IndexedDB,
 * lib/memory-indexeddb.ts) and the app's signed helper (lib/api.ts signedFetch), its fetch answered by one fake node that
 * keeps rows and tombstones as engine/tool-state.ts does: today's (S2, never a `deletedAt`), S2.1's (`deletedAt` once
 * deleted) or S2.2's (it orders the writes: an ordinary PUT over a removed copy is 410), 404 as an older node, nothing
 * when down, and 500 when refusing.
 *
 * The page's words and order (Remove my data, the toggle's failure line, the line once) are in tools-template.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_COPY_ANSWER_MS, TOOL_COPY_PUSH_MS, word, type ToolManifest } from '@beanpool/core';
import { memoryIndexedDB, type MemoryIndexedDB } from '../../lib/memory-indexeddb';
import { beginAccountEpoch, endAccountEpoch, resetAccountEpochForTest } from '../../lib/account-epoch';
import { keepToolDoc, patchToolSettings, readToolRecord, readToolSettings, resetToolStoreForTest, type ToolSettings } from '../store';
import { keepsNodeCopy, openToolCopy, removeToolCopyFirst, switchToolCopy, toolCopyAfterWrite, type WebToolCopy } from '../node-copy';
import { readDoc } from '../builder';

const NODE = 'https://mullum.example';
const ME = 'me-key';
const iso = (ms: number) => new Date(ms).toISOString();

/** One community server's tool store, as engine/tool-state.ts keeps it. */
class FakeNode {
    rows = new Map<string, { doc: Record<string, unknown>; updatedAt: string }>();
    tombs = new Map<string, string>();
    log: Array<{ method: string; path: string; body?: unknown; signer: string }> = [];
    /** S2.1's GET: `deletedAt` when no row is kept. Today's node (S2) never sends it. */
    sendsDeletedAt = false;
    /**
     * S2.2's order (scratch/tools/DESIGN-t04-late-put-fable.md §3), with S2.1's `deletedAt`: a DELETE leaves a tombstone
     * with no copy kept too, and an ordinary PUT (no `turnOn: true`) arriving with no row and a tombstone is refused 410
     * `tool_copy_off`, nothing written; the member's switch-on writes.
     */
    refusesOff = false;
    /** The `max` each GET and PUT answers: 65536, every tool's on a node from before a tool could name more. */
    max = 65536;
    /** Runs once as the next PUT arrives, before the node reads it (another browser's request landing first). */
    beforePut: (() => void) | null = null;
    mode: 'up' | 'down' | 'refusing' | 'older' = 'up';
    keepers = new Map<string, Set<string>>();
    clock = Date.parse('2026-10-21T08:00:00.000Z');

    count(method: string) { return this.log.filter((r) => r.method === method).length; }
    answer(method: string, path: string, body: unknown, signer: string): { status: number; json: unknown } | null {
        const before = method === 'PUT' ? this.beforePut : null;
        if (before) {
            this.beforePut = null;
            before();
        }
        this.log.push({ method, path, body, signer });
        if (this.mode === 'down') return null;
        if (this.mode === 'older') return { status: 404, json: null };
        if (this.mode === 'refusing') return { status: 500, json: { error: 'Something went wrong' } };
        const m = /^\/api\/(?:treasury\/([^/]+)\/)?tools\/([a-z0-9-]+)$/.exec(path);
        if (!m) return { status: 404, json: null };
        const tool = m[2];
        const owner = m[1] ? decodeURIComponent(m[1]) : signer;
        if (m[1] && !this.keepers.get(owner)?.has(signer)) return { status: 403, json: { error: 'You are not a keeper of this enterprise' } };
        const key = `${owner}|${tool}`;
        const now = (this.clock += 1000);
        const row = this.rows.get(key);
        if (method === 'GET') {
            return { status: 200, json: { tool, doc: row?.doc ?? null, updatedAt: row?.updatedAt ?? null, bytes: 0, max: this.max, ...(this.sendsDeletedAt || this.refusesOff ? { deletedAt: row ? null : this.tombs.get(key) ?? null } : {}) } };
        }
        if (method === 'PUT') {
            const doc = (body as { doc?: unknown } | null)?.doc;
            if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { status: 400, json: { error: "Send the tool's document as doc, a JSON object." } };
            if (JSON.stringify(doc).length > this.max) return { status: 413, json: { error: "This tool's copy is too big.", code: 'tool_doc_too_large' } };
            const tomb = this.tombs.get(key);
            if (this.refusesOff && (body as { turnOn?: unknown }).turnOn !== true && !row && tomb) {
                return { status: 410, json: { error: "This tool's copy was switched off, so nothing was kept. Switch it on again in Settings to keep one.", code: 'tool_copy_off', deletedAt: tomb } };
            }
            let at = now;
            for (const t of [row?.updatedAt, this.tombs.get(key)]) if (t && Date.parse(t) >= at) at = Date.parse(t) + 1;
            this.rows.set(key, { doc: doc as Record<string, unknown>, updatedAt: iso(at) });
            return { status: 200, json: { success: true, tool, updatedAt: iso(at), bytes: 0, max: this.max } };
        }
        if (method === 'DELETE') {
            if (row || this.refusesOff) {
                this.rows.delete(key);
                const was = [row?.updatedAt, this.tombs.get(key)].filter((t): t is string => !!t).sort().at(-1);
                this.tombs.set(key, was && was > iso(now) ? was : iso(now));
            }
            return { status: 200, json: { success: true, tool, removed: !!row } };
        }
        return { status: 404, json: null };
    }
    prune() { this.tombs.clear(); }
    doc(owner: string, tool: string) { return this.rows.get(`${owner}|${tool}`)?.doc ?? null; }
}

/** One browser: its own IndexedDB, signed in as `signer`, on the community at NODE. */
const browser = (name: string, signer = ME) => ({ name, idb: memoryIndexedDB(), signer });
type Browser = { name: string; idb: MemoryIndexedDB; signer: string };
let signer = ME;
/** The browser in the member's hand: the store and signer the modules reach are its own. */
function use(b: Browser) {
    vi.stubGlobal('indexedDB', b.idb);
    resetToolStoreForTest();
    signer = b.signer;
}

type Doc = { v: number; items: string[] };
const KIT: ToolManifest<Doc> = {
    id: 'kit', name: word('Fixture kit'), line: word('Everything a tool can draw, for the tests.'), icon: '🧪',
    shelf: 'stock', shopKinds: 'all', owner: 'both', permissions: ['node-copy'], screens: ['main'], row: () => null,
    examples: [word('a drill')],
    doc: {
        // Version 1 kept one name; version 2 a list. A document marked `poison` can't be read.
        version: 2,
        empty: () => ({ v: 2, items: [] }),
        read: (raw: unknown): Doc => {
            const r = raw as Record<string, unknown> | null;
            if (!r || typeof r !== 'object') return { v: 2, items: [] };
            if (r.poison) throw new Error('unreadable');
            if (r.v === 1) return { v: 2, items: typeof r.name === 'string' ? [r.name] : [] };
            return { ...r, v: 2, items: Array.isArray(r.items) ? r.items as string[] : [] } as Doc;
        },
    },
};
const member = (b: Browser): WebToolCopy => ({ manifest: KIT, owner: { kind: 'member', publicKey: b.signer }, node: NODE });
const doc = (...items: string[]): Doc => ({ v: 2, items });

let node: FakeNode;
let A: Browser;
let B: Browser;
let t0: number;

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('bp_node_url', NODE);
    resetAccountEpochForTest();
    node = new FakeNode();
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        const a = node.answer(init?.method ?? 'GET', new URL(url).pathname, typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, signer);
        if (!a) throw new TypeError('Failed to fetch');
        return new Response(a.json === null ? '' : JSON.stringify(a.json), { status: a.status });
    });
    A = browser('A');
    B = browser('B');
    t0 = Date.parse('2026-10-21T09:00:00.000Z');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetAccountEpochForTest(); });

async function open(b: Browser) { use(b); return openToolCopy(member(b)); }
/** A write in `b` at its own clock, then its sync (as the host's useToolDoc.set does), not waited for. */
async function write(b: Browser, d: Doc, at = (t0 += 60_000)) {
    use(b);
    expect(await keepToolDoc(b.signer, KIT.id, JSON.stringify(d), iso(at))).toBe(true);
    toolCopyAfterWrite(member(b), () => {});
}
async function held(b: Browser) { use(b); return readDoc(KIT, (await readToolRecord(b.signer, KIT.id))?.body ?? null); }
async function record(b: Browser) { use(b); return readToolRecord(b.signer, KIT.id); }
async function setting(b: Browser) { use(b); return (await readToolSettings(b.signer, KIT.id)).nodeCopy; }
async function setSetting(b: Browser, nodeCopy: boolean | undefined) { use(b); await patchToolSettings(b.signer, KIT.id, { nodeCopy }); }
const syncNow = open;
/** The next GET held until `release()`, so the page can move or its account change while it is out. */
function holdNextGet() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let arrived!: () => void;
    const asked = new Promise<void>((r) => { arrived = r; });
    const answers = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'GET') {
            vi.stubGlobal('fetch', answers);
            arrived();
            await gate;
        }
        return answers(url, init);
    });
    return { asked, release };
}

describe("the most the server keeps of a tool's document (its answers' `max`)", () => {
    /** A tool that names 128 KB, as the Tool shed does. */
    const BIG: ToolManifest<Doc> = { ...KIT, doc: { ...KIT.doc, maxBytes: 131_072 } };
    const bigCopy = (b: Browser): WebToolCopy => ({ manifest: BIG, owner: { kind: 'member', publicKey: b.signer }, node: NODE });
    const sized = (bytes: number): Doc => ({ v: 2, items: ['x'.repeat(bytes - '{"v":2,"items":[""]}'.length)] });

    it('kept beside the setting once heard, and moved by the next answer that says another', async () => {
        use(A);
        expect(await keepToolDoc(ME, 'kit', JSON.stringify(sized(1_000)), iso(t0))).toBe(true);
        expect((await readToolSettings(ME, 'kit')).nodeMax).toBeUndefined();
        expect(await openToolCopy(bigCopy(A))).toBe('put');
        expect((await readToolSettings(ME, 'kit')).nodeMax).toBe(65536);
        node.max = 131_072;
        expect(await openToolCopy(bigCopy(A))).toBe('nothing');
        expect((await readToolSettings(ME, 'kit')).nodeMax).toBe(131_072);
        expect(await keepToolDoc(ME, 'kit', JSON.stringify(sized(70_000)), iso(t0 + 60_000))).toBe(true);
        expect(await openToolCopy(bigCopy(A))).toBe('put');
        expect(JSON.stringify(node.doc(ME, 'kit')).length).toBe(70_000);
    });

    it('a browser that holds more than an older server keeps sends none of it: switching on there is too big, never "failed", and nothing is written over', async () => {
        use(A);
        await patchToolSettings(ME, 'kit', { nodeCopy: false });
        expect(await keepToolDoc(ME, 'kit', JSON.stringify(sized(70_000)), iso(t0))).toBe(true);
        node.log.length = 0;
        expect(await switchToolCopy(bigCopy(A), true)).toBe('too-big');
        expect(node.log.map((r) => r.method)).toEqual(['GET']);
        expect(await setting(A)).toBe(false);
        expect((await readToolSettings(ME, 'kit')).nodeMax).toBe(65536);
        expect((await record(A))?.body.length).toBe(70_000);
    });
});

describe('two browsers, one server: the open rule', () => {
    it('only a tool that asks for node-copy keeps a copy at all', () => {
        expect(keepsNodeCopy(KIT)).toBe(true);
        expect(keepsNodeCopy({ permissions: [] })).toBe(false);
    });

    it("first open with none: nothing sent, nothing kept; first open with a node copy: taken, both times the node's", async () => {
        expect(await open(A)).toBe('nothing');
        expect(node.count('PUT')).toBe(0);
        expect(await record(A)).toBeNull();
        await write(A, doc('Ladder'));
        expect(await syncNow(A)).toBe('put');
        const kept = node.rows.get(`${ME}|kit`)!;
        expect(kept.doc).toEqual(doc('Ladder'));
        expect(await record(A)).toEqual({ body: JSON.stringify(doc('Ladder')), updatedAt: kept.updatedAt, syncedAt: kept.updatedAt });
        expect(await open(B)).toBe('taken');
        expect(await held(B)).toEqual(doc('Ladder'));
        expect(await record(B)).toEqual({ body: JSON.stringify(doc('Ladder')), updatedAt: kept.updatedAt, syncedAt: kept.updatedAt });
    });

    it("B opens after A wrote: B takes A's; equal: nothing sent; a write keeps the last sync", async () => {
        await write(A, doc('Ladder'));
        await syncNow(A);
        await open(B);
        const synced = (await record(B))!.syncedAt;
        await write(A, doc('Ladder', 'Tent'));
        expect((await record(A))!.syncedAt).toBe(synced);
        await syncNow(A);
        const puts = node.count('PUT');
        expect(await open(B)).toBe('taken');
        expect(await held(B)).toEqual(doc('Ladder', 'Tent'));
        expect(await open(B)).toBe('nothing');
        expect(await open(A)).toBe('nothing');
        expect(node.count('PUT')).toBe(puts);
    });

    it('both changed since the last sync: the later write wins, in both browsers', async () => {
        await write(A, doc('Ladder'));
        await syncNow(A);
        await open(B);
        const base = (node.clock = t0 + 60_000);
        await write(B, doc('Ladder', 'from B'), base + 500);
        await write(A, doc('Ladder', 'from A'), base + 900);
        expect(await syncNow(A)).toBe('put');
        expect(await syncNow(B)).toBe('taken');
        expect(await held(B)).toEqual(doc('Ladder', 'from A'));
        const later = (node.clock = base + 600_000);
        await write(A, doc('a'), later + 100);
        await write(B, doc('b'), later + 60_000);
        expect(await syncNow(A)).toBe('put');
        expect(await syncNow(B)).toBe('put');
        expect(await open(A)).toBe('taken');
        expect([await held(A), await held(B), node.doc(ME, 'kit')]).toEqual([doc('b'), doc('b'), doc('b')]);
    });

    it('404 from an older server: this browser only, nothing sent, the write stays here', async () => {
        node.mode = 'older';
        await write(A, doc('Ladder'));
        expect(await open(A)).toBe('older-node');
        expect(node.count('PUT')).toBe(0);
        expect(await held(A)).toEqual(doc('Ladder'));
        expect((await record(A))!.syncedAt).toBeNull();
    });

    it('offline: kept, and sent on the next open', async () => {
        node.mode = 'down';
        await write(A, doc('Ladder'));
        expect(await open(A)).toBe('later');
        node.mode = 'up';
        expect(await open(A)).toBe('put');
        expect(node.doc(ME, 'kit')).toEqual(doc('Ladder'));
    });

    it('a write: one PUT five seconds after the last keystroke, not one each', async () => {
        // The in-memory IndexedDB answers on a timer too: the clock also runs on by itself, so its answers come.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        for (let i = 1; i <= 12; i++) {
            await write(A, doc(`Ladde${'r'.repeat(i)}`), t0 + i * 300);
            await vi.advanceTimersByTimeAsync(300);
        }
        expect(node.count('PUT')).toBe(0);
        await vi.advanceTimersByTimeAsync(4_700);
        await vi.waitFor(() => expect(node.count('PUT')).toBe(1));
        expect(node.doc(ME, 'kit')).toEqual(doc(`Ladde${'r'.repeat(12)}`));
        expect(node.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(node.count('PUT')).toBe(1);
    });

    it("a sync waiting when the browser's account changes (Sign Out, another sign-in) is dropped: never signed as the next account", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        await write(A, doc('Ladder'));
        endAccountEpoch('signed-out');
        beginAccountEpoch();
        signer = 'someone-else';
        await vi.advanceTimersByTimeAsync(10_000);
        expect(node.log).toEqual([]);
        // With no change of account since the write, it goes.
        await write(A, doc('Ladder', 'Tent'));
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(() => expect(node.count('PUT')).toBe(1));
        expect(node.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
        expect(node.doc(ME, 'kit')).toEqual(doc('Ladder', 'Tent'));
        expect(node.doc('someone-else', 'kit')).toBeNull();
    });

    it("a GET still out when the page moves to another community or the account changes: nothing after it is sent or kept", async () => {
        await write(A, doc('Ladder'));
        // Moved while the GET was out: A's copy is not PUT to the community the page is on now.
        let gate = holdNextGet();
        const put = open(A);
        await gate.asked;
        localStorage.setItem('bp_node_url', 'https://elsewhere.example');
        gate.release();
        expect(await put).toBe('later');
        expect(node.log.map((r) => r.method)).toEqual(['GET']);
        // Nor is the server's copy kept as the other community's record.
        localStorage.setItem('bp_node_url', NODE);
        node.rows.set(`${ME}|kit`, { doc: doc('From the server'), updatedAt: '2026-12-01T00:00:00.000Z' });
        gate = holdNextGet();
        const take = open(A);
        await gate.asked;
        localStorage.setItem('bp_node_url', 'https://elsewhere.example');
        gate.release();
        expect(await take).toBe('later');
        expect(await record(A)).toBeNull();
        localStorage.setItem('bp_node_url', NODE);
        expect(await held(A)).toEqual(doc('Ladder'));
        // Signed out, and another account signed in, while the GET was out: nothing goes signed as them.
        node.rows.clear();
        gate = holdNextGet();
        const after = open(A);
        await gate.asked;
        endAccountEpoch('signed-out');
        beginAccountEpoch();
        signer = 'someone-else';
        gate.release();
        expect(await after).toBe('later');
        expect(node.count('PUT')).toBe(0);
        expect(node.doc('someone-else', 'kit')).toBeNull();
    });

    it("take runs the tool's reader: an older version is upgraded; a copy that can't be read never replaces the browser's", async () => {
        node.rows.set(`${ME}|kit`, { doc: { v: 1, name: 'Ladder' }, updatedAt: '2026-10-21T08:30:00.000Z' });
        expect(await open(A)).toBe('taken');
        expect(JSON.parse((await record(A))!.body)).toEqual(doc('Ladder'));
        await write(B, doc('Mine'));
        for (const [i, unreadable] of [{ v: 2, poison: true }, { items: ['no v'] }].entries()) {
            node.rows.set(`${ME}|kit`, { doc: unreadable, updatedAt: iso(Date.parse('2026-12-01T00:00:00.000Z') + i) });
            expect(await open(B)).toBe('unreadable');
            expect((await record(B))!.body).toBe(JSON.stringify(doc('Mine')));
        }
    });

    it("an enterprise's copy goes to its treasury route, signed by a keeper; an open's body is exactly { doc }, the toggle's exactly { doc, turnOn: true }", async () => {
        node.keepers.set('ent-key', new Set(['keeper-1']));
        const k1 = browser('K1', 'keeper-1');
        const ent: WebToolCopy = { manifest: KIT, owner: { kind: 'enterprise', publicKey: 'ent-key' }, node: NODE };
        use(k1);
        await keepToolDoc('ent-key', KIT.id, JSON.stringify(doc('Till float')), iso(t0));
        expect(await openToolCopy(ent)).toBe('put');
        expect(node.log.map((r) => [r.method, r.path, r.signer])).toEqual([
            ['GET', '/api/treasury/ent-key/tools/kit', 'keeper-1'],
            ['PUT', '/api/treasury/ent-key/tools/kit', 'keeper-1'],
        ]);
        const put = node.log.find((r) => r.method === 'PUT')!;
        expect(put.body).toEqual({ doc: doc('Till float') });
        expect(Object.keys(put.body as object)).toEqual(['doc']);
        expect(JSON.stringify(put.body)).not.toContain('ent-key');
        expect(node.doc('keeper-1', 'kit')).toBeNull();
        // The member's switch-on, on either route: the one PUT that says so. Their own copy's open: the document alone.
        use(A);
        await keepToolDoc(ME, KIT.id, JSON.stringify(doc('Ladder')), iso(t0));
        node.log.length = 0;
        expect(await openToolCopy(member(A))).toBe('put');
        expect(node.log.map((r) => [r.method, r.path, r.body])).toEqual([['GET', '/api/tools/kit', undefined], ['PUT', '/api/tools/kit', { doc: doc('Ladder') }]]);
        for (const [b, copy] of [[k1, ent], [A, member(A)]] as const) {
            use(b);
            expect(await switchToolCopy(copy, false)).toBe('off');
            node.log.length = 0;
            expect(await switchToolCopy(copy, true)).toBe('on');
            expect(node.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
            expect(Object.keys(node.log[1].body as object)).toEqual(['doc', 'turnOn']);
            expect(node.log[1].body).toEqual({ doc: JSON.parse((await readToolRecord(copy.owner.publicKey, 'kit'))!.body), turnOn: true });
        }
    });
});

async function bothSynced() {
    await write(A, doc('Ladder'));
    await syncNow(A);
    await open(B);
    expect((await record(B))!.syncedAt).not.toBeNull();
}

describe.each([
    ['a node that orders the writes (S2.2: deletedAt, and an ordinary PUT over a removed copy is 410)', true, true],
    ['a node that says when (S2.1: deletedAt)', true, false],
    ["today's node (S2: none, no deletedAt)", false, false],
])('switched off in one browser, with %s', (_name, sendsDeletedAt, refusesOff) => {
    beforeEach(() => { node.sendsDeletedAt = sendsDeletedAt; node.refusesOff = refusesOff; });

    it("5/6. A off: one DELETE, A's setting off, its next open asks nothing; B's open: no PUT, B off, B's copy intact", async () => {
        await bothSynced();
        node.log.length = 0;
        use(A);
        expect(await switchToolCopy(member(A), false)).toBe('off');
        expect(node.log.map((r) => r.method)).toEqual(['DELETE']);
        expect(await setting(A)).toBe(false);
        expect(await open(A)).toBe('off');
        await write(A, doc('Ladder', 'only here'));
        await syncNow(A);
        expect(node.log.map((r) => r.method)).toEqual(['DELETE']);
        expect(await open(B)).toBe('switched-off');
        expect(node.count('PUT')).toBe(0);
        expect(await setting(B)).toBe(false);
        expect(await held(B)).toEqual(doc('Ladder'));
        node.log.length = 0;
        expect(await open(B)).toBe('off');
        expect(node.log).toEqual([]);
    });

    it("5. B wrote since and its sync comes after A's off: still switched off, and its write stays in B", async () => {
        await bothSynced();
        use(A);
        await switchToolCopy(member(A), false);
        await write(B, doc('Ladder', 'B since'));
        expect(await syncNow(B)).toBe('switched-off');
        expect(node.rows.size).toBe(0);
        expect(await held(B)).toEqual(doc('Ladder', 'B since'));
    });

    it('11. a fresh browser C within the 30 days: switched off on S2.1, its first write sends nothing; on S2 it starts on', async () => {
        await bothSynced();
        use(A);
        await switchToolCopy(member(A), false);
        const C = browser('C');
        node.log.length = 0;
        if (sendsDeletedAt) {
            expect(await open(C)).toBe('switched-off');
            expect(await setting(C)).toBe(false);
            await write(C, doc('C writes'));
            await syncNow(C);
            expect(node.log.map((r) => r.method)).toEqual(['GET']);
        } else {
            expect(await open(C)).toBe('nothing');
            await write(C, doc('C writes'));
            expect(await syncNow(C)).toBe('put');
            expect(node.doc(ME, 'kit')).toEqual(doc('C writes'));
        }
    });
});

describe('the delete rule: what the node is told and when', () => {
    it("6. the residual: D never synced and holds a copy; past the tombstone (or on today's node) D's open PUTs it", async () => {
        await bothSynced();
        use(A);
        await switchToolCopy(member(A), false);
        const D = browser('D');
        use(D);
        await keepToolDoc(ME, KIT.id, JSON.stringify(doc('D kept offline')), iso(t0));
        node.sendsDeletedAt = true;
        expect(await open(D)).toBe('switched-off');
        await setSetting(D, undefined);
        node.prune();
        expect(await open(D)).toBe('put');
        expect(node.doc(ME, 'kit')).toEqual(doc('D kept offline'));
    });

    it("7. B on again: one PUT of B's body at once, setting on; A on: B's copy taken; both read the same document", async () => {
        await bothSynced();
        use(A);
        await switchToolCopy(member(A), false);
        await open(B);
        node.log.length = 0;
        use(B);
        await keepToolDoc(ME, KIT.id, JSON.stringify(doc('B again')), iso(t0 + 120_000));
        expect(await switchToolCopy(member(B), true)).toBe('on');
        expect(node.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
        expect(await setting(B)).toBe(true);
        expect((await record(B))!.syncedAt).toBe(node.rows.get(`${ME}|kit`)!.updatedAt);
        use(A);
        expect(await switchToolCopy(member(A), true)).toBe('on');
        expect([await held(A), await held(B)]).toEqual([doc('B again'), doc('B again')]);
        expect(await open(A)).toBe('nothing');
        expect(await open(B)).toBe('nothing');
    });

    it("7. A on with a newer write of its own than the copy: A's PUT wins", async () => {
        await bothSynced();
        await write(B, doc('B'), t0 + 1_000);
        await syncNow(B);
        await write(A, doc('A, later'), t0 + 900_000);
        await setSetting(A, false);
        expect(await switchToolCopy(member(A), true)).toBe('on');
        expect(node.doc(ME, 'kit')).toEqual(doc('A, later'));
        expect(await open(B)).toBe('taken');
        expect(await held(B)).toEqual(doc('A, later'));
    });

    it('8. on with nothing kept here: the empty document is sent and kept; the next open is equal, no switch-off', async () => {
        await setSetting(A, false);
        expect(await switchToolCopy(member(A), true)).toBe('on');
        expect(node.doc(ME, 'kit')).toEqual(KIT.doc.empty());
        const at = node.rows.get(`${ME}|kit`)!.updatedAt;
        expect(await record(A)).toEqual({ body: JSON.stringify(KIT.doc.empty()), updatedAt: at, syncedAt: at });
        node.log.length = 0;
        expect(await open(A)).toBe('nothing');
        expect(node.log.map((x) => x.method)).toEqual(['GET']);
        expect(await setting(A)).toBe(true);
    });

    it('9. the toggle while the server is down or refusing: the setting is not written, the switch stays, the failure', async () => {
        await bothSynced();
        for (const mode of ['down', 'refusing'] as const) {
            node.mode = mode;
            use(A);
            expect(await switchToolCopy(member(A), false), mode).toBe('failed');
            expect(await setting(A)).toBeUndefined();
            await setSetting(A, false);
            expect(await switchToolCopy(member(A), true), mode).toBe('failed');
            expect(await setting(A)).toBe(false);
            await setSetting(A, undefined);
        }
        node.mode = 'up';
        expect(node.doc(ME, 'kit')).toEqual(doc('Ladder'));
        node.mode = 'older';
        expect(await switchToolCopy(member(A), true)).toBe('older-node');
        expect(await switchToolCopy(member(A), false)).toBe('off');
    });

    it('10. Remove my data, the server first: refused, nothing may go; done, the browser may go and B then switches off', async () => {
        await bothSynced();
        use(A);
        node.mode = 'down';
        expect(await removeToolCopyFirst(member(A))).toBe(false);
        node.mode = 'refusing';
        expect(await removeToolCopyFirst(member(A))).toBe(false);
        expect(node.doc(ME, 'kit')).toEqual(doc('Ladder'));
        node.mode = 'up';
        expect(await removeToolCopyFirst(member(A))).toBe(true);
        expect(node.rows.size).toBe(0);
        await setSetting(A, false);
        node.log.length = 0;
        expect(await removeToolCopyFirst(member(A))).toBe(true);
        expect(node.log).toEqual([]);
        expect(await open(B)).toBe('switched-off');
    });

    it("19. a PUT refused 410 (switched off in the other browser after this one's GET): this browser switches off, its document stays, and its next open asks nothing", async () => {
        node.refusesOff = true;
        await bothSynced();
        const synced = (await record(B))!.syncedAt;
        await write(B, doc('Ladder', 'B since'));
        node.log.length = 0;
        // A's off lands between B's GET and B's PUT.
        node.beforePut = () => { node.answer('DELETE', '/api/tools/kit', undefined, ME); };
        expect(await syncNow(B)).toBe('switched-off');
        expect(node.log.map((r) => r.method)).toEqual(['GET', 'DELETE', 'PUT']);
        expect(node.rows.size).toBe(0);
        expect(await setting(B)).toBe(false);
        expect(await held(B)).toEqual(doc('Ladder', 'B since'));
        expect((await record(B))!.syncedAt).toBe(synced);
        node.log.length = 0;
        expect(await open(B)).toBe('off');
        expect(node.log).toEqual([]);
    });

    it("19. keeper 2's browser on the enterprise route the same: its PUT refused 410 after keeper 1's off, keeper 2 off, the till kept", async () => {
        node.refusesOff = true;
        node.keepers.set('ent-key', new Set(['keeper-1', 'keeper-2']));
        const k2 = browser('K2', 'keeper-2');
        const ent: WebToolCopy = { manifest: KIT, owner: { kind: 'enterprise', publicKey: 'ent-key' }, node: NODE };
        use(k2);
        await keepToolDoc('ent-key', KIT.id, JSON.stringify(doc('Till float')), iso(t0));
        expect(await openToolCopy(ent)).toBe('put');
        await keepToolDoc('ent-key', KIT.id, JSON.stringify(doc('Till float', 'Keys')), iso(t0 + 60_000));
        node.beforePut = () => { node.answer('DELETE', '/api/treasury/ent-key/tools/kit', undefined, 'keeper-1'); };
        expect(await openToolCopy(ent)).toBe('switched-off');
        expect(node.doc('ent-key', 'kit')).toBeNull();
        expect((await readToolSettings('ent-key', 'kit')).nodeCopy).toBe(false);
        expect(readDoc(KIT, (await readToolRecord('ent-key', 'kit'))?.body ?? null)).toEqual(doc('Till float', 'Keys'));
    });

    it('20. a settings record that still holds the old marks (nodeCopyMarks, before fix round 3) is read without error and left alone; nothing here writes one', async () => {
        const OLD = { unsure: 'check', digests: ['0123456789abcdef'] };
        use(A);
        await patchToolSettings(ME, 'kit', { nodeCopyMarks: OLD } as unknown as ToolSettings);
        await write(A, doc('Ladder'));
        expect(await syncNow(A)).toBe('put');
        expect(await switchToolCopy(member(A), false)).toBe('off');
        node.log.length = 0;
        expect(await open(A)).toBe('off');
        expect(node.log).toEqual([]);
        expect(await readToolSettings(ME, 'kit')).toEqual({ nodeCopyMarks: OLD, nodeCopy: false, nodeMax: 65536 });
    });

    it("12. the enterprise's copy: keeper 1 off, keeper 2's open switches off", async () => {
        node.keepers.set('ent-key', new Set(['keeper-1', 'keeper-2']));
        const k1 = browser('K1', 'keeper-1');
        const k2 = browser('K2', 'keeper-2');
        const ent: WebToolCopy = { manifest: KIT, owner: { kind: 'enterprise', publicKey: 'ent-key' }, node: NODE };
        use(k1);
        await keepToolDoc('ent-key', KIT.id, JSON.stringify(doc('Till float')), iso(t0));
        await openToolCopy(ent);
        use(k2);
        expect(await openToolCopy(ent)).toBe('taken');
        use(k1);
        expect(await switchToolCopy(ent, false)).toBe('off');
        use(k2);
        expect(await openToolCopy(ent)).toBe('switched-off');
        expect((await readToolSettings('ent-key', 'kit')).nodeCopy).toBe(false);
        expect(readDoc(KIT, (await readToolRecord('ent-key', 'kit'))?.body ?? null)).toEqual(doc('Till float'));
    });

    it("nothing runs once the page has moved to another community: its records and its server are another's", async () => {
        await write(A, doc('Ladder'));
        localStorage.setItem('bp_node_url', 'https://elsewhere.example');
        expect(await open(A)).toBe('later');
        expect(await switchToolCopy(member(A), false)).toBe('failed');
        expect(await removeToolCopyFirst(member(A))).toBe(false);
        expect(node.log).toEqual([]);
    });
});

describe('off means gone, even when a slow PUT is on its way (PR #2297, the deciding review at d4fcc070)', () => {
    const KEY = `tool-copy:${NODE}:${ME}:kit`;
    const methods = () => node.log.map((r) => r.method);
    const settingsOf = async (b: Browser) => { use(b); return readToolSettings(b.signer, KIT.id); };
    beforeEach(() => { node.refusesOff = true; });
    afterEach(() => { Reflect.deleteProperty(navigator, 'locks'); });

    /**
     * The next PUT on a slow line: its body reaches the node when `arrive()` is called. Let go before then (the page's
     * signal), fetch throws as a browser's does; `landsAnyway`: the body was on its way, and the node takes it on arrival.
     */
    function slowNextPut(landsAnyway = false) {
        let arrive!: () => void;
        const arrived = new Promise<'arrived'>((r) => { arrive = () => r('arrived'); });
        let signal: AbortSignal | undefined;
        const answers = globalThis.fetch;
        vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
            if (init?.method !== 'PUT') return answers(url, init);
            vi.stubGlobal('fetch', answers);
            signal = init.signal ?? undefined;
            const letGo = new Promise<'let go'>((r) => signal?.addEventListener('abort', () => r('let go')));
            if (await Promise.race([arrived, letGo]) === 'let go') {
                if (landsAnyway) void arrived.then(() => answers(url, init));
                throw new DOMException('The operation was aborted.', 'AbortError');
            }
            return answers(url, init);
        });
        return { arrive, signal: () => signal };
    }
    /** A minimal LockManager: each name's callbacks one at a time, in the order asked (the exclusive lock the page asks for). */
    function fakeLocks() {
        const held = new Map<string, Promise<unknown>>();
        const asked: string[] = [];
        const locks = {
            request: (name: string, callback: () => Promise<unknown>) => {
                asked.push(name);
                const run = (held.get(name) ?? Promise.resolve()).then(() => callback());
                held.set(name, run.catch(() => undefined));
                return run;
            },
        };
        Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
        return asked;
    }
    /** Another tab of the same browser: the same IndexedDB and server, its own node-copy queue. */
    async function otherTab() {
        vi.resetModules();
        return import('../node-copy');
    }

    it('each request gets a signal; a PUT slower than the limit is let go then, and only then does the off send its DELETE', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        await write(A, doc('Ladder'));
        const line = slowNextPut();
        await vi.advanceTimersByTimeAsync(TOOL_COPY_PUSH_MS);
        await vi.waitFor(() => expect(line.signal()).toBeInstanceOf(AbortSignal));
        use(A);
        const off = switchToolCopy(member(A), false);
        await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS - 1_000);
        expect(line.signal()!.aborted).toBe(false);
        expect(methods()).toEqual(['GET']);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await off).toBe('off');
        expect(line.signal()!.aborted).toBe(true);
        expect(methods()).toEqual(['GET', 'DELETE']);
        expect(await settingsOf(A)).toEqual({ nodeCopy: false, nodeMax: 65536 });
        // Off: the next open asks nothing at all.
        line.arrive();
        node.log.length = 0;
        expect(await open(A)).toBe('off');
        expect(methods()).toEqual([]);
    });

    it("a PUT let go at the limit that the server takes anyway, after the DELETE (the review's order): refused there, and the next open sends nothing", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        for (const refusesOff of [true, false]) {
            node = new FakeNode();
            node.refusesOff = refusesOff;
            A = browser(`A, S2.2 ${refusesOff}`);
            await write(A, doc('Ladder'));
            const line = slowNextPut(true);
            await vi.advanceTimersByTimeAsync(TOOL_COPY_PUSH_MS);
            await vi.waitFor(() => expect(line.signal()).toBeInstanceOf(AbortSignal));
            use(A);
            const off = switchToolCopy(member(A), false);
            await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS);
            expect(await off).toBe('off');
            line.arrive();
            await vi.waitFor(() => expect(methods()).toEqual(['GET', 'DELETE', 'PUT']));
            // S2.2 refuses it (410, nothing written); a node before it keeps it (residual 1: it closes as nodes update).
            expect(node.doc(ME, 'kit')).toEqual(refusesOff ? null : doc('Ladder'));
            node.log.length = 0;
            expect(await open(A)).toBe('off');
            expect(methods()).toEqual([]);
            expect(await settingsOf(A)).toEqual({ nodeCopy: false, nodeMax: 65536 });
        }
    });

    it("two tabs on one key, with Web Locks: the other tab's off waits for this tab's PUT, one job at a time; no copy", async () => {
        const asked = fakeLocks();
        use(A);
        await keepToolDoc(ME, KIT.id, JSON.stringify(doc('Ladder')), iso(t0));
        const tab2 = await otherTab();
        const line = slowNextPut();
        const put = openToolCopy(member(A));
        await vi.waitFor(() => expect(line.signal()).toBeInstanceOf(AbortSignal));
        const off = tab2.switchToolCopy(member(A), false);
        await new Promise((r) => setTimeout(r, 50));
        expect(methods()).toEqual(['GET']);
        line.arrive();
        expect([await put, await off]).toEqual(['put', 'off']);
        expect(methods()).toEqual(['GET', 'PUT', 'DELETE']);
        expect(node.rows.size).toBe(0);
        expect(await settingsOf(A)).toEqual({ nodeCopy: false, nodeMax: 65536 });
        expect(asked).toEqual([KEY, KEY]);
    });

    it('two tabs on one key, with no Web Locks: the DELETE lands first and the PUT after it, and the server refuses that PUT; both tabs off, nothing more sent', async () => {
        use(A);
        await keepToolDoc(ME, KIT.id, JSON.stringify(doc('Ladder')), iso(t0));
        const tab2 = await otherTab();
        const line = slowNextPut();
        const put = openToolCopy(member(A));
        await vi.waitFor(() => expect(line.signal()).toBeInstanceOf(AbortSignal));
        expect(await tab2.switchToolCopy(member(A), false)).toBe('off');
        line.arrive();
        expect(await put).toBe('switched-off');
        expect(methods()).toEqual(['GET', 'DELETE', 'PUT']);
        expect(node.rows.size).toBe(0);
        expect(await settingsOf(A)).toEqual({ nodeCopy: false, nodeMax: 65536 });
        expect(readDoc(KIT, (await readToolRecord(ME, KIT.id))?.body ?? null)).toEqual(doc('Ladder'));
        // The next open, in either tab, with the setting off: nothing at all.
        node.log.length = 0;
        expect(await tab2.openToolCopy(member(A))).toBe('off');
        expect(await openToolCopy(member(A))).toBe('off');
        expect(methods()).toEqual([]);
    });

    it('Remove my data with a PUT out: the DELETE goes once the PUT has settled; refused, nothing may go', async () => {
        use(A);
        await keepToolDoc(ME, KIT.id, JSON.stringify(doc('Ladder')), iso(t0));
        const line = slowNextPut();
        void openToolCopy(member(A));
        await vi.waitFor(() => expect(line.signal()).toBeInstanceOf(AbortSignal));
        node.mode = 'refusing';
        const refused = removeToolCopyFirst(member(A));
        await new Promise((r) => setTimeout(r, 50));
        expect(methods()).toEqual(['GET']);
        line.arrive();
        expect(await refused).toBe(false);
        expect(methods()).toEqual(['GET', 'PUT', 'DELETE']);
        expect(await setting(A)).toBeUndefined();
        node.mode = 'up';
        expect(await removeToolCopyFirst(member(A))).toBe(true);
        expect(node.rows.size).toBe(0);
        expect(await setting(A)).toBe(false);
    });

    describe("keeper 1's late PUT never undoes keeper 2's switch-on, and no mark is kept (the reviews at 8a48f318 and after)", () => {
        const ent: WebToolCopy = { manifest: KIT, owner: { kind: 'enterprise', publicKey: 'ent-key' }, node: NODE };
        const entSettings = async (b: Browser) => { use(b); return readToolSettings('ent-key', 'kit'); };
        /** Keeper 1's browser: its copy on, then a sync after a write whose PUT is let go at the limit, then off. */
        async function offWithPutLetGo(k1: Browser, landsAnyway: boolean) {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
            use(k1);
            await keepToolDoc('ent-key', KIT.id, JSON.stringify(doc('Till float')), iso(t0));
            expect(await openToolCopy(ent)).toBe('put');
            expect(await keepToolDoc('ent-key', KIT.id, JSON.stringify(doc('Till float', 'Keys')), iso(t0 + 60_000))).toBe(true);
            const line = slowNextPut(landsAnyway);
            const sync = openToolCopy(ent);
            await vi.waitFor(() => expect(line.signal()).toBeInstanceOf(AbortSignal));
            await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS);
            expect(await sync).toBe('later');
            expect(await switchToolCopy(ent, false)).toBe('off');
            expect(await entSettings(k1)).toEqual({ nodeCopy: false, nodeMax: 65536 });
            return line;
        }

        it("12. the enterprise's copy: keeper 1's browser, off with a PUT let go, leaves the copy keeper 2 switched on; keeper 2 stays on", async () => {
            node.keepers.set('ent-key', new Set(['keeper-1', 'keeper-2']));
            const k1 = browser('K1', 'keeper-1');
            const k2 = browser('K2', 'keeper-2');
            await offWithPutLetGo(k1, false);
            // Keeper 2 switches it on again, with the enterprise's document as keeper 2's browser holds it.
            use(k2);
            await keepToolDoc('ent-key', KIT.id, JSON.stringify(doc('Cash tin')), iso(t0 + 120_000));
            expect(await switchToolCopy(ent, true)).toBe('on');
            // Keeper 1 merely opens the tool: nothing asked, keeper 2's copy left alone.
            use(k1);
            node.log.length = 0;
            expect(await openToolCopy(ent)).toBe('off');
            expect(node.log).toEqual([]);
            expect(node.doc('ent-key', 'kit')).toEqual(doc('Cash tin'));
            use(k2);
            expect(await openToolCopy(ent)).toBe('nothing');
            expect((await entSettings(k2)).nodeCopy).toBe(true);
            expect(node.doc('ent-key', 'kit')).toEqual(doc('Cash tin'));
        });

        it("keeper 1's own late PUT, taken after the off: the server refuses it, so no copy is left and keeper 1's next open asks nothing", async () => {
            node.keepers.set('ent-key', new Set(['keeper-1']));
            const k1 = browser('K1', 'keeper-1');
            const line = await offWithPutLetGo(k1, true);
            line.arrive();
            await vi.waitFor(() => expect(methods().at(-1)).toBe('PUT'));
            expect(methods()).toEqual(['GET', 'PUT', 'GET', 'DELETE', 'PUT']);
            expect(node.doc('ent-key', 'kit')).toBeNull();
            node.log.length = 0;
            use(k1);
            expect(await openToolCopy(ent)).toBe('off');
            expect(node.log).toEqual([]);
            expect(await entSettings(k1)).toEqual({ nodeCopy: false, nodeMax: 65536 });
        });
    });
});
