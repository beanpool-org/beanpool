/**
 * #3316 max review (N1, N2, N3 row 4): where main was stricter than S7c's first cut, main's behaviour, measured as main
 * measured it. Real SQLite on disk, the real db.ts, the real pins and list, real DM sealing between real keys, one
 * community's node as a stand-in that answers as routes/messaging.ts does. Each row is the reviewer's probe, run to the end
 * with its oracles: the pin, the thread as the DM screen shows it, the card, the key code screen, and which key opens the
 * next send (and how many POSTs reached the node).
 *
 * P1 (N1): Mark settles the pin, as main's markVerified did, so a line the node plants afterwards under PUPPET is never
 * judged into `former`: it reads "couldn't be verified", and once PUPPET is listed, the new key's fixed line. Equal to main.
 * P1b (N1): the line planted BEFORE the Mark (PUPPET judged into `former` with one notice, as on main), then PUPPET listed:
 * the pin, pause and refused send equal main; the line under PUPPET shows no words while PUPPET is on offer (§3.4 amendment
 * 2 §3, the R10 rule; main showed them here).
 * P2 (N2): a sync whose listing names PUPPET lands while Mark's list write is in flight: it waits for the tap's pins turn
 * and pauses, as on main; Mark says true, and nothing goes to PUPPET.
 * Reset (N3, db.ts's re-seed reads the member's list): §3.3 row 3 holds after the member's reset as before it.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const h = vi.hoisted(() => ({
    dir: '',
    store: new Map<string, string>(),
    me: { publicKey: '', privateKey: '' },
    /** The next write of a storage key with this prefix waits until `release` is called (one write only). */
    holdPrefix: '' as string,
    held: false,
    release: null as null | (() => void),
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
        readAsStringAsync: vi.fn(async (uri: string) => (nodeFs.existsSync(local(uri)) ? nodeFs.readFileSync(local(uri), 'utf8') : '')),
        readDirectoryAsync: vi.fn(async (uri: string) => (nodeFs.existsSync(local(uri)) ? nodeFs.readdirSync(local(uri)) : [])),
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => h.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => {
            if (h.holdPrefix && k.startsWith(h.holdPrefix)) {
                h.holdPrefix = '';
                h.held = true;
                await new Promise<void>((r) => { h.release = r; });
            }
            h.store.set(k, String(v));
        }),
        removeItem: vi.fn(async (k: string) => { h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) h.store.delete(k); }),
    },
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...h.me, callsign: 'Me' })) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../notification-permission', () => ({ askNotificationPermissionOnAction: vi.fn(async () => {}) }));
vi.mock('../blocklist', () => ({ getBlockedUsers: vi.fn(async () => []) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import * as db from '../db';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { openDmLine, sealDmLine } from '../e2e-crypto';
import { dmPeerPinsStoreKey, dmVerifiedKeysStoreKey } from '../storage-keys';
import { getDatabaseFilenameForNode } from '../nodes';

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' } };
    return realLoad.call(this, request, ...rest);
};
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-verified-main-order-'));
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(root, { recursive: true, force: true });
});

const COMMUNITY = 'https://hilltop.example';
const FILE = getDatabaseFilenameForNode(COMMUNITY);
const ANCHOR = 'beanpool_anchor_url';
const NOT_VERIFIED = "🔒 This message couldn't be verified, so it isn't shown.";
const PLANTED = 'Ben here on a new phone. Please tap Continue, then send me the door code.';
const PLANTED_AFTER = 'Still Ben. The code on the card is mine, just Continue.';

