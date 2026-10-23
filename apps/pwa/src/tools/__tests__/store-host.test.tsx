/**
 * The web host's one store, its document handling and its doors (scratch/tools/DESIGN-tool-template-fable.md §1.4, §1.6,
 * slice T0.3): IndexedDB `beanpool-tools` / `tool_docs`, one record per community, owner and tool; nothing written once
 * the account has left this browser; every sign-out leaves nothing of it; a draft held to the composer's own fields.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { TOOL_LIMITS, word, type ToolManifest } from '@beanpool/core';
import { memoryIndexedDB, MemoryIDBKeyRange, type MemoryIndexedDB } from '../../lib/memory-indexeddb';
import { endAccountEpoch, resetAccountEpochForTest } from '../../lib/account-epoch';
import { clearAccountStorage } from '../../lib/device-prefs';
import {
    TOOL_DB_NAME, TOOL_STORE, clearToolRecordsFor, clearToolStore, readToolRecord, removeToolRecord, resetToolStoreForTest, subscribeToolStore, toolRecordKey, writeToolRecord,
} from '../store';
import { COMPOSER_TITLE_CHARS, ToolDocTooBig, composerDraft, docMaxBytes, isEmptyDoc, readDoc, useToolDoc, webHostFor } from '../builder';
import { parseToolTarget, toolTarget } from '../route';
import { drawnToolCardTypes, toolOfCard } from '../cards';
import { HOME_DRAWN } from '../../lib/home-layout';

const rec = (body: string) => ({ body, updatedAt: '2026-10-20T08:00:00.000Z', syncedAt: null });
let mem: MemoryIndexedDB;

beforeEach(() => {
    localStorage.clear();
    mem = memoryIndexedDB();
    vi.stubGlobal('indexedDB', mem);
    vi.stubGlobal('IDBKeyRange', MemoryIDBKeyRange);
    resetToolStoreForTest();
    resetAccountEpochForTest();
});
afterEach(() => { vi.unstubAllGlobals(); resetAccountEpochForTest(); });

/**
 * `inner`, with connections the browser can drop, as when its storage process goes or iOS has had the page in the
 * background a long time: from then on every transaction on that connection throws InvalidStateError, and `close` fires
 * on it. A connection opened afterwards works.
 */
function droppable(inner: MemoryIndexedDB) {
    const live: Array<() => void> = [];
    const open = (name: string, version?: number) => {
        const req = inner.open(name, version) as ReturnType<MemoryIndexedDB['open']> & { onupgradeneeded: ((ev: unknown) => void) | null };
        let lost = false;
        let db: { onclose: ((ev: unknown) => void) | null; [k: string]: unknown } | null = null;
        const outer = {
            onsuccess: null as ((ev: unknown) => void) | null,
            onerror: null as ((ev: unknown) => void) | null,
            onupgradeneeded: null as ((ev: unknown) => void) | null,
            error: null as unknown,
            get result() { return db; },
        };
        const wrap = () => {
            const real = req.result as { createObjectStore(n: string): unknown; close(): void; transaction(...a: unknown[]): unknown };
            const conn = {
                onclose: null as ((ev: unknown) => void) | null,
                onversionchange: null as ((ev: unknown) => void) | null,
                createObjectStore: (n: string) => real.createObjectStore(n),
                close: () => real.close(),
                transaction: (...a: unknown[]) => {
                    if (lost) throw new DOMException('Connection to Indexed Database server lost.', 'InvalidStateError');
                    return real.transaction(...a);
                },
            };
            db = conn;
            live.push(() => { lost = true; conn.onclose?.({}); });
        };
        req.onupgradeneeded = (ev) => { if (!db) wrap(); outer.onupgradeneeded?.(ev); };
        req.onsuccess = (ev) => { if (!db) wrap(); outer.onsuccess?.(ev); };
        req.onerror = (ev) => outer.onerror?.(ev);
        return outer;
    };
    return { idb: { ...inner, open }, dropAll: () => live.splice(0).forEach((drop) => drop()) };
}

interface Doc { v: number; items: string[] }
const tool: ToolManifest<Doc> = {
    id: 'notes', name: word('New tool'), line: word('One line on what this tool keeps for you.'), icon: '🧩', shelf: 'stock',
    shopKinds: 'all', owner: 'member', permissions: [], screens: ['main'], row: () => null, examples: [],
    doc: {
        version: 1,
        empty: () => ({ v: 1, items: [] }),
        read: (raw) => (raw && typeof raw === 'object' && Array.isArray((raw as Doc).items) ? { v: 1, items: (raw as Doc).items } : { v: 1, items: [] }),
        maxBytes: 200,
    },
    homeCard: { line: word('What your new tool keeps, at a glance.'), lines: () => [] },
};

