/**
 * A chat ever seen locked is never sent readable words: every path of the web that can send them (lib/api.ts) x what this
 * browser knows of the chat's lock. The words go on a positive "never locked" and on nothing else (lib/group-hold.ts
 * readableLineTo; the phone's table: apps/native/utils/__tests__/group-in-place-table.test.ts; #3358, "Web, follow-up").
 *
 * Real api.ts, real lock store over an in-memory IndexedDB, real keyrings. "Sent" is read off fetch: a POST whose body
 * holds the words, plain or in base64. The screens' own rows: pages/MessagesPage.readable-lines.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { endAccountEpoch, resetAccountEpochForTest, ACCOUNT_EPOCH_KEY } from './account-epoch';
import { rememberDmConversations } from './dm-guard';
import { encodePlaintext } from './e2e-crypto';
import { fakeGroupNode, person } from './group-chat-fake-node.test-support';
import {
    forgetGroupKeys, groupKeyring, GroupChatKeyError, memoryGroupLockStore, noteAnsweredLocked, resetAnsweredLockedForTest,
} from './group-chat-keys';
import { chatIsLocked, groupChatSendPlan, GROUP_CHAT_LOCK_LOST_TEXT } from './group-chat-lines';
import { indexedDbGroupLockStore as store, LOCK_STORE_MS, resetGroupChatLockStoreForTest } from './group-chat-lock-store';
import { GROUP_CHAT_IS_DM_TEXT, GROUP_HOLD_EVENT_TEXT, GROUP_HOLD_UNREAD_TEXT, readableLineTo } from './group-hold';
import { memoryIndexedDB, type MemoryIndexedDB } from './memory-indexeddb';

let me: { publicKey: string; privateKey: string } | null = null;
/** Run at each read of the account: the check's own is the first, the request's signing the second. */
let onIdentity: (nth: number) => unknown = () => {};
let identityReads = 0;
vi.mock('./identity', () => ({
    loadIdentity: vi.fn(async () => { identityReads += 1; await onIdentity(identityReads); return me; }),
}));

import { editMessageApi, getConversationMessages, getEnterpriseThread, getEventChat, getGroupChat, postEnterpriseThreadMessage, postEventChatMessage, sendMessageApi } from './api';

const ID = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';
const OTHER = '00000000-4a59-4e68-9d7c-8b9a0f1e2d3c';
const WORDS = 'meet at the shed at nine';
const B64 = encodePlaintext(WORDS).ciphertext;
const SEALED = 'x25519-xc20p-v2:AAAA';
const ana = person(true);
const rowKey = (id = ID, pk = ana.publicKey) => `${pk}/${id}`;
const locked = { encryption: { current: 1, stale: false, fromEpoch: 1 }, messages: [] };
const unlocked = { messages: [] };
const sealedLine = { messages: [{ id: 'l1', ciphertext: 'x', nonce: 'group-xc20p-v1:AAAA' }] };

// ── the store's faults ──────────────────────────────────────────────────────────────────────────────────────────────

interface Faults {
    open?: 'error' | 'never' | 'blocked';
    /** Per key read: what becomes of it. */
    get?: (key: string) => 'error' | 'never' | undefined;
    commit?: 'fail' | 'never';
    onGet?: (key: string) => void;
}
let mem: MemoryIndexedDB;
let faults: Faults = {};

