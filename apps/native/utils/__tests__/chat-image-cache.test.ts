import { describe, it, expect, vi, beforeEach } from 'vitest';

// "Delete for everyone" on a photo has to take the DECRYPTED copy with it, on both phones.
// getDecryptedAttachment writes the plaintext JPEG to ${cacheDirectory}chat-images/${messageId}.jpg, and the
// bubble only stops DRAWING it when the row becomes a tombstone — the file itself outlived the message.
// Device modules are stubbed at the boundary as in events-db.test.ts.

const mockRunAsync = vi.fn().mockResolvedValue({ changes: 1 });
const mockGetAllAsync = vi.fn().mockResolvedValue([]);
const mockGetFirstAsync = vi.fn().mockResolvedValue(null);
const mockDb = {
    runAsync: mockRunAsync,
    execAsync: vi.fn().mockResolvedValue(undefined),
    getAllAsync: mockGetAllAsync,
    getFirstAsync: mockGetFirstAsync,
    closeAsync: vi.fn().mockResolvedValue(undefined),
    withTransactionAsync: vi.fn().mockImplementation(async (cb: () => Promise<void>) => { await cb(); }),
};

const mockDeleteAsync = vi.fn().mockResolvedValue(undefined);

vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn().mockImplementation(() => Promise.resolve(mockDb)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
    // Read at call time, not when the factory runs: vi.mock is hoisted above the const above.
    deleteAsync: (...args: any[]) => mockDeleteAsync(...args),
}));
vi.mock('../identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'me-pub', privateKey: 'aa', callsign: 'Me' })),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_test.db'), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
    signData: vi.fn(async (msg: Uint8Array) => msg),
}));

import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as FileSystem from 'expo-file-system/legacy';
import { makeGroupEpochRecord } from '@beanpool/core';
import { deleteMessageApi, syncSingleConversation, getGroupChat, leaveGroupApi } from '../db';
import { groupPhotoCache } from '../group-photo-cache';
import { getDecryptedGroupAttachment } from '../group-chat-lines';
import { groupKeyring, memoryGroupKeyStore } from '../group-chat-keys';
import { groupLineView } from '../group-line-display';
import { openLine, sealLine } from '../group-chat-crypto';

// syncSingleConversation ends with a require('react-native') to emit a DeviceEventEmitter nudge, which node
// cannot parse. That is AFTER the upsert, and syncSingleConversation swallows it — so each sync test below
// also asserts the INSERT really ran, rather than trusting that it got that far.

const CACHED_JPEG = (id: string) => `/tmp/cache/chat-images/${id}.jpg`;

const fetchMock = vi.fn();
function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    mockRunAsync.mockClear();
    mockGetAllAsync.mockReset().mockResolvedValue([]);
    mockGetFirstAsync.mockReset().mockResolvedValue(null);
    mockDeleteAsync.mockClear();
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

describe('a deleted photo leaves no decrypted copy behind', () => {
    it('removes the cached JPEG on the deleter\'s phone', async () => {
        // The author's own row, an image, as the local mirror in deleteMessageApi reads it.
        mockGetFirstAsync.mockResolvedValue({ metadata: null, author_pubkey: 'me-pub' });
        fetchMock.mockResolvedValue(reply(200, {
            message: { ciphertext: 'dGhpcw==', metadata: { removedBy: 'me-pub', removedAt: '2026-09-23T04:00:00Z' } },
        }));

        await deleteMessageApi('img-1');

        expect(mockDeleteAsync).toHaveBeenCalledWith(CACHED_JPEG('img-1'), { idempotent: true });
    });

    it('still removes it when there is no local row to mirror the tombstone into', async () => {
        // A group chat keeps no local message row, and its image was decrypted into the same cache.
        mockGetFirstAsync.mockResolvedValue(null);
        fetchMock.mockResolvedValue(reply(200, { message: { ciphertext: 'dGhpcw==' } }));

        await deleteMessageApi('img-2');

        expect(mockDeleteAsync).toHaveBeenCalledWith(CACHED_JPEG('img-2'), { idempotent: true });
    });

    it('removes it on the PEER\'s phone when the tombstone arrives in a sync', async () => {
        // The local row is still the image; the node's copy is the tombstone the other end just made.
        mockGetAllAsync.mockImplementation(async (sql: string) => {
            if (sql.includes('FROM messages')) {
                return [{ id: 'img-3', metadata: null, edited_at: null, type: 'image' }];
            }
            return [];
        });
        mockGetFirstAsync.mockResolvedValue({
            ciphertext: 'b2xkLWJsb2I=', nonce: 'n1', type: 'image', edited_at: null, metadata: null,
        });
        fetchMock.mockResolvedValue(reply(200, {
            conversation: { id: 'conv-1' },
            messages: [{
                id: 'img-3', type: 'removed', ciphertext: 'dGhpcw==', nonce: 'plaintext-v1',
                metadata: JSON.stringify({ removed: true, removedBy: 'them-pub' }),
                timestamp: '2026-09-23T04:00:00Z',
            }],
        }));

        await syncSingleConversation('conv-1');

        const inserted = mockRunAsync.mock.calls.find(
            ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO messages'),
        );
        expect(inserted).toBeTruthy();
        expect(inserted![1]).toContain('removed');
        expect(mockDeleteAsync).toHaveBeenCalledWith(CACHED_JPEG('img-3'), { idempotent: true });
    });

    it('leaves the cache alone for an ordinary incoming message', async () => {
        mockGetAllAsync.mockImplementation(async (sql: string) => {
            if (sql.includes('FROM messages')) return [];
            return [];
        });
        mockGetFirstAsync.mockResolvedValue(null);
        fetchMock.mockResolvedValue(reply(200, {
            conversation: { id: 'conv-2' },
            messages: [{ id: 'txt-1', type: 'text', ciphertext: 'aGk=', nonce: 'n1', timestamp: '2026-09-23T04:00:00Z' }],
        }));

        await syncSingleConversation('conv-2');

        // The message really did land — otherwise "the cache was left alone" would prove nothing.
        const inserted = mockRunAsync.mock.calls.find(
            ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO messages'),
        );
        expect(inserted).toBeTruthy();
        expect(inserted![1]).toContain('txt-1');
        expect(mockDeleteAsync).not.toHaveBeenCalled();
    });
});

