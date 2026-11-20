/**
 * Slice S4 (scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Where an across chat lives", §6 row S4): a chat
 * with someone in a community the member doesn't belong to is kept in the file of the community that carries it (its
 * mailbox is that community's server). It now shows, and is fetched, whatever community the phone is set to, read through a
 * held, read-only handle (S1) and written through its copy open in place (S2). No data moves between files.
 *
 * One table (close the class): each across action (the list, a line arriving in a round, a line sent, a reaction sent,
 * Accept, Decline) x where the phone is (set to the carrying community; set elsewhere; set elsewhere and switched to a third
 * community while the action's request is on its way; set elsewhere and the account leaving the phone meanwhile). A carries
 * the chat; B is where the phone is set; C is the third. B's file starts as a copy of A's (the same chat ids), so a write
 * by id into the wrong file would show. Each row asserts:
 * - every mail request went to A's own server;
 * - B's and C's across tables are exactly as they were;
 * - the action's effect is in A's file (after a switch, once A's next round has run), and nowhere else;
 * - the account leaving: nothing is written anywhere and no file is made again.
 *
 * Then the rounds and `mail` (the counts answer, server GET /api/me/unread): what A's answer says (an old node with no
 * `mail`, 0, 2, no count) starts A's round only where mail waits; and one table (#3310 review F1, close the class): `mail: 0`
 * heard from A, then a line held there that rings, x {a ring while the app is open, Chat as it opens, the background task}:
 * each fetches A's mailbox, and the line is in A's file.
 *
 * Real SQLite files on disk (node:sqlite, in a directory of this test's own), the real database module, real sealing and
 * signing between real keys; the mailbox is a stand-in that answers as routes/relay.ts does.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ed25519Signer, relayConversationId, relayPayloadHash, sealOutsideLine, signRelayEnvelope, type RelayItem } from '@beanpool/core';

const h = vi.hoisted(() => ({
    dir: '',
    store: new Map<string, string>(),
    me: { publicKey: '', privateKey: '' },
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: () => ({ remove: () => {} }), emit: () => {} },
}));
/** expo-sqlite over node:sqlite, one real file per name in this test's directory, as expo-sqlite opens them in its own. */
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
        setItem: vi.fn(async (k: string, v: string) => { h.store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) h.store.delete(k); }),
    },
}));
vi.mock('expo-crypto', async () => {
    const nodeCrypto = await import('node:crypto');
    return { randomUUID: nodeCrypto.randomUUID, getRandomBytes: (n: number) => new Uint8Array(nodeCrypto.randomBytes(n)) };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...h.me, callsign: 'Me' })) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../notification-permission', () => ({ askNotificationPermissionOnAction: vi.fn(async () => {}) }));
vi.mock('../blocklist', () => ({ getBlockedUsers: vi.fn(async () => []), isUserBlocked: vi.fn(async () => false) }));
// Every community here takes messages from other communities.
vi.mock('../node-profile', async (orig) => ({
    ...(await orig<any>()),
    getCachedNodeProfile: vi.fn(async () => ({ features: { outsideMessages: true } })),
    fetchNodeProfile: vi.fn(async () => ({ features: { outsideMessages: true } })),
}));
// The member's statements as core signs them, without the phone's native modules.
vi.mock('../member-statements', async () => {
    const core = await import('@beanpool/core');
    const toKey = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
    return {
        signRelayEnvelopeStatement: (f: any, k: string) => core.signRelayEnvelope(f, core.ed25519Signer(toKey(k))),
        signAddressCardStatement: (c: any, k: string) => core.signAddressCard(c, core.ed25519Signer(toKey(k))),
    };
});