describe('the one store (IndexedDB)', () => {
    it('keeps a document whole, per owner and per community, in tool_docs', async () => {
        expect(await writeToolRecord('ana', 'notes', rec('{"v":1,"items":["a"]}'))).toBe(true);
        expect(await readToolRecord('ana', 'notes')).toEqual(rec('{"v":1,"items":["a"]}'));
        expect(mem.peek(TOOL_DB_NAME, TOOL_STORE, toolRecordKey('ana', 'notes'))).toEqual(rec('{"v":1,"items":["a"]}'));
        // Another member in this browser, another tool, another community: nothing.
        expect(await readToolRecord('ben', 'notes')).toBeNull();
        expect(await readToolRecord('ana', 'garden')).toBeNull();
        localStorage.setItem('bp_node_url', 'https://other.example');
        expect(await readToolRecord('ana', 'notes')).toBeNull();
    });

    it('Remove my data takes one document, and leaves the others', async () => {
        await writeToolRecord('ana', 'notes', rec('{}'));
        await writeToolRecord('ana', 'garden', rec('{}'));
        expect(await removeToolRecord('ana', 'notes')).toBe(true);
        expect(await readToolRecord('ana', 'notes')).toBeNull();
        expect(await readToolRecord('ana', 'garden')).not.toBeNull();
    });

    it('no IndexedDB (a private window, an old browser): every tool reads empty and a write says it did not keep', async () => {
        vi.stubGlobal('indexedDB', undefined);
        resetToolStoreForTest();
        expect(await readToolRecord('ana', 'notes')).toBeNull();
        expect(await writeToolRecord('ana', 'notes', rec('{}'))).toBe(false);
        await expect(clearToolStore()).resolves.toBeUndefined();
    });

    it('a full disk: the write says it did not keep, and nothing is half-kept', async () => {
        await writeToolRecord('ana', 'notes', rec('"old"'));
        mem.failNextCommit();
        expect(await writeToolRecord('ana', 'notes', rec('"new"'))).toBe(false);
        expect((await readToolRecord('ana', 'notes'))?.body).toBe('"old"');
    });

    it('once the account has signed out (here or in another tab), nothing is written back', async () => {
        endAccountEpoch('signed-out');
        expect(await writeToolRecord('ana', 'notes', rec('{}'))).toBe(false);
        expect(mem.peek(TOOL_DB_NAME, TOOL_STORE, toolRecordKey('ana', 'notes'))).toBeUndefined();
    });

    it('Sign Out leaves nothing: every document of every member and community, and the database itself', async () => {
        await writeToolRecord('ana', 'notes', rec('{"v":1,"items":["my ladder"]}'));
        await writeToolRecord('ben', 'garden', rec('{}'));
        localStorage.setItem('bp_node_url', 'https://other.example');
        await writeToolRecord('ana', 'notes', rec('{}'));
        expect(mem.has(TOOL_DB_NAME)).toBe(true);

        await clearAccountStorage();

        expect(mem.has(TOOL_DB_NAME)).toBe(false);
        resetToolStoreForTest();
        resetAccountEpochForTest();
        expect(await readToolRecord('ana', 'notes')).toBeNull();
        localStorage.removeItem('bp_node_url');
        expect(await readToolRecord('ana', 'notes')).toBeNull();
        expect(await readToolRecord('ben', 'garden')).toBeNull();
    });

    it('leaving a community takes that community\'s tool documents and leaves the others', async () => {
        localStorage.setItem('bp_node_url', 'https://leave.example');
        await writeToolRecord('ana', 'notes', rec('{"v":1,"items":["leave"]}'));
        localStorage.setItem('bp_node_url', 'https://stay.example');
        await writeToolRecord('ana', 'notes', rec('{"v":1,"items":["stay"]}'));

        expect(await clearToolRecordsFor('https://leave.example')).toBe(true);

        localStorage.setItem('bp_node_url', 'https://leave.example');
        expect(await readToolRecord('ana', 'notes')).toBeNull();
        localStorage.setItem('bp_node_url', 'https://stay.example');
        expect(await readToolRecord('ana', 'notes')).toEqual(rec('{"v":1,"items":["stay"]}'));
    });

    it('clearToolRecordsFor normalizes trailing slashes on nodeUrl', async () => {
        localStorage.setItem('bp_node_url', 'https://slash.example');
        await writeToolRecord('ana', 'notes', rec('{"v":1}'));
        expect(await clearToolRecordsFor('https://slash.example///')).toBe(true);
        expect(await readToolRecord('ana', 'notes')).toBeNull();
    });

    it('notifies subscribers on write, remove, and clear', async () => {
        const events: Array<{ owner: string; tool: string }> = [];
        const unsub = subscribeToolStore((owner, tool) => events.push({ owner, tool }));

        await writeToolRecord('ana', 'notes', rec('{}'));
        expect(events).toEqual([{ owner: 'ana', tool: 'notes' }]);

        await removeToolRecord('ana', 'notes');
        expect(events).toEqual([
            { owner: 'ana', tool: 'notes' },
            { owner: 'ana', tool: 'notes' },
        ]);

        await clearToolRecordsFor('https://example.org');
        expect(events[2]).toEqual({ owner: '*', tool: '*' });

        unsub();
        await writeToolRecord('ana', 'notes', rec('{}'));
        expect(events).toHaveLength(3);
    });

    // Review of #2274: a connection the browser closed was held on to, so every read came back empty and every write
    // failed until a reload.
    it('a connection the browser drops is let go of: the next read and write open the database again', async () => {
        const { idb, dropAll } = droppable(mem);
        vi.stubGlobal('indexedDB', idb);
        resetToolStoreForTest();
        expect(await writeToolRecord('ana', 'notes', rec('"kept"'))).toBe(true);
        dropAll();
        expect((await readToolRecord('ana', 'notes'))?.body).toBe('"kept"');
        expect(await writeToolRecord('ana', 'notes', rec('"again"'))).toBe(true);
        expect((await readToolRecord('ana', 'notes'))?.body).toBe('"again"');
    });

    it('a sign-out while the database is open in this page empties it too', async () => {
        await writeToolRecord('ana', 'notes', rec('{}'));
        await readToolRecord('ana', 'notes'); // held open
        await clearToolStore();
        expect(mem.has(TOOL_DB_NAME)).toBe(false);
    });
});

