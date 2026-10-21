/**
 * The node copy on the phone, two phones against one community server (scratch/tools/DESIGN-tool-template-fable.md §1.6,
 * DESIGN-t04-node-copy-delete-fable.md §5 tests 5–12, slice T0.4): tools/node-copy.ts with the phone's real store (each
 * phone its own SQLite table, node:sqlite behind expo-sqlite's calls, and its own app storage) and the app's signed
 * helpers (utils/db.ts signedGet and signedRequestWithMethod) answered by one fake node that keeps rows and tombstones as
 * engine/tool-state.ts does. The node answers as today's (S2, never a `deletedAt`), as S2.1's (`deletedAt` once
 * deleted) or as S2.2's (it orders the writes: an ordinary PUT over a removed copy is 410), 404 as an older node,
 * nothing when down, and 500 when refusing.
 *
 * The web runs the same list against its IndexedDB store (apps/pwa/src/tools/__tests__/node-copy.test.ts); the frame's
 * words and the route's order (Remove my data, the toggle's failure line) are in tools-template.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

vi.mock('react-native', () => ({ Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default } }));
const storage = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => storage.map.get(k) ?? null,
        setItem: async (k: string, v: string) => { storage.map.set(k, v); },
        removeItem: async (k: string) => { storage.map.delete(k); },
        getAllKeys: async () => [...storage.map.keys()],
        multiRemove: async (keys: string[]) => { keys.forEach((k) => storage.map.delete(k)); },
    },
}));
const net = vi.hoisted(() => ({
    node: null as null | { answer(method: string, path: string, body: unknown, signer: string): { status: number; json: unknown } | null },
    signer: '',
    /** The next GET waits for this (holdNextGet), so the phone can move or its account change while it is out. */
    hold: null as null | { asked: () => void; gate: Promise<void> },
    /** Each request's method and the signal the phone handed the helper. */
    signals: [] as Array<[string, AbortSignal | undefined]>,
    /**
     * The next PUT's body reaches the node `arrives` ms after it is sent (slowNextPut). Let go before then, the helper
     * throws as fetch does; `landsAnyway`: the body was on its way, and the node takes it all the same when it arrives.
     */
    slowPut: null as null | { arrives: number; landsAnyway: boolean },
}));
const disk = vi.hoisted(() => ({ db: null as any }));
vi.mock('../db', () => ({
    getDb: async () => disk.db,
    // The app's own helpers, as the phone calls them: the answer as a Response, or as utils/db.ts's throw.
    signedGet: async (path: string, options?: { signal?: AbortSignal }) => {
        net.signals.push(['GET', options?.signal]);
        const hold = net.hold;
        if (hold) {
            net.hold = null;
            hold.asked();
            await hold.gate;
        }
        const a = net.node!.answer('GET', path, undefined, net.signer);
        if (!a) throw new TypeError('Network request failed');
        return { status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => a.json };
    },
    signedRequestWithMethod: async (method: string, path: string, payload: unknown, opts?: { withStatus?: boolean; signal?: AbortSignal }) => {
        net.signals.push([method, opts?.signal]);
        const slow = method === 'PUT' ? net.slowPut : null;
        if (slow) {
            net.slowPut = null;
            const signer = net.signer;
            const arrived = new Promise<'arrived'>((resolve) => setTimeout(() => resolve('arrived'), slow.arrives));
            const letGo = new Promise<'let go'>((resolve) => opts?.signal?.addEventListener('abort', () => resolve('let go')));
            if (await Promise.race([arrived, letGo]) === 'let go') {
                if (slow.landsAnyway) void arrived.then(() => net.node!.answer(method, path, JSON.parse(JSON.stringify(payload)), signer));
                throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
            }
        }
        const a = net.node!.answer(method, path, payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)), net.signer);
        if (!a) throw new TypeError('Network request failed');
        if (a.status < 200 || a.status >= 300) throw Object.assign(new Error((a.json as { error?: string } | null)?.error ?? `Request failed: ${a.status}`), opts?.withStatus ? { status: a.status } : {});
        return a.json;
    },
}));

import { TOOL_COPY_ANSWER_MS, TOOL_COPY_PUSH_MS, word, type ToolManifest } from '@beanpool/core';
import { TOOL_DOCS_TABLE } from '../../tools/schema';
import { readToolCopy, readToolDoc, readToolSettings, writeToolDoc, writeToolSettings, type ToolSettings } from '../../tools/store';
import { keepsNodeCopy, openToolCopy, removeToolCopyFirst, switchToolCopy, toolCopyAfterWrite, type PhoneToolCopy } from '../../tools/node-copy';
import { announceAccountOnPhone } from '../account-on-phone';

const URL_A = 'https://mullum.example';
const ME = 'me-key';
const iso = (ms: number) => new Date(ms).toISOString();

/** One community server's tool store, as engine/tool-state.ts keeps it. */
class FakeNode {
    rows = new Map<string, { doc: Record<string, unknown>; updatedAt: string }>();
    tombs = new Map<string, string>();
    log: Array<{ method: string; path: string; body?: unknown; signer: string; deviceRows?: number }> = [];
    /** S2.1's GET: `deletedAt` when no row is kept. Today's node (S2) never sends it. */
    sendsDeletedAt = false;
    /**
     * S2.2's order (scratch/tools/DESIGN-t04-late-put-fable.md §3), with S2.1's `deletedAt`: a DELETE leaves a tombstone
     * with no copy kept too, and an ordinary PUT (no `turnOn: true`) arriving with no row and a tombstone is refused 410
     * `tool_copy_off`, nothing written; the member's switch-on writes.
     */
    refusesOff = false;
    /** Runs once as the next PUT arrives, before the node reads it (another phone's request landing first). */
    beforePut: (() => void) | null = null;
    mode: 'up' | 'down' | 'refusing' | 'older' = 'up';
    keepers = new Map<string, Set<string>>();
    clock = Date.parse('2026-10-21T08:00:00.000Z');
    /** What the phone holds when each request arrives (Remove my data's order). */
    onRequest: (() => number) | null = null;

