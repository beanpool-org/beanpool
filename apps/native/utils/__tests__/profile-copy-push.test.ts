/**
 * Copy on request (Profile S4): what reaches the community a copy was asked for.
 *
 * A copy is kept for the community the member chose (pending-profile-sync.ts keepPendingProfileChange, `copy`), and goes the next
 * time the phone is on that community: pillar-sync's retry, which is db.ts pushProfileToServer. The real publisher is driven here
 * with a mocked SQLite and a recorded fetch. What the member ticked is all that goes: not the bio, not the contact, not the
 * working style the community's own row happens to hold, and no name when only the photo was ticked. An ordinary change waiting
 * for a community (an offline Save) still carries the row's bio and contact, as it always did.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
    const runAsync = vi.fn();
    const getFirstAsync = vi.fn();
    return {
        runAsync,
        getFirstAsync,
        db: { runAsync, getFirstAsync, execAsync: vi.fn(), getAllAsync: vi.fn(), closeAsync: vi.fn(), withTransactionAsync: vi.fn() },
        asyncStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), getAllKeys: vi.fn() },
        loadIdentity: vi.fn(),
        getCanonicalProfile: vi.fn(),
        saveCanonicalProfile: vi.fn(),
        buildSignedHeaders: vi.fn(),
        archetypeToSend: vi.fn(),
        emit: vi.fn(),
    };
});

vi.mock('../app-events', () => ({ emitAppEvent: h.emit }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: () => Promise.resolve(h.db) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: h.asyncStorage }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../identity', () => ({ loadIdentity: h.loadIdentity }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: () => 'beanpool_test.db',
    addSavedNode: vi.fn().mockResolvedValue(undefined),
    clearGuestNode: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: h.getCanonicalProfile, saveCanonicalProfile: h.saveCanonicalProfile }));
vi.mock('../crypto', () => ({ buildSignedHeaders: h.buildSignedHeaders }));
// The working style a community would be sent: the same answer for every entry, so the test can tell who asks for it.
vi.mock('../working-style', async (importOriginal) => ({ ...(await importOriginal<typeof import('../working-style')>()), archetypeToSend: h.archetypeToSend }));

const SELF_PK = 'rosa'.repeat(16);
const HERE = 'https://second.example.test';
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const OWN_OFFLINE_PICK = 'data:image/jpeg;base64,/9j/OWNPICK==';
const NODE_URL = `/api/avatar/${SELF_PK}?size=thumb&v=e3733e23`;

import { pushProfileToServer } from '../db';
import { keepPendingProfileChange, pendingProfileChange } from '../pending-profile-sync';

let row: any;
let store: Record<string, string>;
let sent: Array<{ url: string; body: any }>;

/** The answer the community gives to an update; the stored photo is echoed when one was sent. */
let answer: (body: any) => { ok: boolean; status?: number; json: () => Promise<any> };

beforeEach(() => {
    vi.clearAllMocks();
    // This community's own row for the member: it holds a bio, a contact and a working style of its own, none of them part of a copy.
    row = {
        public_key: SELF_PK, callsign: 'Rosa Second', avatar_url: NODE_URL,
        bio: 'Grows beans on the corner', contact_value: 'rosa@example.test', contact_visibility: 'friends', archetype: 'gardener',
    };
    store = { beanpool_anchor_url: HERE };
    sent = [];
    h.loadIdentity.mockResolvedValue({ publicKey: SELF_PK, callsign: 'Rosa', privateKey: 'k' });
    h.getCanonicalProfile.mockResolvedValue(null);
    h.buildSignedHeaders.mockResolvedValue({ 'Content-Type': 'application/json' });
    h.archetypeToSend.mockResolvedValue('quiz-result');
    h.db.withTransactionAsync.mockImplementation(async (cb: () => Promise<void>) => { await cb(); });
    h.db.getAllAsync.mockResolvedValue([]);
    h.getFirstAsync.mockImplementation(async () => row);
    h.runAsync.mockResolvedValue({ changes: 1 });
    h.asyncStorage.getItem.mockImplementation(async (k: string) => store[k] ?? null);
    h.asyncStorage.setItem.mockImplementation(async (k: string, v: string) => { store[k] = v; });
    h.asyncStorage.removeItem.mockImplementation(async (k: string) => { delete store[k]; });
    answer = (body) => ({ ok: true, json: async () => ({ profile: { avatar: body.avatar ? 'stored' : null, callsign: body.callsign } }) });
    globalThis.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? '{}');
        sent.push({ url: String(url), body });
        return answer(body);
    }) as any;
});

const copyArrived = (change: { callsign?: string; avatar?: string }) => keepPendingProfileChange(HERE, SELF_PK, change, { copy: true });

