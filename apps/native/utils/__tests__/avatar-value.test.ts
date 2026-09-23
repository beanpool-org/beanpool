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
 * The FIX-ROUND defect is the other direction. The canonical store is written only by a LOCAL
 * pick, so after Damo changes his photo on the PWA this phone holds local row = the node's URL
 * and canonical = the PREVIOUS photo. Anything that "falls back to canonical" then republishes
 * the older picture over the newer one — a bio-only Save, Re-run Setup, or a catch-up publish
 * that assumed the node had nothing. The rule now is: an explicit edit sends `avatar` only for a
 * photo picked in that session, and a catch-up sends canonical only when the node is KNOWN to
 * hold no photo for us.
 *
 * Six things are pinned here:
 *   1. the portable-value helper itself,
 *   2. the per-path publish rules (explicit edit, Re-run Setup, catch-up),
 *   3. the canonical mirror refusing a non-portable value,
 *   4. pushProfileToServer sending canonical only when the node has nothing,
 *   5. a null avatar in the node's COMPLETE member list clearing the local row,
 *   6. the own-row-changed detection behind the sync `profile_updated` event.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

import {
    isPortableAvatarValue,
    explicitEditAvatar,
    catchUpAvatar,
    profileSetupAvatar,
    localRowHasNoAvatar,
} from '../avatar-value';
import { updateMemberProfile, pushProfileToServer, applyDelta, syncMessages } from '../db';

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

// ---------------------------------------------------------------------------
// 2. What each path is allowed to publish
//
// `OLD_PHOTO` is the canonical copy: the last photo picked ON THIS PHONE. `NODE_URL_VERSIONED`
// in the local row means the node holds a photo — in the multi-device case, a NEWER one that
// this phone has never seen the bytes of.
// ---------------------------------------------------------------------------
const OLD_PHOTO = 'data:image/jpeg;base64,T0xEUEhPVE8=';

describe('explicitEditAvatar — the settings Save and the wizard', () => {
    it('sends the photo the member picked in this session', () => {
        expect(explicitEditAvatar(PHOTO)).toBe(PHOTO);
        expect(explicitEditAvatar('bundled://leaf')).toBe('bundled://leaf');
    });

    it('sends NOTHING for a bio-only Save, even though a canonical copy exists', () => {
        // The blocking defect: `publishableAvatar(localRow, canonical)` returned OLD_PHOTO here
        // and the Save posted it, silently replacing the newer photo set on the PWA. A Save the
        // member did not make about their photo must not touch their photo.
        expect(explicitEditAvatar(null)).toBeNull();
        expect(explicitEditAvatar(undefined)).toBeNull();
    });

    it('refuses a non-portable value even if one somehow reaches it as a pick', () => {
        expect(explicitEditAvatar(NODE_URL_VERSIONED)).toBeNull();
        expect(explicitEditAvatar('file:///data/user/0/org.beanpool/cache/pic.jpg')).toBeNull();
    });
});

describe('profileSetupAvatar — Re-run Setup', () => {
    it('does not republish the stale canonical copy when the node has a photo', () => {
        // Re-run Setup used to SEED its preview from canonical and then publish it, so opening
        // the wizard to change a name put the previous picture back.
        expect(profileSetupAvatar(null, NODE_URL_VERSIONED, OLD_PHOTO)).toBeNull();
    });

    it('publishes a photo picked in the wizard, over anything else', () => {
        expect(profileSetupAvatar(PHOTO, NODE_URL_VERSIONED, OLD_PHOTO)).toBe(PHOTO);
    });

    it('publishes canonical only when the node holds no photo for us', () => {
        // Nothing on the node to overwrite — this is the case that makes the picture follow the
        // member onto a freshly-joined community, and keeps the photo gate satisfiable.
        expect(profileSetupAvatar(null, null, OLD_PHOTO)).toBe(OLD_PHOTO);
    });

    it('publishes nothing when there is nothing anywhere', () => {
        expect(profileSetupAvatar(null, null, null)).toBeNull();
    });
});

