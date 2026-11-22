/**
 * Slice S6c (scratch/fable-design/DESIGN-no-switch-messaging-fable.md §6): a deal of a chat in another community this phone holds
 * is read there, and every step on it (its Beans released, its hold cancelled, a standing deal stopped or lowered, its rating)
 * is signed for and sent to THE DEAL'S OWN community, never the one in use.
 *
 * One table (close the class): each step x each way the phone can stand to that community (in use, a held member, a guest's
 * look, taken off the phone, left, another account on the phone, and each of those happening while the step is on its way).
 * Each row asserts on the request log: which server was asked, the name it was signed for, who signed it; that the community
 * in use was asked NOTHING at all; that no other community's file or stored state changed; that a refusal is in words. The
 * same deal, with the same id, is on every community's server and in every file, so a step that went astray would be taken
 * there and would show.
 *
 * Then: a double tap and a retry move Beans once; the deals' own read; what a chat in place shows from that read; and the
 * sweep that makes a new money route, or a new function that names one, red until it has its row.
 *
 * Real SQLite files on disk and the real database open; each community's server is a stand-in that answers as
 * routes/marketplace.ts and engine/escrow.ts do (a pending deal moves once; a release asked again answers alreadyCompleted).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const h = vi.hoisted(() => ({
    dir: '', store: new Map<string, string>(), me: { publicKey: '', privateKey: '' },
    /** Run as a request is signed (its path named), before it leaves. */
    signing: null as null | ((path: string) => unknown),
    /** The next writes of `file` that read as `sql`: SQLite refuses them. */
    cut: null as null | { file: string; sql: RegExp; times: number },
    emitted: [] as string[],
}));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const { join } = await import('node:path');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    return {
        get defaultDatabaseDirectory() { return `file://${h.dir}`; },
        openDatabaseAsync: vi.fn(async (name: string) => {
            const sql = new Sqlite(join(h.dir, name));
            return {
                runAsync: async (q: string, p?: unknown) => {
                    if (h.cut && h.cut.file === name && h.cut.times > 0 && h.cut.sql.test(q)) { h.cut.times--; throw new Error('database is locked'); }
                    const r = sql.prepare(q).run(...params(p));
                    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
                },
                execAsync: async (q: string) => { sql.exec(q); },
                getAllAsync: async (q: string, p?: unknown) => sql.prepare(q).all(...params(p)),
                getFirstAsync: async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null,
                withTransactionAsync: async (cb: () => Promise<void>) => { await cb(); },
                closeAsync: async () => { sql.close(); },
            };
        }),
    };
});
vi.mock('expo-file-system/legacy', async () => {
    const nodeFs = await import('node:fs');
    const local = (uri: string) => decodeURI(uri).replace(/^file:\/\//, '');
    return {
        get cacheDirectory() { return `file://${h.dir}/cache/`; },
        get documentDirectory() { return `file://${h.dir}/doc/`; },
        EncodingType: { Base64: 'base64' },
        getInfoAsync: vi.fn(async (uri: string) => ({ exists: nodeFs.existsSync(local(uri)), size: 0 })),
        moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => { nodeFs.renameSync(local(from), local(to)); }),
        copyAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => { nodeFs.copyFileSync(local(from), local(to)); }),
        deleteAsync: vi.fn(async (uri: string) => { nodeFs.rmSync(local(uri), { force: true, recursive: true }); }),
        makeDirectoryAsync: vi.fn(async (uri: string) => { nodeFs.mkdirSync(local(uri), { recursive: true }); }),
        writeAsStringAsync: vi.fn(async (uri: string, data: string) => { nodeFs.writeFileSync(local(uri), data); }),
        readAsStringAsync: vi.fn(async () => ''),
        readDirectoryAsync: vi.fn(async () => []),
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => h.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { h.store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) h.store.delete(k); }),
    },
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('react-native', () => ({ DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' }, AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => (h.me.publicKey ? { ...h.me, callsign: 'Me' } : null)) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../blocklist', () => ({ getBlockedUsers: vi.fn(async () => []), isUserBlocked: vi.fn(async () => false) }));
// Each request says the address it is signed for and whose key signed it.
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string, _body: string, _priv: string, pub: string) => {
        await h.signing?.(new URL(url).pathname);
        return { 'X-Signed': `${method} ${url}`, 'X-Signer': pub };
    }),
}));

import * as db from '../db';
import { switchPhoneTo } from '../reconnect';
import { removeCommunityCaches } from '../community-cache';
import { getDatabaseFilenameForNode, removeSavedNode } from '../nodes';
import { whileAccountLeaves } from '../account-leaving';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { signedRequestWords } from '../../components/signed-request-lines';
import { chatLineWords } from '../chat-line-words';
import { chatInPlaceRoute } from '../held-chats';
import { isChatStripDeal, localDealMoves, localDealRow } from '../deal-rows';
import { isLiveStanding, setLanguage, standingPanel } from '@beanpool/core';

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: (e: string) => { h.emitted.push(e); }, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' } };
    return realLoad.call(this, request, ...rest);
};
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-deals-in-place-'));
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(root, { recursive: true, force: true });
});

/** A: the deal's own community. B: the community the phone is set to. C: a third, the phone switches to. */
const A = 'https://riverside.example';
const B = 'https://hilltop.example';
const C = 'https://brookside.example';
const A_FILE = getDatabaseFilenameForNode(A);
const B_FILE = getDatabaseFilenameForNode(B);
const C_FILE = getDatabaseFilenameForNode(C);
const SWITCHED = 'This phone has switched community since this chat was opened.';
const OTHER_ACCOUNT = 'The account on this phone has changed since this chat was opened. Nothing was sent.';

interface Person { publicKey: string; privateKey: string }
function person(): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

// ── Each community's server, as routes/marketplace.ts and engine/escrow.ts answer ────────────────────────────────────