describe('what a waiting copy publishes', () => {
    it('a name and a photo: exactly those two, and none of the row\'s bio, contact or working style', async () => {
        await copyArrived({ callsign: 'Rosa', avatar: PHOTO });

        expect(await pushProfileToServer({ community: HERE })).toBe(true);

        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe(`${HERE}/api/profile/update`);
        expect(sent[0].body).toEqual({ publicKey: SELF_PK, callsign: 'Rosa', avatar: PHOTO });
        expect(h.archetypeToSend).not.toHaveBeenCalled();
    });

    it('a name alone: no photo goes, not even one the row holds waiting to be sent', async () => {
        row.avatar_url = OWN_OFFLINE_PICK;
        await copyArrived({ callsign: 'Rosa' });

        await pushProfileToServer({ community: HERE });

        expect(sent[0].body).toEqual({ publicKey: SELF_PK, callsign: 'Rosa' });
    });

    it('a photo alone: no name goes, though the row holds one', async () => {
        await copyArrived({ avatar: PHOTO });

        await pushProfileToServer({ community: HERE });

        expect(sent[0].body).toEqual({ publicKey: SELF_PK, avatar: PHOTO });
        expect('callsign' in sent[0].body).toBe(false);
    });

    it('retires the copy once the community took it, and writes only what was copied into the row', async () => {
        await copyArrived({ callsign: 'Rosa', avatar: PHOTO });

        await pushProfileToServer({ community: HERE });

        expect(await pendingProfileChange(HERE, SELF_PK)).toBeNull();
        const upsert = h.runAsync.mock.calls.find(([sql]) => /INSERT INTO members/.test(String(sql)));
        expect(upsert).toBeTruthy();
        // callsign, avatar_url, bio, contact_value, contact_visibility, archetype: the row's own bio, contact and style are left as they are.
        expect(upsert![1]).toEqual([SELF_PK, 'Rosa', PHOTO, null, null, null, null]);
    });

    it('keeps the copy waiting when the community did not take it, and still sends nothing more on the next try', async () => {
        await copyArrived({ callsign: 'Rosa', avatar: PHOTO });
        answer = () => ({ ok: false, status: 503, json: async () => ({}) });

        expect(await pushProfileToServer({ community: HERE })).toBe(false);
        expect(await pendingProfileChange(HERE, SELF_PK)).toMatchObject({ callsign: 'Rosa', avatar: PHOTO });

        answer = (body) => ({ ok: true, json: async () => ({ profile: { avatar: body.avatar ? 'stored' : null, callsign: body.callsign } }) });
        await pushProfileToServer({ community: HERE });
        expect(sent[1].body).toEqual({ publicKey: SELF_PK, callsign: 'Rosa', avatar: PHOTO });
    });

    it('a name the community refuses for good leaves the copy; the photo still goes, and the name is not sent again', async () => {
        await copyArrived({ callsign: 'Taken', avatar: PHOTO });
        answer = (body) => body.callsign
            ? { ok: false, status: 409, json: async () => ({ error: 'callsign_taken', message: 'Someone here has that name.' }) }
            : { ok: true, json: async () => ({ profile: { avatar: 'stored' } }) };

        await pushProfileToServer({ community: HERE });

        expect(sent).toHaveLength(2);
        expect(sent[0].body).toEqual({ publicKey: SELF_PK, callsign: 'Taken', avatar: PHOTO });
        // The second try carries the photo and no name: not the row's name in its place, and still no bio or contact.
        expect(sent[1].body).toEqual({ publicKey: SELF_PK, avatar: PHOTO });
        expect(await pendingProfileChange(HERE, SELF_PK)).toBeNull();
    });

    it('a name alone that the community refuses for good sends nothing more and leaves nothing waiting', async () => {
        await copyArrived({ callsign: 'Taken' });
        answer = () => ({ ok: false, status: 409, json: async () => ({ error: 'callsign_taken', message: 'Someone here has that name.' }) });

        await pushProfileToServer({ community: HERE });

        expect(sent).toHaveLength(1);
        expect(await pendingProfileChange(HERE, SELF_PK)).toBeNull();
    });
});

describe('a change that is more than a copy still publishes the row', () => {
    it('an offline Save waiting for the community carries the row\'s bio, contact and working style, as before', async () => {
        await keepPendingProfileChange(HERE, SELF_PK, { callsign: 'Rosa Second' });

        await pushProfileToServer({ community: HERE });

        expect(sent[0].body).toMatchObject({
            publicKey: SELF_PK, callsign: 'Rosa Second', bio: 'Grows beans on the corner',
            contact: { value: 'rosa@example.test', visibility: 'friends' }, archetype: 'quiz-result',
        });
    });

    it('a copy asked for on top of a change already waiting does not strip that change of its bio and contact', async () => {
        await keepPendingProfileChange(HERE, SELF_PK, { callsign: 'Rosa Second' });
        await copyArrived({ avatar: PHOTO });

        await pushProfileToServer({ community: HERE });

        expect(sent[0].body).toMatchObject({ callsign: 'Rosa Second', avatar: PHOTO, bio: 'Grows beans on the corner' });
    });

    it('an ordinary change kept after a copy takes the whole row with it, as an ordinary change does', async () => {
        await copyArrived({ avatar: PHOTO });
        await keepPendingProfileChange(HERE, SELF_PK, { callsign: 'Rosa Second' });

        await pushProfileToServer({ community: HERE });

        expect(sent[0].body).toMatchObject({ callsign: 'Rosa Second', avatar: PHOTO, bio: 'Grows beans on the corner' });
    });
});