/** The in-memory IndexedDB, with the lock store's faults as they stand at each call. */
function faulty(inner: MemoryIndexedDB) {
    const wrap = (db: any) => ({
        createObjectStore: (n: string) => db.createObjectStore(n),
        close: () => db.close(),
        transaction: (s: string, mode?: IDBTransactionMode) => {
            if (mode === 'readwrite' && faults.commit === 'fail') inner.failNextCommit();
            if (mode === 'readwrite' && faults.commit === 'never') inner.holdNextCommit();
            const tx = db.transaction(s, mode);
            const os = tx.objectStore;
            tx.objectStore = () => {
                const real = os.call(tx);
                return {
                    ...real,
                    get(key: string) {
                        if (mode !== 'readwrite') faults.onGet?.(key);
                        const fault = mode === 'readwrite' ? undefined : faults.get?.(key);
                        if (!fault) return real.get(key);
                        const req: any = { result: undefined, error: new DOMException('The read failed.', 'UnknownError'), onsuccess: null, onerror: null };
                        if (fault === 'error') setTimeout(() => req.onerror?.({ target: req }), 0);
                        return req;
                    },
                };
            };
            return tx;
        },
    });
    return {
        open(name: string, v?: number) {
            const outer: any = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
            if (faults.open === 'never') return outer;
            if (faults.open) {
                const how = faults.open;
                outer.error = new DOMException('The lock store did not open.', 'UnknownError');
                setTimeout(() => (how === 'blocked' ? outer.onblocked : outer.onerror)?.({ target: outer }), 0);
                return outer;
            }
            const req = inner.open(name, v) as any;
            req.onupgradeneeded = (ev: any) => { outer.result = wrap(req.result); outer.onupgradeneeded?.(ev); };
            req.onsuccess = (ev: any) => { outer.result = wrap(req.result); outer.onsuccess?.(ev); };
            req.onerror = (ev: any) => { outer.error = req.error; outer.onerror?.(ev); };
            return outer;
        },
        deleteDatabase: (n: string) => inner.deleteDatabase(n),
    };
}

// ── the node, as fetch ──────────────────────────────────────────────────────────────────────────────────────────────

let answer: unknown = unlocked;
let posts: { url: string; body: string }[] = [];
const wordsWent = () => posts.filter((p) => p.body.includes(WORDS) || p.body.includes(B64));

/** This page, loaded afresh: no ring, no session memory, the store opened again. What IndexedDB has stays. */
function pageLoad() {
    forgetGroupKeys();
    resetAnsweredLockedForTest();
    resetGroupChatLockStoreForTest();
}

