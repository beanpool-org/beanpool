/**
 * No invites on the worldwide community (Marty, 2026-10-01: "Off on global"; apps/server config/node-profile.ts
 * `invites`): anyone joins it with a sign-in, so People → Invites there offers no code, QR, offline ticket or "Share
 * Invite", only the community's own link to share. Every local community, and a node too old to say, exactly as before.
 *
 * Screens can't be drawn here (vitest.config.ts: logic, not screens), so the last block reads People's source and checks
 * that every way to make an invite goes through the helpers tested above it.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Device modules, stubbed at the boundary (vitest.config.ts), for node-profile.ts: the signer's random bytes and storage.
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
import { invitesOn, readNodeProfile } from '../node-profile';
import {
    communityLinkMessage, invitesOffRefusal, INVITES_OFF_FALLBACK, GUEST_NO_INVITES_TEXT, onlyAdminsInvite, mayInviteHere,
    mayMakeOfflineTicket, offlineTicketRefusal, adminsOnlyText, adminsOnlyRefusal, ADMINS_ONLY_FALLBACK, MEMBER_TICKET_REFUSED_TEXT,
} from '../invite-entries';

/** What the global node reports (test-node-profile's BUILT_TODAY.global), read as the phone reads it. */
const GLOBAL = readNodeProfile({
    profile: 'global',
    features: {
        beans: false, escrow: false, enterprises: false, openJoin: true, knocks: false, distanceSearch: true, probation: true,
        autoHideReports: true, autoMute: true, guestListingsOnly: true, exampleListings: true, decisions: false, invites: false,
    },
})!.features;
const LOCAL = readNodeProfile({
    profile: 'local',
    features: {
        beans: true, escrow: true, enterprises: true, openJoin: false, knocks: true, distanceSearch: true, probation: false,
        autoHideReports: false, autoMute: false, guestListingsOnly: false, exampleListings: false, decisions: true, invites: true,
    },
})!.features;
/** A server from before the switch: says nothing about invites. */
const OLD = readNodeProfile({ profile: 'local', features: { beans: true, knocks: true } })!.features;

describe('invitesOn: whether a node makes invites', () => {
    it('the phone keeps what the node said, and only a boolean', () => {
        expect(GLOBAL.invites).toBe(false);
        expect(LOCAL.invites).toBe(true);
        expect(readNodeProfile({ profile: 'global', features: { invites: 'no' } })!.features.invites).toBeUndefined();
    });

    it('only a node that says outright it makes none makes none', () => {
        expect(invitesOn(GLOBAL)).toBe(false);
        expect(invitesOn(LOCAL)).toBe(true);
        expect(invitesOn(OLD)).toBe(true);
        expect(invitesOn({})).toBe(true);
        expect(invitesOn(null)).toBe(true);
        expect(invitesOn(undefined)).toBe(true);
    });
});

describe('what the screen shares and says', () => {
    it("the link is the community's plain address: no code, no ?invite=", () => {
        expect(communityLinkMessage('https://global.beanpool.org/')).toBe('Join me on BeanPool: https://global.beanpool.org');
        expect(communityLinkMessage(' https://global.beanpool.org ')).not.toMatch(/invite|INV-|BP-/i);
    });

    it("a generate the node refuses because it takes no invites gives the node's words, so no offline ticket is made", () => {
        const words = 'This community doesn’t use invites: anyone joins it with a sign-in in the BeanPool app. To bring someone here, share its link.';
        expect(invitesOffRefusal(404, { error: words, code: 'feature_off', feature: 'invites' })).toBe(words);
        expect(invitesOffRefusal(404, { code: 'feature_off' })).toBe(INVITES_OFF_FALLBACK);
        expect(invitesOffRefusal(404, { code: 'feature_off', error: '  ' })).toBe(INVITES_OFF_FALLBACK);
    });

    it('any other answer is not that refusal: the screen does what it always did', () => {
        expect(invitesOffRefusal(200, { success: true })).toBeNull();
        expect(invitesOffRefusal(403, { error: 'Only registered members can generate invites' })).toBeNull();
        expect(invitesOffRefusal(429, { code: 'writer_limit', error: 'Too many' })).toBeNull();
        expect(invitesOffRefusal(404, { error: 'Not Found' })).toBeNull();
        expect(invitesOffRefusal(404, null)).toBeNull();
        expect(invitesOffRefusal(404, 'Not Found')).toBeNull();
    });
});

