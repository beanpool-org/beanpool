/**
 * The node copy on the web, two browsers against one community server (scratch/tools/DESIGN-tool-template-fable.md §1.6,
 * DESIGN-t04-node-copy-delete-fable.md §5 tests 5–12, slice T0.4): the phone's list (apps/native/utils/__tests__/
 * tool-node-copy.test.ts) again, through tools/node-copy.ts with the web's real store (each browser its own IndexedDB,
 * lib/memory-indexeddb.ts) and the app's signed helper (lib/api.ts signedFetch), its fetch answered by one fake node that
 * keeps rows and tombstones as engine/tool-state.ts does: today's (S2, never a `deletedAt`) or S2.1's (`deletedAt` once
 * deleted), 404 as an older node, nothing when down, and 500 when refusing.
 *
 * The page's words and order (Remove my data, the toggle's failure line, the line once) are in tools-template.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { word, type ToolManifest } from '@beanpool/core';
import { memoryIndexedDB, type MemoryIndexedDB } from '../../lib/memory-indexeddb';
import { resetAccountEpochForTest } from '../../lib/account-epoch';
import { keepToolDoc, patchToolSettings, readToolRecord, readToolSettings, resetToolStoreForTest } from '../store';
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
    mode: 'up' | 'down' | 'refusing' | 'older' = 'up';
    keepers = new Map<string, Set<string>>();
    clock = Date.parse('2026-10-21T08:00:00.000Z');

    count(method: string) { return this.log.filter((r) => r.method === method).length; }
    answer(method: string, path: string, body: unknown, signer: string): { status: number; json: unknown } | null {
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
            return { status: 200, json: { tool, doc: row?.doc ?? null, updatedAt: row?.updatedAt ?? null, bytes: 0, max: 65536, ...(this.sendsDeletedAt ? { deletedAt: row ? null : this.tombs.get(key) ?? null } : {}) } };
        }
        if (method === 'PUT') {
            const doc = (body as { doc?: unknown } | null)?.doc;
            if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { status: 400, json: { error: "Send the tool's document as doc, a JSON object." } };
            let at = now;
            for (const t of [row?.updatedAt, this.tombs.get(key)]) if (t && Date.parse(t) >= at) at = Date.parse(t) + 1;
            this.rows.set(key, { doc: doc as Record<string, unknown>, updatedAt: iso(at) });
            return { status: 200, json: { success: true, tool, updatedAt: iso(at), bytes: 0, max: 65536 } };
        }
        if (method === 'DELETE') {
            if (row) {
                this.rows.delete(key);
                this.tombs.set(key, row.updatedAt > iso(now) ? row.updatedAt : iso(now));
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

    it("an enterprise's copy goes to its treasury route, signed by a keeper; the body is the document alone", async () => {
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
        expect(JSON.stringify(put.body)).not.toContain('ent-key');
        expect(node.doc('keeper-1', 'kit')).toBeNull();
    });
});

async function bothSynced() {
    await write(A, doc('Ladder'));
    await syncNow(A);
    await open(B);
    expect((await record(B))!.syncedAt).not.toBeNull();
}

describe.each([
    ['a node that says when (S2.1: deletedAt)', true],
    ["today's node (S2: none, no deletedAt)", false],
])('switched off in one browser, with %s', (_name, sendsDeletedAt) => {
    beforeEach(() => { node.sendsDeletedAt = sendsDeletedAt; });

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