    count(method: string) { return this.log.filter((r) => r.method === method).length; }
    answer(method: string, path: string, body: unknown, signer: string): { status: number; json: unknown } | null {
        const before = method === 'PUT' ? this.beforePut : null;
        if (before) {
            this.beforePut = null;
            before();
        }
        this.log.push({ method, path, body, signer, deviceRows: this.onRequest?.() });
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
            return { status: 200, json: { tool, doc: row?.doc ?? null, updatedAt: row?.updatedAt ?? null, bytes: 0, max: 65536, ...(this.sendsDeletedAt || this.refusesOff ? { deletedAt: row ? null : this.tombs.get(key) ?? null } : {}) } };
        }
        if (method === 'PUT') {
            const doc = (body as { doc?: unknown } | null)?.doc;
            if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { status: 400, json: { error: "Send the tool's document as doc, a JSON object." } };
            const tomb = this.tombs.get(key);
            if (this.refusesOff && (body as { turnOn?: unknown }).turnOn !== true && !row && tomb) {
                return { status: 410, json: { error: "This tool's copy was switched off, so nothing was kept. Switch it on again in Settings to keep one.", code: 'tool_copy_off', deletedAt: tomb } };
            }
            let at = now;
            for (const t of [row?.updatedAt, this.tombs.get(key)]) if (t && Date.parse(t) >= at) at = Date.parse(t) + 1;
            this.rows.set(key, { doc: doc as Record<string, unknown>, updatedAt: iso(at) });
            return { status: 200, json: { success: true, tool, updatedAt: iso(at), bytes: 0, max: 65536 } };
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
    /** pruneTombstones past the 30 days. */
    prune() { this.tombs.clear(); }
    doc(owner: string, tool: string) { return this.rows.get(`${owner}|${tool}`)?.doc ?? null; }
}

/** One phone: its own SQLite file and app storage, on the community at URL_A. */
function phone(name: string) {
    const d = new DatabaseSync(':memory:');
    d.exec(TOOL_DOCS_TABLE);
    const bind = (params?: unknown[]) => (params ?? []) as any[];
    const db = {
        execAsync: async (sql: string) => { d.exec(sql); },
        runAsync: async (sql: string, params?: unknown[]) => { const r = d.prepare(sql).run(...bind(params)); return { changes: Number(r.changes) }; },
        getFirstAsync: async (sql: string, params?: unknown[]) => d.prepare(sql).get(...bind(params)) ?? null,
        getAllAsync: async (sql: string, params?: unknown[]) => d.prepare(sql).all(...bind(params)),
        rows: () => Number((d.prepare('SELECT COUNT(*) AS n FROM tool_docs').get() as { n: number }).n),
    };
    const map = new Map<string, string>([['beanpool_anchor_url', URL_A]]);
    return { name, db, map, signer: ME };
}
type Phone = ReturnType<typeof phone>;
/** The phone in the member's hand: the store, storage and signer the modules reach are its own. */
function use(p: Phone) {
    disk.db = p.db;
    storage.map = p.map;
    net.signer = p.signer;
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
const member = (p: Phone): PhoneToolCopy => ({ manifest: KIT, owner: { kind: 'member', publicKey: p.signer }, url: URL_A });
const doc = (...items: string[]): Doc => ({ v: 2, items });

let node: FakeNode;
let A: Phone;
let B: Phone;
let t0: number;

beforeEach(() => {
    node = new FakeNode();
    net.node = node;
    net.signals = [];
    net.slowPut = null;
    A = phone('A');
    B = phone('B');
    t0 = Date.parse('2026-10-21T09:00:00.000Z');
});
afterEach(() => { vi.useRealTimers(); });

async function open(p: Phone) { use(p); return openToolCopy(member(p)); }
/** A write on `p` at its own clock, then its sync (as the host's doc.set does), not waited for. */
async function write(p: Phone, d: Doc, at = (t0 += 60_000)) {
    use(p);
    await writeToolDoc(p.signer, KIT, d, at);
    toolCopyAfterWrite(member(p), () => {});
}
async function held(p: Phone) { use(p); return (await readToolDoc(p.signer, KIT)).doc; }
async function row(p: Phone) { use(p); return readToolCopy(p.signer, KIT.id); }
async function setting(p: Phone) { use(p); return (await readToolSettings(p.signer, KIT.id, URL_A)).nodeCopy; }
/** The sync a write waits five seconds for, run now: what the next open does too. */
async function syncNow(p: Phone) { return open(p); }
/** The next GET held until `release()`. */
function holdNextGet() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let asked!: () => void;
    const arrived = new Promise<void>((r) => { asked = r; });
    net.hold = { asked, gate };
    return { asked: arrived, release };
}

describe('two phones, one server: the open rule', () => {
    it('only a tool that asks for node-copy keeps a copy at all', () => {
        expect(keepsNodeCopy(KIT)).toBe(true);
        expect(keepsNodeCopy({ permissions: [] })).toBe(false);
        expect(keepsNodeCopy({ permissions: ['photos', 'reminders'] })).toBe(false);
    });

    it('first open with none: nothing sent, nothing kept; first open with a node copy: taken, both times the node\'s', async () => {
        expect(await open(A)).toBe('nothing');
        expect(node.count('PUT')).toBe(0);
        expect(await row(A)).toBeNull();
        await write(A, doc('Ladder'));
        expect(await syncNow(A)).toBe('put');
        const kept = node.rows.get(`${ME}|kit`)!;
        expect(kept.doc).toEqual(doc('Ladder'));
        expect(await row(A)).toEqual({ body: JSON.stringify(doc('Ladder')), updatedAt: kept.updatedAt, syncedAt: kept.updatedAt });

        expect(await open(B)).toBe('taken');
        expect(await held(B)).toEqual(doc('Ladder'));
        expect(await row(B)).toEqual({ body: JSON.stringify(doc('Ladder')), updatedAt: kept.updatedAt, syncedAt: kept.updatedAt });
    });

    it('B opens after A wrote: B takes A\'s; equal: nothing sent', async () => {
        await write(A, doc('Ladder'));
        await syncNow(A);
        await open(B);
        await write(A, doc('Ladder', 'Tent'));
        await syncNow(A);
        const puts = node.count('PUT');
        expect(await open(B)).toBe('taken');
        expect(await held(B)).toEqual(doc('Ladder', 'Tent'));
        expect(await open(B)).toBe('nothing');
        expect(await open(A)).toBe('nothing');
        expect(node.count('PUT')).toBe(puts);
    });

    it('both changed since the last sync: the later write wins, on both phones', async () => {
        await write(A, doc('Ladder'));
        await syncNow(A);
        await open(B);
        // B writes (offline) before A does; A's reaches the server, stamped after both writes.
        const base = (node.clock = t0 + 60_000);
        await write(B, doc('Ladder', 'from B'), base + 500);
        await write(A, doc('Ladder', 'from A'), base + 900);
        expect(await syncNow(A)).toBe('put');
        expect(Date.parse(node.rows.get(`${ME}|kit`)!.updatedAt)).toBeGreaterThan(base + 900);
        // B's own write is older than the server's copy: the server's is taken.
        expect(await syncNow(B)).toBe('taken');
        expect(await held(B)).toEqual(doc('Ladder', 'from A'));
        // And the other way: A's write reaches the server first, but B wrote later, after the server's stamp: B's goes up.
        const later = (node.clock = base + 600_000);
        await write(A, doc('a'), later + 100);
        await write(B, doc('b'), later + 60_000);
        expect(await syncNow(A)).toBe('put');
        expect(await syncNow(B)).toBe('put');
        expect(await open(A)).toBe('taken');
        expect([await held(A), await held(B), node.doc(ME, 'kit')]).toEqual([doc('b'), doc('b'), doc('b')]);
    });

    it('404 from an older server: this phone only, nothing sent, and the write stays here', async () => {
        node.mode = 'older';
        await write(A, doc('Ladder'));
        expect(await open(A)).toBe('older-node');
        expect(node.count('PUT')).toBe(0);
        expect(await held(A)).toEqual(doc('Ladder'));
        expect((await row(A))!.syncedAt).toBeNull();
    });

    it('offline: kept, and sent on the next open', async () => {
        node.mode = 'down';
        await write(A, doc('Ladder'));
        expect(await open(A)).toBe('later');
        expect(await held(A)).toEqual(doc('Ladder'));
        node.mode = 'up';
        expect(await open(A)).toBe('put');
        expect(node.doc(ME, 'kit')).toEqual(doc('Ladder'));
    });

    it('a write: one PUT five seconds after the last keystroke, not one each', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        use(A);
        for (let i = 1; i <= 12; i++) {
            await write(A, doc(`Ladde${'r'.repeat(i)}`), t0 + i * 300);
            await vi.advanceTimersByTimeAsync(300);
        }
        expect(node.count('PUT')).toBe(0);
        await vi.advanceTimersByTimeAsync(4_700);
        await vi.advanceTimersByTimeAsync(10);
        expect(node.count('PUT')).toBe(1);
        expect(node.doc(ME, 'kit')).toEqual(doc(`Ladde${'r'.repeat(12)}`));
        // The sync after a write reconciles as an open does: one GET before the one PUT.
        expect(node.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(node.count('PUT')).toBe(1);
    });

    it("a sync waiting when the phone's account changes (Sign Out, another sign-in) is dropped: never signed as the next account", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await write(A, doc('Ladder'));
        announceAccountOnPhone(null);
        announceAccountOnPhone('someone-else');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(node.log).toEqual([]);
        // The same account announced again (a name change) drops nothing.
        await write(A, doc('Ladder', 'Tent'));
        announceAccountOnPhone('someone-else');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(node.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
        expect(node.doc(ME, 'kit')).toEqual(doc('Ladder', 'Tent'));
    });

    it("the account the phone held from the start, announced again (a name change), drops nothing; another, with no Sign Out between (Replace), still does", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        /** As this build starts: no account announced yet. */
        const fresh = async () => {
            vi.resetModules();
            return { copy: await import('../../tools/node-copy'), announce: (await import('../account-on-phone')).announceAccountOnPhone };
        };
        use(A);
        let started = await fresh();
        await writeToolDoc(ME, KIT, doc('Ladder'), (t0 += 60_000));
        started.copy.toolCopyAfterWrite(member(A), () => {});
        started.announce(ME);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(node.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
        expect(node.doc(ME, 'kit')).toEqual(doc('Ladder'));

        started = await fresh();
        await writeToolDoc(ME, KIT, doc('Ladder', 'Tent'), (t0 += 60_000));
        started.copy.toolCopyAfterWrite(member(A), () => {});
        started.announce('someone-else');
        net.signer = 'someone-else';
        await vi.advanceTimersByTimeAsync(10_000);
        // Nothing more is asked, so nothing is signed as them.
        expect(node.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
        expect(node.count('PUT')).toBe(1);
        expect(node.doc('someone-else', 'kit')).toBeNull();
    });

    it("a GET still out when the phone moves to another community or its account changes: nothing after it is sent or kept", async () => {
        await write(A, doc('Ladder'));
        // Moved while the GET was out (getDb opens that community's file, the helpers sign to its server): A's copy is not PUT.
        const elsewhere = phone('elsewhere');
        let gate = holdNextGet();
        const put = open(A);
        await gate.asked;
        A.map.set('beanpool_anchor_url', 'https://elsewhere.example');
        disk.db = elsewhere.db;
        gate.release();
        expect(await put).toBe('later');
        expect(node.log.map((r) => r.method)).toEqual(['GET']);
        // Nor is the server's copy kept in the other community's file.
        A.map.set('beanpool_anchor_url', URL_A);
        node.rows.set(`${ME}|kit`, { doc: doc('From the server'), updatedAt: '2026-12-01T00:00:00.000Z' });
        gate = holdNextGet();
        const take = open(A);
        await gate.asked;
        A.map.set('beanpool_anchor_url', 'https://elsewhere.example');
        disk.db = elsewhere.db;
        gate.release();
        expect(await take).toBe('later');
        expect(elsewhere.db.rows()).toBe(0);
        A.map.set('beanpool_anchor_url', URL_A);
        expect(await held(A)).toEqual(doc('Ladder'));
        // Signed out, and another account signed in, while the GET was out: nothing goes signed as them.
        node.rows.clear();
        gate = holdNextGet();
        const after = open(A);
        await gate.asked;
        announceAccountOnPhone(null);
        announceAccountOnPhone('someone-else');
        net.signer = 'someone-else';
        gate.release();
        expect(await after).toBe('later');
        expect(node.count('PUT')).toBe(0);
        expect(node.doc('someone-else', 'kit')).toBeNull();
    });

    it("take runs the tool's reader: an older version is upgraded; a copy that can't be read never replaces the phone's", async () => {
        node.rows.set(`${ME}|kit`, { doc: { v: 1, name: 'Ladder' }, updatedAt: '2026-10-21T08:30:00.000Z' });
        expect(await open(A)).toBe('taken');
        expect(await held(A)).toEqual(doc('Ladder'));
        expect(JSON.parse((await row(A))!.body)).toEqual(doc('Ladder'));

        await write(B, doc('Mine'));
        use(B);
        await writeToolSettings(ME, 'kit', {}, URL_A);
        for (const [i, unreadable] of [{ v: 2, poison: true }, { items: ['no v'] }].entries()) {
            // Newer than B's write, so the open's rule would take it.
            node.rows.set(`${ME}|kit`, { doc: unreadable, updatedAt: iso(Date.parse('2026-12-01T00:00:00.000Z') + i) });
            expect(await open(B)).toBe('unreadable');
            expect(await held(B)).toEqual(doc('Mine'));
            expect((await row(B))!.body).toBe(JSON.stringify(doc('Mine')));
        }
    });

    it("an enterprise's copy goes to its treasury route, signed by a keeper; an open's body is exactly { doc }, the toggle's exactly { doc, turnOn: true }", async () => {
        node.keepers.set('ent-key', new Set(['keeper-1', 'keeper-2']));
        const k1 = { ...A, signer: 'keeper-1' };
        const ent: PhoneToolCopy = { manifest: KIT, owner: { kind: 'enterprise', publicKey: 'ent-key' }, url: URL_A };
        use(k1);
        await writeToolDoc('ent-key', KIT, doc('Till float'), t0);
        expect(await openToolCopy(ent)).toBe('put');
        expect(node.log.map((r) => [r.method, r.path, r.signer])).toEqual([
            ['GET', '/api/treasury/ent-key/tools/kit', 'keeper-1'],
            ['PUT', '/api/treasury/ent-key/tools/kit', 'keeper-1'],
        ]);
        const put = node.log.find((r) => r.method === 'PUT')!;
        expect(Object.keys(put.body as object)).toEqual(['doc']);
        expect(put.body).toEqual({ doc: doc('Till float') });
        expect(JSON.stringify(put.body)).not.toContain('ent-key');
        expect(node.doc('ent-key', 'kit')).toEqual(doc('Till float'));
        expect(node.doc('keeper-1', 'kit')).toBeNull();
        // A member's own copy: their own route, no key in the path or the body.
        use(A);
        await writeToolDoc(ME, KIT, doc('Ladder'), t0);
        await openToolCopy(member(A));
        const own = node.log.filter((r) => r.path === '/api/tools/kit');
        expect(own.map((r) => r.method)).toEqual(['GET', 'PUT']);
        expect(own[1].body).toEqual({ doc: doc('Ladder') });
        // The member's switch-on, on either route: the one PUT that says so.
        for (const [p, copy] of [[k1, ent], [A, member(A)]] as const) {
            use(p);
            expect(await switchToolCopy(copy, false)).toBe('off');
            node.log.length = 0;
            expect(await switchToolCopy(copy, true)).toBe('on');
            expect(node.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
            expect(Object.keys(node.log[1].body as object)).toEqual(['doc', 'turnOn']);
            expect(node.log[1].body).toEqual({ doc: JSON.parse((await readToolCopy(copy.owner.publicKey, 'kit'))!.body), turnOn: true });
        }
    });
});

/** A and B both on, both holding the copy and synced with it. */
async function bothSynced() {
    await write(A, doc('Ladder'));
    await syncNow(A);
    await open(B);
    expect((await row(B))!.syncedAt).not.toBeNull();
}

describe.each([
    ['a node that orders the writes (S2.2: deletedAt, and an ordinary PUT over a removed copy is 410)', true, true],
    ['a node that says when (S2.1: deletedAt)', true, false],
    ["today's node (S2: none, no deletedAt)", false, false],
])('switched off on one phone, with %s', (_name, sendsDeletedAt, refusesOff) => {
    beforeEach(() => { node.sendsDeletedAt = sendsDeletedAt; node.refusesOff = refusesOff; });

    it('5/6. A off: one DELETE, A\'s setting off, its next open asks nothing; B\'s open: no PUT, B off, B\'s copy intact', async () => {
        await bothSynced();
        node.log.length = 0;
        use(A);
        expect(await switchToolCopy(member(A), false)).toBe('off');
        expect(node.log.map((r) => r.method)).toEqual(['DELETE']);
        expect(await setting(A)).toBe(false);
        expect(node.rows.size).toBe(0);
        expect(await open(A)).toBe('off');
        await write(A, doc('Ladder', 'only here'));
        await syncNow(A);
        expect(node.log.map((r) => r.method)).toEqual(['DELETE']);

        expect(await open(B)).toBe('switched-off');
        expect(node.count('PUT')).toBe(0);
        expect(await setting(B)).toBe(false);
        expect(await held(B)).toEqual(doc('Ladder'));
        // Said once: the next open asks nothing at all.
        node.log.length = 0;
        expect(await open(B)).toBe('off');
        expect(node.log).toEqual([]);
    });

    it('5. B wrote since and its sync comes after A\'s off: still switched off, and its write stays on B', async () => {
        await bothSynced();
        use(A);
        await switchToolCopy(member(A), false);
        await write(B, doc('Ladder', 'B since'));
        expect(await syncNow(B)).toBe('switched-off');
        expect(node.rows.size).toBe(0);
        expect(await held(B)).toEqual(doc('Ladder', 'B since'));
    });

    it('11. a fresh phone C (no row) within the 30 days: switched off on S2.1, its first write sends nothing; on S2 (no field) it starts on', async () => {
        await bothSynced();
        use(A);
        await switchToolCopy(member(A), false);
        const C = phone('C');
        node.log.length = 0;
        if (sendsDeletedAt) {
            expect(await open(C)).toBe('switched-off');
            expect(await setting(C)).toBe(false);
            await write(C, doc('C writes'));
            await syncNow(C);
            expect(node.log.map((r) => r.method)).toEqual(['GET']);
        } else {
            // Today's node can't tell C apart from a first open: nothing to take, the default on, and its first write is a
            // new copy (nothing old comes back). Known; closed by S2.1's deletedAt.
            expect(await open(C)).toBe('nothing');
            await write(C, doc('C writes'));
            expect(await syncNow(C)).toBe('put');
            expect(node.doc(ME, 'kit')).toEqual(doc('C writes'));
        }
    });
});

describe('the delete rule: what the node is told and when', () => {
    it("6. the residual: B never synced (offline or an older node until now) and holds a copy; the copy is gone past its tombstone: B's open PUTs it", async () => {
        await bothSynced();
        use(A);
        await switchToolCopy(member(A), false);
        const D = phone('D');
        use(D);
        await writeToolDoc(ME, KIT, doc('D kept offline'), t0);
        node.sendsDeletedAt = true;
        // Within the 30 days, S2.1 says when: D switches off and sends nothing.
        expect(await open(D)).toBe('switched-off');
        await writeToolSettings(ME, 'kit', {}, URL_A);
        // Past them (or on today's node) the node can only say none: D never synced, so it gives its copy (accepted, §6).
        node.prune();
        expect(await open(D)).toBe('put');
        expect(node.doc(ME, 'kit')).toEqual(doc('D kept offline'));
    });

    it("7. B on again: one PUT of B's body at once, setting on; A on: GET, B's copy taken; both read the same document", async () => {
        await bothSynced();
        use(A);
        await switchToolCopy(member(A), false);
        await open(B);
        node.log.length = 0;
        use(B);
        await writeToolDoc(ME, KIT, doc('B again'), t0 + 120_000);
        expect(await switchToolCopy(member(B), true)).toBe('on');
        expect(node.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
        expect(await setting(B)).toBe(true);
        const kept = node.rows.get(`${ME}|kit`)!;
        expect((await row(B))!.syncedAt).toBe(kept.updatedAt);
        // The stamp is past the tombstone: every later open answers the copy.
        use(A);
        expect(await switchToolCopy(member(A), true)).toBe('on');
        expect([await held(A), await held(B)]).toEqual([doc('B again'), doc('B again')]);
        expect(await open(A)).toBe('nothing');
        expect(await open(B)).toBe('nothing');
    });

    it('7. A on with a newer write of its own than the copy: A\'s PUT wins', async () => {
        await bothSynced();
        await write(B, doc('B'), t0 + 1_000);
        await syncNow(B);
        await write(A, doc('A, later'), t0 + 900_000);
        use(A);
        await writeToolSettings(ME, 'kit', { nodeCopy: false }, URL_A);
        expect(await switchToolCopy(member(A), true)).toBe('on');
        expect(node.doc(ME, 'kit')).toEqual(doc('A, later'));
        expect(await open(B)).toBe('taken');
        expect(await held(B)).toEqual(doc('A, later'));
    });

    it('8. on with nothing kept here: the empty document is sent and kept; the next open is equal, no switch-off', async () => {
        use(A);
        await writeToolSettings(ME, 'kit', { nodeCopy: false }, URL_A);
        expect(await switchToolCopy(member(A), true)).toBe('on');
        expect(node.doc(ME, 'kit')).toEqual(KIT.doc.empty());
        const r = await row(A);
        expect(r).toEqual({ body: JSON.stringify(KIT.doc.empty()), updatedAt: node.rows.get(`${ME}|kit`)!.updatedAt, syncedAt: node.rows.get(`${ME}|kit`)!.updatedAt });
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
            await writeToolSettings(ME, 'kit', { nodeCopy: false, door: 'doing' }, URL_A);
            expect(await switchToolCopy(member(A), true), mode).toBe('failed');
            expect(await readToolSettings(ME, 'kit', URL_A)).toEqual({ nodeCopy: false, door: 'doing' });
            await writeToolSettings(ME, 'kit', {}, URL_A);
        }
        node.mode = 'up';
        expect(node.doc(ME, 'kit')).toEqual(doc('Ladder'));
        // An older server: on is refused with its own answer; off is true there (it never kept a copy).
        node.mode = 'older';
        expect(await switchToolCopy(member(A), true)).toBe('older-node');
        expect(await switchToolCopy(member(A), false)).toBe('off');
    });

    it('10. Remove my data, the server first: refused, nothing may go; done, the phone may go and B then switches off', async () => {
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
        expect(node.log.filter((r) => r.method === 'DELETE')).toHaveLength(3);
        // With the copy off already, there is nothing on the server to remove.
        await writeToolSettings(ME, 'kit', { nodeCopy: false }, URL_A);
        node.log.length = 0;
        expect(await removeToolCopyFirst(member(A))).toBe(true);
        expect(node.log).toEqual([]);
        expect(await open(B)).toBe('switched-off');
    });

    it("19. a PUT refused 410 (switched off on the other phone after this one's GET): this phone switches off, its document stays, and its next open asks nothing", async () => {
        node.refusesOff = true;
        await bothSynced();
        const synced = (await row(B))!.syncedAt;
        await write(B, doc('Ladder', 'B since'));
        node.log.length = 0;
        // A's off lands between B's GET and B's PUT.
        node.beforePut = () => { node.answer('DELETE', '/api/tools/kit', undefined, ME); };
        expect(await syncNow(B)).toBe('switched-off');
        expect(node.log.map((r) => r.method)).toEqual(['GET', 'DELETE', 'PUT']);
        expect(node.rows.size).toBe(0);
        expect(await setting(B)).toBe(false);
        expect(await held(B)).toEqual(doc('Ladder', 'B since'));
        expect((await row(B))!.syncedAt).toBe(synced);
        node.log.length = 0;
        expect(await open(B)).toBe('off');
        expect(node.log).toEqual([]);
    });

    it("19. keeper 2's phone on the enterprise route the same: its PUT refused 410 after keeper 1's off, keeper 2 off, the till kept", async () => {
        node.refusesOff = true;
        node.keepers.set('ent-key', new Set(['keeper-1', 'keeper-2']));
        const k2 = { ...phone('K2'), signer: 'keeper-2' };
        const ent: PhoneToolCopy = { manifest: KIT, owner: { kind: 'enterprise', publicKey: 'ent-key' }, url: URL_A };
        use(k2);
        await writeToolDoc('ent-key', KIT, doc('Till float'), t0);
        expect(await openToolCopy(ent)).toBe('put');
        await writeToolDoc('ent-key', KIT, doc('Till float', 'Keys'), t0 + 60_000);
        node.beforePut = () => { node.answer('DELETE', '/api/treasury/ent-key/tools/kit', undefined, 'keeper-1'); };
        expect(await openToolCopy(ent)).toBe('switched-off');
        expect(node.doc('ent-key', 'kit')).toBeNull();
        expect((await readToolSettings('ent-key', 'kit', URL_A)).nodeCopy).toBe(false);
        expect((await readToolDoc('ent-key', KIT)).doc).toEqual(doc('Till float', 'Keys'));
    });

    it("20. a settings record that still holds the old marks (nodeCopyMarks, before fix round 3) is read without error and left alone; nothing here writes one", async () => {
        const OLD = { unsure: 'check', digests: ['0123456789abcdef'] };
        use(A);
        await writeToolSettings(ME, 'kit', { nodeCopyMarks: OLD } as unknown as ToolSettings, URL_A);
        await write(A, doc('Ladder'));
        expect(await syncNow(A)).toBe('put');
        expect(await switchToolCopy(member(A), false)).toBe('off');
        node.log.length = 0;
        expect(await open(A)).toBe('off');
        expect(node.log).toEqual([]);
        expect(await readToolSettings(ME, 'kit', URL_A)).toEqual({ nodeCopyMarks: OLD, nodeCopy: false });
        const REPO = path.resolve(__dirname, '../../../..');
        for (const f of ['apps/native/tools/node-copy.ts', 'apps/native/tools/store.ts', 'apps/native/app/tool/[id].tsx', 'apps/pwa/src/tools/node-copy.ts', 'apps/pwa/src/tools/store.ts', 'apps/pwa/src/pages/ToolsPage.tsx']) {
            expect(fs.readFileSync(path.join(REPO, f), 'utf8'), f).not.toMatch(/nodeCopyMarks|ToolCopyMarks|\.mark\(/);
        }
    });

    it('12. the enterprise\'s copy: keeper 1 off, keeper 2\'s open switches off', async () => {
        node.keepers.set('ent-key', new Set(['keeper-1', 'keeper-2']));
        const k1 = { ...phone('K1'), signer: 'keeper-1' };
        const k2 = { ...phone('K2'), signer: 'keeper-2' };
        const ent: PhoneToolCopy = { manifest: KIT, owner: { kind: 'enterprise', publicKey: 'ent-key' }, url: URL_A };
        use(k1);
        await writeToolDoc('ent-key', KIT, doc('Till float'), t0);
        await openToolCopy(ent);
        use(k2);
        expect(await openToolCopy(ent)).toBe('taken');
        use(k1);
        expect(await switchToolCopy(ent, false)).toBe('off');
        use(k2);
        expect(await openToolCopy(ent)).toBe('switched-off');
        expect((await readToolSettings('ent-key', 'kit', URL_A)).nodeCopy).toBe(false);
        expect((await readToolDoc('ent-key', KIT)).doc).toEqual(doc('Till float'));
    });

    it('only the two hosts call the tool routes; on the server only the store, its route and the copies (standby, re-key, account close) touch the table', () => {
        const REPO = path.resolve(__dirname, '../../../..');
        const SKIP = /(^|\/)(node_modules|dist|generated|__tests__|android|ios|\.expo)(\/|$)|\.test\.[jt]sx?$|(^|\/)test-[^/]*\.ts$/;
        const walk = (dir: string): string[] => fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((e) => {
            const rel = `${dir}/${e.name}`;
            if (SKIP.test(rel)) return [];
            return e.isDirectory() ? walk(rel) : /\.(ts|tsx|js|mjs|sql)$/.test(e.name) ? [rel] : [];
        });
        const read = (f: string) => fs.readFileSync(path.join(REPO, f), 'utf8');
        const clients = ['app', 'components', 'utils', 'services', 'tools', 'constants'].map((d) => `apps/native/${d}`)
            .concat(['apps/pwa/src', 'apps/manager/src'], fs.readdirSync(path.join(REPO, 'packages')).map((p) => `packages/${p}/src`))
            .filter((d) => fs.existsSync(path.join(REPO, d)));
        const callers = clients.flatMap(walk).filter((f) => /\/api\/tools\/|\/tools\/\$\{|toolCopyPath\(/.test(read(f)));
        expect(callers.sort()).toEqual(['apps/native/tools/node-copy.ts', 'apps/pwa/src/tools/node-copy.ts', 'packages/beanpool-core/src/tools/node-copy.ts']);
        // No sync page, Home answer, pooled count or admin screen reads it.
        const server = walk('apps/server/src').filter((f) => /member_tool_state|tool-state\.js|routes\/tools\.js/.test(read(f)));
        expect(server.sort()).toEqual([
            'apps/server/src/db/schema.sql', 'apps/server/src/engine/key-move.ts', 'apps/server/src/engine/replication-manifest.ts',
            'apps/server/src/engine/sync.ts', 'apps/server/src/engine/tool-state.ts', 'apps/server/src/https-server.ts',
            'apps/server/src/routes/tools.ts', 'apps/server/src/state-engine.ts',
        ]);
    });

    it('nothing runs once the phone has moved to another community: its file and its server are another\'s', async () => {
        await write(A, doc('Ladder'));
        A.map.set('beanpool_anchor_url', 'https://elsewhere.example');
        expect(await open(A)).toBe('later');
        expect(await switchToolCopy(member(A), false)).toBe('failed');
        expect(await removeToolCopyFirst(member(A))).toBe(false);
        expect(node.log).toEqual([]);
    });
});

describe('off means gone, even when a slow PUT is on its way (PR #2297, the deciding review at d4fcc070)', () => {
    beforeEach(() => { node.refusesOff = true; });
    /** A write's sync, its PUT on a slow line (`arrives` ms), and the member switching the copy off while it is out. */
    async function offWhilePutIsOut(arrives: number, landsAnyway: boolean) {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await write(A, doc('Ladder'));
        net.slowPut = { arrives, landsAnyway };
        await vi.advanceTimersByTimeAsync(TOOL_COPY_PUSH_MS);
        expect(net.signals.map(([m]) => m)).toEqual(['GET', 'PUT']);
        return { off: switchToolCopy(member(A), false) };
    }

    it('each request gets a signal; a PUT slower than the limit is let go then, and only then does the off send its DELETE', async () => {
        const { off } = await offWhilePutIsOut(45_000, false);
        await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS - 1);
        const put = net.signals[1][1]!;
        expect(put.aborted).toBe(false);
        expect(node.log.map((r) => r.method)).toEqual(['GET']);
        await vi.advanceTimersByTimeAsync(1);
        expect(await off).toBe('off');
        expect(put.aborted).toBe(true);
        expect(net.signals.map(([m, s]) => [m, s instanceof AbortSignal])).toEqual([['GET', true], ['PUT', true], ['DELETE', true]]);
        expect(node.log.map((r) => r.method)).toEqual(['GET', 'DELETE']);
        expect(await readToolSettings(ME, KIT.id, URL_A)).toEqual({ nodeCopy: false });
        // Off: the next open asks nothing at all.
        await vi.advanceTimersByTimeAsync(60_000);
        node.log.length = 0;
        expect(await open(A)).toBe('off');
        expect(node.log).toEqual([]);
    });

    it("a PUT let go at the limit that the node takes anyway, after the DELETE (the review's order): refused there, and the next open sends nothing", async () => {
        for (const refusesOff of [true, false]) {
            node = new FakeNode();
            net.node = node;
            net.signals = [];
            node.refusesOff = refusesOff;
            A = phone(`A, S2.2 ${refusesOff}`);
            const { off } = await offWhilePutIsOut(45_000, true);
            await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS);
            expect(await off).toBe('off');
            await vi.advanceTimersByTimeAsync(45_000);
            expect(node.log.map((r) => r.method)).toEqual(['GET', 'DELETE', 'PUT']);
            // S2.2 refuses it (410, nothing written); a node before it keeps it (residual 1: it closes as nodes update).
            expect(node.doc(ME, 'kit')).toEqual(refusesOff ? null : doc('Ladder'));
            node.log.length = 0;
            expect(await open(A)).toBe('off');
            expect(node.log).toEqual([]);
            expect(await readToolSettings(ME, KIT.id, URL_A)).toEqual({ nodeCopy: false });
        }
    });

    it('a PUT that lands before the limit: the off waits for its answer', async () => {
        const { off } = await offWhilePutIsOut(10_000, false);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(node.log.map((r) => r.method)).toEqual(['GET']);
        await vi.advanceTimersByTimeAsync(1);
        expect(await off).toBe('off');
        expect(node.log.map((r) => r.method)).toEqual(['GET', 'PUT', 'DELETE']);
        expect(node.rows.size).toBe(0);
        expect(await readToolSettings(ME, KIT.id, URL_A)).toEqual({ nodeCopy: false });
        node.log.length = 0;
        expect(await open(A)).toBe('off');
        expect(node.log).toEqual([]);
    });

    it('Remove my data with a PUT out: the DELETE goes once the PUT has settled; refused, nothing may go', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await write(A, doc('Ladder'));
        net.slowPut = { arrives: 10_000, landsAnyway: false };
        await vi.advanceTimersByTimeAsync(TOOL_COPY_PUSH_MS);
        node.mode = 'refusing';
        const refused = removeToolCopyFirst(member(A));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await refused).toBe(false);
        expect(node.log.map((r) => r.method)).toEqual(['GET', 'PUT', 'DELETE']);
        expect(await setting(A)).toBeUndefined();
        node.mode = 'up';
        expect(await removeToolCopyFirst(member(A))).toBe(true);
        expect(node.rows.size).toBe(0);
        expect(await readToolSettings(ME, KIT.id, URL_A)).toEqual({ nodeCopy: false });
    });

    describe("keeper 1's late PUT never undoes keeper 2's switch-on, and no mark is kept (the reviews at 8a48f318 and after)", () => {
        it("12. the enterprise's copy: keeper 1's phone, off with a PUT let go, leaves the copy keeper 2 switched on; keeper 2 stays on", async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            node.keepers.set('ent-key', new Set(['keeper-1', 'keeper-2']));
            const k1 = { ...phone('K1'), signer: 'keeper-1' };
            const k2 = { ...phone('K2'), signer: 'keeper-2' };
            const ent: PhoneToolCopy = { manifest: KIT, owner: { kind: 'enterprise', publicKey: 'ent-key' }, url: URL_A };
            const entSettings = async (p: Phone) => { use(p); return readToolSettings('ent-key', 'kit', URL_A); };
            use(k1);
            await writeToolDoc('ent-key', KIT, doc('Till float'), t0);
            expect(await openToolCopy(ent)).toBe('put');
            // Keeper 1's next sync after a write: its PUT let go at the limit, never taken.
            await writeToolDoc('ent-key', KIT, doc('Till float', 'Keys'), t0 + 60_000);
            net.slowPut = { arrives: 45_000, landsAnyway: false };
            const sync = openToolCopy(ent);
            await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS);
            expect(await sync).toBe('later');
            expect(await switchToolCopy(ent, false)).toBe('off');
            expect(await entSettings(k1)).toEqual({ nodeCopy: false });
            // Keeper 2 switches it on again, with the enterprise's document as keeper 2's phone holds it.
            use(k2);
            await writeToolDoc('ent-key', KIT, doc('Cash tin'), t0 + 120_000);
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

        it("keeper 1's own late PUT, taken after the off: the node refuses it, so no copy is left and keeper 1's next open asks nothing", async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            node.keepers.set('ent-key', new Set(['keeper-1']));
            const k1 = { ...phone('K1'), signer: 'keeper-1' };
            const ent: PhoneToolCopy = { manifest: KIT, owner: { kind: 'enterprise', publicKey: 'ent-key' }, url: URL_A };
            use(k1);
            await writeToolDoc('ent-key', KIT, doc('Till float'), t0);
            expect(await openToolCopy(ent)).toBe('put');
            await writeToolDoc('ent-key', KIT, doc('Till float', 'Keys'), t0 + 60_000);
            net.slowPut = { arrives: 45_000, landsAnyway: true };
            const sync = openToolCopy(ent);
            await vi.advanceTimersByTimeAsync(TOOL_COPY_ANSWER_MS);
            expect(await sync).toBe('later');
            expect(await switchToolCopy(ent, false)).toBe('off');
            await vi.advanceTimersByTimeAsync(45_000);
            expect(node.log.map((r) => r.method)).toEqual(['GET', 'PUT', 'GET', 'DELETE', 'PUT']);
            expect(node.doc('ent-key', 'kit')).toBeNull();
            node.log.length = 0;
            expect(await openToolCopy(ent)).toBe('off');
            expect(node.log).toEqual([]);
            expect(await readToolSettings('ent-key', 'kit', URL_A)).toEqual({ nodeCopy: false });
        });
    });
});