describe('People → Invites goes through the helpers (source check)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../..', 'app/(tabs)/people.tsx'), 'utf-8');
    const count = (needle: string) => src.split(needle).length - 1;
    const gate = src.indexOf('{!makesInvites ? (');
    const otherwise = src.indexOf(') : (', gate);
    const redeemSection = src.indexOf('REDEEM INVITE SECTION');
    const noInvites = src.slice(gate, otherwise);
    const makes = src.slice(otherwise, redeemSection);
    /** The two branches exist, in this order, before the redeem section: without them every check below reads nothing. */
    const branchesFound = () => {
        expect(gate).toBeGreaterThan(0);
        expect(otherwise).toBeGreaterThan(gate);
        expect(redeemSection).toBeGreaterThan(otherwise);
    };

    it("reads the node's switch through invitesOn", () => {
        expect(src).toMatch(/const makesInvites = invitesOn\(nodeProfile\?\.features\);/);
        branchesFound();
    });

    it('every way to make or share an invite is drawn only where the node makes them', () => {
        branchesFound();
        for (const entry of ['📤 Invite Someone', 'onPress={handleGenerate}', '<QRCode', '📤 Share Invite', 'shareInvite(inv.code)']) {
            expect(count(entry)).toBe(1);
            expect(makes).toContain(entry);
            expect(noInvites).not.toContain(entry);
        }
    });

    it("where it makes none: the community's link, shared as communityLinkMessage says", () => {
        branchesFound();
        expect(noInvites).toContain('onPress={shareCommunityLink}');
        expect(src).toMatch(/Share\.share\(\{ message: communityLinkMessage\(anchorUrl\) \}\)/);
    });

    it("a generate the node refuses for that makes no offline ticket", () => {
        const handler = src.slice(src.indexOf('const handleGenerate'), src.indexOf('const shareInvite'));
        expect(handler).toContain('invitesOffRefusal(res.status');
        expect(handler.indexOf('invitesOffRefusal(')).toBeLessThan(handler.indexOf('makeOfflineTicket('));
    });

    it('a guest where no invites are made: no invite-code form, the sentence instead; invites on is unchanged', () => {
        expect(src).toMatch(/const guestNoInvites = isGuest && !makesInvites;/);
        expect(src).toContain('GUEST_NO_INVITES_TEXT');
        expect(GUEST_NO_INVITES_TEXT).toMatch(/doesn’t use invite codes/);
        expect(GUEST_NO_INVITES_TEXT).toMatch(/isn’t possible in the app yet/);
        // The whole redeem section (heading, field, button) sits inside the guard.
        const start = src.indexOf('{!guestNoInvites && (');
        const end = src.indexOf('{isGuest && (', start);
        expect(start).toBeGreaterThan(0);
        const form = src.slice(start, end);
        for (const part of ['REDEEM INVITE SECTION', 'placeholder="Invite URL or token"', 'onPress={handleRedeem}', 'Complete Registration']) {
            expect(count(part) >= 1).toBe(true);
            expect(form).toContain(part);
        }
        expect(src.indexOf('Complete Registration')).toBeGreaterThan(start);
        // The old copy stays for a guest where invites are on.
        expect(src).toContain('You cannot generate invites or participate in community trade until you register your identity.');
        // The no-invite branch is told apart by makesInvites, not by anything else (an old node that says nothing counts as on).
        expect(invitesOn(undefined)).toBe(true);
        expect(invitesOn(GLOBAL)).toBe(false);
        expect(invitesOn(LOCAL)).toBe(true);
    });
});

// ── Who may invite (the door) ──────────────────────────────────────────────────────────────────────────────────────────
// Community modes slice 1 (apps/server config/door.ts): a community may choose that only its owners and admins invite.
// /api/community/info says so as `features.door` ('members' | 'admins', 'open' on the worldwide community).

const ADMINS_DOOR = readNodeProfile({ profile: 'local', features: { beans: true, knocks: true, invites: true, door: 'admins' } })!.features;
const ADMINS_DOOR_NO_KNOCKS = readNodeProfile({ profile: 'local', features: { beans: true, knocks: false, invites: true, door: 'admins' } })!.features;
const MEMBERS_DOOR = readNodeProfile({ profile: 'local', features: { beans: true, knocks: true, invites: true, door: 'members' } })!.features;

describe('the door, as the phone reads it', () => {
    it('keeps a door the node names, and only one of the three', () => {
        expect(ADMINS_DOOR.door).toBe('admins');
        expect(MEMBERS_DOOR.door).toBe('members');
        expect(readNodeProfile({ profile: 'global', features: { invites: false, door: 'open' } })!.features.door).toBe('open');
        expect(readNodeProfile({ profile: 'local', features: { door: 'everyone' } })!.features.door).toBeUndefined();
        expect(readNodeProfile({ profile: 'local', features: { door: true } })!.features.door).toBeUndefined();
        expect(OLD.door).toBeUndefined();
    });

    it('only a node that says `admins` keeps invites to its admins', () => {
        expect(onlyAdminsInvite(ADMINS_DOOR)).toBe(true);
        for (const f of [MEMBERS_DOOR, LOCAL, OLD, GLOBAL, {}, null, undefined]) expect(onlyAdminsInvite(f)).toBe(false);
    });
});

