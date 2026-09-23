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
    localRowHasNoAvatar,
    resolveProfilePublishAvatar,
    retireParkedPickAfterPublish,
} from '../avatar-value';
import { updateMemberProfile, pushProfileToServer, applyDelta, syncMessages, redeemInvite } from '../db';

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

// Re-run Setup no longer has a rule of its own: `profileSetupAvatar` was the wizard's copy of
// the decision, and a second copy is what let the wizard clear a parked pick it never sent. The
// cases it pinned are pinned here against the one rule, with nothing parked.
describe('the one rule, on the Re-run Setup inputs', () => {
    const wizard = (pick: string | null, nodeAvatar: string | null, canonical: string | null) =>
        resolveProfilePublishAvatar({ sessionPick: pick, catchUp: { localRow: nodeAvatar, canonical } });

    it('does not republish the stale canonical copy when the node has a photo', async () => {
        // Re-run Setup used to SEED its preview from canonical and then publish it, so opening
        // the wizard to change a name put the previous picture back.
        expect((await wizard(null, NODE_URL_VERSIONED, OLD_PHOTO)).avatar).toBeNull();
    });

    it('publishes a photo picked in the wizard, over anything else', async () => {
        expect((await wizard(PHOTO, NODE_URL_VERSIONED, OLD_PHOTO)).avatar).toBe(PHOTO);
    });

    it('publishes canonical only when the node holds no photo for us', async () => {
        // Nothing on the node to overwrite — this is the case that makes the picture follow the
        // member onto a freshly-joined community, and keeps the photo gate satisfiable.
        expect((await wizard(null, null, OLD_PHOTO)).avatar).toBe(OLD_PHOTO);
    });

    it('publishes nothing when there is nothing anywhere', async () => {
        expect((await wizard(null, null, null)).avatar).toBeNull();
    });

    it('leaves no second copy of the decision behind', () => {
        // `profileSetupAvatar` existed only to compose the two halves for one screen. While it
        // exists, a screen can go on composing them its own way — which is this whole defect.
        const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../avatar-value.ts'), 'utf8');
        expect(src).not.toContain('profileSetupAvatar');
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

    it('sends NOTHING when the node said it holds a photo, however empty the local row', () => {
        // The third state, and the one the invite-redeem publish needs: an empty row on a node
        // this device has never synced means UNSYNCED, not "the node has none". Treating the
        // two alike put the canonical copy over the newer photo the node already held.
        expect(catchUpAvatar(null, OLD_PHOTO, false)).toBeNull();
        expect(catchUpAvatar('', OLD_PHOTO, false)).toBeNull();
        expect(catchUpAvatar(NODE_URL_VERSIONED, OLD_PHOTO, false)).toBeNull();
        // …and "not asked" still falls back to the local row, which is every other caller.
        expect(catchUpAvatar(null, OLD_PHOTO, undefined)).toBe(OLD_PHOTO);
    });

    it('always sends a photo picked during an OFFLINE save', () => {
        // It never reached the node, so it is the newest copy anywhere.
        expect(catchUpAvatar(PHOTO, OLD_PHOTO)).toBe(PHOTO);
        expect(catchUpAvatar(PHOTO, OLD_PHOTO, true)).toBe(PHOTO);
        expect(catchUpAvatar(PHOTO, OLD_PHOTO, false)).toBe(PHOTO);
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

    it('settings Save derives `avatar` from the one shared rule', () => {
        // This assertion used to pin `explicitEditAvatar(avatarPickedThisSession)` as the Save's
        // whole rule. That was the round-3 defect: with no pick on this mount it published no
        // `avatar` at all and then cleared the parked pick, so an offline pick reached nothing.
        // The session pick is still what an explicit edit sends FIRST — that is now inside
        // `resolveProfilePublishAvatar`, tested directly above, rather than restated here.
        const src = read('app/(tabs)/settings.tsx');
        expect(src).toContain('resolveProfilePublishAvatar({ sessionPick: avatarPickedThisSession })');
        // The only assignment of the payload's avatar is that decision.
        expect(src.match(/payloadObj\.avatar\s*=\s*([A-Za-z0-9_.]+)/g)).toEqual(['payloadObj.avatar = publishAvatar']);
        // And the displayed `avatar` state never reaches the publish decision again.
        expect(src).not.toContain('publishableAvatar');
        // No `catchUp` here: a Save the member did not make about their photo must never
        // republish a canonical copy, which may be older than what the node holds.
        expect(src).not.toContain('catchUp');
    });

    it('settings Save writes only a session pick back to the local members row', () => {
        // Writing the displayed value would put the node's own URL into the row as if the
        // member had chosen it, which is how the round-trip started.
        const src = read('app/(tabs)/settings.tsx');
        expect(src.match(/localUpdate\.avatar_url\s*=\s*([A-Za-z0-9_.]+)/g))
            .toEqual(['localUpdate.avatar_url = avatarPickedThisSession']);
    });

    it('Re-run Setup builds its payload through the one shared rule, not from the preview', () => {
        const src = read('app/profile-setup.tsx');
        expect(src).toContain('sessionPick: pendingAvatar');
        expect(src).toContain('catchUp: { localRow: nodeAvatar, canonical: canonicalAvatar }');
        expect(src).toContain('resolveProfilePublishAvatar({');
        // `avatar: pendingAvatar` in the request body was the stale-preview publish itself.
        expect(src).not.toMatch(/avatar:\s*pendingAvatar/);
        expect(src).not.toContain('publishableAvatar');
        // And no second copy of the decision for this screen to drift away on.
        expect(src).not.toContain('profileSetupAvatar');
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
        }
    });

    it('no publish path clears the parked pick by hand', () => {
        // This replaces an assertion that pinned the online branch removing the key outright
        // ("a pick that DID publish is never re-sent"). It was true only of a Save that carried
        // the pick: a bio-only Save publishes no `avatar`, and clearing the key there disarmed
        // the retry for a photo that had reached nothing. The screens no longer touch either key
        // on success — `retireParkedPickAfterPublish` decides, from what the payload carried.
        for (const rel of ['app/(tabs)/settings.tsx', 'app/profile-setup.tsx'] as const) {
            const src = read(rel);
            expect(src).not.toMatch(/removeItem\('pending_profile_(avatar|sync)'\)/);
            expect(src).toContain('retireParkedPickAfterPublish(');
        }
    });

    it('the catch-up publish goes through the same two functions', () => {
        // One rule in one place is only true if `pushProfileToServer` uses it too, rather than
        // keeping its own copy of "prefer the parked pick, else catch up".
        const src = read('utils/db.ts');
        expect(src).toContain('resolveProfilePublishAvatar({');
        expect(src).toContain('retireParkedPickAfterPublish(');
        expect(src).not.toContain('catchUpAvatar(');
        // Exactly one hand-written removal survives: the give-up branch, which is reached only
        // when there is nothing publishable anywhere — a portable parked pick would have been
        // chosen as `avatar` and kept this code out of that branch entirely.
        expect(src.match(/removeItem\('pending_profile_avatar'\)/g)).toHaveLength(1);
    });

    it('only the NODE\'s own answer claims the node has no photo', () => {
        // `nodeHasNoPhoto` overrides the local row, so it must never be an inference from
        // local state. Two callers have the node's answer: the marketplace heal sites, where
        // the node has just said "please set a profile photo", and the invite-redeem publish,
        // which reads it off the redeem response. The pending-sync retry has no such answer
        // and must pass nothing, or it is back to posting canonical over a newer photo.
        const src = read('utils/db.ts');
        const healBranches = src.match(/_isProfilePhotoError\([a-zA-Z]+\)\)\s*\{[\s\S]{0,400}?pushProfileToServer\([^)]*\)/g) ?? [];
        expect(healBranches).toHaveLength(2);
        for (const branch of healBranches) {
            expect(branch).toContain('pushProfileToServer({ nodeHasNoPhoto: true })');
        }
        // The redeem sites pass the node's answer and nothing else — never `true`, which
        // would be the old unconditional publish wearing the flag's name.
        const layout = read('app/_layout.tsx');
        expect(layout.match(/pushProfileToServer\([^)]*\)/g))
            .toEqual(Array(2).fill('pushProfileToServer({ nodeHasNoPhoto: !redeemRes?.nodeHasPhoto })'));
        // And pillar-sync, which only ever has the local row, still claims nothing.
        expect(read('services/pillar-sync.ts')).not.toContain('nodeHasNoPhoto');
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
// 4c. An ONLINE Save that is not about the photo still delivers the parked pick
//
// Round 2 taught the catch-up retry to prefer the parked pick. The two explicit-edit screens
// kept their own rule, and a Save that said nothing about the photo cleared the parked key on
// its 200 — so the pick was dropped unsent, the retry was disarmed, and the card went on showing
// the photo from the local row, giving the member no reason to pick again.
//
// The screens cannot be mounted here (node environment, see vitest.config.ts), so the sequences
// below drive the two functions the screens are pinned to in 2b — `resolveProfilePublishAvatar`
// to build the payload and `retireParkedPickAfterPublish` to clear the keys — in the order the
// screens call them, around a real `pushProfileToServer` and a real `applyDelta`. The wiring
// assertions in 2b are what ties these sequences to the screens themselves.
// ---------------------------------------------------------------------------
describe('an online Save that is not about the photo still delivers the parked pick', () => {
    let row: any;
    let store: Record<string, string>;

    beforeEach(() => {
        row = {
            public_key: SELF_PK, callsign: 'Damo', avatar_url: null,
            bio: 'wrote this on the train', contact_value: null, contact_visibility: null, archetype: null,
        };
        store = { beanpool_anchor_url: 'https://test.beanpool.org' };
        h.loadIdentity.mockResolvedValue({ publicKey: SELF_PK, callsign: 'Damo', privateKey: 'k' });
        h.getCanonicalProfile.mockResolvedValue({ avatar: OLD_PHOTO });
        h.db.withTransactionAsync.mockImplementation(async (cb: () => Promise<void>) => { await cb(); });
        h.db.getAllAsync.mockResolvedValue([]);
        h.getFirstAsync.mockImplementation(async () => row);
        h.asyncStorage.getItem.mockImplementation(async (k: string) => store[k] ?? null);
        h.asyncStorage.setItem.mockImplementation(async (k: string, v: string) => { store[k] = v; });
        h.asyncStorage.removeItem.mockImplementation(async (k: string) => { delete store[k]; });
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

    /** The offline branch both screens share: park the pick beside the flag, commit locally. */
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
        expect(row.avatar_url).toBe(NODE_URL_VERSIONED);
    };

    /**
     * The settings Save's online branch: a bio/name/contact edit. No `catchUp` — this path may
     * never fall back to canonical. `accepted` is the node's answer.
     */
    const settingsSave = async (sessionPick: string | null, accepted: boolean) => {
        const decision = await resolveProfilePublishAvatar({ sessionPick });
        const payloadObj: any = { publicKey: SELF_PK, callsign: 'Damo', bio: row.bio };
        if (decision.avatar) payloadObj.avatar = decision.avatar;
        if (!accepted) return payloadObj;       // the node said no: nothing local moves
        await retireParkedPickAfterPublish(decision);
        return payloadObj;
    };

    /** Re-run Setup's `published` branch, with the node's row as its catch-up input. */
    const wizardFinish = async (sessionPick: string | null, accepted: boolean) => {
        const decision = await resolveProfilePublishAvatar({
            sessionPick,
            catchUp: { localRow: row.avatar_url, canonical: OLD_PHOTO },
        });
        const body: any = { publicKey: SELF_PK, callsign: 'Damo' };
        if (decision.avatar) body.avatar = decision.avatar;
        if (!accepted) return body;
        await retireParkedPickAfterPublish(decision);
        return body;
    };

    it('an offline pick, a failed retry, then a bio Save: the Save carries the pick', async () => {
        await offlineSaveWithPick(PHOTO);
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }) as any;
        expect(await pushProfileToServer()).toBe(false);
        expect(store.pending_profile_avatar).toBe(PHOTO);   // the retry kept it

        const payload = await settingsSave(null, true);

        // Before this fix: no `avatar` at all, and both keys gone on the 200.
        expect(payload.avatar).toBe(PHOTO);
        expect(store.pending_profile_avatar).toBeUndefined();
        expect(store.pending_profile_sync).toBeUndefined();
    });

    it('the keys clear only AFTER the node has taken it', async () => {
        await offlineSaveWithPick(PHOTO);

        const payload = await settingsSave(null, false);   // node rejected / unreachable

        expect(payload.avatar).toBe(PHOTO);
        expect(store.pending_profile_avatar).toBe(PHOTO);
        expect(store.pending_profile_sync).toBe('true');
    });

    it('the same through Re-run Setup, with a members sync landing in between', async () => {
        await offlineSaveWithPick(PHOTO);
        await membersSyncWritesNodeUrl();

        const body = await wizardFinish(null, true);

        // Before this fix the wizard asked `profileSetupAvatar(null, <node URL>, canonical)`,
        // which correctly returns null — and then cleared the parked pick anyway.
        expect(body.avatar).toBe(PHOTO);
        expect(store.pending_profile_avatar).toBeUndefined();
        expect(store.pending_profile_sync).toBeUndefined();
    });

    it('a bio-only online Save with nothing parked still leaves out `avatar`', async () => {
        await membersSyncWritesNodeUrl();   // the node holds a photo this phone never picked

        const payload = await settingsSave(null, true);

        expect('avatar' in payload).toBe(false);
        expect(store.pending_profile_avatar).toBeUndefined();
    });

    it('a photo picked in THIS session beats an older parked one, and retires it', async () => {
        // The fix brief put the parked pick first. That would publish OLD_PHOTO and clear both
        // keys, stranding PHOTO — the newest photo anywhere, and the one on the member's screen —
        // with nothing left to send it. A session pick can only be newer than a parked one.
        await offlineSaveWithPick(OLD_PHOTO);

        const payload = await settingsSave(PHOTO, true);

        expect(payload.avatar).toBe(PHOTO);
        expect(store.pending_profile_avatar).toBeUndefined();
        expect(store.pending_profile_sync).toBeUndefined();
    });

    it('a parked pick the retry DID deliver is never sent twice', async () => {
        await offlineSaveWithPick(PHOTO);
        expect(await pushProfileToServer()).toBe(true);
        expect(store.pending_profile_avatar).toBeUndefined();

        await membersSyncWritesNodeUrl();
        const payload = await settingsSave(null, true);

        expect('avatar' in payload).toBe(false);
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
// 4c. Redeeming an invite uses the node's own answer about the photo it holds
//
// For a member re-entering a node this device has never synced, the local row is empty and
// `catchUpAvatar` reads that as "the node holds nothing" — so the follow-up publish puts the
// canonical copy over whatever newer photo the node actually has. The answer is already in the
// redeem response: both endpoints return the existing member row.
// ---------------------------------------------------------------------------
describe('redeemInvite reports whether the node already holds a photo', () => {
    const redeemAnswers = (body: any) => {
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body }) as any;
    };

    beforeEach(() => {
        h.loadIdentity.mockResolvedValue({ publicKey: SELF_PK, callsign: 'Damo', privateKey: 'k' });
        h.buildSignedHeaders.mockResolvedValue({});
        h.asyncStorage.getItem.mockImplementation(async (k: string) =>
            k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null);
    });

    it('says the node HAS a photo when the existing member row carries a portable one', async () => {
        redeemAnswers({ success: true, alreadyMember: true, member: { publicKey: SELF_PK, avatarUrl: PHOTO } });
        expect(await redeemInvite('CODE', 'Damo')).toEqual(
            { success: true, alreadyMember: true, nodeHasPhoto: true });
    });

    it('counts a self-referential URL as NO photo — the node cannot serve it', async () => {
        redeemAnswers({ success: true, alreadyMember: true, member: { publicKey: SELF_PK, avatarUrl: NODE_URL_VERSIONED } });
        expect((await redeemInvite('CODE', 'Damo')).nodeHasPhoto).toBe(false);
    });

    it('says no photo when the existing member row has none', async () => {
        redeemAnswers({ success: true, alreadyMember: true, member: { publicKey: SELF_PK, avatarUrl: null } });
        expect((await redeemInvite('CODE', 'Damo')).nodeHasPhoto).toBe(false);
    });

    it('says no photo for a brand-new join — there is no row yet', async () => {
        redeemAnswers({ success: true, alreadyMember: false, member: { publicKey: SELF_PK, avatarUrl: null } });
        expect((await redeemInvite('CODE', 'Damo')).nodeHasPhoto).toBe(false);
    });

    it('reads `avatar` as well as `avatarUrl`, so the profile shape answers too', async () => {
        redeemAnswers({ success: true, alreadyMember: true, member: { publicKey: SELF_PK, avatar: 'bundled://leaf' } });
        expect((await redeemInvite('CODE', 'Damo')).nodeHasPhoto).toBe(true);
    });

    it('says no photo when the node returns no member at all', async () => {
        redeemAnswers({ success: true, alreadyMember: true });
        expect((await redeemInvite('CODE', 'Damo')).nodeHasPhoto).toBe(false);
    });

    it('leaves a photo the node already holds alone when the redeem publish follows', async () => {
        // The end of the chain: `nodeHasPhoto` true means `nodeHasNoPhoto` false at the call
        // site, so even an empty local row does not license publishing the canonical copy.
        h.getFirstAsync.mockResolvedValue({
            public_key: SELF_PK, callsign: 'Damo', avatar_url: null,
            bio: null, contact_value: null, contact_visibility: null, archetype: null,
        });
        h.getCanonicalProfile.mockResolvedValue({ avatar: OLD_PHOTO, bio: 'hi' });
        redeemAnswers({ success: true, alreadyMember: true, member: { publicKey: SELF_PK, avatarUrl: PHOTO } });
        const res = await redeemInvite('CODE', 'Damo');

        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any;
        await pushProfileToServer({ nodeHasNoPhoto: !res.nodeHasPhoto });

        const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
        expect('avatar' in body).toBe(false);
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
