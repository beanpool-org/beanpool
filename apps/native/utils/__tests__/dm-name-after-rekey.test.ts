import { describe, it, expect, vi, beforeEach } from 'vitest';
import Module from 'node:module';

// The person a DM is named by, after their re-key, on the phone's own SQLite (the real schema, node:sqlite): every
// reader that names a chat by the person in it (the chat list, the thread's header, Needs you) takes the same person,
// whatever order the index gives the participants.
//
// Found walking #3263 (scratch/walks/RESULT-walk-emulator-s1-w3.md, Row 1 §2): after an admin re-keyed Ben, the phone held
// three participants in the DM (the new key, the old key, me), which it keeps until a send (#1872 U7), and a card for the
// old key only. Each reader took the first other participant (LIMIT 1, no order): the new key, with no card, so the list
// named the DM by the key's first 8 characters and the thread, its header and its "{name}'s key changed" line by the
// conversation's id. The node now sends the moved card in the next members delta (member-wizards.ts completeRekey), and
// the hourly whole read drops the old one, so the phone holds the old card, both, or the new one, by turns. Each state is
// a row below, in both orders of the two keys (the participants' primary key orders the index by key): the name is Ben's
// in every one, and the list, the header and Needs you take the same key, the newest card's.

const h = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    (globalThis as any).__dmNamePhoneSql = sql;
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

import { getDb, getConversations, getConversation, getUnreadByConversation } from '../db';

const sql = (globalThis as any).__dmNamePhoneSql as import('node:sqlite').DatabaseSync;

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
const LOW = 'a'.repeat(64);  // sorts before mine and HIGH: the index's first other participant
const HIGH = 'c'.repeat(64);
const CONV = 'dm-ben';

type Card = { stamped: string | null; face: string };
/** What the phone holds for Ben's two keys: a card for the old key, the new key, both or neither. */
type State = { what: string; old: Card | null; new: Card | null; name: string | null; face: string | null; key: 'old' | 'new' | 'first' };
const OLD_CARD: Card = { stamped: '2026-10-01T09:00:00.000Z', face: 'bundled://avatar-1' };
const NEW_CARD: Card = { stamped: '2026-11-16T12:14:41.538Z', face: 'bundled://avatar-2' };
const STATES: State[] = [
    { what: "the old key's card only (before the members delta brings the moved one)", old: OLD_CARD, new: null, name: 'Ben', face: OLD_CARD.face, key: 'old' },
    { what: 'both cards (the delta brought the moved one; the whole read has not dropped the old one)', old: OLD_CARD, new: NEW_CARD, name: 'Ben', face: NEW_CARD.face, key: 'new' },
    { what: "the new key's card only (after the hourly whole read)", old: null, new: NEW_CARD, name: 'Ben', face: NEW_CARD.face, key: 'new' },
    { what: 'both cards, the old one never stamped (a card from before profile_updated_at)', old: { stamped: null, face: OLD_CARD.face }, new: NEW_CARD, name: 'Ben', face: NEW_CARD.face, key: 'new' },
    // No card for either: no name to give, so each reader falls back, and still on the same key (the first by key).
    { what: 'no card for either key', old: null, new: null, name: null, face: null, key: 'first' },
];
const ORDERS = [
    { what: 'the old key sorts first', oldKey: LOW, newKey: HIGH },
    { what: 'the new key sorts first', oldKey: HIGH, newKey: LOW },
];

beforeEach(async () => {
    h.store.clear();
    h.store.set('beanpool_anchor_url', 'https://riverside.example');
    await getDb();
    for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
    sql.prepare('INSERT INTO members (public_key, callsign) VALUES (?, ?)').run(ME, 'Walker');
});

describe("a DM after the other person's re-key: every reader names it by the same person, Ben, in every order", () => {
    for (const order of ORDERS) {
        for (const state of STATES) {
            it(`${state.what}; ${order.what}`, async () => {
                const card = sql.prepare('INSERT INTO members (public_key, callsign, avatar_url, profile_updated_at) VALUES (?, ?, ?, ?)');
                if (state.old) card.run(order.oldKey, 'Ben', state.old.face, state.old.stamped);
                if (state.new) card.run(order.newKey, 'Ben', state.new.face, state.new.stamped);
                sql.prepare('INSERT INTO conversations (id, type) VALUES (?, ?)').run(CONV, 'dm');
                const part = sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)');
                // In the order the walk's phone held them: the new key, the old key, mine.
                part.run(CONV, order.newKey, null);
                part.run(CONV, order.oldKey, null);
                part.run(CONV, ME, '2026-11-16T12:00:00.000Z');
                // A line of Ben's since, unread, so Needs you lists the chat (no identity on this phone: nothing is opened).
                sql.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp)
                             VALUES ('m1', ?, ?, 'x', 'v2enc', 'text', '2026-11-16T12:20:00.000Z')`).run(CONV, order.newKey);

                const key = state.key === 'old' ? order.oldKey : state.key === 'new' ? order.newKey : LOW;
                const fallback = state.name ?? null;

                const listed = (await withScreens(() => getConversations(ME))).find((c: any) => c.id === CONV);
                expect({ peer: listed?.peer, peerPubkey: listed?.peerPubkey, peerAvatar: listed?.peerAvatar })
                    .toEqual({ peer: fallback ?? key.slice(0, 8), peerPubkey: key, peerAvatar: state.face });

                const header = await getConversation(CONV, ME);
                expect({ otherCallsign: header?.otherCallsign ?? null, otherPubkey: header?.otherPubkey, otherAvatar: header?.otherAvatar ?? null })
                    .toEqual({ otherCallsign: fallback, otherPubkey: key, otherAvatar: state.face });

                const needsYou = (await getUnreadByConversation(ME)).find(r => r.id === CONV);
                expect(needsYou?.peer).toBe(fallback ?? CONV.slice(0, 8));
            });
        }
    }
});