describe('the document', () => {
    it('read: any stored text, garbage and a throwing read() included, is a document; never a throw', () => {
        expect(readDoc(tool, null)).toEqual({ v: 1, items: [] });
        expect(readDoc(tool, 'not json')).toEqual({ v: 1, items: [] });
        expect(readDoc(tool, '{"v":1,"items":["a"]}')).toEqual({ v: 1, items: ['a'] });
        const throwing = { ...tool, doc: { ...tool.doc, read: () => { throw new Error('bad'); } } };
        expect(readDoc(throwing, '{}')).toEqual({ v: 1, items: [] });
        expect(isEmptyDoc(tool, { v: 1, items: [] })).toBe(true);
        expect(isEmptyDoc(tool, { v: 1, items: ['a'] })).toBe(false);
    });

    it("a tool's bound: its own (64 KB when it names none), never past 128 KB, and never past what the node said it keeps", () => {
        expect(docMaxBytes(tool as ToolManifest<unknown>)).toBe(200);
        expect(docMaxBytes({ ...tool, doc: { ...tool.doc, maxBytes: undefined } } as ToolManifest<unknown>)).toBe(TOOL_LIMITS.docBytes);
        expect(docMaxBytes({ ...tool, doc: { ...tool.doc, maxBytes: 10_000_000 } } as ToolManifest<unknown>)).toBe(TOOL_LIMITS.docBytesMax);
        expect(docMaxBytes({ ...tool, doc: { ...tool.doc, maxBytes: 131_072 } } as ToolManifest<unknown>, 65_536)).toBe(65_536);
    });

    it("set() holds to the node's max once heard: an older node's 64 KB refuses a 70 KB document of a tool that names 128 KB", async () => {
        const big = { ...tool, doc: { ...tool.doc, maxBytes: 131_072 } } as typeof tool;
        const seventy = { v: 1, items: ['x'.repeat(70_000)] };
        const { result, rerender } = renderHook(({ nodeMax }: { nodeMax?: number }) => useToolDoc(big, 'ana', undefined, nodeMax), { initialProps: {} });
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        expect(result.current.maxBytes()).toBe(131_072);
        await act(async () => { await result.current.set(seventy); });
        rerender({ nodeMax: 65_536 });
        expect(result.current.maxBytes()).toBe(65_536);
        let refused: unknown = null;
        await act(async () => { await result.current.set({ v: 1, items: ['y'.repeat(70_000)] }).catch((e) => { refused = e; }); });
        expect(refused).toBeInstanceOf(ToolDocTooBig);
        expect((refused as ToolDocTooBig).max).toBe(65_536);
        expect(JSON.parse((await readToolRecord('ana', 'notes'))!.body)).toEqual(seventy);
    });

    it('set() writes whole; one over the bound is refused whole, nothing written, and the tool is told why', async () => {
        const { result } = renderHook(() => useToolDoc(tool, 'ana'));
        await waitFor(() => expect(result.current.state.status).toBe('ready'));
        await act(async () => { await result.current.set({ v: 1, items: ['ladder'] }); });
        expect(JSON.parse((await readToolRecord('ana', 'notes'))!.body)).toEqual({ v: 1, items: ['ladder'] });
        let refused: unknown = null;
        await act(async () => { await result.current.set({ v: 1, items: ['x'.repeat(500)] }).catch((e) => { refused = e; }); });
        expect(refused).toBeInstanceOf(ToolDocTooBig);
        expect(JSON.parse((await readToolRecord('ana', 'notes'))!.body)).toEqual({ v: 1, items: ['ladder'] });
        expect(result.current.get()).toEqual({ v: 1, items: ['ladder'] });
    });
});