interface Deal { id: string; postId: string; postTitle: string; buyerPublicKey: string; sellerPublicKey: string; amount_c: number; status: string; createdAt: string; completedAt?: string; ratedByBuyer?: boolean; ratedBySeller?: boolean; postAuthorPublicKey?: string; postType?: string; standingId?: string; periodNo?: number; [more: string]: unknown }
interface Server {
    deals: Deal[];
    /** How many times each deal's Beans were paid out, and given back. */
    paid: Record<string, number>; refunded: Record<string, number>;
    stops: number; lowered: Map<string, number>; answered: Map<string, boolean>; withdrawn: Set<string>; ratings: any[];
    /** Its answer to a step is lost on the way: the step is taken, the phone hears nothing. */
    loseAnswers?: number;
    /** It answers its transactions list with this status, or this body. */
    listStatus?: number; listBody?: unknown;
}
let servers: Record<string, Server>;
let me: Person;
let peer: Person;
let other: Person;
let tx: string;
let sd: string;
let standingTx: string;
let done: string;
let asked: Array<{ method: string; url: string; origin: string; path: string; signed: string | null; signer: string | null; body: any }> = [];
let hold: null | { path: string; seen: () => void; go: Promise<void>; used: boolean } = null;

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    const res: any = { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
    res.clone = () => res;
    return res;
}
/** One step, as the server takes it: the signer is the actor the body names, and a deal moves only from the state the step needs. */
function step(s: Server, p: string, body: any, signer: string | null): { status: number; body: any } {
    const named = body.confirmerPublicKey ?? body.cancellerPublicKey ?? body.raterPubkey;
    if (!signer || (named && named !== signer)) return { status: 403, body: { error: 'You can only act as yourself' } };
    if (p === '/api/marketplace/transactions/complete') {
        const d = s.deals.find((x) => x.id === body.transactionId);
        if (d?.status === 'completed' && d.buyerPublicKey === signer) return { status: 200, body: { success: true, transaction: d, alreadyCompleted: true } };
        if (!d || d.status !== 'pending' || d.buyerPublicKey !== signer) return { status: 400, body: { error: 'Cannot complete — transaction not found or not authorized' } };
        d.status = 'completed';
        d.completedAt = '2026-11-23T01:00:00.000Z';
        s.paid[d.id] = (s.paid[d.id] ?? 0) + 1;
        return { status: 200, body: { success: true, transaction: d, alreadyCompleted: false } };
    }
    if (p === '/api/marketplace/transactions/cancel') {
        const d = s.deals.find((x) => x.id === body.transactionId);
        if (!d || d.status !== 'pending' || ![d.buyerPublicKey, d.sellerPublicKey].includes(signer)) return { status: 400, body: { error: 'Cannot cancel — transaction not found or not authorized', code: 'transaction_gone' } };
        d.status = 'cancelled';
        s.refunded[d.id] = (s.refunded[d.id] ?? 0) + 1;
        return { status: 200, body: { success: true, transaction: d } };
    }
    const standing = /^\/api\/marketplace\/standing\/([^/]+)\/(.+)$/.exec(p);
    if (standing) {
        const d = s.deals.find((x) => x.standingId === decodeURIComponent(standing[1]));
        if (!d || ![d.buyerPublicKey, d.sellerPublicKey].includes(signer)) return { status: 404, body: { error: 'This standing deal is not here any more.', code: 'standing_gone' } };
        if (standing[2] === 'stop') { if (!d.standingStopped) s.stops++; d.standingStopped = true; }
        else if (standing[2] === 'lower') s.lowered.set(body.id, body.beans_c);
        else if (/\/answer$/.test(standing[2])) s.answered.set(standing[2].split('/')[1], body.yes);
        else s.withdrawn.add(standing[2].split('/')[1]);
        return { status: 200, body: { success: true, standing: { id: d.standingId } } };
    }
    if (p === '/api/ratings') {
        const rating = { id: `r-${body.transactionId}`, raterPubkey: signer, targetPubkey: body.targetPubkey, stars: body.stars, comment: body.comment, role: 'provider', transactionId: body.transactionId, createdAt: '2026-11-23T02:00:00.000Z' };
        s.ratings = [...s.ratings.filter((r) => r.id !== rating.id), rating];
        return { status: 200, body: { success: true, rating } };
    }
    return { status: 404, body: { error: 'not here' } };
}
const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const signer = init.headers?.['X-Signer'] ?? null;
    asked.push({ method, url, origin: u.origin, path: u.pathname, signed: init.headers?.['X-Signed'] ?? null, signer, body });
    const held = hold && !hold.used && hold.path === u.pathname ? hold : null;
    if (held) held.used = true;
    const s = servers[u.origin];
    // The server takes a step as it arrives; its answer is what may be held, or lost, on its way back.
    let out: { status: number; body: any } = { status: 404, body: { error: 'not here' } };
    if (s && method === 'POST') out = step(s, u.pathname, body ?? {}, signer);
    else if (s && u.pathname === '/api/marketplace/transactions') {
        out = signer !== u.searchParams.get('publicKey') ? { status: 403, body: { error: 'You may only view your own marketplace transactions' } }
            : s.listStatus ? { status: s.listStatus, body: { error: 'busy' } } : { status: 200, body: s.listBody ?? s.deals.map((d) => ({ ...d })) };
    }
    else if (s && u.pathname.startsWith('/api/ledger/balance/')) out = { status: 200, body: { balance_c: 4200 } };
    const reply = JSON.parse(JSON.stringify(out));
    if (held) { held.seen(); await held.go; }
    if (s?.loseAnswers && method === 'POST') { s.loseAnswers--; throw new TypeError('Network request failed'); }
    return answer(reply.status, reply.body);
});

// ── The phone ───────────────────────────────────────────────────────────────────────────────────────────────────────