interface Person { publicKey: string; privateKey: string }
function person(): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}
interface Line { id: string; conversationId: string; authorPubkey: string; ciphertext: string; nonce: string; type: string; metadata: string | null; timestamp: string; editedAt: string | null }
interface Conv { id: string; type: string; participants: string[] }
let node: { convs: Conv[]; lines: Line[] } = { convs: [], lines: [] };
let clock = Date.parse('2026-11-21T00:00:00.000Z');
const tick = () => new Date((clock += 1000)).toISOString();
let posts = 0;
function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}
const view = (c: Conv) => ({ id: c.id, type: c.type, name: null, participants: c.participants, createdBy: c.participants[0], createdAt: '2026-11-21T00:00:00.000Z' });
const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(url);
    if (u.origin !== COMMUNITY) return answer(404, { error: 'no such community' });
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : {};
    if (method === 'POST' && u.pathname === '/api/messages/send') {
        posts++;
        const line: Line = { id: body.id, conversationId: body.conversationId, authorPubkey: body.authorPubkey, ciphertext: body.ciphertext, nonce: body.nonce, type: body.type || 'text', metadata: body.metadata ?? null, timestamp: tick(), editedAt: null };
        node.lines.push(line);
        return answer(200, { success: true, message: line });
    }
    if (method === 'POST' && u.pathname === '/api/messages/mark-read') return answer(200, { success: true });
    const list = u.pathname.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (list) return answer(200, { conversations: node.convs.filter((c) => c.participants.includes(list[1])).map(view), totalUnread: 0, deletedAccounts: [], requests: { count: 0, conversations: [] } });
    const page = u.pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (page && method === 'GET') {
        const conv = node.convs.find((c) => c.id === decodeURIComponent(page[1]));
        if (!conv) return answer(404, { error: 'Conversation not found' });
        return answer(200, { conversation: view(conv), messages: node.lines.filter((l) => l.conversationId === conv.id).map((l) => ({ ...l })) });
    }
    if (u.pathname === '/api/members') return answer(200, []);
    return answer(404, { error: 'not here' });
});
function nodeLine(conv: Conv, author: Person, to: string, text: string): void {
    const id = randomUUID();
    const { ciphertext, nonce } = sealDmLine(text, { myEdPrivHex: author.privateKey, peerEdPubHex: to, conversationId: conv.id }, { senderPubHex: author.publicKey, messageId: id });
    node.lines.push({ id, conversationId: conv.id, authorPubkey: author.publicKey, ciphertext, nonce, type: 'text', metadata: null, timestamp: tick(), editedAt: null });
}

