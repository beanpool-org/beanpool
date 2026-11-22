import { describe, it, expect, vi, beforeEach } from 'vitest';
import Module from 'node:module';

// A member's block of a person holds across that person's re-key, on the phone's own SQLite (the real schema,
// node:sqlite), in every reader of the DM: the thread (its composer and canSendNow read isPeerBlocked, app/chat/[id].tsx),
// Talk's list (app/(tabs)/chats.tsx talkShowsChat) and Needs you, the bell's DM row (getUnreadByConversation). And the
// name each shows is the person's, or the start of their key, never the conversation's id.
//
// Review of #3268, finding 2: after an admin re-keys Ben, his moved card arrives in the members delta and the name order
// (db.ts otherParticipantSql) picks his NEW key. The member blocked his OLD key, and the phone's block list never learned
// the new one, so the thread dropped its blocked state and the composer came back. Now a DM is blocked when ANY key its
// other person is known by here is blocked (utils/dm-blocked.ts): its participants (the phone keeps the old key's row
// until a send, #1872 U7), and its pin's key and former keys (after the listing moved the pin to the new key, the old
// row gone). The block list itself follows the re-key too (blocklist.ts followRekeyedBlocks, its own test).
//
// The bell's blocked state is the node's: it withholds a blocked member's DM lines, and their push, by the block it moved
// to the new key (apps/server engine/member-blocks.ts moveBlocks; test-member-blocks section 7), so Needs you is asked
// here for its name only.
//
// The table: who is blocked (the old key, the new key, nobody) × the cards the phone holds (none, the old only, the new
// only, both) × what the phone holds of the DM's people (both keys as participants; or only the new key, with the pin's
// former naming the old) × the readers.

const h = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    (globalThis as any).__dmBlockedPhoneSql = sql;
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    const adapter = {
        runAsync: vi.fn(async (q: string, p?: unknown) => {
            const r = sql.prepare(q).run(...params(p));
            return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
        }),
        execAsync: vi.fn(async (q: string) => { sql.exec(q); }),
        getAllAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).all(...params(p))),
        getFirstAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null),
        closeAsync: vi.fn(async () => {}),
        withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
    };
    return { openDatabaseAsync: vi.fn(async () => adapter) };
});
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: 'file:///nowhere/',
    getInfoAsync: vi.fn(async () => ({ exists: false })),
    deleteAsync: vi.fn(async () => {}),
    makeDirectoryAsync: vi.fn(async () => {}),
    writeAsStringAsync: vi.fn(async () => {}),
    moveAsync: vi.fn(async () => {}),
}));
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
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(() => 'beanpool_riverside.db'), addSavedNode: vi.fn(async () => {}) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { getDb, getConversations, getConversation, getUnreadByConversation, _resetDmPeerPinsForTests } from '../db';
import { dmPeerName, isDmBlocked, talkShowsChat } from '../dm-blocked';
import { directChatsHere } from '../message-anyone';

const sql = (globalThis as any).__dmBlockedPhoneSql as import('node:sqlite').DatabaseSync;

/** Runs `fn` with react-native's DeviceEventEmitter stood in for (node cannot load it). */
async function withScreens<T>(fn: () => Promise<T>): Promise<T> {
    const nodeLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
        return request === 'react-native' ? { DeviceEventEmitter: { emit: () => {} } } : nodeLoad.call(this, request, ...rest);
    };
    try {
        return await fn();
    } finally {
        (Module as any)._load = nodeLoad;
    }
}

const ME = 'b'.repeat(64);
const OLD = 'a'.repeat(64);
const NEW = 'c'.repeat(64);
const CONV = 'dm-ben';
const PINS_KEY = `beanpool_dm_peer_pins:${ME}:beanpool_riverside.db`;

const OLD_CARD = { stamped: '2026-10-01T09:00:00.000Z' };
const NEW_CARD = { stamped: '2026-11-16T12:14:41.538Z' };
const CARDS = [
    { what: 'no card for either key', old: false, new: false },
    { what: "the old key's card only", old: true, new: false },
    { what: "the new key's card only", old: false, new: true },
    { what: 'both cards', old: true, new: true },
];
const BLOCKS = [
    { what: 'the member blocked his old key', list: [OLD], blocked: true },
    { what: 'the member blocked his new key', list: [NEW], blocked: true },
    { what: 'the member blocked nobody', list: [] as string[], blocked: false },
];
const PEOPLE = [
    { what: 'both his keys are participants (before a send)', participants: [NEW, OLD], pin: null },
    { what: "only his new key is a participant, the pin's former names the old", participants: [NEW],
        pin: { peer: NEW, since: '2026-11-16T12:15:00.000Z', by: 'listing', checked: true, former: [OLD], changedAt: ['2026-11-16T12:15:00.000Z'] } },
];