let phoneN = 0;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
const fileOn = (file: string) => path.join(h.dir, file);
const TABLES = ['marketplace_transactions', 'posts', 'ratings', 'accounts', 'transactions', 'conversations', 'conversation_participants', 'messages', 'members'];
function rowsOf(file: string): Record<string, any[]> | null {
    if (!fs.existsSync(fileOn(file))) return null;
    const sql = new DatabaseSync(fileOn(file));
    try {
        return Object.fromEntries(TABLES.map((t) => [t, sql.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((r) => ({ ...(r as object) }))]));
    } finally {
        sql.close();
    }
}
const storedFor = (file: string) => Object.fromEntries([...h.store.entries()].filter(([k]) => k.includes(file)).sort());
function into(file: string, run: (sql: DatabaseSync) => void): void {
    const sql = new DatabaseSync(fileOn(file));
    try { run(sql); } finally { sql.close(); }
}
const dealRow = (file: string, id: string): any => rowsOf(file)?.marketplace_transactions.find((r) => r.id === id);

/** The deals of one community: one held in trust (mine to release), a standing deal's current period (paid by me), one done. */
function dealsOf(): Deal[] {
    const base = { postId: 'p-eggs', postTitle: 'Duck eggs', buyerPublicKey: me.publicKey, sellerPublicKey: peer.publicKey, createdAt: '2026-11-20T00:00:00.000Z', postAuthorPublicKey: peer.publicKey, postType: 'offer' };
    return [
        { ...base, id: tx, amount_c: 1250, status: 'pending' },
        {
            ...base, id: standingTx, postId: 'p-veg', postTitle: 'Veg box', amount_c: 2000, status: 'completed', standingId: sd, periodNo: 2, standingPhase: 'paid', standingBeans_c: 2000,
            standingUnit: 'week', standingMaxPeriods: null, standingNextDueAt: '2026-11-27T00:00:00.000Z', standingStartsAt: '2026-11-06T00:00:00.000Z', standingStopped: false, standingAsksLeft: 2,
            standingAsk: null,
        },
        { ...base, id: done, postId: 'p-jam', postTitle: 'Jam', amount_c: 500, status: 'completed', completedAt: '2026-11-21T00:00:00.000Z' },
    ];
}
const server = (): Server => ({ deals: dealsOf(), paid: {}, refunded: {}, stops: 0, lowered: new Map(), answered: new Map(), withdrawn: new Set(), ratings: [] });

/** A phone that kept its deals in A, then was set to B, whose file is a copy of A's: the same deals by the same ids. A is away. */
async function phoneOnB(): Promise<void> {
    h.signing = null;
    h.cut = null;
    hold = null;
    await db.closeDB();
    db._resetDmPeerPinsForTests();
    db._resetChatsInPlaceForTests();
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set('bp_trust_sync_v3', 'true');
    me = person();
    peer = person();
    other = person();
    h.me = { ...me };
    [tx, sd, standingTx, done] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    servers = { [A]: server(), [B]: server(), [C]: server() };
    (globalThis as any).fetch = fetchMock;
    await switchPhoneTo(C);
    await db.getDb();
    await switchPhoneTo(A);
    await db.getDb();
    await settle();
    into(A_FILE, (sql) => {
        sql.prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES ('dm-1', 'dm', ?, '2026-11-20T00:00:00.000Z')").run(peer.publicKey);
        for (const pk of [me.publicKey, peer.publicKey]) sql.prepare("INSERT INTO conversation_participants (conversation_id, public_key) VALUES ('dm-1', ?)").run(pk);
        sql.prepare("INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, status, pending_transaction_id) VALUES ('p-eggs', 'offer', 'food', 'Duck eggs', '', 1250, ?, 'pending', ?)").run(peer.publicKey, tx);
        for (const d of dealsOf()) {
            sql.prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status, created_at, post_title, standing_id, period_no, standing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(d.id, d.postId, d.buyerPublicKey, d.sellerPublicKey, d.amount_c, d.status, d.createdAt, d.postTitle, d.standingId ?? null, d.periodNo ?? null,
                    d.standingId ? JSON.stringify({ phase: 'paid', beans_c: 2000, unit: 'week', nextDueAt: '2026-11-27T00:00:00.000Z', startsAt: '2026-11-06T00:00:00.000Z', stopped: false, asksLeft: 2 }) : null);
        }
    });
    await db.closeDB();
    fs.copyFileSync(fileOn(A_FILE), fileOn(B_FILE));
    await switchPhoneTo(B);
    await db.getDb();
    await settle();
    asked = [];
    h.emitted.length = 0;
}
beforeEach(async () => { setLanguage('en'); await phoneOnB(); });

/** Another account signed in on this phone (Sign Out and in, a restore): what loadIdentity answers from now. */
const accountChanges = (): void => { h.me = { ...other }; };