/** The mailboxes, one per community server, as routes/relay.ts answers: what each holds for this phone, and every request. */
const mail = vi.hoisted(() => ({
    held: new Map<string, any[]>(),
    asked: [] as Array<{ origin: string; method: string; path: string }>,
    /** The next request matching `matches` waits for `release` (an action on its way while something happens). */
    hold: null as null | { matches: (method: string, p: string) => boolean; seenNow: () => void; released: Promise<void>; taken: boolean },
    /** What each server was told of the across mute (POST /api/mail/quiet), and whether it refuses one. */
    quiet: [] as Array<{ origin: string; key: string; quiet: boolean }>,
    refuseQuiet: false,
    /** What each server holds of it, by `origin member`: the keys its mailbox answer lists as `quiet`. */
    held_quiet: new Map<string, Set<string>>(),
}));
vi.mock('../node-post', async (orig) => {
    const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const waitIfHeld = async (method: string, p: string) => {
        const hold = mail.hold;
        if (hold && !hold.taken && hold.matches(method, p)) {
            hold.taken = true;
            hold.seenNow();
            await hold.released;
        }
    };
    return {
        ...(await orig<any>()),
        signedGet: vi.fn(async (url: string, p: string, who?: { publicKey: string }) => {
            const origin = new URL(url).origin;
            mail.asked.push({ origin, method: 'GET', path: p.split('?')[0] });
            await waitIfHeld('GET', p.split('?')[0]);
            if (p.startsWith('/api/mail?')) {
                const quiet = [...(mail.held_quiet.get(`${origin} ${who?.publicKey}`) ?? [])];
                return answer(200, { items: mail.held.get(origin) ?? [], more: false, outbox: [], outboxMore: false, quiet });
            }
            return answer(404, { error: 'not here' });
        }),
        signedPost: vi.fn(async (url: string, p: string, body: any, who?: { publicKey: string }) => {
            const origin = new URL(url).origin;
            mail.asked.push({ origin, method: 'POST', path: p });
            await waitIfHeld('POST', p);
            if (p === '/api/mail/confirm') {
                mail.held.set(origin, (mail.held.get(origin) ?? []).filter((i) => !body.ids.includes(i.envelope.itemId)));
                return answer(200, { confirmed: body.ids.length });
            }
            if (p === '/api/mail/send') return answer(200, { items: body.items.map((i: RelayItem) => ({ itemId: i.envelope.itemId, state: 'sent' })) });
            if (p === '/api/mail/quiet') {
                if (mail.refuseQuiet) return answer(404, { error: 'Not found' });
                mail.quiet.push({ origin, key: body.key, quiet: body.quiet });
                const kept = mail.held_quiet.get(`${origin} ${who?.publicKey}`) ?? new Set<string>();
                if (body.quiet) kept.add(body.key); else kept.delete(body.key);
                mail.held_quiet.set(`${origin} ${who?.publicKey}`, kept);
                return answer(200, { quiet: body.quiet });
            }
            return answer(404, { error: 'not here' });
        }),
    };
});

import * as db from '../db';
import { switchPhoneTo } from '../reconnect';
import { removeCommunityCaches } from '../community-cache';
import { getDatabaseFilenameForNode } from '../nodes';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { SAVED_NODES_STORE_KEY } from '../storage-keys';
import { heldChatsInView, heldOutsideChatsShown, outsideChatHref } from '../held-chats';
import { mailAfterBackgroundSync, outsideContext, roundOnRing, roundWhereMailWaits, syncHeldMailNow, syncOutsideMailNow } from '../outside-chat-live';
import { chatsShown, outsideQuiet, sendFromBox, sendOutsideChange, setOutsideQuiet } from '../outside-mail';

// A finished write may end with require('react-native') for a DeviceEventEmitter nudge: answered at node's loader.
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' } };
    return realLoad.call(this, request, ...rest);
};
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-across-everywhere-'));
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(root, { recursive: true, force: true });
});

/** A: carries the across chat (its mailbox). B: where the phone is set. C: a third, the phone switches to. */
const A = 'https://riverside.example';
const B = 'https://hilltop.example';
const C = 'https://brookside.example';
const A_FILE = getDatabaseFilenameForNode(A);
const B_FILE = getDatabaseFilenameForNode(B);
const C_FILE = getDatabaseFilenameForNode(C);
const ANCHOR = 'beanpool_anchor_url';
const ACROSS_TABLES = ['outside_chats', 'outside_lines', 'outside_changes', 'outside_receipts'];
const PEER_HOME = 'faraway.example';