beforeEach(async () => {
    h.store.clear();
    // The pins db.ts keeps in memory for the run: each row's are its own.
    _resetDmPeerPinsForTests();
    h.store.set('beanpool_anchor_url', 'https://riverside.example');
    await getDb();
    for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
    sql.prepare('INSERT INTO members (public_key, callsign) VALUES (?, ?)').run(ME, 'Walker');
});

describe("a DM after the blocked person's re-key: blocked in the thread, hidden in Talk, and named, never by its id", () => {
    for (const people of PEOPLE) {
        for (const cards of CARDS) {
            for (const block of BLOCKS) {
                it(`${block.what}; ${cards.what}; ${people.what}`, async () => {
                    const card = sql.prepare('INSERT INTO members (public_key, callsign, profile_updated_at) VALUES (?, ?, ?)');
                    if (cards.old) card.run(OLD, 'Ben', OLD_CARD.stamped);
                    if (cards.new) card.run(NEW, 'Ben', NEW_CARD.stamped);
                    sql.prepare('INSERT INTO conversations (id, type) VALUES (?, ?)').run(CONV, 'dm');
                    const part = sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)');
                    for (const key of people.participants) part.run(CONV, key, null);
                    part.run(CONV, ME, '2026-11-16T12:00:00.000Z');
                    // A line of his from before the block, unread, so Needs you lists the chat.
                    sql.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp)
                                 VALUES ('m1', ?, ?, 'x', 'v2enc', 'text', '2026-11-16T12:20:00.000Z')`).run(CONV, OLD);
                    if (people.pin) h.store.set(PINS_KEY, JSON.stringify({ pins: { [CONV]: people.pin } }));


                    // The thread: getConversation's keys, read as app/chat/[id].tsx reads them for isPeerBlocked.
                    const thread = await getConversation(CONV, ME);
                    const threadKeys: string[] = thread?.peerKeys ?? (thread?.otherPubkey ? [thread.otherPubkey] : []);
                    // Talk's list: getConversations' row, through the list's own filter.
                    const row = (await withScreens(() => getConversations(ME))).find((c: any) => c.id === CONV);
                    // Needs you, the bell's DM row: its name.
                    const bell = (await getUnreadByConversation(ME)).find(r => r.id === CONV);

                    expect({
                        threadBlocked: isDmBlocked(threadKeys, block.list),
                        talkListed: !!row && talkShowsChat(row, block.list),
                    }).toEqual({ threadBlocked: block.blocked, talkListed: !block.blocked });

                    // Message (S5 part 2, utils/message-anyone.ts directChatsHere) finds the DM in what getConversations itself
                    // RETURNS, by either of his keys, unless Talk hides it (#3354 review: it read the SQL row's aliases, so it
                    // found no DM here on a real phone, and a hand-written row hid that). Mutation: read `convType` /
                    // `otherPubkey` / `otherKeys` again -> no chat found, and every unblocked row goes red.
                    const listed = await withScreens(() => getConversations(ME));
                    for (const key of [OLD, NEW]) {
                        expect(directChatsHere(listed, [key], 'https://riverside.example', (c) => talkShowsChat(c, block.list)).map((c) => c.id)).toEqual(block.blocked ? [] : [CONV]);
                    }

                    // The name, the same in all three: his card's, else the start of the key each names him by (no card for
                    // it yet), never the conversation's id. With both keys still participants, a card for either names him.
                    const named = String(thread?.otherPubkey);
                    const carded = (named === OLD && cards.old) || (named === NEW && cards.new);
                    if (people.participants.length === 2 && (cards.old || cards.new)) expect(carded).toBe(true);
                    const threadName = dmPeerName(thread ?? {});
                    for (const shown of [threadName, row?.peer, bell?.peer]) {
                        expect(shown).not.toBe(CONV.slice(0, 8));
                        expect(shown).toBe(carded ? 'Ben' : named.slice(0, 8));
                    }
                });
            }
        }
    }
});

describe('the one name rule (dmPeerName): the chat, the card, the start of the key, then "Member"', () => {
    it.each([
        [{ name: 'Market chat', otherCallsign: 'Ben', otherPubkey: NEW }, 'Market chat'],
        [{ name: null, otherCallsign: 'Ben', otherPubkey: NEW }, 'Ben'],
        [{ name: null, otherCallsign: null, otherPubkey: NEW }, NEW.slice(0, 8)],
        [{ name: null, otherCallsign: '  ', otherPubkey: null }, 'Member'],
    ])('%j → %s', (row, want) => {
        expect(dmPeerName(row)).toBe(want);
    });
});