interface Act {
    name: string;
    path: () => string;
    run: (community: string | undefined) => Promise<unknown>;
    /** Its effect at a community's server. */
    took: (s: Server) => boolean;
    /** Its effect in its community's file (null: the step keeps none there; that community's next read brings it). */
    kept: null | ((file: string) => boolean);
}
const CHANGE = '3f0e7c1a-1111-4222-8333-444455556666';
const ACTS: Act[] = [
    { name: 'release the Beans (completeMarketplaceTransaction)', path: () => '/api/marketplace/transactions/complete', run: (c) => db.completeMarketplaceTransaction(tx, me.publicKey, undefined, c), took: (s) => s.paid[tx] === 1, kept: (f) => dealRow(f, tx)?.status === 'completed' },
    { name: 'cancel the hold (cancelMarketplaceTransaction)', path: () => '/api/marketplace/transactions/cancel', run: (c) => db.cancelMarketplaceTransaction(tx, me.publicKey, c), took: (s) => s.refunded[tx] === 1, kept: (f) => dealRow(f, tx)?.status === 'cancelled' },
    { name: 'stop a standing deal (stopStandingDeal)', path: () => `/api/marketplace/standing/${sd}/stop`, run: (c) => db.stopStandingDeal(sd, me.publicKey, c), took: (s) => s.stops === 1, kept: null },
    { name: 'lower a period of it, or ask to (lowerStandingPeriod)', path: () => `/api/marketplace/standing/${sd}/lower`, run: (c) => db.lowerStandingPeriod(sd, CHANGE, 3, 1500, me.publicKey, c), took: (s) => s.lowered.get(CHANGE) === 1500, kept: null },
    { name: 'answer an ask about it (answerStandingAsk)', path: () => `/api/marketplace/standing/${sd}/lower/${CHANGE}/answer`, run: (c) => db.answerStandingAsk(sd, CHANGE, true, me.publicKey, c), took: (s) => s.answered.get(CHANGE) === true, kept: null },
    { name: 'take an ask back (withdrawStandingAsk)', path: () => `/api/marketplace/standing/${sd}/lower/${CHANGE}/withdraw`, run: (c) => db.withdrawStandingAsk(sd, CHANGE, me.publicKey, c), took: (s) => s.withdrawn.has(CHANGE), kept: null },
    { name: 'rate the other side (submitRating)', path: () => '/api/ratings', run: (c) => db.submitRating(me.publicKey, peer.publicKey, 4, 'Kind', done, c), took: (s) => s.ratings.length === 1, kept: (f) => dealRow(f, done)?.rated_by_buyer === 1 && rowsOf(f)!.ratings.length === 1 },
];

/** Each way the phone can stand to the deal's community. `named`: the community the chat names. `holds`: a screen holds it in place. */
interface Stand {
    name: string;
    first?: () => unknown; named: string | undefined; holds: boolean;
    /** Refused before anything is asked, in these words. */
    refused?: string;
    /** Run as the request is signed (before it leaves), or once its server has it (before its answer lands). */
    asSigned?: () => unknown; asAnswered?: () => unknown;
    /** Its answer lands nowhere on this phone (the phone moved on, the copy went, the account left). */
    keptNowhere?: boolean;
}
const setToA = () => switchPhoneTo(A).then(() => db.getDb());
const takenOff = async () => { await removeSavedNode(A); await removeCommunityCaches([A]); };
let accountGoing: () => void = () => {};
/** An account begins to leave the phone, and is still going. */
const accountLeaves = () => { void whileAccountLeaves(() => new Promise<void>((r) => { accountGoing = r; })); };
const STANDS: Stand[] = [
    { name: 'in use, no community named', first: setToA, named: undefined, holds: false },
    { name: 'in use, named by a screen that opened in place before the switch', first: setToA, named: A, holds: true },
    { name: 'in use, the phone switching to a third community as it is signed', first: setToA, named: undefined, holds: false, asSigned: () => switchPhoneTo(C), keptNowhere: true },
    { name: 'in use, the phone switching to a third community before its answer', first: setToA, named: undefined, holds: false, asAnswered: () => switchPhoneTo(C).then(() => db.getDb()), keptNowhere: true },
    { name: 'in use, another account on the phone since', first: async () => { await setToA(); accountChanges(); }, named: undefined, holds: false, refused: OTHER_ACCOUNT },
    { name: 'in use, an account leaving the phone as it is signed', first: setToA, named: undefined, holds: false, asSigned: accountLeaves, refused: OTHER_ACCOUNT },
    { name: 'a held member', named: A, holds: true },
    { name: 'a held member, named by another spelling of its address', named: `${A}/`, holds: true },
    { name: 'a held member, the phone switching to a third community before its answer', named: A, holds: true, asAnswered: () => switchPhoneTo(C).then(() => db.getDb()), keptNowhere: true },
    { name: 'a held member, the phone switching onto that very community before its answer', named: A, holds: true, asAnswered: () => switchPhoneTo(A).then(() => db.getDb()) },
    { name: 'a held member, the phone switching to a third community as it is signed', named: A, holds: true, asSigned: () => switchPhoneTo(C), refused: SWITCHED },
    { name: 'a held member, the community taken off the phone as it is signed', named: A, holds: true, asSigned: takenOff, refused: SWITCHED },
    { name: 'a held member, the community taken off the phone before its answer', named: A, holds: true, asAnswered: takenOff, keptNowhere: true },
    { name: 'a held member, the chat left as it is signed, nothing holding it', named: A, holds: true, asSigned: () => db.leaveChatInPlace(A), refused: SWITCHED },
    { name: 'a held member, another account on the phone since the chat opened', first: accountChanges, named: A, holds: true, refused: OTHER_ACCOUNT },
    { name: 'a held member, another account on the phone as it is signed', named: A, holds: true, asSigned: () => { accountChanges(); accountLeaves(); accountGoing(); }, refused: OTHER_ACCOUNT },
    { name: 'a held member, an account leaving the phone as it is signed', named: A, holds: true, asSigned: accountLeaves, refused: OTHER_ACCOUNT },
    { name: 'a held member, an account leaving the phone before its answer', named: A, holds: true, asAnswered: accountLeaves, keptNowhere: true },
    { name: 'no account on the phone', first: () => { h.me = { publicKey: '', privateKey: '' }; }, named: A, holds: true, refused: 'No identity found. You must be logged in.' },
    { name: 'a held guest\'s look', first: () => { h.store.set('beanpool_guest_nodes', JSON.stringify([A])); }, named: A, holds: true, refused: SWITCHED },
    { name: 'the chat left, and not back', first: async () => { db.enterChatInPlace(A); await db.leaveChatInPlace(A); }, named: A, holds: false, refused: SWITCHED },
    { name: 'the community taken off the phone (left)', first: takenOff, named: A, holds: true, refused: SWITCHED },
    { name: 'a community this phone never held', named: 'https://elsewhere.example', holds: false, refused: SWITCHED },
    { name: 'a held member whose copy has no such deal of mine', first: () => into(A_FILE, (sql) => { sql.prepare('UPDATE marketplace_transactions SET buyer_pubkey = ?').run(other.publicKey); }), named: A, holds: true, refused: SWITCHED },
];

