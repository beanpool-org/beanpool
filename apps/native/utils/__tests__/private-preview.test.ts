/**
 * A node in a private preview (server config/private-preview.ts): the phone reads the flag from /api/community/info and
 * shows the server's own sentence when a join is refused, never the generic "door closed".
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn(), dismissAuthSession: vi.fn(), dismissBrowser: vi.fn(async () => undefined) }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: vi.fn(async () => false), signInAsync: vi.fn(), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)), digest: vi.fn(), CryptoDigestAlgorithm: { SHA256: 'SHA-256' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) } }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined) }));
import { readNodeProfile, privatePreviewOn, checkGlobalDoor, GLOBAL_DOOR_MESSAGES, GLOBAL_NODE_URL } from '../node-profile';
import { readDoorAnswer, readWordsDoorAnswer, PRIVATE_PREVIEW_MESSAGE } from '../global-join';

const SENTENCE = 'This community is in a private preview. Ask its owner for an invite.';

describe('private preview', () => {
    it('reads the flag from the info, and a node that says nothing is not in one', () => {
        const on = readNodeProfile({ profile: 'global', features: { openJoin: false, wordsDoor: false, invites: true, privatePreview: true } });
        expect(privatePreviewOn(on?.features)).toBe(true);
        const off = readNodeProfile({ profile: 'global', features: { openJoin: true, wordsDoor: true, invites: false } });
        expect(privatePreviewOn(off?.features)).toBe(false);
        expect(privatePreviewOn(null)).toBe(false);
    });

    it('a refused join shows the server\'s sentence as-is, at either door', () => {
        const body = { error: SENTENCE, code: 'private_preview' };
        expect(readDoorAnswer(403, body)).toEqual({ kind: 'door_closed', message: SENTENCE });
        expect(readWordsDoorAnswer(403, body)).toEqual({ kind: 'door_closed', message: SENTENCE });
        expect(readDoorAnswer(403, { code: 'private_preview' })).toEqual({ kind: 'door_closed', message: PRIVATE_PREVIEW_MESSAGE });
    });

    it('the door is not offered in a preview, and the welcome screens say the node\'s sentence (even with the door switch on)', async () => {
        const info = { profile: 'global', features: { beans: false, openJoin: true, wordsDoor: true, invites: true, privatePreview: true } };
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => info }) as unknown as Response);
        await expect(checkGlobalDoor(GLOBAL_NODE_URL, fetchImpl)).resolves.toEqual({ ok: false, reason: 'private_preview' });
        expect(GLOBAL_DOOR_MESSAGES.private_preview).toBe(SENTENCE);
        expect(PRIVATE_PREVIEW_MESSAGE).toBe(SENTENCE);
    });
});