describe('catchUpAvatar — pushProfileToServer', () => {
    it('leaves `avatar` out when the local row holds the node\'s own URL', () => {
        // The node has a photo; it may be newer than canonical, and this path has no way to
        // tell. Omitting the field is how the node is told "unchanged".
        expect(catchUpAvatar(NODE_URL_VERSIONED, OLD_PHOTO)).toBeNull();
        expect(catchUpAvatar(NODE_URL_ABSOLUTE, OLD_PHOTO)).toBeNull();
    });

    it('sends canonical when the local row has no avatar at all', () => {
        expect(catchUpAvatar(null, OLD_PHOTO)).toBe(OLD_PHOTO);
        expect(catchUpAvatar('', OLD_PHOTO)).toBe(OLD_PHOTO);
        expect(catchUpAvatar('null', OLD_PHOTO)).toBe(OLD_PHOTO);
    });

    it('sends canonical over a node URL when the node itself said it has no photo', () => {
        // The marketplace photo gate: the node has just answered "please set a profile photo",
        // which outranks a local row left stale by a sync.
        expect(catchUpAvatar(NODE_URL_VERSIONED, OLD_PHOTO, true)).toBe(OLD_PHOTO);
    });

    it('always sends a photo picked during an OFFLINE save', () => {
        // It never reached the node, so it is the newest copy anywhere.
        expect(catchUpAvatar(PHOTO, OLD_PHOTO)).toBe(PHOTO);
        expect(catchUpAvatar(PHOTO, OLD_PHOTO, true)).toBe(PHOTO);
    });

    it('never invents an avatar out of nothing', () => {
        expect(catchUpAvatar(null, null)).toBeNull();
        expect(catchUpAvatar(null, null, true)).toBeNull();
        expect(catchUpAvatar(NODE_URL_VERSIONED, null, true)).toBeNull();
    });
});