describe('every step on a deal goes to the deal\'s own community, signed for it by its member, or is refused in words with nothing asked', () => {
    const cases = ACTS.flatMap((a) => STANDS.map((s) => [a.name, s.name, a, s] as const));
    it.each(cases)('%s x %s', async (_a, _s, act, stand) => {
        await stand.first?.();
        await settle();
        if (stand.holds) db.enterChatInPlace(A);
        const inUse = h.store.get('beanpool_anchor_url');
        const others = () => ({ B: rowsOf(B_FILE), C: rowsOf(C_FILE), storedB: storedFor(B_FILE), storedC: storedFor(C_FILE) });
        const before = others();
        const aBefore = rowsOf(A_FILE);
        asked = [];
        if (stand.asSigned) h.signing = async (p) => { if (p === act.path()) { h.signing = null; await stand.asSigned!(); } };
        let go: () => void = () => {};
        let seen: Promise<void> | null = null;
        if (stand.asAnswered) {
            let sawIt!: () => void;
            seen = new Promise((r) => { sawIt = r; });
            hold = { path: act.path(), seen: () => sawIt(), go: new Promise((r) => { go = r; }), used: false };
        }
        let thrown: any = null;
        const running = act.run(stand.named).then(() => {}, (e) => { thrown = e; });
        if (seen) {
            await seen;
            await stand.asAnswered!();
            await settle();
            go();
        }
        await running;
        accountGoing();
        await settle();
        const steps = asked.filter((r) => r.method === 'POST' && /^\/api\/(marketplace|ratings)/.test(r.path));
        // Not one request of any kind to another community: not the one in use, not the one switched to.
        expect(asked.filter((r) => r.origin !== A && /^\/api\/(marketplace|ratings|ledger|members|profile|messages)/.test(r.path)).map((r) => `${r.method} ${r.url}`), 'asked of another community').toEqual([]);
        for (const s of [B, C]) expect(servers[s], `${s} took nothing`).toEqual({ ...server(), deals: servers[s].deals });
        for (const s of [B, C]) expect(servers[s].deals, `${s}'s deals`).toEqual(dealsOf());
        if (stand.refused) {
            expect(thrown, 'refused').not.toBeNull();
            expect(String(thrown.message)).toBe(stand.refused);
            expect(db.isNoCopyInPlace(thrown)).toBe(stand.refused === SWITCHED);
            expect(steps.map((r) => r.url), 'nothing asked').toEqual([]);
            expect(act.took(servers[A])).toBe(false);
            if (aBefore && fs.existsSync(fileOn(A_FILE))) expect(rowsOf(A_FILE)).toEqual(aBefore);
        } else {
            expect(thrown, String(thrown?.message ?? '')).toBeNull();
            // Once, to A, signed for A's address, by the member.
            expect(steps.map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${A}${act.path()}`]);
            expect(steps[0].signed, 'signed for the address it went to').toBe(`POST ${A}${act.path()}`);
            expect(steps[0].signer, 'signed by the member').toBe(me.publicKey);
            expect(act.took(servers[A]), `${act.name} happened there`).toBe(true);
            if (act.kept && !stand.keptNowhere) expect(act.kept(A_FILE), `${act.name} is in that community's own file`).toBe(true);
            if (act.kept && stand.keptNowhere && fs.existsSync(fileOn(A_FILE))) expect(act.kept(A_FILE)).toBe(false);
        }
        // Nothing of it in any other community's file or stored state, and a copy taken off is never made again.
        expect(others()).toEqual(before);
        if (stand.asSigned === takenOff || stand.asAnswered === takenOff || stand.first === takenOff) expect(fs.existsSync(fileOn(A_FILE))).toBe(false);
        // In place: no ledger or balance news for the screens of the community in use.
        if (stand.named === A && inUse !== A) expect(h.emitted.filter((e) => e !== 'sync_data_updated' || !stand.asAnswered), 'no news to the community in use').toEqual([]);
        if (stand.holds) await db.leaveChatInPlace(A).catch(() => {});
        expect(db.heldCopyFiles(), 'left, the copy open in place closes').not.toContain(A_FILE);
    });

    it(`every step and every stand is in the table (${7 * 24} rows)`, () => {
        expect(cases.length).toBe(7 * 24);
        expect(new Set(STANDS.map((s) => s.name)).size).toBe(24);
    });

    it('a refusal reads in the member\'s language: both sentences are in the words table, and in every catalog', () => {
        for (const sentence of [SWITCHED, OTHER_ACCOUNT]) {
            expect(signedRequestWords(sentence)).toBe(sentence);
            expect(chatLineWords(sentence)).toBe(sentence);
            for (const f of fs.readdirSync(path.join(__dirname, '../../words'))) {
                expect(JSON.parse(fs.readFileSync(path.join(__dirname, '../../words', f), 'utf8'))[sentence], `${f}: ${sentence}`).toBeTruthy();
            }
        }
        expect(fs.readFileSync(path.join(__dirname, '../chat-line-words.ts'), 'utf8')).toContain(`'${OTHER_ACCOUNT}': word('${OTHER_ACCOUNT}')`);
    });

    it.each(ACTS.map((a) => [a.name, a] as const))('%s: that community\'s own refusal comes back in its words, and nothing is kept', async (_n, act) => {
        db.enterChatInPlace(A);
        const before = rowsOf(A_FILE);
        for (const d of servers[A].deals) { d.buyerPublicKey = other.publicKey; d.status = 'requested'; }
        servers[A].deals.length = 0;
        const thrown = await act.run(A).then(() => null, (e) => e);
        if (act.path() === '/api/ratings') expect(thrown).toBeNull(); // the stand-in takes any rating: the deal is no part of it there
        else {
            expect(String(thrown.message)).toMatch(/not found or not authorized|not here any more/);
            expect(rowsOf(A_FILE)).toEqual(before);
        }
        expect(asked.filter((r) => r.origin === B)).toEqual([]);
        await db.leaveChatInPlace(A);
    });

    it('that community asking for a profile photo: its words come back, and the community in use is asked to publish nothing', async () => {
        db.enterChatInPlace(A);
        const real = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementationOnce(async (url: string, init: any) => { asked.push({ method: init.method, url, origin: new URL(url).origin, path: new URL(url).pathname, signed: null, signer: null, body: null }); return answer(400, { error: 'Please set a profile photo before using the marketplace. Tap your profile to add one.' }); });
        const thrown = await db.completeMarketplaceTransaction(tx, me.publicKey, undefined, A).then(() => null, (e) => e);
        expect(String(thrown.message)).toContain('set a profile photo');
        expect(asked.map((r) => r.origin)).toEqual([A]);
        fetchMock.mockImplementation(real);
        await db.leaveChatInPlace(A);
    });

    it('its file refusing the write: the server\'s yes stands, nothing is thrown, and the next read of that community puts it there', async () => {
        db.enterChatInPlace(A);
        h.cut = { file: A_FILE, sql: /UPDATE marketplace_transactions/, times: 1 };
        await expect(db.completeMarketplaceTransaction(tx, me.publicKey, undefined, A)).resolves.toMatchObject({ success: true });
        expect(h.cut.times, 'the write was refused').toBe(0);
        expect(dealRow(A_FILE, tx).status, 'the file never says more than was written').toBe('pending');
        expect([...(await db.syncDealsBetween(me.publicKey, peer.publicKey, A))!.keys()]).toContain(tx);
        expect(dealRow(A_FILE, tx).status).toBe('completed');
        await db.leaveChatInPlace(A);
    });

    it('a step begun as the chat is left still finishes in its own community (whileChatInPlace), and is kept in its file', async () => {
        db.enterChatInPlace(A);
        const going = db.whileChatInPlace(A, () => db.completeMarketplaceTransaction(tx, me.publicKey, undefined, A));
        await db.leaveChatInPlace(A);
        await going;
        expect(servers[A].paid).toEqual({ [tx]: 1 });
        expect(dealRow(A_FILE, tx).status).toBe('completed');
        expect(dealRow(B_FILE, tx).status).toBe('pending');
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
    });
});

describe('a double tap and a retry never move Beans twice', () => {
    const places = [['in use', undefined], ['held, in place', A]] as const;
    const each = ACTS.flatMap((a) => places.map(([where, c]) => [a.name, where, a, c] as const));
    const ready = async (c: string | undefined) => { if (c) db.enterChatInPlace(A); else await setToA(); asked = []; };
    const moved = (s: Server) => [s.paid[tx] ?? 0, s.refunded[tx] ?? 0, s.stops, s.lowered.size, s.answered.size, s.withdrawn.size, s.ratings.length].reduce((a, b) => a + b, 0);
    const steps = () => asked.filter((r) => r.method === 'POST');

    it.each(each)('%s, tapped twice at once, %s: one request, one answer for both, moved once', async (_n, _w, act, c) => {
        await ready(c);
        const [a, b] = await Promise.all([act.run(c), act.run(c)]);
        expect(steps().length).toBe(1);
        expect(b).toEqual(a);
        expect(moved(servers[A])).toBe(1);
    });

    it.each(each)('%s, tapped again while the first is on its way, %s: the first one\'s answer', async (_n, _w, act, c) => {
        await ready(c);
        let go!: () => void;
        let sawIt!: () => void;
        const seen = new Promise<void>((r) => { sawIt = r; });
        hold = { path: act.path(), seen: () => sawIt(), go: new Promise((r) => { go = r; }), used: false };
        const first = act.run(c);
        await seen;
        const second = act.run(c);
        await settle();
        go();
        await Promise.all([first, second]);
        expect(steps().length).toBe(1);
        expect(moved(servers[A])).toBe(1);
    });

    it.each(each)('%s, its answer lost on the way and tried again, %s: taken once', async (_n, _w, act, c) => {
        await ready(c);
        servers[A].loseAnswers = 1;
        const first = await act.run(c).then(() => null, (e) => e);
        expect(String(first?.message)).toBe('Network request failed');
        expect(moved(servers[A]), 'the server took it').toBe(1);
        const again = await act.run(c).then((r) => ({ r }), (e) => ({ e }));
        expect(steps().length, 'a retry is a request of its own').toBe(2);
        expect(steps().every((r) => r.origin === A)).toBe(true);
        expect(JSON.stringify(steps()[1].body), 'for the very same thing').toBe(JSON.stringify(steps()[0].body));
        expect(moved(servers[A]), 'and moved nothing more').toBe(1);
        // A cancel asked again says in words that there is nothing left to cancel; every other one is answered.
        if (act.path().endsWith('/cancel')) expect(String((again as any).e?.message)).toContain('Cannot cancel');
        else expect((again as any).e).toBeUndefined();
        if (act.path().endsWith('/complete')) expect((again as any).r.alreadyCompleted).toBe(true);
    });

    it.each(places)('a release and a cancel of one deal at once, %s: the server settles one, the other is refused in words', async (_w, c) => {
        await ready(c);
        const out = await Promise.allSettled([ACTS[0].run(c), ACTS[1].run(c)]);
        expect(out.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(moved(servers[A])).toBe(1);
    });

    it('the same deal id in two communities is two deals: a release in each goes to each, once', async () => {
        db.enterChatInPlace(A);
        await Promise.all([db.completeMarketplaceTransaction(tx, me.publicKey, undefined, A), db.completeMarketplaceTransaction(tx, me.publicKey)]);
        expect(servers[A].paid).toEqual({ [tx]: 1 });
        expect(servers[B].paid).toEqual({ [tx]: 1 });
        await db.leaveChatInPlace(A);
    });

    it('a step that failed is forgotten: the next tap asks again', async () => {
        db.enterChatInPlace(A);
        servers[A].deals[0].status = 'requested';
        await expect(db.completeMarketplaceTransaction(tx, me.publicKey, undefined, A)).rejects.toThrow('Cannot complete');
        servers[A].deals[0].status = 'pending';
        await db.completeMarketplaceTransaction(tx, me.publicKey, undefined, A);
        expect(servers[A].paid).toEqual({ [tx]: 1 });
        await db.leaveChatInPlace(A);
    });
});

describe('a deal\'s state in place is its own community\'s word, kept in that community\'s file and shown from it', () => {
    const read = (c: string | undefined = A) => db.syncDealsBetween(me.publicKey, peer.publicKey, c);

    it('one signed read of that community, its rows in that community\'s file alone, and the rows shown are its file\'s', async () => {
        into(A_FILE, (sql) => { sql.prepare('DELETE FROM marketplace_transactions').run(); });
        into(B_FILE, (sql) => { sql.prepare("UPDATE marketplace_transactions SET amount_c = 999999, status = 'requested'").run(); });
        servers[A].deals.push({ ...dealsOf()[0], id: 'someone-elses', buyerPublicKey: other.publicKey }, { ...dealsOf()[0], id: 'with-another', sellerPublicKey: other.publicKey });
        const before = [rowsOf(B_FILE), rowsOf(C_FILE)];
        db.enterChatInPlace(A);
        const got = (await read())!;
        expect([...got.keys()].sort()).toEqual([tx, standingTx, done].sort());
        expect(asked.map((r) => [r.method, r.url, r.signed, r.signer])).toEqual([['GET', `${A}/api/marketplace/transactions?publicKey=${me.publicKey}&limit=200`, `GET ${A}/api/marketplace/transactions?publicKey=${me.publicKey}&limit=200`, me.publicKey]]);
        expect(rowsOf(A_FILE)!.marketplace_transactions.map((r) => r.id).sort(), 'this pair\'s deals only').toEqual([tx, standingTx, done].sort());
        const shown = await db.getDealsBetween(me.publicKey, peer.publicKey, A);
        expect(shown.find((d) => d.txId === tx)).toMatchObject({ amount_c: 1250, status: 'pending', iAmBuyer: true });
        expect([rowsOf(B_FILE), rowsOf(C_FILE)]).toEqual(before);
        await db.leaveChatInPlace(A);
    });

    it('what it shows is what its member may do there: release and cancel, Stop for the standing deal, a review once', async () => {
        db.enterChatInPlace(A);
        await read();
        const rows = await db.getDealsBetween(me.publicKey, peer.publicKey, A);
        const of = (id: string) => rows.find((d) => d.txId === id)!;
        expect(localDealMoves(of(tx), me.publicKey)).toMatchObject({ release: true, cancelHold: true });
        expect(isChatStripDeal(of(tx), me.publicKey)).toBe(true);
        const standing = localDealRow(of(standingTx), me.publicKey);
        expect(isLiveStanding(standing)).toBe(true);
        expect(standingPanel(standing, me.publicKey, (d) => d)?.stop).toBe(true);
        expect(localDealMoves(of(done), me.publicKey)?.step.state).toBe('done-to-review');
        // Rated since on another device: the node's own flag, though that copy holds no rating of mine.
        servers[A].deals.find((d) => d.id === done)!.ratedByBuyer = true;
        await read();
        expect(localDealMoves((await db.getDealsBetween(me.publicKey, peer.publicKey, A)).find((d) => d.txId === done)!, me.publicKey)?.step.state).toBe('done');
        await db.leaveChatInPlace(A);
    });

    it('a deal finished there since the phone was last set to it: the stale file is put right, and no step shows on it', async () => {
        servers[A].deals[0].status = 'completed';
        db.enterChatInPlace(A);
        expect(localDealMoves((await db.getDealsBetween(me.publicKey, peer.publicKey, A)).find((d) => d.txId === tx)!, me.publicKey)?.release, 'the stale copy').toBe(true);
        await read();
        expect(localDealMoves((await db.getDealsBetween(me.publicKey, peer.publicKey, A)).find((d) => d.txId === tx)!, me.publicKey)?.release).toBe(false);
        // An older answer that lands late never takes a finished deal back.
        servers[A].deals[0].status = 'pending';
        await read();
        expect(dealRow(A_FILE, tx).status).toBe('completed');
        expect(dealRow(B_FILE, tx).status).toBe('pending');
        await db.leaveChatInPlace(A);
    });

    const UNREAD: Array<[string, () => unknown, boolean]> = [
        ['that community doesn\'t answer', () => { servers[A].listStatus = 503; }, true],
        ['it refuses', () => { servers[A].listStatus = 403; }, true],
        ['it answers something else', () => { servers[A].listBody = { error: 'x' }; }, true],
        ['a guest\'s look', () => { h.store.set('beanpool_guest_nodes', JSON.stringify([A])); }, true],
        ['the community taken off the phone', takenOff, true],
        ['the chat left', async () => { db.enterChatInPlace(A); await db.leaveChatInPlace(A); }, false],
        ['another account on the phone', accountChanges, true],
        ['the phone switching to a third community as it is signed', () => { h.signing = async () => { h.signing = null; await switchPhoneTo(C); }; }, true],
        ['the chat left as it is signed', () => { h.signing = async () => { h.signing = null; await db.leaveChatInPlace(A); }; }, true],
        ['an account leaving the phone as it is signed', () => { h.signing = () => { h.signing = null; accountLeaves(); }; }, true],
        ['its file refuses the rows', () => { h.cut = { file: A_FILE, sql: /INTO marketplace_transactions/, times: 99 }; }, true],
    ];
    it.each(UNREAD)('%s: nothing is taken for that community\'s word, nothing is written anywhere, the community in use is asked nothing', async (_n, first, holds) => {
        await first();
        const before = [rowsOf(A_FILE), rowsOf(B_FILE), rowsOf(C_FILE)];
        if (holds) db.enterChatInPlace(A);
        asked = [];
        expect(await read()).toBeNull();
        accountGoing();
        expect(asked.filter((r) => r.origin !== A && r.path.startsWith('/api/marketplace'))).toEqual([]);
        h.cut = null;
        expect([rowsOf(A_FILE), rowsOf(B_FILE), rowsOf(C_FILE)]).toEqual(before);
    });

    it('a row it can\'t keep (no id, no listing, no sides) is passed over, never a step offered on it', async () => {
        servers[A].listBody = [{ id: 7 }, { id: 'x', postId: null, buyerPublicKey: me.publicKey, sellerPublicKey: peer.publicKey }, null, 'nonsense', ...dealsOf()];
        db.enterChatInPlace(A);
        expect([...(await read())!.keys()].sort()).toEqual([tx, standingTx, done].sort());
        await db.leaveChatInPlace(A);
    });

    it('in use nothing is asked: the phone\'s own sync keeps those (no community named, or the one in use)', async () => {
        await setToA();
        asked = [];
        expect(await read(undefined)).toBeNull();
        expect(await read(A)).toBeNull();
        expect(asked.filter((r) => r.path.startsWith('/api/marketplace'))).toEqual([]);
        expect((await db.getDealsBetween(me.publicKey, peer.publicKey)).length).toBe(3);
    });

    it('the chat itself: a deal\'s chat of a held member opens in place; a guest\'s look, a community left and an unknown one don\'t', async () => {
        expect(await chatInPlaceRoute(me.publicKey, 'dm-1', A)).toMatchObject({ open: 'in-place', community: A });
        expect((await chatInPlaceRoute(me.publicKey, 'dm-1', 'https://elsewhere.example')).open).toBe('nothing');
        h.store.set('beanpool_guest_nodes', JSON.stringify([A]));
        expect((await chatInPlaceRoute(me.publicKey, 'dm-1', A)).open).toBe('nothing');
        h.store.delete('beanpool_guest_nodes');
        await takenOff();
        expect((await chatInPlaceRoute(me.publicKey, 'dm-1', A)).open).toBe('nothing');
    });
});

describe('a new money step fails until it has its row (the sweep)', () => {
    const APP = path.join(__dirname, '..', '..');
    /** Every function of the phone that names a deal's route, and the route's last part. */
    function namers(): string[] {
        const out: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name === '__tests__' || e.name === 'node_modules') continue;
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { walk(p); continue; }
                if (!/\.tsx?$/.test(e.name)) continue;
                const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
                (function visit(x: ts.Node, fn: string) {
                    const named = ts.isFunctionDeclaration(x) && x.name ? x.name.text : fn;
                    if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) || ts.isTemplateHead(x))
                        && /^\/api\/(marketplace\/(transactions|standing)\/|ratings$)/.test(x.text)) out.push(`${path.relative(APP, p)} ${named}`);
                    ts.forEachChild(x, (c) => visit(c, named));
                })(sf, 'top level');
            }
        };
        for (const d of ['app', 'components', 'utils', 'services', 'tools']) if (fs.existsSync(path.join(APP, d))) walk(path.join(APP, d));
        return [...new Set(out)].sort();
    }
    /** In a row above: each takes its community, and is asked of that one alone. */
    const IN_THE_TABLE = ['completeMarketplaceTransaction', 'cancelMarketplaceTransaction', 'standingDealStep', 'submitRating'];
    /** A request's answer and withdrawal are on the listing's page, which doesn't open in place (the chat offers the move there). */
    const ON_THE_LISTING = ['approveMarketplaceRequest', 'rejectMarketplaceRequest', 'cancelMarketplaceRequest'];

    it('every function that names one is in the table, or on the listing\'s page and named here', () => {
        expect(namers()).toEqual([...IN_THE_TABLE, ...ON_THE_LISTING].map((f) => `utils/db.ts ${f}`).sort());
    });

    it('the steps a member has on a deal at its server are these, and no dispute or hold back is among them', () => {
        const routes = fs.readFileSync(path.join(APP, '../server/src/routes/marketplace.ts'), 'utf8');
        const steps = [...routes.matchAll(/router\.post\('\/api\/marketplace\/((?:transactions|standing)\/[^']+)'/g)].map((m) => m[1]).sort();
        expect(steps).toEqual([
            'standing/:id/extend', 'standing/:id/lower', 'standing/:id/lower/:changeId/answer', 'standing/:id/lower/:changeId/withdraw', 'standing/:id/stop',
            'transactions/approve', 'transactions/cancel', 'transactions/cancel-request', 'transactions/complete', 'transactions/reject',
        ]);
    });

    it('each of them reaches the one gate, dealStep, and the gate alone signs for a deal', () => {
        const source = fs.readFileSync(path.join(APP, 'utils/db.ts'), 'utf8');
        for (const fn of IN_THE_TABLE) {
            const at = source.search(new RegExp(`(export )?async function ${fn}\\(`));
            const body = source.slice(at, source.indexOf('\n}\n', at));
            expect(body, fn).toContain('await dealStep(community, ');
            expect(body, fn).not.toMatch(/_signedRequest\(|getDb\(\)|signedRequest\(/);
        }
    });
});