describe('mayInviteHere: whether this member makes invites here', () => {
    it('any member, on a members door or a node too old to say: exactly as before', () => {
        for (const role of [null, 'moderator', 'admin', 'owner', undefined] as const) {
            expect(mayInviteHere(MEMBERS_DOOR, role)).toBe(true);
            expect(mayInviteHere(LOCAL, role)).toBe(true);
            expect(mayInviteHere(OLD, role)).toBe(true);
        }
    });

    it('where only admins invite: an owner or admin, never a member or a moderator', () => {
        expect(mayInviteHere(ADMINS_DOOR, 'owner')).toBe(true);
        expect(mayInviteHere(ADMINS_DOOR, 'admin')).toBe(true);
        expect(mayInviteHere(ADMINS_DOOR, 'moderator')).toBe(false);
        expect(mayInviteHere(ADMINS_DOOR, null)).toBe(false);
    });

    it("a role the node hasn't said yet counts as before: the node decides, and says why", () => {
        expect(mayInviteHere(ADMINS_DOOR, undefined)).toBe(true);
    });

    it('no invites at all where the node takes none, whoever asks', () => {
        for (const role of [null, 'admin', 'owner', undefined] as const) expect(mayInviteHere(GLOBAL, role)).toBe(false);
    });
});

describe('an offline ticket where only admins invite', () => {
    it('only from a member the node has said is an owner or admin: a role not heard is no answer', () => {
        expect(mayMakeOfflineTicket(ADMINS_DOOR, 'owner')).toBe(true);
        expect(mayMakeOfflineTicket(ADMINS_DOOR, 'admin')).toBe(true);
        for (const role of [null, 'moderator', undefined] as const) expect(mayMakeOfflineTicket(ADMINS_DOOR, role)).toBe(false);
    });

    it('on a members door, or a node too old to say, as before; never where the node takes no invites', () => {
        for (const role of [null, 'moderator', 'admin', undefined] as const) {
            expect(mayMakeOfflineTicket(MEMBERS_DOOR, role)).toBe(true);
            expect(mayMakeOfflineTicket(OLD, role)).toBe(true);
            expect(mayMakeOfflineTicket(GLOBAL, role)).toBe(false);
        }
    });

    it('the refusal never tells an admin that only admins invite; a member is told, an unknown role is told to retry', () => {
        expect(offlineTicketRefusal(null).text).toBe('In this community only its admins invite people.');
        expect(offlineTicketRefusal('moderator').text).toBe('In this community only its admins invite people.');
        const unknown = offlineTicketRefusal(undefined);
        expect(unknown.text).toBe('You’re offline. Try again when you’re back online.');
        expect(unknown.text).not.toMatch(/admins/);
        expect(unknown.title).not.toMatch(/admins/);
    });

    it('a remembered owner or admin counts as heard: an offline ticket is made', () => {
        // people.tsx hands the remembered role to inviteRole when the node gives no answer.
        for (const remembered of ['owner', 'admin'] as const) expect(mayMakeOfflineTicket(ADMINS_DOOR, remembered)).toBe(true);
    });
});

describe('what a member who may not invite is told', () => {
    it('plain words, no tier, and a way forward', () => {
        for (const knocks of [true, false]) {
            const text = adminsOnlyText(knocks);
            expect(text).toMatch(/only its admins invite people/);
            expect(text).toMatch(/ask an admin/i);
            expect(text).not.toMatch(/tier|Steward|Elder|Resident|Newcomer|badge|locked/i);
        }
        expect(adminsOnlyText(true)).toMatch(/ask to join/);
        expect(adminsOnlyText(false)).not.toMatch(/ask to join|Share/);
    });

    it("a generate the node refuses for it (403 admins_only) gives the node's words, so no offline ticket is made", () => {
        const words = 'In this community only its admins invite people. Ask an admin to bring them in.';
        expect(adminsOnlyRefusal(403, { error: words, code: 'admins_only' })).toBe(words);
        expect(adminsOnlyRefusal(403, { code: 'admins_only' })).toBe(ADMINS_ONLY_FALLBACK);
        expect(adminsOnlyRefusal(403, { code: 'admins_only', error: ' ' })).toBe(ADMINS_ONLY_FALLBACK);
        expect(adminsOnlyRefusal(403, { error: 'Only registered members can generate invites' })).toBeNull();
        expect(adminsOnlyRefusal(404, { code: 'feature_off' })).toBeNull();
        expect(adminsOnlyRefusal(200, { success: true })).toBeNull();
        expect(adminsOnlyRefusal(403, null)).toBeNull();
    });
});