describe('localRowHasNoAvatar', () => {
    it('reads every empty shape the row has historically held as "the node has none"', () => {
        expect(localRowHasNoAvatar(null)).toBe(true);
        expect(localRowHasNoAvatar(undefined)).toBe(true);
        expect(localRowHasNoAvatar('')).toBe(true);
        expect(localRowHasNoAvatar('   ')).toBe(true);
        expect(localRowHasNoAvatar('null')).toBe(true);
        expect(localRowHasNoAvatar('undefined')).toBe(true);
    });

    it('reads a node URL as "the node HAS a photo" — that is the whole point', () => {
        expect(localRowHasNoAvatar(NODE_URL_VERSIONED)).toBe(false);
        expect(localRowHasNoAvatar(PHOTO)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 2b. The two explicit-edit SCREENS are wired to those rules
//
// The rules above are only worth anything if the screens go through them. Screens need a device
// (see vitest.config.ts), so what is checkable here is the wiring: that the Save and the wizard
// build their `avatar` field from the session pick, and never from the value they DISPLAY. That
// is the exact shape of the defect — `publishableAvatar(avatar, canonical)` read the displayed
// value and posted a stale canonical copy over a newer photo — so it is the shape worth pinning.
// ---------------------------------------------------------------------------
describe('the explicit-edit screens publish only a session pick', () => {
    const read = (rel: string) =>
        readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..', rel), 'utf8');

    it('settings Save derives `avatar` from the session pick alone', () => {
        const src = read('app/(tabs)/settings.tsx');
        expect(src).toContain('explicitEditAvatar(avatarPickedThisSession)');
        // The only assignment of the payload's avatar is that value.
        expect(src.match(/payloadObj\.avatar\s*=\s*([A-Za-z0-9_.]+)/g)).toEqual(['payloadObj.avatar = publishAvatar']);
        // And the displayed `avatar` state never reaches the publish decision again.
        expect(src).not.toContain('publishableAvatar');
    });

    it('settings Save writes only a session pick back to the local members row', () => {
        // Writing the displayed value would put the node's own URL into the row as if the
        // member had chosen it, which is how the round-trip started.
        const src = read('app/(tabs)/settings.tsx');
        expect(src.match(/localUpdate\.avatar_url\s*=\s*([A-Za-z0-9_.]+)/g))
            .toEqual(['localUpdate.avatar_url = avatarPickedThisSession']);
    });

    it('Re-run Setup builds its payload through profileSetupAvatar, not from the preview', () => {
        const src = read('app/profile-setup.tsx');
        expect(src).toContain('profileSetupAvatar(pendingAvatar, nodeAvatar, canonicalAvatar)');
        // `avatar: pendingAvatar` in the request body was the stale-preview publish itself.
        expect(src).not.toMatch(/avatar:\s*pendingAvatar/);
        expect(src).not.toContain('publishableAvatar');
    });

    it('both offline branches park the session pick beside the pending flag', () => {
        // The retry cannot recover a pick it was never given, and the local members row is not
        // a durable place to leave one — the next full-directory sync overwrites it.
        for (const [rel, pick] of [
            ['app/(tabs)/settings.tsx', 'avatarPickedThisSession'],
            ['app/profile-setup.tsx', 'pendingAvatar'],
        ] as const) {
            const src = read(rel);
            expect(src).toContain(`const offlinePick = explicitEditAvatar(${pick});`);
            expect(src).toContain("if (offlinePick) await AsyncStorage.setItem('pending_profile_avatar', offlinePick);");
            // And the online branch clears it, so a pick that DID publish is never re-sent.
            expect(src).toContain("await AsyncStorage.removeItem('pending_profile_avatar');");
        }
    });

    it('only the marketplace photo gate claims the node has no photo', () => {
        // `nodeHasNoPhoto` overrides the local row, so it must come ONLY from the node saying
        // so. Both heal sites pass it; the pending-sync retry and the invite-redeem publish
        // must not, or they are back to posting canonical over a newer photo.
        const src = read('utils/db.ts');
        const healBranches = src.match(/_isProfilePhotoError\([a-zA-Z]+\)\)\s*\{[\s\S]{0,400}?pushProfileToServer\([^)]*\)/g) ?? [];
        expect(healBranches).toHaveLength(2);
        for (const branch of healBranches) {
            expect(branch).toContain('pushProfileToServer({ nodeHasNoPhoto: true })');
        }
        // Every other caller in the app takes no argument.
        for (const rel of ['services/pillar-sync.ts', 'app/_layout.tsx']) {
            expect(read(rel)).not.toContain('nodeHasNoPhoto');
        }
    });

    it('Re-run Setup shows the node\'s photo through MemberAvatar', () => {
        // The preview used to render the canonical copy as if it were current. MemberAvatar
        // resolves the node's relative `/api/avatar/<pk>` path and falls back to the initial.
        const src = read('app/profile-setup.tsx');
        expect(src).toMatch(/<MemberAvatar[\s\S]{0,200}avatarUrl=\{displayAvatar\}/);
        expect(src).toContain('const displayAvatar = pendingAvatar ?? nodeAvatar ?? canonicalAvatar;');
    });
});

// ---------------------------------------------------------------------------
// 3. The canonical mirror
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
// 4. pushProfileToServer
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

    /** The exact local state after any members sync: the row points back at the node. */
    const rowHoldsNodeUrl = (extra: Record<string, unknown> = {}) => {
        h.getFirstAsync.mockResolvedValue({
            public_key: SELF_PK, callsign: 'Damo', avatar_url: NODE_URL_VERSIONED,
            bio: null, contact_value: null, contact_visibility: null, archetype: null, ...extra,
        });
    };

    it('leaves `avatar` out when the local row holds the node URL — the node may have a NEWER photo', async () => {
        // This assertion is the reverse of the one it replaces. The old test pinned
        // `publishableAvatar`'s unconditional canonical fallback, which the deciding review
        // found to be a silent overwrite: after a photo change on the PWA, canonical is the
        // PREVIOUS photo, and the pending-sync retry and the invite-redeem publish both reach
        // a node that already holds the newer one.
        rowHoldsNodeUrl({ bio: 'still has a bio' });
        h.getCanonicalProfile.mockResolvedValue({ avatar: PHOTO });

        await pushProfileToServer();

        expect('avatar' in postedBody()).toBe(false);
    });

    it('publishes the canonical photo when the local row has no avatar at all', async () => {
        // A freshly-joined second community: the row exists from registration with no photo, so
        // there is nothing on the node to overwrite and the picture should follow the member.
        h.getFirstAsync.mockResolvedValue({
            public_key: SELF_PK, callsign: 'Damo', avatar_url: null,
            bio: null, contact_value: null, contact_visibility: null, archetype: null,
        });
        h.getCanonicalProfile.mockResolvedValue({ avatar: PHOTO });

        await pushProfileToServer();

        expect(postedBody().avatar).toBe(PHOTO);
    });

    it('publishes canonical over a stale node URL when the photo gate says the node has none', async () => {
        // `nodeHasNoPhoto` is the node's own answer to a marketplace action, which outranks a
        // local row a sync left stale — this is the heal path, and it must still heal.
        rowHoldsNodeUrl();
        h.getCanonicalProfile.mockResolvedValue({ avatar: PHOTO });

        await pushProfileToServer({ nodeHasNoPhoto: true });

        expect(postedBody().avatar).toBe(PHOTO);
    });

    it('sends the photo picked during an OFFLINE save, and not the older canonical one', async () => {
        // The `pending_profile_sync` retry after an offline pick: the picked photo is sitting
        // portable in the local row and has never reached the node.
        h.getFirstAsync.mockResolvedValue({
            public_key: SELF_PK, callsign: 'Damo', avatar_url: PHOTO,
            bio: null, contact_value: null, contact_visibility: null, archetype: null,
        });
        h.getCanonicalProfile.mockResolvedValue({ avatar: OLD_PHOTO });

        await pushProfileToServer();

        expect(postedBody().avatar).toBe(PHOTO);
    });

    it('sends no photo at all on the retry after an offline BIO-ONLY save', async () => {
        // The case the deciding review named: the member saved a bio while offline, and by the
        // time the retry runs the node holds a newer photo from another device. The retry must
        // publish the bio and say nothing about the avatar.
        rowHoldsNodeUrl({ bio: 'wrote this on the train' });
        h.getCanonicalProfile.mockResolvedValue({ avatar: OLD_PHOTO });

        await pushProfileToServer();

        const body = postedBody();
        expect('avatar' in body).toBe(false);
        expect(body.bio).toBe('wrote this on the train');
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
        // Callers must not turn a null into `avatar: null`: the server reads an explicit null as
        // "clear it", which would finish the job the round-trip started.
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
// 4b. An offline pick survives a members sync that lands before the retry
//
// The rule in 4 rests on the picked photo sitting portable in the local `members` row. It sits
// there only until the first full-directory sync replaces it with the node's own URL — and on a
// reconnect after more than an hour offline, that sync can easily run before the retry
// succeeds. The row then says "the node has a photo", the retry publishes no `avatar` at all,
// the node keeps the PREVIOUS picture and nothing ever resends the pick. So the pick is parked
// in `pending_profile_avatar` by the screen that could not publish it, and read from there.
// ---------------------------------------------------------------------------
describe('an offline pick survives a members sync landing before the retry', () => {
    /**
     * A members row that the mocked SQLite actually writes to, so the sequence under test is
     * the real one: offline save → members upsert → retry, rather than three unrelated mocks.
     * Only the viewer's own row and only the columns this path reads.
     */
    let row: any;
    let parked: string | null;

    const postedBody = (): any => {
        const call = (globalThis.fetch as any).mock.calls[0];
        return JSON.parse(call[1].body);
    };

    beforeEach(() => {
        row = {
            public_key: SELF_PK, callsign: 'Damo', avatar_url: null,
            bio: null, contact_value: null, contact_visibility: null, archetype: null,
        };
        parked = null;
        h.loadIdentity.mockResolvedValue({ publicKey: SELF_PK, callsign: 'Damo', privateKey: 'k' });
        h.getCanonicalProfile.mockResolvedValue({ avatar: OLD_PHOTO });
        h.db.withTransactionAsync.mockImplementation(async (cb: () => Promise<void>) => { await cb(); });
        h.db.getAllAsync.mockResolvedValue([]);
        h.getFirstAsync.mockImplementation(async () => row);
        h.asyncStorage.getItem.mockImplementation(async (k: string) => {
            if (k === 'beanpool_anchor_url') return 'https://test.beanpool.org';
            if (k === 'pending_profile_avatar') return parked;
            return null;
        });
        h.asyncStorage.setItem.mockImplementation(async (k: string, v: string) => {
            if (k === 'pending_profile_avatar') parked = v;
        });
        h.asyncStorage.removeItem.mockImplementation(async (k: string) => {
            if (k === 'pending_profile_avatar') parked = null;
        });
        // The members upsert, applied to `row` with the same precedence the SQL has: on a
        // COMPLETE list the incoming value wins outright, including a null.
        h.runAsync.mockImplementation(async (sql: string, params: any[]) => {
            if (typeof sql === 'string' && /INSERT INTO members/.test(sql) && /joined_at/.test(sql)) {
                const [pk, cs, av] = params;
                const clears = params[params.length - 1] === 1;
                if (pk === row.public_key) {
                    row.callsign = cs;
                    row.avatar_url = clears ? av : (av ?? row.avatar_url);
                }
            }
            return { changes: 1 };
        });
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ profile: { avatar: 'stored' } }) }) as any;
    });

    /** What the offline branch of settings Save / Re-run Setup does. */
    const offlineSaveWithPick = async (pick: string) => {
        await h.asyncStorage.setItem('pending_profile_sync', 'true');
        await h.asyncStorage.setItem('pending_profile_avatar', pick);
        await updateMemberProfile(SELF_PK, { callsign: 'Damo', avatar_url: pick });
    };

    /** The node's hourly full directory, which knows nothing of the unpublished pick. */
    const membersSyncWritesNodeUrl = async () => {
        await applyDelta({
            members: [{ publicKey: SELF_PK, callsign: 'Damo', avatarUrl: NODE_URL_VERSIONED }],
            membersComplete: true,
        });
        expect(row.avatar_url).toBe(NODE_URL_VERSIONED); // the pick really is gone from the row
    };

    it('still sends the pick after the sync has overwritten the local row', async () => {
        await offlineSaveWithPick(PHOTO);
        await membersSyncWritesNodeUrl();

        await pushProfileToServer();

        // Without the parked copy this is `undefined`: the row says the node has a photo, so
        // `catchUpAvatar` returns null and the member's choice is dropped for good.
        expect(postedBody().avatar).toBe(PHOTO);
    });

    it('clears the parked pick once the node has taken it', async () => {
        await offlineSaveWithPick(PHOTO);
        await pushProfileToServer();
        expect(parked).toBeNull();
        expect(h.asyncStorage.removeItem).toHaveBeenCalledWith('pending_profile_sync');
    });

    it('KEEPS the parked pick when the publish fails, so the next retry still has it', async () => {
        await offlineSaveWithPick(PHOTO);
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }) as any;

        expect(await pushProfileToServer()).toBe(false);

        expect(parked).toBe(PHOTO);
    });

    it('KEEPS the parked pick when the node 200s without storing the avatar', async () => {
        // `avatarPersisted` false: the POST looked fine but the photo did not land.
        await offlineSaveWithPick(PHOTO);
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ profile: {} }) }) as any;

        expect(await pushProfileToServer()).toBe(false);

        expect(parked).toBe(PHOTO);
    });

    it('a bio-only offline edit parks nothing and still says nothing about the photo', async () => {
        // No pick this session, so nothing is parked; by the time the retry runs the node holds
        // a photo this phone has never seen, and the bio must not drag an older one along.
        row.bio = 'wrote this on the train';
        await h.asyncStorage.setItem('pending_profile_sync', 'true');
        await membersSyncWritesNodeUrl();

        await pushProfileToServer();

        const body = postedBody();
        expect('avatar' in body).toBe(false);
        expect(body.bio).toBe('wrote this on the train');
    });
});

