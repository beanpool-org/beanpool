/**
 * The phone half of the avatar-consistency fix.
 *
 * Damo (test node) sent three screenshots of his own account a minute apart: My Profile showed
 * his new photo, the Settings card an empty ring, the header pill his PREVIOUS photo. The
 * defect underneath the worst of it was that the phone kept posting the NODE's own
 * `/api/avatar/<pk>?size=thumb` string back to the node as the member's avatar — because the
 * members sync writes that string into the local `members` row, and every publisher read the
 * local row first. The node stored it, `GET /api/avatar/<pk>` then 404d, and the canonical
 * mirror destroyed the device's only portable copy on the way past.
 *
 * Four things are pinned here:
 *   1. the portable-value helper itself,
 *   2. the canonical mirror refusing a non-portable value,
 *   3. pushProfileToServer choosing the canonical copy over a node URL,
 *   4. the own-row-changed detection behind the sync `profile_updated` event.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above every const in this file, so the shared doubles have to
// be created inside vi.hoisted() or the factories close over a TDZ binding.
const h = vi.hoisted(() => {
    const runAsync = vi.fn();
    const getFirstAsync = vi.fn();
    return {
        runAsync,
        getFirstAsync,
        db: {
            runAsync,
            getFirstAsync,
            execAsync: vi.fn(),
            getAllAsync: vi.fn(),
            closeAsync: vi.fn(),
            withTransactionAsync: vi.fn(),
        },
        asyncStorage: {
            getItem: vi.fn(),
            setItem: vi.fn(),
            removeItem: vi.fn(),
            getAllKeys: vi.fn(),
        },
        loadIdentity: vi.fn(),
        getCanonicalProfile: vi.fn(),
        saveCanonicalProfile: vi.fn(),
        buildSignedHeaders: vi.fn(),
        // db.ts announces events through utils/app-events, which exists precisely so this is
        // observable: a raw `require('react-native')` does not return a mock under vitest, it
        // throws, and db.ts's catch would swallow every emit silently.
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
}));
vi.mock('../canonical-profile', () => ({
    getCanonicalProfile: h.getCanonicalProfile,
    saveCanonicalProfile: h.saveCanonicalProfile,
}));
vi.mock('../crypto', () => ({ buildSignedHeaders: h.buildSignedHeaders }));

const SELF_PK = 'damo'.repeat(16);

import { isPortableAvatarValue, publishableAvatar } from '../avatar-value';
import { updateMemberProfile, pushProfileToServer, applyDelta } from '../db';

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const NODE_URL_RELATIVE = `/api/avatar/${SELF_PK}?size=thumb`;
const NODE_URL_VERSIONED = `/api/avatar/${SELF_PK}?size=thumb&v=e3733e23`;
const NODE_URL_ABSOLUTE = `https://mullum.beanpool.org/api/avatar/${SELF_PK}?size=thumb`;

beforeEach(() => {
    vi.clearAllMocks();
    h.runAsync.mockResolvedValue({ changes: 1 });
    h.getFirstAsync.mockResolvedValue(null);
    h.loadIdentity.mockResolvedValue(null);
    h.getCanonicalProfile.mockResolvedValue(null);
    h.asyncStorage.getItem.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// 1. The helper
// ---------------------------------------------------------------------------
describe('isPortableAvatarValue', () => {
    it('accepts the two things that actually carry a picture anywhere', () => {
        expect(isPortableAvatarValue(PHOTO)).toBe(true);
        expect(isPortableAvatarValue('DATA:image/png;base64,iVBOR')).toBe(true);
        expect(isPortableAvatarValue('bundled://leaf')).toBe(true);
    });

    it('refuses the node URL that was destroying photos, in every shape it arrives in', () => {
        expect(isPortableAvatarValue(NODE_URL_RELATIVE)).toBe(false);
        expect(isPortableAvatarValue(NODE_URL_VERSIONED)).toBe(false);
        expect(isPortableAvatarValue(NODE_URL_ABSOLUTE)).toBe(false);
    });

    it('is an allow-list, so a device-local path is refused too', () => {
        // A file:// cache path is exactly as useless on another device as a node URL is on
        // another node, and it used to reach the wire the same way.
        expect(isPortableAvatarValue('file:///data/user/0/org.beanpool/cache/pic.jpg')).toBe(false);
        expect(isPortableAvatarValue('https://example.com/some/photo.jpg')).toBe(false);
    });

    it('refuses the empty and sentinel values the app has historically stored', () => {
        expect(isPortableAvatarValue(null)).toBe(false);
        expect(isPortableAvatarValue(undefined)).toBe(false);
        expect(isPortableAvatarValue('')).toBe(false);
        expect(isPortableAvatarValue('   ')).toBe(false);
        expect(isPortableAvatarValue('null')).toBe(false);
        expect(isPortableAvatarValue('undefined')).toBe(false);
    });
});

describe('publishableAvatar', () => {
    it('prefers the local row when it is portable — it is what the user just picked', () => {
        expect(publishableAvatar(PHOTO, 'bundled://leaf')).toBe(PHOTO);
    });

    it('falls back to canonical when the local row holds the node URL', () => {
        expect(publishableAvatar(NODE_URL_RELATIVE, PHOTO)).toBe(PHOTO);
        expect(publishableAvatar(NODE_URL_ABSOLUTE, PHOTO)).toBe(PHOTO);
    });

    it('returns null — meaning "omit the field" — when neither side is portable', () => {
        // Callers must not turn this into `avatar: null`: the server reads an explicit null
        // as "clear it", which would finish the job the round-trip started.
        expect(publishableAvatar(NODE_URL_RELATIVE, null)).toBeNull();
        expect(publishableAvatar(null, null)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 2. The canonical mirror
// ---------------------------------------------------------------------------
describe('updateMemberProfile canonical mirror', () => {
    beforeEach(() => {
        h.loadIdentity.mockResolvedValue({ publicKey: SELF_PK, callsign: 'Damo', privateKey: 'k' });
    });

    it('mirrors a real photo', async () => {
        await updateMemberProfile(SELF_PK, { callsign: 'Damo', avatar_url: PHOTO });
        expect(h.saveCanonicalProfile).toHaveBeenCalledWith(
            expect.objectContaining({ avatar: PHOTO })
        );
    });

    it('does NOT mirror the node URL — that wiped the only portable copy on the device', async () => {
        await updateMemberProfile(SELF_PK, { callsign: 'Damo', avatar_url: NODE_URL_VERSIONED });
        const saved = h.saveCanonicalProfile.mock.calls[0][0];
        // `undefined`, not null: saveCanonicalProfile merges on `!== undefined`, so undefined
        // leaves the stored photo alone while null would clear it.
        expect(saved.avatar).toBeUndefined();
    });

    it('leaves the stored avatar alone rather than clearing it on an ambiguous null', async () => {
        // This is the archetype-quiz path: it rebuilds the row with `?? null` from a local row
        // that had not synced yet, and the null used to reach canonical and wipe the picture.
        await updateMemberProfile(SELF_PK, { callsign: 'Damo', avatar_url: null, bio: 'hi' });
        const saved = h.saveCanonicalProfile.mock.calls[0][0];
        expect(saved.avatar).toBeUndefined();
        expect(saved.bio).toBe('hi');
    });

    it('never mirrors another member\'s row into the viewer\'s canonical profile', async () => {
        await updateMemberProfile('somebody-else', { callsign: 'Ada', avatar_url: PHOTO });
        expect(h.saveCanonicalProfile).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 3. pushProfileToServer
// ---------------------------------------------------------------------------
describe('pushProfileToServer avatar choice', () => {
    const postedBody = (): any => {
        const call = (globalThis.fetch as any).mock.calls[0];
        return JSON.parse(call[1].body);
    };

    beforeEach(() => {
        h.loadIdentity.mockResolvedValue({ publicKey: SELF_PK, callsign: 'Damo', privateKey: 'k' });
        h.asyncStorage.getItem.mockImplementation(async (k: string) =>
            k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null);
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any;
    });

    it('publishes the canonical photo when the local row holds the node URL', async () => {
        // The exact state after any members sync: the row points back at the node.
        h.getFirstAsync.mockResolvedValue({
            public_key: SELF_PK, callsign: 'Damo', avatar_url: NODE_URL_VERSIONED,
            bio: null, contact_value: null, contact_visibility: null, archetype: null,
        });
        h.getCanonicalProfile.mockResolvedValue({ avatar: PHOTO });

        await pushProfileToServer();

        expect(postedBody().avatar).toBe(PHOTO);
    });

    it('prefers the local row when it really does hold the photo', async () => {
        h.getFirstAsync.mockResolvedValue({
            public_key: SELF_PK, callsign: 'Damo', avatar_url: PHOTO,
            bio: null, contact_value: null, contact_visibility: null, archetype: null,
        });
        h.getCanonicalProfile.mockResolvedValue({ avatar: 'bundled://leaf' });

        await pushProfileToServer();

        expect(postedBody().avatar).toBe(PHOTO);
    });

    it('omits `avatar` entirely — never sends null — when nothing portable is available', async () => {
        h.getFirstAsync.mockResolvedValue({
            public_key: SELF_PK, callsign: 'Damo', avatar_url: NODE_URL_RELATIVE,
            bio: 'still has a bio', contact_value: null, contact_visibility: null, archetype: null,
        });
        h.getCanonicalProfile.mockResolvedValue({ avatar: null });

        await pushProfileToServer();

        const body = postedBody();
        expect('avatar' in body).toBe(false);
        // The rest of the profile still publishes: this path must not become a no-op.
        expect(body.bio).toBe('still has a bio');
    });
});

// ---------------------------------------------------------------------------
// 4. The sync telling the UI that the viewer's OWN row changed
// ---------------------------------------------------------------------------
describe('applyDelta emits profile_updated for the viewer\'s own row', () => {
    /** What the local DB holds BEFORE the sync writes over it. */
    const localRowIs = (row: { callsign: string | null; avatar_url: string | null } | null) => {
        h.getFirstAsync.mockImplementation(async (sql: string) =>
            /SELECT callsign, avatar_url FROM members/.test(sql) ? row : null);
    };

    const syncMember = async (m: Record<string, unknown>) => {
        await applyDelta({ members: [m] });
        return h.emit.mock.calls.filter(c => c[0] === 'profile_updated');
    };

    beforeEach(() => {
        h.loadIdentity.mockResolvedValue({ publicKey: SELF_PK, callsign: 'Damo', privateKey: 'k' });
        h.db.withTransactionAsync.mockImplementation(async (cb: () => Promise<void>) => { await cb(); });
        h.db.getAllAsync.mockResolvedValue([]);
    });

    it('emits when a synced photo change lands on the viewer\'s own row', async () => {
        // The case the header could never see: the photo was changed on the PWA or another
        // device, so it arrives by sync and `updateMemberProfile` never runs.
        localRowIs({ callsign: 'Damo', avatar_url: '/api/avatar/x?size=thumb&v=aaaaaaaa' });
        const calls = await syncMember({
            publicKey: SELF_PK, callsign: 'Damo',
            avatarUrl: '/api/avatar/x?size=thumb&v=bbbbbbbb',
        });
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toEqual({ pubkey: SELF_PK });
    });

    it('emits when a synced rename lands on the viewer\'s own row', async () => {
        localRowIs({ callsign: 'Damo', avatar_url: null });
        expect(await syncMember({ publicKey: SELF_PK, callsign: 'Damien' })).toHaveLength(1);
    });

    it('stays silent when nothing about the viewer\'s row actually changed', async () => {
        // Without this the header would re-read on every poll, forever.
        localRowIs({ callsign: 'Damo', avatar_url: '/api/avatar/x?size=thumb&v=aaaaaaaa' });
        expect(await syncMember({
            publicKey: SELF_PK, callsign: 'Damo',
            avatarUrl: '/api/avatar/x?size=thumb&v=aaaaaaaa',
        })).toHaveLength(0);
    });

    it('stays silent when the payload carries no avatar, because COALESCE keeps the stored one', async () => {
        localRowIs({ callsign: 'Damo', avatar_url: '/api/avatar/x?size=thumb&v=aaaaaaaa' });
        expect(await syncMember({ publicKey: SELF_PK, callsign: 'Damo', avatarUrl: null })).toHaveLength(0);
    });

    it('stays silent for another member\'s row, however much it changed', async () => {
        localRowIs({ callsign: 'Ada', avatar_url: null });
        expect(await syncMember({
            publicKey: 'adaa'.repeat(16), callsign: 'Ada Lovelace', avatarUrl: 'data:image/jpeg;base64,zzz',
        })).toHaveLength(0);
    });
});