describe('People → Invites where only admins invite (source check)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../..', 'app/(tabs)/people.tsx'), 'utf-8');
    const gate = src.indexOf(') : !mayInvite ? (');
    const otherwise = src.indexOf(') : (', gate);
    const redeemSection = src.indexOf('REDEEM INVITE SECTION');
    const adminsOnly = src.slice(gate, otherwise);
    const makes = src.slice(otherwise, redeemSection);
    const found = () => {
        expect(src.indexOf('{!makesInvites ? (')).toBeGreaterThan(0);
        expect(gate).toBeGreaterThan(src.indexOf('{!makesInvites ? ('));
        expect(otherwise).toBeGreaterThan(gate);
        expect(redeemSection).toBeGreaterThan(otherwise);
    };

    it("reads the door and the member's role through the helpers", () => {
        expect(src).toMatch(/const doorAdminsOnly = onlyAdminsInvite\(nodeProfile\?\.features\);/);
        expect(src).toMatch(/const mayInvite = mayInviteHere\(nodeProfile\?\.features, inviteRole\);/);
        // The role is the node's answer, asked only where only admins invite.
        expect(src).toMatch(/if \(!doorAdminsOnly \|\| !identity \|\| !anchorUrl \|\| isGuest\) return;/);
        expect(src).toContain('askNodeRole(anchorUrl, identity)');
        found();
    });

    it('a member who may not invite gets the plain words and no way to make an invite', () => {
        found();
        expect(adminsOnly).toContain('adminsOnlyText(takesKnocks)');
        for (const entry of ['📤 Invite Someone', 'onPress={handleGenerate}', '<QRCode', '📤 Share Invite', 'shareInvite(']) {
            expect(adminsOnly).not.toContain(entry);
            expect(makes).toContain(entry);
        }
        // The link only where someone can use it to ask to join.
        expect(adminsOnly).toMatch(/\{takesKnocks && \([\s\S]*onPress=\{shareCommunityLink\}/);
    });

    it('with no answer from the node, the last role it gave for this node and key is used, and kept after each answer', () => {
        const effect = src.slice(src.indexOf('askNodeRole(anchorUrl, identity)'), src.indexOf('const mayInvite = mayInviteHere'));
        expect(effect).toContain('persistNodeRole(anchorUrl, identity.publicKey, r.role)');
        expect(effect).toContain('rememberNodeRole(anchorUrl, identity.publicKey, r)');
        expect(effect).toContain('readPersistedNodeRole(anchorUrl, identity.publicKey)');
        expect(effect.indexOf('readPersistedNodeRole(')).toBeGreaterThan(effect.indexOf('if (r) {'));
        expect(src).toContain('offlineTicketRefusal(inviteRole)');
    });

    it("a generate refused as admins_only, or offline with no answer on the role, makes no offline ticket", () => {
        const handler = src.slice(src.indexOf('const handleGenerate'), src.indexOf('const shareInvite'));
        const ticket = handler.indexOf('makeOfflineTicket(');
        expect(handler).toContain('adminsOnlyRefusal(res.status, body)');
        expect(handler.indexOf('adminsOnlyRefusal(')).toBeLessThan(ticket);
        expect(handler).toContain('mayMakeOfflineTicket(nodeProfile?.features, inviteRole)');
        expect(handler.indexOf('mayMakeOfflineTicket(')).toBeLessThan(ticket);
    });
});

describe("the join's pre-flight: a member's ticket where only admins invite now", () => {
    it('the welcome screen says so in plain words, not "not recognised"', () => {
        const welcome = fs.readFileSync(path.resolve(__dirname, '../..', 'app/welcome.tsx'), 'utf-8');
        const fn = welcome.slice(welcome.indexOf('function inviteProblemMessage'), welcome.indexOf('function joinedLabel'));
        expect(fn).toMatch(/case 'admins_only':\s*return MEMBER_TICKET_REFUSED_TEXT;/);
        expect(fn.indexOf("case 'admins_only'")).toBeLessThan(fn.indexOf('default:'));
        expect(MEMBER_TICKET_REFUSED_TEXT).toMatch(/only its admins bring people in/);
        expect(MEMBER_TICKET_REFUSED_TEXT).toMatch(/Ask an admin for a fresh invite/);
    });
});