// ---------------------------------------------------------------------------
// 5. A null avatar in the node's COMPLETE member list clears the local row
// ---------------------------------------------------------------------------
describe('applyDelta avatar clearing', () => {
    /** The members upsert `applyDelta` ran, as SQL text plus its bound parameters. */
    const membersUpsert = () => {
        const call = h.runAsync.mock.calls.find(
            (c: any[]) => typeof c[0] === 'string' && /INSERT INTO members/.test(c[0]) && /joined_at/.test(c[0])
        );
        expect(call, 'applyDelta did not run the members upsert').toBeTruthy();
        return { sql: call![0] as string, params: call![1] as any[] };
    };

    beforeEach(() => {
        h.loadIdentity.mockResolvedValue({ publicKey: SELF_PK, callsign: 'Damo', privateKey: 'k' });
        h.db.withTransactionAsync.mockImplementation(async (cb: () => Promise<void>) => { await cb(); });
        h.db.getAllAsync.mockResolvedValue([]);
    });

    it('clears a stored avatar when the node\'s COMPLETE list says the member has none', async () => {
        await applyDelta({ members: [{ publicKey: SELF_PK, callsign: 'Damo', avatarUrl: null }], membersComplete: true });
        const { sql, params } = membersUpsert();
        // The CASE placeholder is the last `?` in the statement text, so it is the last param.
        expect(sql).toMatch(/avatar_url = CASE WHEN \? THEN excluded\.avatar_url/);
        expect((sql.match(/\?/g) || []).length).toBe(params.length);
        expect(params[params.length - 1]).toBe(1);
        expect(params[2]).toBeNull(); // avatar_url column stays the incoming null
    });

    it('keeps COALESCE for a PARTIAL list, which is not evidence of absence', async () => {
        // The incremental `?updatedAfter=` delta only carries members who changed; a member
        // absent from it has not lost their photo, and neither has one whose row it omits.
        await applyDelta({ members: [{ publicKey: SELF_PK, callsign: 'Damo', avatarUrl: null }] });
        const { params } = membersUpsert();
        expect(params[params.length - 1]).toBe(0);
    });

    it('still writes an incoming avatar on a partial list', async () => {
        await applyDelta({ members: [{ publicKey: SELF_PK, callsign: 'Damo', avatarUrl: NODE_URL_VERSIONED }] });
        const { params } = membersUpsert();
        expect(params[2]).toBe(NODE_URL_VERSIONED);
    });
});