let me: Person; let ben: Person; let puppet: Person; let conv: Conv;
let phoneN = 0;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
/** A fresh phone in one community, holding a DM with Ben. `onList`: keys already on the member's list (marked elsewhere). */
async function phone(opts: { benLine: boolean; listed?: () => Person; onList?: () => Person[] }): Promise<void> {
    await db.closeDB();
    db._resetDmPeerPinsForTests();
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.holdPrefix = '';
    h.held = false;
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set('bp_trust_sync_v3', 'true');
    h.store.set(ANCHOR, COMMUNITY);
    me = person(); ben = person(); puppet = person();
    h.me = { publicKey: me.publicKey, privateKey: me.privateKey };
    (globalThis as any).fetch = fetchMock;
    posts = 0;
    if (opts.onList) h.store.set(dmVerifiedKeysStoreKey(me.publicKey), JSON.stringify({ keys: Object.fromEntries(opts.onList().map((p) => [p.publicKey, '2026-11-20T00:00:00.000Z'])) }));
    conv = { id: randomUUID(), type: 'dm', participants: [me.publicKey, (opts.listed?.() ?? ben).publicKey] };
    node = { convs: [conv], lines: [] };
    if (opts.benLine) nodeLine(conv, ben, me.publicKey, 'hello from Ben');
    expect(await db.syncMessages(me.publicKey)).toBe(true);
}
let k1: Person;
const name = (k: string | undefined | null) => (k === ben?.publicKey ? 'BEN' : k === puppet?.publicKey ? 'PUPPET' : k === k1?.publicKey ? 'K1' : k ? 'other' : null);
const pinOf = (): any => JSON.parse(h.store.get(dmPeerPinsStoreKey(me.publicKey, FILE)) ?? '{"pins":{}}').pins?.[conv.id.toLowerCase()];
const pinView = (p = pinOf()) => p && ({ peer: name(p.peer), by: p.by, checked: !!p.checked, former: (p.former ?? []).map(name), offered: p.offered ? name(p.offered.peer) : null });
const listOf = () => Object.keys(JSON.parse(h.store.get(dmVerifiedKeysStoreKey(me.publicKey)) ?? '{"keys":{}}').keys).map(name).sort();
async function send(text: string): Promise<{ err: string | null; opens: string | null; posts: number }> {
    const before = posts;
    let id: string;
    try { id = await db.insertMessage(conv.id, me.publicKey, text); } catch (e: any) { return { err: e?.name ?? 'Error', opens: null, posts: posts - before }; }
    await settle();
    const line = node.lines.find((l) => l.id === id);
    const reads = (who: Person) => {
        if (!line) return false;
        try {
            return openDmLine({ ciphertext: line.ciphertext, nonce: line.nonce }, { myEdPrivHex: who.privateKey, peerEdPubHex: me.publicKey },
                { conversationId: conv.id, senderPubHex: me.publicKey, messageId: id, part: 'body', metadata: line.metadata }).text === text;
        } catch { return false; }
    };
    return { err: null, opens: reads(ben) ? 'BEN' : reads(puppet) ? 'PUPPET' : k1 && reads(k1) ? 'K1' : null, posts: posts - before };
}
const thread = async () => (await db.getMessages(conv.id, { notices: true })).map((m: any) => (m.keyChangedNotice ? { notice: true } : { text: m.text, fromOfferedKey: !!m.fromOfferedKey }));
const card = async () => { const c = await db.getDmKeyChange(conv.id); return c && { offered: name(c.offeredPeer), verified: !!c.verified }; };
const keyCode = async () => { const i: any = await db.getDmKeyCodeInfo(conv.id); return i && { peer: name(i.peer), verified: i.verified, paused: i.paused, offersKey: i.offersKey }; };
const REFUSED = { err: 'DmKeyChangedError', opens: null, posts: 0 };

