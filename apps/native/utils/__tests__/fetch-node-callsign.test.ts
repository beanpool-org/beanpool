/**
 * The name a restore asks its community for (utils/db.ts fetchNodeCallsign, the restore's `nameOnNode`).
 *
 * A community names a key only to that key's own signer (apps/server routes/community.ts, the membership probe: the
 * global node since G9a, every local community since 2026-10-01). A restore asks before the key is saved on the phone,
 * so the phone's signing wrapper (node-request-signing.ts) has no key to sign with: the restore signs the question
 * itself, with the key it restored. Asked unsigned, the community would answer no name, and the account would come up
 * nameless until its first sync.
 *
 * Nothing here contacts a node: fetch is a stub that records what would have been sent, and the signature is checked
 * as the node checks it (server-signature-check.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// db.ts pulls in device modules at import time; stub them at the boundary (as check-invite-ticket.test.ts does), and
// keep the real signing.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { randomUUID: () => 'test-uuid', getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));

import { fetchNodeCallsign } from '../db';
import { mnemonicToKeypair } from '../crypto';
import { boundSignatureValid } from './server-signature-check';

// Test phrase only (a BIP-39 vector), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const NODE = 'https://castlemaine.beanpool.org';

const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function reply(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("a restore asks its community for the account's name, signed by the key it restored", () => {
    it('asks the membership probe, signed so the node accepts it as that key, and takes the name it answers', async () => {
        const { publicKeyHex, privateKeyHex } = await mnemonicToKeypair(WORDS);
        fetchMock.mockResolvedValueOnce(reply(200, { isMember: true, callsign: 'Marty' }));

        expect(await fetchNodeCallsign(NODE, publicKeyHex, privateKeyHex)).toBe('Marty');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${NODE}/api/community/membership/${publicKeyHex}`);
        expect(boundSignatureValid({ url, method: 'GET', headers: init.headers, body: '' }, publicKeyHex)).toBe(true);
    });

    it('a community that answers no name (asked by anyone else, or the key is no member) leaves it empty', async () => {
        const { publicKeyHex, privateKeyHex } = await mnemonicToKeypair(WORDS);
        fetchMock.mockResolvedValueOnce(reply(200, { isMember: true, callsign: null }));
        expect(await fetchNodeCallsign(NODE, publicKeyHex, privateKeyHex)).toBeNull();

        fetchMock.mockResolvedValueOnce(reply(403, { error: 'This key was replaced by a new one' }));
        expect(await fetchNodeCallsign(NODE, publicKeyHex, privateKeyHex)).toBeNull();
    });
});