// ---------------------------------------------------------------------------
// 5b. Both full-directory writers obey the SAME rule for the viewer's own row
//
// `syncMessages` does its own `/api/members` fetch, gated on the same hourly key as
// pillar-sync's, and used to run a SECOND members upsert with an unconditional COALESCE. So
// whichever of the two won the hour boundary decided whether a node that says "no photo"
// cleared the stored URL or left it for another hour — and while it was left, `catchUpAvatar`
// read "the node has a photo" and would not republish the canonical copy. There is now one
// writer: this fetch goes through `applyDelta` with `membersComplete: true`.
// ---------------------------------------------------------------------------
describe('the syncMessages directory fetch goes through applyDelta', () => {
    const membersUpserts = () =>
        h.runAsync.mock.calls.filter(
            (c: any[]) => typeof c[0] === 'string' && /INSERT INTO members/.test(c[0])
        );

    beforeEach(() => {
        h.loadIdentity.mockResolvedValue({ publicKey: SELF_PK, callsign: 'Damo', privateKey: 'k' });
        h.buildSignedHeaders.mockResolvedValue({});
        h.db.withTransactionAsync.mockImplementation(async (cb: () => Promise<void>) => { await cb(); });
        h.db.getAllAsync.mockResolvedValue([]);
        h.getFirstAsync.mockImplementation(async (sql: string) =>
            /COUNT\(\*\)/.test(sql) ? { count: 3 }
                : /SELECT callsign, avatar_url FROM members/.test(sql)
                    ? { callsign: 'Damo', avatar_url: NODE_URL_VERSIONED }
                    : null);
        h.asyncStorage.getItem.mockImplementation(async (k: string) =>
            k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null);
        globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('/api/members')) {
                // The node's complete directory, saying it holds no photo for the viewer.
                return { ok: true, json: async () => ([{ publicKey: SELF_PK, callsign: 'Damo', avatarUrl: null }]) };
            }
            // Conversations: enough to get past the directory block and stop.
            return { ok: true, json: async () => ({}) };
        }) as any;
    });

    it('writes the directory with the COMPLETE-list rule, so a null clears the stored avatar', async () => {
        await syncMessages(SELF_PK);

        const upserts = membersUpserts();
        // One writer, not two: the second upsert this function used to run is gone.
        expect(upserts).toHaveLength(1);
        const [sql, params] = upserts[0] as [string, any[]];
        expect(sql).toMatch(/avatar_url = CASE WHEN \? THEN excluded\.avatar_url/);
        expect(params[params.length - 1]).toBe(1); // complete list → the incoming null wins
        expect(params[2]).toBeNull();
    });

    it('emits profile_updated once the clear has landed on the viewer\'s own row', async () => {
        // The old path emitted too, but only for its own COALESCE view of "changed" — under
        // which a clear was not a change at all.
        await syncMessages(SELF_PK);
        expect(h.emit.mock.calls.filter(c => c[0] === 'profile_updated')).toHaveLength(1);
    });

    it('leaves exactly one writer of the node\'s member directory in db.ts', () => {
        // A source check as well as the behavioural one: a future second directory writer
        // would bring back the split rule, and the test above would still pass on its own.
        // Matched on `elder_vouched_by`, which only a directory upsert carries —
        // `updateMemberProfile`'s upsert writes a LOCAL edit and keeps its own COALESCE,
        // because there an absent field means "not edited", not "the node has none".
        const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../db.ts'), 'utf8');
        expect(src.match(/INSERT INTO members \([^)]*elder_vouched_by/g)).toHaveLength(1);
        expect(src).toContain('applyDelta({ members: dirData, membersComplete: true }, expectedDbName)');
    });
});