interface Person { publicKey: string; privateKey: string }
function person(): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}
const uuid = () => { const b = randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const x = b.toString('hex'); return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`; };
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

let me: Person;
let peer: Person;
let chatId: string;
/** A line of theirs already in A's file (and B's copy): what a reaction names. */
let theirLine: string;
let phoneN = 0;

const fileOn = (file: string) => path.join(h.dir, file);
function acrossRowsOf(file: string): Record<string, unknown[]> | null {
    if (!fs.existsSync(fileOn(file))) return null;
    const sql = new DatabaseSync(fileOn(file));
    try {
        const out: Record<string, unknown[]> = {};
        for (const t of ACROSS_TABLES) out[t] = sql.prepare(`SELECT * FROM ${t} ORDER BY 1`).all().map((r) => ({ ...(r as object) }));
        return out;
    } finally {
        sql.close();
    }
}
function setChatState(file: string, state: string): void {
    const sql = new DatabaseSync(fileOn(file));
    sql.prepare('UPDATE outside_chats SET state = ? WHERE id = ?').run(state, chatId);
    sql.close();
}

/** A line `peer` writes me, sealed on their phone, held at A's mailbox for me. */
async function heldAtA(text: string): Promise<string> {
    const itemId = uuid();
    const payload = sealOutsideLine({ text, name: 'Pia', myEdPrivHex: peer.privateKey, myKey: peer.publicKey, peerKey: me.publicKey, messageId: itemId });
    const envelope = await signRelayEnvelope({
        kind: 'dm-line', itemId, senderKey: peer.publicKey, senderHome: PEER_HOME, recipient: me.publicKey, recipientHome: new URL(A).host,
        at: Date.now(), payloadHash: relayPayloadHash(payload),
    }, ed25519Signer(Buffer.from(peer.privateKey, 'hex')));
    mail.held.set(A, [...(mail.held.get(A) ?? []), { kind: 'dm-line', envelope, payload, bytes: payload.length, receivedAt: Date.now() }]);
    return itemId;
}

/**
 * A phone that holds an open across chat with `peer` in A's file (one line of theirs in it), then is set to `setTo`. B's
 * file starts as a copy of A's (the same ids).
 */
async function phone(setTo: string): Promise<void> {
    await db.closeDB();
    db._resetChatsInPlaceForTests();
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set(SAVED_NODES_STORE_KEY, JSON.stringify([A, B, C].map((url) => ({ url, lastConnected: '2026-11-20T00:00:00.000Z' }))));
    h.store.set(ANCHOR, A);
    me = person();
    peer = person();
    h.me = { publicKey: me.publicKey, privateKey: me.privateKey };
    mail.held = new Map();
    mail.held_quiet = new Map();
    mail.asked = [];
    mail.hold = null;
    chatId = relayConversationId(me.publicKey, peer.publicKey);

    // Made while set to A, as today: the chat lives in A's file, A's mailbox is its home.
    const here = db.outsideStore(A);
    await here.setMeta('home', `${new URL(A).host} ${Date.now()}`);
    await here.openChat(me.publicKey, chatId, { key: peer.publicKey, home: PEER_HOME, name: 'Pia' });
    theirLine = await heldAtA('first words from Pia');
    expect(await syncOutsideMailNow(30_000)).not.toBeNull();
    expect(acrossRowsOf(A_FILE)!.outside_lines.some((l: any) => l.id === theirLine)).toBe(true);
    await db.closeDB();
    fs.copyFileSync(fileOn(A_FILE), fileOn(B_FILE));
    if (setTo !== A) await switchPhoneTo(setTo);
    else await db.initDB();
    expect(h.store.get(ANCHOR)).toBe(setTo);
    mail.asked = [];
}

interface Act {
    name: string;
    /** The mail request held while something happens (null: the action asks no server). */
    held: ((method: string, p: string) => boolean) | null;
    before?: () => Promise<void> | void;
    act: (community: string) => Promise<unknown>;
    /** The action's effect, as A's across tables and its result show it. */
    landed: (a: Record<string, any[]>, result: any) => boolean;
}

let arrived = '';
const sentWords = 'an answer from wherever I am';
const ACTS: Act[] = [
    {
        name: 'the list', held: null,
        act: async () => {
            // As Chat reads it while in view (app/(tabs)/chats.tsx): its held handles close as it is left.
            const view = heldChatsInView();
            try {
                const here = await outsideContext();
                return { here: here ? await chatsShown(here) : [], held: await heldOutsideChatsShown(me.publicKey, view) };
            } finally {
                await view.leave();
            }
        },
        landed: (_a, r) => {
            const set = h.store.get(ANCHOR);
            const listed = set === A ? r.here.find((c: any) => c.id === chatId) : r.held.find((c: any) => c.id === chatId && c.community === A);
            return !!listed && listed.lastText === 'first words from Pia' && (set === A || outsideChatHref(listed) === `/outside-chat/${chatId}?community=${encodeURIComponent(A)}`);
        },
    },
    {
        name: 'a line arriving (the round)',
        held: (m, p) => m === 'GET' && p === '/api/mail',
        before: async () => { arrived = await heldAtA('arrived wherever the phone is set'); },
        act: (community) => syncOutsideMailNow(30_000, community),
        landed: (a) => a.outside_lines.some((l: any) => l.id === arrived && l.text === 'arrived wherever the phone is set'),
    },
    {
        name: 'a line sent',
        held: (m, p) => m === 'POST' && p === '/api/mail/send',
        act: async (community) => {
            const ctx = await outsideContext(community);
            return sendFromBox(ctx!, chatId, sentWords, 20_000, () => {});
        },
        landed: (a) => a.outside_lines.some((l: any) => l.text === sentWords && l.author === me.publicKey),
    },
    {
        name: 'a reaction sent',
        held: (m, p) => m === 'POST' && p === '/api/mail/send',
        act: async (community) => sendOutsideChange((await outsideContext(community))!, chatId, { kind: 'dm-reaction', lineId: theirLine, emoji: '👍' }),
        landed: (a) => a.outside_changes.some((c: any) => c.line_id === theirLine && c.emoji === '👍' && c.author === me.publicKey),
    },
    {
        name: 'Accept a request',
        held: null,
        before: () => { setChatState(A_FILE, 'request'); setChatState(B_FILE, 'request'); },
        act: async (community) => (await outsideContext(community))!.store.decide(me.publicKey, chatId, 'open'),
        landed: (a) => a.outside_chats.some((c: any) => c.id === chatId && c.state === 'open'),
    },
    {
        name: 'Decline a request',
        held: null,
        before: () => { setChatState(A_FILE, 'request'); setChatState(B_FILE, 'request'); },
        act: async (community) => (await outsideContext(community))!.store.decide(me.publicKey, chatId, 'declined'),
        landed: (a) => a.outside_chats.some((c: any) => c.id === chatId && c.state === 'declined'),
    },
];

/** Where the phone is, and what happens while the action is on its way. */
const WHERE: Record<string, { setTo: string; meanwhile: (() => Promise<void>) | null; leaves: boolean }> = {
    'set to the carrying community': { setTo: A, meanwhile: null, leaves: false },
    'set elsewhere': { setTo: B, meanwhile: null, leaves: false },
    'set elsewhere, switched to a third community mid-way': { setTo: B, meanwhile: async () => { await switchPhoneTo(C); }, leaves: false },
    'set elsewhere, the account leaving the phone mid-way': {
        setTo: B,
        meanwhile: async () => { await db.clearDB({ identityLeaves: true }); await removeCommunityCaches([A, B, C], { everyCopy: true }); },
        leaves: true,
    },
};

describe('an across chat: every action lands in the carrying community\'s file and mailbox, wherever the phone is set', () => {
    const cases = ACTS.flatMap((a) => Object.keys(WHERE).map((w) => [a.name, w, a] as const));
    it.each(cases)('%s, %s', async (_name, whereName, row) => {
        const where = WHERE[whereName];
        await phone(where.setTo);
        await row.before?.();
        const bBefore = acrossRowsOf(B_FILE);
        const cBefore = acrossRowsOf(C_FILE);
        mail.asked = [];

        let seen: () => void = () => {};
        let release: () => void = () => {};
        const seenP = new Promise<void>((r) => { seen = r; });
        const released = new Promise<void>((r) => { release = r; });
        if (row.held && where.meanwhile) mail.hold = { matches: row.held, seenNow: seen, released, taken: false };
        // A chat screen holds its community in place while it is up (app/outside-chat/[id].tsx); a round holds it itself.
        const holds = where.setTo !== A;
        if (holds) db.enterChatInPlace(A);
        let result: unknown;
        const running = row.act(A).then((r) => { result = r; }, () => {});
        if (mail.hold) await seenP;
        else await running;
        if (where.meanwhile) await where.meanwhile();
        await settle();
        const cAfterMeanwhile = acrossRowsOf(C_FILE);
        release();
        await running;
        if (holds) await db.leaveChatInPlace(A);
        await settle();

        // Every mail request went to A's own server.
        for (const r of mail.asked) expect(r.origin, `${r.method} ${r.path}`).toBe(A);
        if (row.held && !where.leaves) expect(mail.asked.length, 'the action asked A').toBeGreaterThan(0);

        if (where.leaves) {
            // Nothing written anywhere after the account left, and no copy made again.
            expect(fs.existsSync(fileOn(A_FILE)), 'A\'s copy is never made again').toBe(false);
            expect(fs.existsSync(fileOn(B_FILE)), 'B\'s copy is never made again').toBe(false);
            expect(db.heldCopyFiles()).toEqual([]);
            return;
        }
        // B's and C's across tables exactly as they were (C's as the switch made it).
        expect(acrossRowsOf(B_FILE), 'B\'s file').toEqual(bBefore);
        if (cBefore || cAfterMeanwhile) expect(acrossRowsOf(C_FILE), 'C\'s file').toEqual(cAfterMeanwhile ?? cBefore);
        // A round of A afterwards (a switch can cut the first), from wherever the phone now is: the effect is in A's file.
        if (where.meanwhile && row.held) await syncOutsideMailNow(30_000, A);
        expect(row.landed(acrossRowsOf(A_FILE)!, result), 'landed in A').toBe(true);
        expect(acrossRowsOf(B_FILE), 'B\'s file, after A\'s next round').toEqual(bBefore);
        // Nothing of A left open beside the copy in use once the screen, the list and the rounds let go.
        if (h.store.get(ANCHOR) !== A) expect(db.heldCopyFiles(), 'nothing of A left open').not.toContain(A_FILE);
    });
});

describe('rounds and `mail`: an answer that says mail waits starts that community\'s round, and none it gives keeps a line from the next (#3310 review F1)', () => {
    const HEARD: Array<[string, unknown, boolean]> = [
        // what A's counts answer said, body; does it start A's round
        ['an old node, no `mail`', { unread: 0, requests: 0 }, false],
        ['`mail: 0`', { unread: 0, requests: 0, mail: 0 }, false],
        ['`mail: 2`', { unread: 0, requests: 0, mail: 2 }, true],
        ['a `mail` that is no count', { mail: -1 }, false],
    ];
    it.each(HEARD)('%s', async (_name, body, starts) => {
        await phone(B);
        const id = await heldAtA('waiting at A');
        mail.asked = [];
        const round = roundWhereMailWaits(A, body);
        expect(round !== null).toBe(starts);
        await round;
        expect(mail.asked.some((r) => r.origin === A && r.path === '/api/mail')).toBe(starts);
        expect(acrossRowsOf(A_FILE)!.outside_lines.some((l: any) => l.id === id)).toBe(starts);
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
    });

    // `mail: 0` heard from A, then a line held at A for me from someone I wrote to (A's server rings: engine/relay-mail.ts).
    // Mutation: put back a kept 0 that skips A in syncHeldMailNow (or one mailAfterBackgroundSync applies) -> the Chat or the
    // background row goes red; drop roundOnRing's round -> the ring row goes red.
    const WHEN: Array<[string, () => Promise<unknown>]> = [
        ['a ring from A while the app is open (handleNotification)', () => roundOnRing({ community: A, kind: 'chat.message', active: false })],
        ['Chat as it opens (its focus round)', () => syncHeldMailNow(30_000)],
        ['the background task', () => mailAfterBackgroundSync(Date.now())],
    ];
    it.each(WHEN)('`mail: 0` heard from A, then a line there that rings; %s: A\'s mailbox is fetched, the line in A\'s file', async (_name, run) => {
        await phone(B);
        expect(roundWhereMailWaits(A, { unread: 0, requests: 0, mail: 0 })).toBeNull();
        const bBefore = acrossRowsOf(B_FILE);
        const id = await heldAtA('rang a minute after the zero');
        mail.asked = [];
        await run();
        expect(mail.asked.some((r) => r.origin === A && r.path === '/api/mail')).toBe(true);
        expect(acrossRowsOf(A_FILE)!.outside_lines.some((l: any) => l.id === id && l.text === 'rang a minute after the zero')).toBe(true);
        expect(acrossRowsOf(B_FILE), 'B\'s file').toEqual(bBefore);
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
    });

    it('a ring starts a round only for a chat line from another community this phone holds, at the address it saved', async () => {
        await phone(B);
        await heldAtA('one line');
        const NOT: Array<[string, Parameters<typeof roundOnRing>[0]]> = [
            ['a group\'s line', { community: A, kind: 'chat.group', active: false }],
            ['a kind this build doesn\'t know', { community: A, kind: null, active: false }],
            ['the community in use', { community: B, kind: 'chat.message', active: true }],
            ['a community the phone doesn\'t hold', { community: 'https://faraway.example', kind: 'chat.message', active: false }],
        ];
        for (const [name, notice] of NOT) {
            mail.asked = [];
            expect(await roundOnRing(notice), name).toBeNull();
            expect(mail.asked, name).toEqual([]);
        }
        // Another spelling of A: fetched at the address the phone saved for it.
        mail.asked = [];
        expect(await roundOnRing({ community: 'HTTPS://RIVERSIDE.EXAMPLE/', kind: 'chat.message', active: false })).not.toBeNull();
        expect(mail.asked.length).toBeGreaterThan(0);
        expect(mail.asked.every((r) => r.origin === A)).toBe(true);
    });

    it('wired: a checked notice while the app is open reaches roundOnRing; the background task runs mailAfterBackgroundSync; Chat\'s focus round fetches every held community', () => {
        const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');
        const service = read('../../services/push-notifications.ts');
        const handler = service.slice(service.indexOf('handleNotification: async'), service.indexOf('return { shouldPlaySound'));
        expect(handler).toMatch(/countForItsCommunity\(incoming\(notification\), recipient\)\.then\(\(notice\) => \{/);
        expect(handler).toContain('roundOnRing(notice)');
        expect(read('../../services/background-task.ts')).toContain('await mailAfterBackgroundSync(wokeAt);');
        expect(read('../../app/(tabs)/chats.tsx')).toContain('void syncHeldMailNow().catch(() => 0);');
        // Nothing keeps a counts answer's 0 (the skip this review found): no map of what was heard is left to apply.
        expect(read('../outside-chat-live.ts')).not.toMatch(/mailHeard|=== 0\) continue/);
    });
});

describe('listed only where it opens', () => {
    it('a guest mark naming the carrying community under another spelling: its across chats are not listed, and none opens there', async () => {
        await phone(B);
        const view = heldChatsInView();
        try {
            expect((await heldOutsideChatsShown(me.publicKey, view)).some((c) => c.id === chatId)).toBe(true);
            h.store.set('beanpool_guest_nodes', JSON.stringify(['HTTPS://RIVERSIDE.EXAMPLE/']));
            expect((await heldOutsideChatsShown(me.publicKey, view)).some((c) => c.id === chatId)).toBe(false);
            expect(await outsideContext(A)).toBeNull();
        } finally {
            await view.leave();
        }
    });
});

describe('the across mute: told to the carrying community\'s server, kept in its file, wherever the phone is set', () => {
    it.each([['set to the carrying community', A], ['set elsewhere', B]])('%s', async (_name, setTo) => {
        await phone(setTo);
        mail.quiet = [];
        mail.refuseQuiet = false;
        const bBefore = acrossRowsOf(B_FILE);
        if (setTo !== A) db.enterChatInPlace(A);
        const ctx = (await outsideContext(A))!;
        await setOutsideQuiet(ctx, peer.publicKey, true);
        expect(mail.quiet).toEqual([{ origin: A, key: peer.publicKey, quiet: true }]);
        expect(await outsideQuiet(ctx.store, me.publicKey, peer.publicKey)).toBe(true);
        // A server that refuses (one from before S4 has no such route): nothing kept, the chat still says quiet.
        mail.refuseQuiet = true;
        await expect(setOutsideQuiet(ctx, peer.publicKey, false)).rejects.toThrow();
        expect(await outsideQuiet(ctx.store, me.publicKey, peer.publicKey)).toBe(true);
        mail.refuseQuiet = false;
        await setOutsideQuiet(ctx, peer.publicKey, false);
        expect(await outsideQuiet(ctx.store, me.publicKey, peer.publicKey)).toBe(false);
        if (setTo !== A) await db.leaveChatInPlace(A);
        expect(acrossRowsOf(B_FILE), 'B\'s file').toEqual(bBefore);
        expect(mail.asked.every((r) => r.origin === A)).toBe(true);
    });
});

/** A new phone holding `who`'s account, set to A, with nothing of it kept yet: a re-key's new phone, or one restored from 12 words. */
async function newPhoneFor(who: Person): Promise<void> {
    await db.closeDB();
    db._resetChatsInPlaceForTests();
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set(SAVED_NODES_STORE_KEY, JSON.stringify([A, B].map((url) => ({ url, lastConnected: '2026-11-20T00:00:00.000Z' }))));
    h.store.set(ANCHOR, A);
    me = who;
    h.me = { publicKey: who.publicKey, privateKey: who.privateKey };
    await db.initDB();
    mail.asked = [];
}

describe('the across mute goes with the account (#3310 review F2): a re-key, a restore from 12 words, another account on the phone', () => {
    // My server carries the mute to the key I hold after a re-key (server: engine/relay-mail.ts quietId, test-mail-ring
    // section 4: the other person's line rings nothing); the phone shows it after its first round.
    const AFTER: Array<[string, (old: Person) => Person]> = [
        ['an admin re-key: a new phone with the new key', (old) => {
            const moved = person();
            for (const origin of [A, B]) {
                const kept = mail.held_quiet.get(`${origin} ${old.publicKey}`);
                if (kept) { mail.held_quiet.set(`${origin} ${moved.publicKey}`, kept); mail.held_quiet.delete(`${origin} ${old.publicKey}`); }
            }
            return moved;
        }],
        ['a restore from 12 words: a new phone with the same key', (old) => old],
    ];
    it.each(AFTER)('muted, then %s: the chat shows muted after its first round; another account there is not muted', async (_name, after) => {
        await phone(B);
        db.enterChatInPlace(A);
        await setOutsideQuiet((await outsideContext(A))!, peer.publicKey, true);
        await db.leaveChatInPlace(A);
        const theirs = peer.publicKey;
        const now = after(me);
        await newPhoneFor(now);
        const store = db.outsideStore(A);
        expect(await outsideQuiet(store, now.publicKey, theirs), 'nothing kept on the new phone yet').toBe(false);
        expect(await syncOutsideMailNow(30_000)).not.toBeNull();
        expect(await outsideQuiet(store, now.publicKey, theirs), 'muted, as my server holds it').toBe(true);
        expect(await outsideQuiet(store, person().publicKey, theirs), 'another account on this phone').toBe(false);
    });

    it('another account on the same phone is never muted by mine', async () => {
        await phone(A);
        const ctx = (await outsideContext(A))!;
        await setOutsideQuiet(ctx, peer.publicKey, true);
        expect(await outsideQuiet(ctx.store, me.publicKey, peer.publicKey)).toBe(true);
        const other = person();
        expect(await outsideQuiet(ctx.store, other.publicKey, peer.publicKey)).toBe(false);
        // Nothing kept under the other person's key alone, which any account here would read.
        expect(await ctx.store.getMeta(`quiet:${peer.publicKey}`)).toBeNull();
    });

    it('my own Unmute here stands against a page asked before my server was told', async () => {
        await phone(A);
        const ctx = (await outsideContext(A))!;
        await setOutsideQuiet(ctx, peer.publicKey, true);
        await setOutsideQuiet(ctx, peer.publicKey, false);
        // A page from before the Unmute landed still lists the key.
        mail.held_quiet.set(`${A} ${me.publicKey}`, new Set([peer.publicKey]));
        await syncOutsideMailNow(30_000);
        expect(await outsideQuiet(ctx.store, me.publicKey, peer.publicKey)).toBe(false);
    });
});

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); });