describe('the host', () => {
    const ctx = {
        owner: { kind: 'member' as const, publicKey: 'ana', name: 'Ana' },
        node: { url: null, profile: 'local', features: null },
        navigate: vi.fn(),
        back: vi.fn(),
        openComposer: vi.fn(),
    };
    const doc = { get: () => ({ v: 1, items: [] }), set: async () => {}, maxBytes: () => 200 };

    it('given only what the manifest declared: an undeclared door is absent, and the web grants none it has not built', () => {
        expect(Object.keys(webHostFor(tool, ctx, doc)).sort()).toEqual(['back', 'doc', 'navigate', 'node', 'now', 'owner']);
        const withDoors = webHostFor({ ...tool, permissions: ['need-door', 'place', 'event-door', 'reminders'] as const }, ctx, doc);
        expect(Object.keys(withDoors).sort()).toEqual(['back', 'doc', 'navigate', 'needDoor', 'node', 'now', 'owner']);
        expect('offerDoor' in withDoors).toBe(false);
        expect('place' in withDoors).toBe(false);
        // What the Tool shed asks for was built with it (T1.3).
        const shed = webHostFor({ ...tool, permissions: ['photos', 'camera', 'posts', 'deals', 'pricing-guide'] as const }, ctx, doc);
        expect(Object.keys(shed).sort()).toEqual(['back', 'camera', 'deals', 'doc', 'navigate', 'node', 'now', 'owner', 'photos', 'posts', 'pricingGuide']);
    });

    it("an offer draft as the composer takes it: unknown fields dropped, an unknown category or a bad price left to the member", () => {
        expect(composerDraft('offer', {
            title: 'x'.repeat(500), description: 'Three metres', category: 'tools', credits: 5, priceType: 'daily', repeatable: true,
            lendable: true, shop: true, availableFrom: '2026-11-03', photos: ['ref1'],
        })).toEqual({
            type: 'offer', title: 'x'.repeat(COMPOSER_TITLE_CHARS), description: 'Three metres', category: 'tools', credits: 5,
            priceType: 'daily', repeatable: true, cashAlsoNeeded: false,
        });
        expect(composerDraft('offer', { title: 'Jam', category: 'not-a-category', credits: -2, priceType: 'yearly' }))
            .toMatchObject({ category: null, credits: null, priceType: null });
        expect(composerDraft('offer', { title: 'Jam', credits: 2.5 }).credits).toBeNull();
        // A Need carries no price.
        expect(composerDraft('need', { title: 'Seeds', description: 'Tomato' })).toEqual({
            type: 'need', title: 'Seeds', description: 'Tomato', category: null, credits: null, priceType: null, repeatable: false, cashAlsoNeeded: false,
        });
    });

    it('the doors call the composer and nothing else', () => {
        const host = webHostFor({ ...tool, permissions: ['offer-door'] as const }, ctx, doc);
        host.offerDoor({ title: 'Ladder' });
        expect(ctx.openComposer).toHaveBeenCalledWith(expect.objectContaining({ type: 'offer', title: 'Ladder' }));
    });
});

describe("the covered page's place, and Home", () => {
    it("navigateToTab's context and openTool, both ways", () => {
        expect(parseToolTarget(null)).toEqual({ id: null, screen: 'main', key: null });
        expect(parseToolTarget('things')).toEqual({ id: 'things', screen: 'main', key: null });
        expect(parseToolTarget('things?screen=thing&key=t%201')).toEqual({ id: 'things', screen: 'thing', key: 't 1' });
        expect(toolTarget('things')).toBe('things');
        expect(parseToolTarget(toolTarget('things', 'thing', 't 1'))).toEqual({ id: 'things', screen: 'thing', key: 't 1' });
    });

    it("a tool's card is drawn on Home only for a tool with a card and a web half; the Tool shed's ships (T1.3)", () => {
        expect(drawnToolCardTypes()).toEqual(['tool-things']);
        expect([...HOME_DRAWN].filter((t) => t.startsWith('tool-'))).toEqual(['tool-things']);
        expect(drawnToolCardTypes([tool], { notes: () => null })).toEqual(['tool-notes']);
        expect(drawnToolCardTypes([tool], {})).toEqual([]);
        expect(drawnToolCardTypes([{ ...tool, homeCard: undefined }], { notes: () => null })).toEqual([]);
        expect(toolOfCard('tool-notes', [tool], { notes: () => null })).toBe(tool);
        expect(toolOfCard('tool-garden', [tool], { notes: () => null })).toBeUndefined();
    });
});