// ---------------------------------------------------------------------------
// 6. The sync telling the UI that the viewer's OWN row changed
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

    it('stays silent when a PARTIAL payload carries no avatar, because COALESCE keeps the stored one', async () => {
        localRowIs({ callsign: 'Damo', avatar_url: '/api/avatar/x?size=thumb&v=aaaaaaaa' });
        expect(await syncMember({ publicKey: SELF_PK, callsign: 'Damo', avatarUrl: null })).toHaveLength(0);
    });

    it('emits when the COMPLETE list clears the viewer\'s photo', async () => {
        // The row really does change now, and the header must stop showing a photo the node no
        // longer has — the old `incomingAvatar !== null` guard would have stayed silent.
        localRowIs({ callsign: 'Damo', avatar_url: '/api/avatar/x?size=thumb&v=aaaaaaaa' });
        await applyDelta({ members: [{ publicKey: SELF_PK, callsign: 'Damo', avatarUrl: null }], membersComplete: true });
        expect(h.emit.mock.calls.filter(c => c[0] === 'profile_updated')).toHaveLength(1);
    });

    it('stays silent when the COMPLETE list clears an avatar that was already absent', async () => {
        localRowIs({ callsign: 'Damo', avatar_url: null });
        await applyDelta({ members: [{ publicKey: SELF_PK, callsign: 'Damo', avatarUrl: null }], membersComplete: true });
        expect(h.emit.mock.calls.filter(c => c[0] === 'profile_updated')).toHaveLength(0);
    });

    it('stays silent for another member\'s row, however much it changed', async () => {
        localRowIs({ callsign: 'Ada', avatar_url: null });
        expect(await syncMember({
            publicKey: 'adaa'.repeat(16), callsign: 'Ada Lovelace', avatarUrl: 'data:image/jpeg;base64,zzz',
        })).toHaveLength(0);
    });
});
