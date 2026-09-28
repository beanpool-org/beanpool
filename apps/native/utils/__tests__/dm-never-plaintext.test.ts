import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from '@beanpool/core';

// A direct message leaves the phone encrypted or not at all (utils/dm-lock.ts, PR #1283 review). db.ts used to fall back
// to readable plaintext-v1 whenever it could not resolve the other person's key or the encryption threw. Real
// encryption here, and a small stand-in for the SQLite calls these paths make; device modules are stubbed at the
// boundary as in events-db.test.ts.

// ── the phone's database, as far as these paths use it ──────────────────────────────────────────────────────────────
const store = vi.hoisted(() => ({
    conversations: new Map<string, { id: string; type: string; created_by: string | null }>(),
    participants: new Map<string, Set<string>>(),
    messages: new Map<string, any>(),
    writes: [] as Array<{ sql: string; params: any[] }>,
}));
const partsOf = (id: string) => { if (!store.participants.has(id)) store.participants.set(id, new Set()); return store.participants.get(id)!; };
const mockDb = {
    execAsync: vi.fn(async () => undefined),
    closeAsync: vi.fn(async () => undefined),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
    getFirstAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (/FROM conversations WHERE id = \?/.test(sql)) return store.conversations.get(params[0]) ?? null;
        if (/SELECT author_pubkey FROM messages WHERE conversation_id = \?/.test(sql)) {
            return [...store.messages.values()].find(m => m.conversation_id === params[0] && m.author_pubkey !== params[1] && m.author_pubkey !== 'SYSTEM') ?? null;
        }
        if (/SELECT metadata FROM messages WHERE id/.test(sql)) return store.messages.get(params[0]) ?? null;
        return null;
    }),
    getAllAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (/SELECT public_key FROM conversation_participants WHERE conversation_id = \?/.test(sql)) {
            return [...partsOf(params[0])].map(public_key => ({ public_key }));
        }
        return [];
    }),
    runAsync: vi.fn(async (sql: string, params: any[] = []) => {
        store.writes.push({ sql, params });
        if (/^INSERT OR IGNORE INTO conversation_participants/.test(sql)) partsOf(params[0]).add(params[1]);
        else if (/^INSERT OR IGNORE INTO conversations/.test(sql)) {
            if (!store.conversations.has(params[0])) store.conversations.set(params[0], { id: params[0], type: params[1], created_by: params[4] ?? null });
        } else if (/^INSERT INTO messages/.test(sql)) {
            store.messages.set(params[0], { id: params[0], conversation_id: params[1], author_pubkey: params[2], ciphertext: params[3], nonce: params[4], metadata: params[5] });
        } else if (/^DELETE FROM messages WHERE id = \?/.test(sql)) store.messages.delete(params[0]);
        return { changes: 1 };
    }),
};

vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn().mockImplementation(() => Promise.resolve(mockDb)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
const who = vi.hoisted(() => ({ me: { publicKey: '', privateKey: '' } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...who.me, callsign: 'Me' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_test.db'), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { insertMessage, editMessage, sendImageMessage } from '../db';
import { decryptDM, isEncryptedNonce } from '../e2e-crypto';
import { DmNotLockedError, isDmNotLocked, dmNotLockedLine, restoredDraft } from '../dm-lock';

// A delivered send ends with require('react-native') for a DeviceEventEmitter nudge, which node cannot parse and no
// vi.mock reaches. Answered here, at node's loader, so a send that goes through finishes as it does on a phone.
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {} } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

function person() {
    const seed = ed25519.utils.randomSecretKey();
    return { seed, publicKey: bytesToHex(ed25519.getPublicKey(seed)) };
}
const me = person();
const peer = person();
const CONV = 'conv-1';

// ── the node ─────────────────────────────────────────────────────────────────────────────────────────────────────────
let nodeConversation: any = null;
const fetchMock = vi.fn();
function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
const calls = (method: string, path: string) => fetchMock.mock.calls.filter(([url, init]) =>
    String(url).startsWith(`https://test.beanpool.org${path}`) && (init?.method ?? 'GET') === method);
const sentBodies = (path: string) => calls('POST', path).map(([, init]) => JSON.parse(init.body));
const peerReads = (ciphertext: string, nonce: string) =>
    decryptDM(ciphertext, nonce, { myEdPrivHex: bytesToHex(peer.seed), peerEdPubHex: me.publicKey, conversationId: CONV });
const messageWrites = () => store.writes.filter(w => /^INSERT INTO messages|^UPDATE messages SET ciphertext/.test(w.sql));
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
/** Nothing readable anywhere: not in a write to the phone's database, not in anything sent to the node. */
function nothingReadable(words: string) {
    const everything = JSON.stringify(store.writes) + JSON.stringify(fetchMock.mock.calls);
    expect(everything).not.toContain('plaintext-v1');
    expect(everything).not.toContain(b64(words));
    expect(everything).not.toContain(words);
}

function dm(participants: string[], type = 'dm') {
    store.conversations.set(CONV, { id: CONV, type, created_by: me.publicKey });
    store.participants.set(CONV, new Set(participants));
}

beforeEach(() => {
    who.me = { publicKey: me.publicKey, privateKey: bytesToHex(me.seed) };   // the phone keeps the bare seed
    store.conversations.clear();
    store.participants.clear();
    store.messages.clear();
    store.writes.length = 0;
    nodeConversation = null;
    fetchMock.mockReset().mockImplementation(async (url: string, init: any = {}) => {
        const path = String(url).replace('https://test.beanpool.org', '');
        if ((init.method ?? 'GET') === 'GET' && path.startsWith(`/api/messages/${CONV}`)) {
            return nodeConversation ? reply(200, { conversation: nodeConversation, messages: [] }) : reply(404, { error: 'Conversation not found' });
        }
        if (init.method === 'POST' && path === '/api/messages/send') {
            const body = JSON.parse(init.body);
            return reply(200, { success: true, message: { id: body.id, timestamp: new Date().toISOString() } });
        }
        if (init.method === 'POST' && path === '/api/messages/edit') return reply(200, { success: true, message: { editedAt: new Date().toISOString() } });
        return reply(404, { error: 'not in this test' });
    });
    (globalThis as any).fetch = fetchMock;
});

describe('a DM line', () => {
    it('with the other person known: sent locked, only they read it, nothing readable anywhere', async () => {
        dm([me.publicKey, peer.publicKey]);
        await insertMessage(CONV, me.publicKey, 'meet at the gate at 6');
        await vi.waitFor(() => expect(calls('POST', '/api/messages/send')).toHaveLength(1));

        const [sent] = sentBodies('/api/messages/send');
        expect(isEncryptedNonce(sent.nonce)).toBe(true);
        expect(peerReads(sent.ciphertext, sent.nonce)).toBe('meet at the gate at 6');
        expect(messageWrites()[0].params[3]).toBe(sent.ciphertext);   // the bubble's own row holds the same ciphertext
        nothingReadable('meet at the gate at 6');
    });

    it('a phone holding a browser\'s PKCS8 key (a transfer code) locks too', async () => {
        who.me = { publicKey: me.publicKey, privateKey: bytesToHex(toEd25519Pkcs8(me.seed)) };
        dm([me.publicKey, peer.publicKey]);
        await insertMessage(CONV, me.publicKey, 'hello');
        await vi.waitFor(() => expect(calls('POST', '/api/messages/send')).toHaveLength(1));
        const [sent] = sentBodies('/api/messages/send');
        expect(peerReads(sent.ciphertext, sent.nonce)).toBe('hello');
    });

    it('no key for the other person: asks the node once, then nothing is written or sent', async () => {
        dm([me.publicKey]);
        nodeConversation = { id: CONV, type: 'dm', participants: [me.publicKey], createdBy: me.publicKey };

        await expect(insertMessage(CONV, me.publicKey, 'meet at the gate at 6')).rejects.toBeInstanceOf(DmNotLockedError);
        expect(calls('GET', `/api/messages/${CONV}`)).toHaveLength(1);
        expect(calls('POST', '/api/messages/send')).toHaveLength(0);
        expect(messageWrites()).toHaveLength(0);
        nothingReadable('meet at the gate at 6');
    });

    it('Send again once the node knows the other person: the retry writes them down, locks and sends', async () => {
        dm([me.publicKey]);
        nodeConversation = { id: CONV, type: 'dm', participants: [me.publicKey], createdBy: me.publicKey };
        await expect(insertMessage(CONV, me.publicKey, 'meet at 6')).rejects.toSatisfy(isDmNotLocked);

        nodeConversation = { ...nodeConversation, participants: [me.publicKey, peer.publicKey] };
        await insertMessage(CONV, me.publicKey, 'meet at 6');
        await vi.waitFor(() => expect(calls('POST', '/api/messages/send')).toHaveLength(1));
        expect(store.participants.get(CONV)?.has(peer.publicKey)).toBe(true);
        const [sent] = sentBodies('/api/messages/send');
        expect(peerReads(sent.ciphertext, sent.nonce)).toBe('meet at 6');
        nothingReadable('meet at 6');
    });

    it('a chat the phone hasn\'t stored yet (opened from a push) is fetched from the node and locked', async () => {
        nodeConversation = { id: CONV, type: 'dm', participants: [me.publicKey, peer.publicKey], createdBy: peer.publicKey };
        await insertMessage(CONV, me.publicKey, 'on my way');
        await vi.waitFor(() => expect(calls('POST', '/api/messages/send')).toHaveLength(1));
        const [sent] = sentBodies('/api/messages/send');
        expect(peerReads(sent.ciphertext, sent.nonce)).toBe('on my way');
    });

    it('and one the node doesn\'t know either is not sent', async () => {
        await expect(insertMessage(CONV, me.publicKey, 'on my way')).rejects.toBeInstanceOf(DmNotLockedError);
        expect(calls('POST', '/api/messages/send')).toHaveLength(0);
        nothingReadable('on my way');
    });

    it('the encryption throws (a peer key that is not a key): nothing is written or sent', async () => {
        dm([me.publicKey, 'system']);
        await expect(insertMessage(CONV, me.publicKey, 'hello admin')).rejects.toBeInstanceOf(DmNotLockedError);
        expect(calls('POST', '/api/messages/send')).toHaveLength(0);
        expect(messageWrites()).toHaveLength(0);
        nothingReadable('hello admin');
    });
});

describe('a resend of a failed bubble', () => {
    const FAILED = randomUUID();
    const failedRow = () => store.messages.set(FAILED, { id: FAILED, conversation_id: CONV, author_pubkey: me.publicKey, ciphertext: 'x', nonce: 'x25519-xc20p-v2:x', metadata: '{"__sendState":"failed"}' });

    it('that can\'t be locked leaves the failed bubble where it was', async () => {
        dm([me.publicKey]);
        failedRow();
        await expect(insertMessage(CONV, me.publicKey, 'hello', undefined, FAILED)).rejects.toBeInstanceOf(DmNotLockedError);
        expect(store.messages.has(FAILED)).toBe(true);
        expect(store.writes.some(w => /^DELETE FROM messages/.test(w.sql))).toBe(false);
    });

    it('that can replaces it under the same id, locked', async () => {
        dm([me.publicKey, peer.publicKey]);
        failedRow();
        await insertMessage(CONV, me.publicKey, 'hello', undefined, FAILED);
        await vi.waitFor(() => expect(calls('POST', '/api/messages/send')).toHaveLength(1));
        const [sent] = sentBodies('/api/messages/send');
        expect(sent.id).toBe(FAILED);
        expect(peerReads(sent.ciphertext, sent.nonce)).toBe('hello');
    });
});

describe('an edit follows the same rule', () => {
    it('no key: not sent, and the message on the phone is untouched', async () => {
        dm([me.publicKey]);
        await expect(editMessage(CONV, 'msg-1', 'actually 7')).rejects.toBeInstanceOf(DmNotLockedError);
        expect(calls('POST', '/api/messages/edit')).toHaveLength(0);
        expect(messageWrites()).toHaveLength(0);
        nothingReadable('actually 7');
    });

    it('with the key: the new words go locked', async () => {
        dm([me.publicKey, peer.publicKey]);
        await editMessage(CONV, 'msg-1', 'actually 7');
        const [sent] = sentBodies('/api/messages/edit');
        expect(peerReads(sent.ciphertext, sent.nonce)).toBe('actually 7');
        nothingReadable('actually 7');
    });
});

describe('a photo follows the same rule', () => {
    it('no key: neither the picture nor its caption goes', async () => {
        dm([me.publicKey]);
        await expect(sendImageMessage(CONV, 'data:image/jpeg;base64,/9j/4AAQ', 'the back fence')).rejects.toBeInstanceOf(DmNotLockedError);
        expect(calls('POST', '/api/messages/send')).toHaveLength(0);
        nothingReadable('the back fence');
    });
});

describe('a chat the node reads stays readable, as designed', () => {
    it('a group chat line through the old send path is plaintext-v1', async () => {
        dm([me.publicKey, peer.publicKey], 'group_thread');
        await insertMessage(CONV, me.publicKey, 'swap day on Saturday');
        await vi.waitFor(() => expect(calls('POST', '/api/messages/send')).toHaveLength(1));
        const [sent] = sentBodies('/api/messages/send');
        expect(sent.nonce).toBe('plaintext-v1');
        expect(Buffer.from(sent.ciphertext, 'base64').toString('utf8')).toBe('swap day on Saturday');
    });

    it('a group chat the phone hasn\'t stored yet (opened from a push) goes on the first Send, as plaintext-v1', async () => {
        nodeConversation = { id: CONV, type: 'group_thread', participants: [me.publicKey, peer.publicKey], createdBy: peer.publicKey };
        await insertMessage(CONV, me.publicKey, 'see you at the garden');
        await vi.waitFor(() => expect(calls('POST', '/api/messages/send')).toHaveLength(1));
        const [sent] = sentBodies('/api/messages/send');
        expect(sent.nonce).toBe('plaintext-v1');
        expect(Buffer.from(sent.ciphertext, 'base64').toString('utf8')).toBe('see you at the garden');
    });
});

describe('what the member is told', () => {
    it('one plain line, naming the other person when the chat knows them', () => {
        expect(dmNotLockedLine('Bob')).toBe("This message couldn't be locked for Bob yet, so it wasn't sent. Try again in a moment.");
        expect(dmNotLockedLine(null)).toContain('for the other person yet');
        expect(dmNotLockedLine('Loading...')).toContain('for the other person yet');
    });

    it('the unsent words go back in the box, with anything typed since under them', () => {
        expect(restoredDraft('meet at 6', '')).toBe('meet at 6');
        expect(restoredDraft('meet at 6', '  and bring gloves ')).toBe('meet at 6\nand bring gloves');
    });

    it('a DmNotLockedError is recognised after a timeout race hands it back', () => {
        expect(isDmNotLocked(new DmNotLockedError())).toBe(true);
        expect(isDmNotLocked(Object.assign(new Error('x'), { name: 'DmNotLockedError' }))).toBe(true);
        expect(isDmNotLocked(new Error('Sending is taking too long'))).toBe(false);
    });
});
