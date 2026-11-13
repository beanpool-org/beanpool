/**
 * A voice message is sent once, however many times Send is pressed for one recording (utils/db.ts sendVoiceMessage,
 * postGroupChatVoice; PR #3112 review, round 2, db.ts:7448 and :7490).
 *
 * The recorder keeps a recording after any failure so Send can try again, including the screens' 60 s timeout. A plain race
 * stopped waiting while the POST carried on and could still land, and each try made a new line id, so the node's duplicate
 * guard (engine/messaging.ts and engine/group-thread.ts: a line already stored under this id is answered again, nothing new
 * stored) couldn't match the retry to the first copy: the other person got the voice message twice. And in a DM the first
 * try's late answer ran on to its local INSERT, so the line showed while the recorder said it wasn't sent.
 *
 * Now: one line id per recording, passed in on every try; the local row is written only if it isn't there; and a send the
 * caller gave up on (utils/voice-recorder.ts voiceSendWithin) aborts its POST and writes nothing here after a late answer.
 *
 * Real sealing and the real db.ts, with a small stand-in for the SQLite calls these paths make and a node that keeps lines by
 * id as the real one does; device modules are stubbed at the boundary as in dm-never-plaintext.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { VOICE_BARS, type VoiceInput } from '@beanpool/core';

// ── the phone's database, as far as these paths use it ──────────────────────────────────────────────────────────────
const store = vi.hoisted(() => ({
    conversations: new Map<string, { id: string; type: string; created_by: string | null }>(),
    participants: new Map<string, Set<string>>(),
    messages: new Map<string, any>(),
    files: new Map<string, string>(),
}));
const partsOf = (id: string) => { if (!store.participants.has(id)) store.participants.set(id, new Set()); return store.participants.get(id)!; };
const mockDb = {
    execAsync: vi.fn(async () => undefined),
    closeAsync: vi.fn(async () => undefined),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
    getFirstAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (/SELECT id FROM conversations WHERE id IN \(/.test(sql)) {
            return params.map((p) => store.conversations.get(p)).find((c) => c?.type === 'dm') ?? null;
        }
        if (/FROM conversations WHERE id = \? COLLATE NOCASE AND type = 'dm'/.test(sql)) {
            return [...store.conversations.values()].find((c) => c.id.toLowerCase() === String(params[0]).toLowerCase() && c.type === 'dm') ?? null;
        }
        if (/FROM conversations WHERE id = \?/.test(sql)) return store.conversations.get(params[0]) ?? null;
        if (/FROM messages WHERE id = \?/.test(sql)) return store.messages.get(params[0]) ?? null;
        return null;
    }),
    getAllAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (/SELECT id FROM conversations WHERE id = \? COLLATE NOCASE/.test(sql)) {
            return [...store.conversations.values()].filter((c) => c.id.toLowerCase() === String(params[0]).toLowerCase()).map((c) => ({ id: c.id }));
        }
        if (/SELECT public_key FROM conversation_participants WHERE conversation_id = \?/.test(sql)) return [...partsOf(params[0])].map(public_key => ({ public_key }));
        return [];
    }),
    runAsync: vi.fn(async (sql: string, params: any[] = []) => {
        const row = () => ({ id: params[0], conversation_id: params[1], author_pubkey: params[2], ciphertext: params[3], nonce: params[4], type: params[5], metadata: params[6], timestamp: params[7] });
        if (/^INSERT OR IGNORE INTO conversation_participants/.test(sql)) partsOf(params[0]).add(params[1]);
        else if (/^INSERT OR IGNORE INTO messages/.test(sql)) { if (!store.messages.has(params[0])) store.messages.set(params[0], row()); }
        else if (/^INSERT INTO messages/.test(sql)) {
            // SQLite's PRIMARY KEY: a second row under one id is refused.
            if (store.messages.has(params[0])) throw new Error('UNIQUE constraint failed: messages.id');
            store.messages.set(params[0], row());
        }
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
// The phone's own copy of a voice message (utils/voice-cache.ts): what was kept, by file.
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    documentDirectory: '/tmp/doc/',
    EncodingType: { Base64: 'base64' },
    getInfoAsync: vi.fn(async (uri: string) => ({ exists: store.files.has(uri), size: 0 })),
    makeDirectoryAsync: vi.fn(async () => undefined),
    writeAsStringAsync: vi.fn(async (uri: string, data: string) => { store.files.set(uri, data); }),
    readAsStringAsync: vi.fn(async (uri: string) => store.files.get(uri) ?? ''),
    readDirectoryAsync: vi.fn(async () => []),
    deleteAsync: vi.fn(async (uri: string) => { store.files.delete(uri); }),
}));
const who = vi.hoisted(() => ({ me: { publicKey: '', privateKey: '' } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...who.me, callsign: 'Me' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_test.db'), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));
// A group's sealed-line path (utils/group-chat-lines.ts), as the node answers it: a line stored under its clientId is
// answered again, nothing new stored (engine/group-thread.ts). Its sealing is group-chat-e2e.test.ts's.
const groupNode = vi.hoisted(() => ({ lines: new Map<string, { id: string }>(), asked: [] as any[], hold: null as null | Promise<void> }));
vi.mock('../group-chat-lines', async (orig) => ({
    ...(await orig<any>()),
    sendSealedGroupLine: vi.fn(async (_url: string, _identity: unknown, _store: unknown, input: any) => {
        groupNode.asked.push(input);
        if (!groupNode.lines.has(input.clientId)) groupNode.lines.set(input.clientId, { id: input.clientId });
        if (groupNode.hold) await groupNode.hold;
        return { success: true, message: groupNode.lines.get(input.clientId) };
    }),
}));
vi.mock('../group-chat-keys', async (orig) => ({
    ...(await orig<any>()),
    // The group this phone has seen locked (no DM check stands in its way); the DM was never a group here.
    groupKeyring: vi.fn((_url: string, _identity: unknown, groupId: string) => ({ groupId, seenLocked: async () => groupId !== 'conv-1' })),
}));

import { sendVoiceMessage, postGroupChatVoice, _resetDmPeerPinsForTests } from '../db';
import { voiceSendWithin } from '../voice-recorder';

// A delivered send ends with require('react-native') for a DeviceEventEmitter nudge, which node cannot parse and no
// vi.mock reaches. Answered here, at node's loader.
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
const LINE = '5d3c1b2a-9e8f-4a7b-8c6d-1e2f3a4b5c6d';
const GROUP = 'b78da72e-773f-4425-914a-8bfbd4e4130a';
const m4a = (n: number) => {
    const s = new Uint8Array(n);
    s.set([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0, 0x4d, 0x34, 0x41, 0x20]);
    return s;
};
const voice: VoiceInput = { durationMs: 4200, bars: Array.from({ length: VOICE_BARS }, (_, i) => i * 5), sound: m4a(400) };

// ── the node: its stored lines by id, as engine/messaging.ts keeps them ────────────────────────────────────────────────
const node = { lines: new Map<string, any>(), posts: 0, hold: null as null | Promise<void>, signals: [] as unknown[] };
function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const path = String(url).replace('https://test.beanpool.org', '');
    if (init.method === 'POST' && path === '/api/messages/send') {
        node.posts += 1;
        node.signals.push(init.signal);
        const body = JSON.parse(init.body);
        // Stored as it comes, or answered with the line already stored under this id (nothing new stored).
        if (!node.lines.has(body.id)) {
            node.lines.set(body.id, { id: body.id, ciphertext: body.ciphertext, nonce: body.nonce, type: body.type, metadata: body.metadata ?? null, timestamp: new Date().toISOString() });
        }
        // The answer is slow to come back (a slow link): the node has already stored the line.
        if (node.hold) await node.hold;
        return reply(200, { success: true, message: node.lines.get(body.id) });
    }
    return reply(404, { error: 'not in this test' });
});
const keptVoices = () => [...store.files.keys()].filter((f) => f.startsWith('/tmp/doc/voice/') && f.endsWith('.m4a'));

beforeEach(() => {
    who.me = { publicKey: me.publicKey, privateKey: bytesToHex(me.seed) };
    _resetDmPeerPinsForTests();
    store.conversations.clear();
    store.participants.clear();
    store.messages.clear();
    store.files.clear();
    store.conversations.set(CONV, { id: CONV, type: 'dm', created_by: me.publicKey });
    store.participants.set(CONV, new Set([me.publicKey, peer.publicKey]));
    node.lines.clear();
    node.posts = 0;
    node.hold = null;
    node.signals.length = 0;
    groupNode.lines.clear();
    groupNode.asked.length = 0;
    groupNode.hold = null;
    fetchMock.mockClear();
    (globalThis as any).fetch = fetchMock;
});

describe('a direct chat\'s voice message, sent twice for one recording, is one line (PR #3112 review, round 2: db.ts:7448)', () => {
    it('the same line id on both tries: the node answers the first, and the phone holds one row', async () => {
        await sendVoiceMessage(CONV, voice, undefined, { messageId: LINE });
        await sendVoiceMessage(CONV, voice, undefined, { messageId: LINE });
        expect(node.posts).toBe(2);
        expect([...node.lines.keys()]).toEqual([LINE]);
        expect([...store.messages.keys()]).toEqual([LINE]);
        // The row holds the line the node stored (its seal), not the retry's.
        expect(store.messages.get(LINE).ciphertext).toBe(node.lines.get(LINE).ciphertext);
        expect(keptVoices()).toHaveLength(1);
    });

    it('a retry after the 60 s timeout: the first try\'s late answer writes nothing while the recorder says not sent; Send again is the one line', async () => {
        let answer!: () => void;
        node.hold = new Promise<void>((r) => { answer = r; });
        // The screen's give-up, shortened: the node has stored the line, its answer hasn't come back.
        const first = voiceSendWithin(30, 'Sending the voice message is taking too long — please try again.',
            (signal) => sendVoiceMessage(CONV, voice, undefined, { messageId: LINE, signal }));
        await expect(first).rejects.toThrow('taking too long');
        // The POST was given the signal, and it is aborted: a real fetch stops here.
        expect((node.signals[0] as AbortSignal).aborted).toBe(true);
        // The late answer comes back (a fetch that ignored the abort): nothing is written on this phone.
        node.hold = null;
        answer();
        await vi.waitFor(() => expect(node.lines.size).toBe(1));
        await new Promise((r) => setTimeout(r, 20));
        expect(store.messages.size).toBe(0);
        expect(keptVoices()).toHaveLength(0);
        // Send again: the node answers the line it stored. One line there, one row here.
        await sendVoiceMessage(CONV, voice, undefined, { messageId: LINE });
        expect([...node.lines.keys()]).toEqual([LINE]);
        expect([...store.messages.keys()]).toEqual([LINE]);
        expect(keptVoices()).toHaveLength(1);
    });

    it('a row already on this phone (a sync brought the first copy): the second try still goes as sent, one row', async () => {
        await sendVoiceMessage(CONV, voice, undefined, { messageId: LINE });
        await expect(sendVoiceMessage(CONV, voice, undefined, { messageId: LINE })).resolves.toBeUndefined();
        expect(store.messages.size).toBe(1);
    });
});

describe('a group\'s voice message, sent twice for one recording, is one line (PR #3112 review, round 2: db.ts:7490)', () => {
    it('the same clientId on both tries: one line on the node, one copy kept', async () => {
        await postGroupChatVoice(GROUP, { voice, clientId: LINE });
        await postGroupChatVoice(GROUP, { voice, clientId: LINE });
        expect(groupNode.asked.map((a) => a.clientId)).toEqual([LINE, LINE]);
        expect(groupNode.lines.size).toBe(1);
        expect(keptVoices()).toHaveLength(1);
    });

    it('a try given up at 60 s whose answer comes late keeps nothing here; Send again is the one line', async () => {
        let answer!: () => void;
        groupNode.hold = new Promise<void>((r) => { answer = r; });
        const first = voiceSendWithin(30, 'Sending the voice message is taking too long — please try again.',
            (signal) => postGroupChatVoice(GROUP, { voice, clientId: LINE, signal }));
        await expect(first).rejects.toThrow('taking too long');
        expect((groupNode.asked[0].signal as AbortSignal).aborted).toBe(true);
        groupNode.hold = null;
        answer();
        await new Promise((r) => setTimeout(r, 20));
        expect(keptVoices()).toHaveLength(0);
        await postGroupChatVoice(GROUP, { voice, clientId: LINE });
        expect(groupNode.lines.size).toBe(1);
        expect(keptVoices()).toHaveLength(1);
    });
});