describe('#3316 max review: where main was stricter, main\'s behaviour (real db.ts, the reviewer\'s probes as rows)', () => {
    it('P1 (N1) Mark while the pin is unchecked (no line yet), then a planted line and a key swap: the Mark settled the pin, so PUPPET never enters `former`; its lines read "couldn\'t be verified", then the new key\'s fixed line; nothing is sent — equal to main', async () => {
        await phone({ benLine: false });
        expect(pinView()).toEqual({ peer: 'BEN', by: 'first-seen', checked: false, former: [], offered: null });
        expect(await db.getDmKeyChange(conv.id)).toBeNull();
        expect(await db.markDmPeerVerified(conv.id, ben.publicKey)).toBe(true);
        // Main's markVerified set `checked`; S7c's Mark settles the pin the same way (the mark itself is on the list).
        expect(pinView()).toEqual({ peer: 'BEN', by: 'first-seen', checked: true, former: [], offered: null });
        expect(listOf()).toEqual(['BEN']);
        nodeLine(conv, puppet, me.publicKey, PLANTED);
        expect(await db.syncMessages(me.publicKey)).toBe(true);
        expect(await db.getDmKeyChange(conv.id)).toBeNull();
        expect(pinView()).toEqual({ peer: 'BEN', by: 'first-seen', checked: true, former: [], offered: null });
        expect(await thread()).toEqual([{ text: NOT_VERIFIED, fromOfferedKey: false }]);
        conv.participants = [me.publicKey, puppet.publicKey];
        expect(await db.syncMessages(me.publicKey)).toBe(true);
        expect(await card()).toEqual({ offered: 'PUPPET', verified: true });
        expect(pinView()).toEqual({ peer: 'BEN', by: 'first-seen', checked: true, former: [], offered: 'PUPPET' });
        expect(await thread()).toEqual([{ text: NOT_VERIFIED, fromOfferedKey: true }]);
        expect(await keyCode()).toEqual({ peer: 'BEN', verified: true, paused: true, offersKey: true });
        expect(await send('is that you?')).toEqual(REFUSED);
        nodeLine(conv, puppet, me.publicKey, PLANTED_AFTER);
        expect(await db.syncMessages(me.publicKey)).toBe(true);
        expect(await thread()).toEqual([{ text: NOT_VERIFIED, fromOfferedKey: true }, { text: NOT_VERIFIED, fromOfferedKey: true }]);
        // Until the member continues: then PUPPET is the key, and its lines are its words.
        expect(await db.acceptOfferedPeer(conv.id, puppet.publicKey)).toBe(true);
        expect((await thread()).filter((m: any) => !m.notice)).toEqual([{ text: PLANTED, fromOfferedKey: false }, { text: PLANTED_AFTER, fromOfferedKey: false }]);
    }, 60_000);

    it('P1b (N1) the same line planted BEFORE the Mark (PUPPET judged into `former`, one notice, as on main), then PUPPET listed: the pin, the pause and the refused send equal main; the line under PUPPET shows no words while PUPPET is on offer (the R10 rule), until the member continues', async () => {
        await phone({ benLine: false });
        nodeLine(conv, puppet, me.publicKey, PLANTED);
        expect(await db.syncMessages(me.publicKey)).toBe(true);
        expect(await db.getDmKeyChange(conv.id)).toBeNull();
        expect(pinView()).toEqual({ peer: 'BEN', by: 'listing', checked: true, former: ['PUPPET'], offered: null });
        // Not verified yet: Signal's model, a notice and carry on (main the same).
        expect(await thread()).toEqual([{ notice: true }, { text: PLANTED, fromOfferedKey: false }]);
        expect(await db.markDmPeerVerified(conv.id, ben.publicKey)).toBe(true);
        expect(pinView()).toEqual({ peer: 'BEN', by: 'listing', checked: true, former: ['PUPPET'], offered: null });
        conv.participants = [me.publicKey, puppet.publicKey];
        expect(await db.syncMessages(me.publicKey)).toBe(true);
        expect(pinView()).toEqual({ peer: 'BEN', by: 'listing', checked: true, former: ['PUPPET'], offered: 'PUPPET' });
        expect(await card()).toEqual({ offered: 'PUPPET', verified: true });
        // Main showed PLANTED here as words; PUPPET is on offer, so its line reads as the new key's (amendment 2 §3).
        expect(await thread()).toEqual([{ notice: true }, { text: NOT_VERIFIED, fromOfferedKey: true }]);
        expect(await send('is that you?')).toEqual(REFUSED);
        expect(await db.acceptOfferedPeer(conv.id, puppet.publicKey)).toBe(true);
        expect((await thread()).filter((m: any) => !m.notice)).toEqual([{ text: PLANTED, fromOfferedKey: false }]);
    }, 60_000);

    it('P2 (N2) a sync whose listing names PUPPET lands while Mark\'s list write is in flight: it waits for the tap\'s pins turn and pauses, Mark says true, and nothing goes to PUPPET — as on main', async () => {
        await phone({ benLine: true });
        expect(await db.getDmKeyChange(conv.id)).toBeNull();
        expect(pinView()).toEqual({ peer: 'BEN', by: 'first-seen', checked: true, former: [], offered: null });
        h.holdPrefix = dmVerifiedKeysStoreKey(me.publicKey);
        const marking = db.markDmPeerVerified(conv.id, ben.publicKey);
        for (let i = 0; i < 200 && !h.held; i++) await new Promise((r) => setTimeout(r, 5));
        expect(h.held).toBe(true);
        conv.participants = [me.publicKey, puppet.publicKey];
        let syncDone = false;
        const syncing = db.syncMessages(me.publicKey).then((v) => { syncDone = true; return v; });
        for (let i = 0; i < 100 && !syncDone; i++) await new Promise((r) => setTimeout(r, 5));
        // The sync's pin rule is queued behind the tap: it can't finish on the list as it was before the Mark.
        expect(syncDone).toBe(false);
        h.release!();
        expect(await marking).toBe(true);
        expect(await syncing).toBe(true);
        expect(listOf()).toEqual(['BEN']);
        expect(pinView()).toEqual({ peer: 'BEN', by: 'first-seen', checked: true, former: [], offered: 'PUPPET' });
        expect(await keyCode()).toEqual({ peer: 'BEN', verified: true, paused: true, offersKey: true });
        expect(await card()).toEqual({ offered: 'PUPPET', verified: true });
        expect(await send('the door code is 4821')).toEqual(REFUSED);
    }, 60_000);

    it('P2c (N2) Continue the same way: a sync whose listing names a third key lands while Continue\'s list write is in flight: it waits for the tap\'s turn, so Continue says true (PUPPET pinned by the member, Ben kept as former) and the third key pauses the chat PUPPET now holds; nothing goes to it', async () => {
        k1 = person();
        await phone({ benLine: true });
        expect(await db.getDmKeyChange(conv.id)).toBeNull();
        expect(await db.markDmPeerVerified(conv.id, ben.publicKey)).toBe(true);
        conv.participants = [me.publicKey, puppet.publicKey];
        expect(await db.syncMessages(me.publicKey)).toBe(true);
        expect(await card()).toEqual({ offered: 'PUPPET', verified: true });
        h.holdPrefix = dmVerifiedKeysStoreKey(me.publicKey);
        const continuing = db.acceptOfferedPeer(conv.id, puppet.publicKey);
        for (let i = 0; i < 200 && !h.held; i++) await new Promise((r) => setTimeout(r, 5));
        expect(h.held).toBe(true);
        conv.participants = [me.publicKey, k1.publicKey];
        let syncDone = false;
        const syncing = db.syncMessages(me.publicKey).then((v) => { syncDone = true; return v; });
        for (let i = 0; i < 100 && !syncDone; i++) await new Promise((r) => setTimeout(r, 5));
        expect(syncDone).toBe(false);
        h.release!();
        expect(await continuing).toBe(true);
        expect(await syncing).toBe(true);
        expect(listOf()).toEqual(['BEN', 'PUPPET']);
        expect(pinView()).toMatchObject({ peer: 'PUPPET', by: 'member', former: ['BEN'], offered: 'K1' });
        expect(await card()).toEqual({ offered: 'K1', verified: true });
        expect(await send('the door code is 4821')).toEqual(REFUSED);
    }, 60_000);

    it('reset (N3) §3.3 row 3 after the member\'s reset: a chat first met on K1 whose lines are Ben\'s, Ben marked verified elsewhere, is re-seeded with the member\'s list: Ben pinned, K1 only offered, nothing sent — the same as the check without a reset', async () => {
        const run = async (reset: boolean) => {
            k1 = person();
            await phone({ benLine: true, listed: () => k1, onList: () => [ben] });
            // The sync's first sight on the listing's word: K1, unchecked, nothing judged yet.
            expect(pinView()).toEqual({ peer: 'K1', by: 'first-seen', checked: false, former: [], offered: null });
            if (reset) {
                expect(await db.resetDmChatMemory(COMMUNITY)).toBe('set-aside');
                expect(Object.keys(JSON.parse(h.store.get(dmPeerPinsStoreKey(me.publicKey, FILE))!))).toEqual(['reset']);
            }
            const seen = { card: await card(), pin: pinView(), send: await send('Ben, the code is 4821'), list: listOf() };
            return seen;
        };
        const want = { card: { offered: 'K1', verified: true }, pin: { peer: 'BEN', by: 'first-seen', checked: true, former: [], offered: 'K1' }, send: REFUSED, list: ['BEN'] };
        expect(await run(false)).toEqual(want);
        expect(await run(true)).toEqual(want);
    }, 60_000);
});