// A group chat's photo (DESIGN-group-chat-photos-fable.md §2.3, §2.4): opened only under its line's words, kept by its
// message id in its group's own folder, and that folder cleared when the node refuses this phone the chat (a removed
// member, a leaver) once the phone has held the group's keys.
describe('a group chat\'s photos: kept by message id in the group\'s own folder, and cleared when the node refuses the chat', () => {
    const seed = ed25519.utils.randomSecretKey();
    const me = { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed), callsign: 'Me', createdAt: new Date().toISOString() };
    const NODE = 'https://test.beanpool.org';
    const PHOTO_B64 = Buffer.from('a decrypted jpeg').toString('base64');
    const PHOTO = `data:image/jpeg;base64,${PHOTO_B64}`;

    /** A group whose epoch-1 key this phone holds (a record I made), and one photo line I sealed in it: what a chat shows. */
    async function photoLine() {
        const g = randomUUID();
        const store = memoryGroupKeyStore();
        const { record } = makeGroupEpochRecord({ myEdPrivHex: me.privateKey, groupId: g, epoch: 1, reason: 'start', subject: null, createdAt: new Date().toISOString(), recipients: [me.publicKey] });
        const mine = record.wraps!.find((w) => w.recipient === me.publicKey)!;
        const { wraps: _all, ...served } = record;
        await store.putEpochs(`${me.publicKey}/${g}`, [{ epoch: 1, record: served as any, wrap: { epoch: 1, wrapper: me.publicKey, ephPub: mine.ephPub, nonce: mine.nonce, wrapped: mine.wrapped, sig: null } as any }]);
        const ring = groupKeyring(NODE, me, g, store);
        const key = (await ring.keyFor(1))!;
        const id = randomUUID();
        const bind = { myEdPrivHex: me.privateKey, groupKey: key, groupId: g, epoch: 1, messageId: id };
        const caption = sealLine('a caption', bind);
        const photo = sealLine(PHOTO, { ...bind, part: 'attachment' });
        const line = { id, authorPubkey: me.publicKey, ciphertext: caption.ciphertext, nonce: caption.nonce, metadata: { epoch: 1, sender: me.publicKey }, type: 'image' };
        const view = groupLineView(line, { groupId: g, fromEpoch: 1, keyFor: (e) => ring.openedKey(e), open: openLine, roster: [{ memberPubkey: me.publicKey, callsign: 'Me' }] });
        return { g, id, store, line, view, photo };
    }

    it('opened once: fetched, then kept as chat-images/groups/<group>/<message id>.jpg; the next view reads that file and fetches nothing', async () => {
        const { g, id, store, line, view, photo } = await photoLine();
        expect([view.signer, view.text]).toEqual([me.publicKey, 'a caption']);
        fetchMock.mockImplementation(async (url: string) => (String(url) === `${NODE}/api/messages/${id}/attachment`
            ? reply(200, { data: photo.ciphertext, nonce: photo.nonce, mime: 'image/jpeg' }) : reply(404, {})));
        const file = `/tmp/cache/chat-images/groups/${g}/${id}.jpg`;
        vi.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({ exists: false } as any);
        const first = await getDecryptedGroupAttachment(NODE, me, store, { groupId: g, line, view }, groupPhotoCache);
        expect(first).toBe(file);
        expect(vi.mocked(FileSystem.writeAsStringAsync)).toHaveBeenCalledWith(file, PHOTO_B64, { encoding: 'base64' });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        vi.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({ exists: true } as any);
        expect(await getDecryptedGroupAttachment(NODE, me, store, { groupId: g, line, view }, groupPhotoCache)).toBe(file);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a photo that opened but can\'t be kept (a full disk) draws from memory this once, and leaves no part of a file under its name', async () => {
        // Review of #2456: the write's failure answered "Image unavailable" for a photo already opened, and Android's
        // in-place write can leave a cut-off file that the next view would read as kept.
        const { g, id, store, line, view, photo } = await photoLine();
        fetchMock.mockImplementation(async (url: string) => (String(url) === `${NODE}/api/messages/${id}/attachment`
            ? reply(200, { data: photo.ciphertext, nonce: photo.nonce, mime: 'image/jpeg' }) : reply(404, {})));
        const file = `/tmp/cache/chat-images/groups/${g}/${id}.jpg`;
        vi.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({ exists: false } as any);
        vi.mocked(FileSystem.writeAsStringAsync).mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
        expect(await getDecryptedGroupAttachment(NODE, me, store, { groupId: g, line, view }, groupPhotoCache)).toBe(PHOTO);
        expect(mockDeleteAsync.mock.calls).toEqual([[file, { idempotent: true }]]);
    });

    it('a 403 from the chat of a group this phone held keys of clears that group\'s folder, and only on a refusal', async () => {
        const held = randomUUID();
        const never = randomUUID();
        // The phone's key memory: `held` has a highest epoch (group_chat_key_state), `never` has none.
        mockGetFirstAsync.mockImplementation(async (sql: string, params: any[] = []) => (
            /FROM group_chat_key_state/.test(sql) && String(params[0]).endsWith(`/${held}`) ? { highest: 2, after: 2 } : null));
        fetchMock.mockResolvedValue(reply(403, { error: 'Only members of this group can open its chat' }));
        await expect(getGroupChat(held)).rejects.toMatchObject({ status: 403 });
        await expect(getGroupChat(never)).rejects.toMatchObject({ status: 403 });
        fetchMock.mockResolvedValue(reply(500, { error: 'busy' }));
        await expect(getGroupChat(held)).rejects.toMatchObject({ status: 500 });
        expect(mockDeleteAsync.mock.calls).toEqual([[`/tmp/cache/chat-images/groups/${held}/`, { idempotent: true }]]);
    });

    it('leaving the group clears its folder; a leave the node refused clears nothing', async () => {
        const g = randomUUID();
        fetchMock.mockResolvedValue(reply(500, { error: 'busy' }));
        await leaveGroupApi(g, 'me-pub').catch(() => null);
        expect(mockDeleteAsync).not.toHaveBeenCalled();
        fetchMock.mockResolvedValue(reply(200, { success: true }));
        expect(await leaveGroupApi(g, 'me-pub')).toBe(true);
        expect(mockDeleteAsync.mock.calls).toEqual([[`/tmp/cache/chat-images/groups/${g}/`, { idempotent: true }]]);
    });

    it('a line the node now serves as removed takes its kept photo with it', async () => {
        const g = randomUUID();
        const id = randomUUID();
        fetchMock.mockResolvedValue(reply(200, {
            messages: [{ id, type: 'removed', authorPubkey: me.publicKey, ciphertext: '', nonce: 'plaintext-v1', metadata: { removed: true } }],
            encryption: { current: 1, stale: false, fromEpoch: 1 },
        }));
        await getGroupChat(g);
        expect(mockDeleteAsync).toHaveBeenCalledWith(`/tmp/cache/chat-images/groups/${g}/${id}.jpg`, { idempotent: true });
    });

    it('an id that is not a plain id never names a file: nothing is kept or cleared outside the folder', async () => {
        vi.mocked(FileSystem.writeAsStringAsync).mockClear();
        expect(await groupPhotoCache.get('../..', randomUUID())).toBeNull();
        expect(await groupPhotoCache.put(randomUUID(), '../../escape', PHOTO)).toBe(PHOTO);
        expect(vi.mocked(FileSystem.writeAsStringAsync)).not.toHaveBeenCalled();
    });
});