beforeEach(() => {
    localStorage.clear();
    resetAccountEpochForTest();
    me = { ...ana };
    onIdentity = () => {};
    identityReads = 0;
    faults = {};
    answer = unlocked;
    posts = [];
    mem = memoryIndexedDB();
    vi.stubGlobal('indexedDB', faulty(mem));
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit = {}) => {
        if (opts.method === 'POST') posts.push({ url, body: String(opts.body ?? '') });
        return new Response(JSON.stringify(opts.method === 'GET' ? answer : { success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    pageLoad();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const ring = () => groupKeyring(fakeGroupNode(ID, [ana.publicKey]).as(ana.publicKey), ana, ID, store);

// ── the paths ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every way the web can put words in a chat for the node to read. The source row below fails on a new one. */
const PATHS: { name: string; send: (id: string) => Promise<unknown>; sentence: string }[] = [
    { name: "an event's chat", send: (id) => postEventChatMessage(id, WORDS), sentence: GROUP_HOLD_EVENT_TEXT },
    { name: "an enterprise's discussion", send: (id) => postEnterpriseThreadMessage(id, WORDS), sentence: GROUP_HOLD_EVENT_TEXT },
    { name: "Messages: a line (an old node's group, an event's or enterprise's by its type)", send: (id) => sendMessageApi(id, ana.publicKey, B64, 'plaintext-v1'), sentence: GROUP_CHAT_LOCK_LOST_TEXT },
    { name: 'Messages: an edit of one', send: (id) => editMessageApi('line-1', ana.publicKey, B64, 'plaintext-v1', id), sentence: GROUP_CHAT_LOCK_LOST_TEXT },
    { name: 'a line under a nonce no one knows', send: (id) => sendMessageApi(id, ana.publicKey, B64, 'some-nonce'), sentence: GROUP_CHAT_LOCK_LOST_TEXT },
    { name: 'a photo not sealed, under a sealed caption', send: (id) => sendMessageApi(id, ana.publicKey, 'AAAA', SEALED, 'image', { data: B64, nonce: 'plaintext-v1', mime: 'image/jpeg' }), sentence: GROUP_CHAT_LOCK_LOST_TEXT },
];

// ── what this browser knows ─────────────────────────────────────────────────────────────────────────────────────────

interface Mark {
    name: string;
    /** Whether the words may go: only on a positive "never locked". */
    sent: boolean;
    arrange: () => unknown;
    /** What the refusal says: the path's locked sentence, this one, or (a string) another. */
    says?: 'locked' | 'unread' | string;
    /** The send's id, where it isn't the mark's own spelling. */
    id?: string;
    /** Refused only once the store's time is up. */
    waits?: boolean;
    /** Refused with no wait for the store, which doesn't answer. */
    atOnce?: boolean;
    /** The store answers from here on: an honest "never" then goes. */
    heals?: boolean;
}

const never = (key: string) => (k: string) => (k === key ? 'never' as const : undefined);
const fails = (key: string) => (k: string) => (k === key ? 'error' as const : undefined);
const indexRow = `${ana.publicKey}/`;

const MARKS: Mark[] = [
    // none
    { name: 'none', sent: true, arrange: () => {} },
    { name: "none: another chat's mark", sent: true, arrange: () => store.markLocked(rowKey(OTHER)) },
    { name: "none: another account's mark of it", sent: true, arrange: () => store.markLocked(rowKey(ID, 'b'.repeat(64))) },
    { name: 'none: a ring of it was asked and saw nothing', sent: true, arrange: async () => { expect(await ring().seenLocked()).toBe(false); } },
    { name: 'none: the node answered it unlocked', sent: true, arrange: () => getGroupChat(ID) },
    { name: 'none: another chat answered locked', sent: true, arrange: async () => { answer = locked; await getGroupChat(OTHER); answer = unlocked; } },
    // seen locked
    { name: 'seen locked', sent: false, says: 'locked', arrange: async () => { await store.markLocked(rowKey()); pageLoad(); } },
    { name: 'seen locked: a key of it held', sent: false, says: 'locked', arrange: async () => { await store.raiseHighest(rowKey(), 2); pageLoad(); } },
    { name: 'seen locked: its row kept, the index row lost', sent: false, says: 'locked', arrange: async () => { await store.markLocked(rowKey()); await put(indexRow, []); pageLoad(); } },
    { name: 'seen locked: the index row kept, its own lost', sent: false, says: 'locked', arrange: async () => { await put(indexRow, [ID]); pageLoad(); } },
    { name: 'seen locked, then sent by its id in capitals', sent: false, says: 'locked', id: ID.toUpperCase(), arrange: async () => { await store.markLocked(rowKey()); pageLoad(); } },
    { name: 'seen locked in this page only (its ring)', sent: false, says: 'locked', arrange: async () => { await groupKeyring(fakeGroupNode(ID, [ana.publicKey]).as(ana.publicKey), ana, ID, memoryGroupLockStore()).noteLocked(); } },
    { name: 'seen locked in another tab, after this page read "never"', sent: false, says: 'locked', arrange: async () => { expect(await ring().seenLocked()).toBe(false); await store.markLocked(rowKey()); } },
    { name: 'seen locked by the group route', sent: false, says: 'locked', arrange: async () => { answer = locked; await getGroupChat(ID); } },
    { name: "seen locked by the event's route", sent: false, says: 'locked', arrange: async () => { answer = locked; await getEventChat(ID); } },
    { name: "seen locked by the enterprise's route", sent: false, says: 'locked', arrange: async () => { answer = locked; await getEnterpriseThread(ID); } },
    { name: 'seen locked by the messages route', sent: false, says: 'locked', arrange: async () => { answer = locked; await getConversationMessages(ID); } },
    { name: 'seen locked: a line sealed as a group\'s, in an answer that says unlocked', sent: false, says: 'locked', arrange: async () => { answer = sealedLine; await getGroupChat(ID); } },
    { name: 'seen locked by an answer for its id in capitals', sent: false, says: 'locked', arrange: async () => { answer = locked; await getGroupChat(ID.toUpperCase()); } },
    { name: 'seen locked by a key the node served', sent: false, says: 'locked', arrange: async () => { const node = fakeGroupNode(ID, [ana.publicKey]); await groupKeyring(node.as(ana.publicKey), ana, ID, memoryGroupLockStore()).prepareToSeal(); forgetGroupKeys(); await groupKeyring(node.as(ana.publicKey), ana, ID, memoryGroupLockStore()).sync(); forgetGroupKeys(); } },
    { name: 'seen locked, then signed out and in again in this page', sent: false, says: 'locked', arrange: async () => { noteAnsweredLocked(ID); forgetGroupKeys(); } },
    // the mark's write failed
    { name: 'write failed', sent: false, says: 'locked', arrange: async () => { faults.commit = 'fail'; await ring().noteLocked(); expect(await store.load(rowKey())).toEqual({ highest: 0, locked: false }); } },
    { name: 'write failed, the rings dropped', sent: false, says: 'locked', arrange: async () => { faults.commit = 'fail'; await ring().noteLocked(); forgetGroupKeys(); } },
    { name: 'write failed, and the node then says unlocked', sent: false, says: 'locked', arrange: async () => { faults.commit = 'fail'; await ring().noteLocked(); expect(await groupChatSendPlan(ring(), unlocked)).toEqual({ kind: 'seal' }); } },
    { name: 'write failed, put by the next send, and the page loaded afresh', sent: false, says: 'locked', arrange: async () => { faults.commit = 'fail'; await ring().noteLocked(); faults.commit = undefined; await groupChatSendPlan(ring(), unlocked); pageLoad(); } },
    { name: 'write failed, put by the next locked answer, and the page loaded afresh', sent: false, says: 'locked', arrange: async () => { faults.commit = 'fail'; await ring().noteLocked(); faults.commit = undefined; await groupChatSendPlan(ring(), locked); pageLoad(); } },
    { name: 'write failed (no IndexedDB to write to)', sent: false, says: 'locked', arrange: async () => { vi.stubGlobal('indexedDB', undefined); resetGroupChatLockStoreForTest(); await ring().noteLocked(); } },
    { name: 'write never answered', sent: false, says: 'locked', arrange: async () => { vi.useFakeTimers(); faults.commit = 'never'; const noted = ring().noteLocked(); await vi.advanceTimersByTimeAsync(LOCK_STORE_MS + 1); await noted; vi.useRealTimers(); } },
    // the read
    { name: 'read failed: the store will not open', sent: false, says: 'unread', heals: true, arrange: () => { faults.open = 'error'; } },
    { name: 'read failed: the store is blocked', sent: false, says: 'unread', heals: true, arrange: () => { faults.open = 'blocked'; } },
    { name: 'read failed: no IndexedDB', sent: false, says: 'unread', arrange: () => { vi.stubGlobal('indexedDB', undefined); } },
    { name: 'read failed: the index row', sent: false, says: 'unread', heals: true, arrange: () => { faults.get = fails(indexRow); } },
    { name: "read failed: the chat's own row", sent: false, says: 'unread', heals: true, arrange: () => { faults.get = fails(rowKey()); } },
    { name: 'read timed out: the store never opens', sent: false, says: 'unread', waits: true, heals: true, arrange: () => { faults.open = 'never'; } },
    { name: 'read timed out: the index row', sent: false, says: 'unread', waits: true, heals: true, arrange: () => { faults.get = never(indexRow); } },
    { name: "read timed out: the chat's own row", sent: false, says: 'unread', waits: true, heals: true, arrange: () => { faults.get = never(rowKey()); } },
    { name: 'read timed out, but seen locked in this page', sent: false, says: 'locked', atOnce: true, arrange: async () => { await ring().noteLocked(); faults.open = 'never'; resetGroupChatLockStoreForTest(); } },
    // not the mark, and no readable line's either
    { name: 'a DM this browser knows', sent: false, says: GROUP_CHAT_IS_DM_TEXT, arrange: () => rememberDmConversations([ID]) },
    { name: 'a DM this browser knows, by its id in capitals', sent: false, says: GROUP_CHAT_IS_DM_TEXT, id: ID.toUpperCase(), arrange: () => rememberDmConversations([ID]) },
    { name: 'no account in this browser', sent: false, says: 'unread', arrange: () => { me = null; } },
    { name: 'signed out in another tab', sent: false, says: 'unread', arrange: () => { endAccountEpoch('signed-out'); } },
];

/** Put a row straight into the store, as a torn write left it. */
async function put(key: string, value: unknown): Promise<void> {
    await new Promise<void>((resolve) => {
        const req = mem.open('beanpool-group-chat-locks', 1) as any;
        req.onupgradeneeded = () => req.result.createObjectStore('locks');
        req.onsuccess = () => {
            const tx = req.result.transaction('locks', 'readwrite');
            tx.objectStore().put(value, key);
            tx.oncomplete = () => resolve();
        };
    });
}

/** Send, with the store's time let run out when the row waits for it: what came of it. */
async function outcomeOf(send: () => Promise<unknown>, waits?: boolean): Promise<unknown> {
    if (!waits) return send().then(() => 'went', (e) => e);
    vi.useFakeTimers();
    const settled = send().then(() => 'went', (e) => e);
    await vi.advanceTimersByTimeAsync(LOCK_STORE_MS - 1);
    const early = await Promise.race([settled, Promise.resolve('waiting')]);
    expect(early).toBe('waiting');
    await vi.advanceTimersByTimeAsync(2);
    const out = await settled;
    vi.useRealTimers();
    return out;
}

/** What came of a send with the store never answering, its time not let run. */
async function withoutTheStore(send: () => Promise<unknown>): Promise<unknown> {
    vi.useFakeTimers();
    const settled = send().then(() => 'went', (e) => e);
    await vi.advanceTimersByTimeAsync(1);
    return Promise.race([settled, Promise.resolve('waiting')]);
}

describe('every readable path x what this browser knows of the lock', () => {
    it('the table is whole: six paths, forty-one marks, and six of those marks let the words go', () => {
        expect([PATHS.length, MARKS.length, MARKS.filter((m) => m.sent).length]).toEqual([6, 41, 6]);
    });

    for (const p of PATHS) {
        for (const m of MARKS) {
            it(`${p.name} | ${m.name} | ${m.sent ? 'sent readable' : 'nothing sent'}`, async () => {
                await m.arrange();
                posts = [];
                const out = m.atOnce ? await withoutTheStore(() => p.send(m.id ?? ID)) : await outcomeOf(() => p.send(m.id ?? ID), m.waits);
                if (m.sent) {
                    expect(out).toBe('went');
                    expect(wordsWent()).toHaveLength(1);
                    return;
                }
                expect(posts).toEqual([]);
                expect(out).toBeInstanceOf(GroupChatKeyError);
                expect((out as Error).message).toBe(m.says === 'locked' ? p.sentence : m.says === 'unread' ? GROUP_HOLD_UNREAD_TEXT : m.says);
                if (!m.heals) return;
                // Refused, not remembered: once the store answers and has nothing of a lock, the same line goes.
                faults = {};
                expect(await outcomeOf(() => p.send(m.id ?? ID))).toBe('went');
                expect(wordsWent()).toHaveLength(1);
            });
        }
    }
});

// ── what lands between the check and the request ────────────────────────────────────────────────────────────────────

const LANDS: { name: string; land: () => void; says: 'locked' | 'unread' | string }[] = [
    { name: 'a locked answer of the group (its ring)', land: () => { void ring().noteLocked(); }, says: 'locked' },
    { name: "a locked answer by another of the chat's routes", land: () => noteAnsweredLocked(ID), says: 'locked' },
    { name: 'a Sign Out in this tab, and another sign-in', land: () => forgetGroupKeys(), says: 'unread' },
    { name: 'a Sign Out in another tab', land: () => { endAccountEpoch('signed-out'); }, says: 'unread' },
    { name: 'the chat known as a DM', land: () => rememberDmConversations([ID]), says: GROUP_CHAT_IS_DM_TEXT },
];
const MOMENTS: { name: string; at: (land: () => void) => void }[] = [
    { name: 'as its record is read', at: (land) => { let done = false; faults.onGet = (key) => { if (!done && key === rowKey()) { done = true; land(); } }; } },
    { name: 'as the request is signed', at: (land) => { onIdentity = (nth) => { if (nth === 2) land(); }; } },
    { name: 'the moment after it is signed', at: (land) => { onIdentity = (nth) => { if (nth === 2) queueMicrotask(land); }; } },
];

describe('what lands while a readable line is on its way stops it', () => {
    for (const p of PATHS) {
        for (const l of LANDS) {
            for (const mo of MOMENTS) {
                it(`${p.name} | ${l.name} | ${mo.name}`, async () => {
                    mo.at(l.land);
                    const out = await outcomeOf(() => p.send(ID));
                    expect(posts).toEqual([]);
                    expect(out).toBeInstanceOf(GroupChatKeyError);
                    expect((out as Error).message).toBe(l.says === 'locked' ? p.sentence : l.says === 'unread' ? GROUP_HOLD_UNREAD_TEXT : l.says);
                });
            }
        }
    }

    for (const p of PATHS) {
        it(`${p.name} | another tab's mark, read by this page's ring | as the request is signed`, async () => {
            // No answer of this page's: the ring alone knows, once it reads what the other tab wrote.
            onIdentity = async (nth) => { if (nth === 2) { await store.markLocked(rowKey()); expect(await ring().seenLocked()).toBe(true); } };
            const out = await outcomeOf(() => p.send(ID));
            expect(posts).toEqual([]);
            expect((out as Error).message).toBe(p.sentence);
        });
    }

    it('a Force Clear & Re-Sync on the way stops nothing: the account stays, and the lock rows with it', async () => {
        onIdentity = (nth) => { if (nth === 2) endAccountEpoch('cleared'); };
        for (const p of PATHS) {
            identityReads = 0;
            expect(await outcomeOf(() => p.send(ID))).toBe('went');
        }
        expect(wordsWent()).toHaveLength(PATHS.length);
        expect(localStorage.getItem(ACCOUNT_EPOCH_KEY)).toBeTruthy();
    });
});

describe('what the check never stops', () => {
    it('a line sealed to a person, its edit, and one with a sealed photo or sound, whatever the record says', async () => {
        faults.open = 'error';
        await sendMessageApi(ID, ana.publicKey, 'AAAA', SEALED);
        await sendMessageApi(ID, ana.publicKey, 'AAAA', SEALED, 'image', { data: 'AAAA', nonce: SEALED, mime: 'image/jpeg' });
        await editMessageApi('line-1', ana.publicKey, 'AAAA', SEALED);
        expect(posts).toHaveLength(3);
    });

    it('an edit that names no chat is readable to nobody', async () => {
        await expect(editMessageApi('line-1', ana.publicKey, B64, 'plaintext-v1')).rejects.toBeInstanceOf(GroupChatKeyError);
        expect(posts).toEqual([]);
    });

    it("a record that couldn't be read marks nothing: once it reads, the chat was never locked", async () => {
        faults.get = fails(rowKey());
        expect(await groupChatSendPlan(ring(), unlocked)).toEqual({ kind: 'seal' });
        faults = {};
        expect(await store.load(rowKey())).toEqual({ highest: 0, locked: false });
        expect(await groupChatSendPlan(ring(), unlocked)).toEqual({ kind: 'readable' });
    });

    it('a group line sealed under its key is never a readable one: it goes by the keyring', async () => {
        const node = fakeGroupNode(ID, [ana.publicKey]);
        const r = groupKeyring(node.as(ana.publicKey), ana, ID, store);
        expect(chatIsLocked(locked)).toBe(true);
        expect(await groupChatSendPlan(r, locked)).toEqual({ kind: 'seal' });
        expect((await r.prepareToSeal()).epoch).toBe(1);
        await expect(readableLineTo(ID)).rejects.toMatchObject({ code: 'refused', message: GROUP_CHAT_LOCK_LOST_TEXT });
    });
});

// ── the source ──────────────────────────────────────────────────────────────────────────────────────────────────────

const SRC = path.resolve(__dirname, '..');
function sources(dir = SRC): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return sources(p);
        return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$|test-support/.test(e.name) ? [p] : [];
    });
}
/** The nearest named function around a node. */
function named(n: ts.Node): string {
    for (let p: ts.Node | undefined = n; p; p = p.parent) {
        if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText();
        if (ts.isVariableDeclaration(p) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.getText();
    }
    return '(module)';
}
/** Every function whose code names a chat line's route, or makes a readable payload. */
function findings(text: string, file: string): { route: string[]; readable: string[] } {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out = { route: new Set<string>(), readable: new Set<string>() };
    const rel = path.relative(SRC, file);
    const visit = (n: ts.Node): void => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
            if (/\/(chat|thread)\/message(?![a-z])|\/api\/messages\/(send|edit)(?![a-z])/.test(n.getText())) out.route.add(`${rel} ${named(n)}`);
        }
        if (ts.isCallExpression(n) && n.expression.getText() === 'encodePlaintext') out.readable.add(`${rel} ${named(n)}`);
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return { route: [...out.route], readable: [...out.readable] };
}

describe('the source: no other path', () => {
    const all = sources().map((f) => findings(fs.readFileSync(f, 'utf8'), f));

    it('a function that names a chat line route has its row here', () => {
        expect(all.flatMap((f) => f.route).sort()).toEqual([
            'lib/api.ts editMessageApi',
            'lib/api.ts postEnterpriseThreadMessage',
            'lib/api.ts postEventChatMessage',
            'lib/api.ts sendMessageApi',
            // Only ever sealed, under the group's key (the keyring's pre-seal rules).
            'lib/group-chat-lines.ts editSealedGroupLine',
            'lib/group-chat-lines.ts sendSealedGroupLine',
        ]);
    });

    it('a readable payload is made only where its send passes the check', () => {
        expect(all.flatMap((f) => f.readable).sort()).toEqual([
            'lib/dm-lock.ts payloadForChat',
            // Read, not sent: a line of Home's chat card, put in the shape the thread check reads.
            'lib/home-cards.ts dmLinesShown',
            'pages/MessagesPage.tsx editInGroup',
            'pages/MessagesPage.tsx sendLineNow',
        ]);
    });

    it('each of the four that can send words readable hands its request the check\'s last ask', () => {
        const api = fs.readFileSync(path.join(SRC, 'lib/api.ts'), 'utf8');
        for (const [fn, ask] of [['sendMessageApi', 'leavingUnlessSealed'], ['editMessageApi', 'leavingUnlessSealed'], ['postEnterpriseThreadMessage', 'readableLineTo'], ['postEventChatMessage', 'readableLineTo']]) {
            const body = api.slice(api.indexOf(`export async function ${fn}(`)).split('\n}\n')[0];
            expect(body, fn).toContain(`await ${ask}(`);
            expect(body, fn).toMatch(/request\('POST',[^;]*, leaving\);/);
        }
        // And the request asks it with nothing awaited before the fetch.
        expect(api).toMatch(/leaving\?\.\(\);\n\s+return fetch\(/);
    });

    it('the rule sees a new one', () => {
        expect(findings("export async function quickReply(id: string) { return request('POST', `/api/posts/${id}/chat/message`, {}); }", path.join(SRC, 'lib/new.ts')).route).toEqual(['lib/new.ts quickReply']);
        expect(findings('const say = () => encodePlaintext(words);', path.join(SRC, 'lib/new.ts')).readable).toEqual(['lib/new.ts say']);
    });
});
