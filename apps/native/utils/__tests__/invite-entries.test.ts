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
import { communityLinkMessage, invitesOffRefusal, INVITES_OFF_FALLBACK } from '../invite-entries';

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

    it("reads the node's switch through invitesOn", () => {
        expect(src).toMatch(/const makesInvites = invitesOn\(nodeProfile\?\.features\);/);
        expect(gate).toBeGreaterThan(0);
        expect(otherwise).toBeGreaterThan(gate);
        expect(redeemSection).toBeGreaterThan(otherwise);
    });

    it('every way to make or share an invite is drawn only where the node makes them', () => {
        for (const entry of ['📤 Invite Someone', 'onPress={handleGenerate}', '<QRCode', '📤 Share Invite', 'shareInvite(inv.code)']) {
            expect(count(entry)).toBe(1);
            expect(makes).toContain(entry);
            expect(noInvites).not.toContain(entry);
        }
    });

    it("where it makes none: the community's link, shared as communityLinkMessage says", () => {
        expect(noInvites).toContain('onPress={shareCommunityLink}');
        expect(src).toMatch(/Share\.share\(\{ message: communityLinkMessage\(anchorUrl\) \}\)/);
    });

    it("a generate the node refuses for that makes no offline ticket", () => {
        const handler = src.slice(src.indexOf('const handleGenerate'), src.indexOf('const shareInvite'));
        expect(handler).toContain('invitesOffRefusal(res.status');
        expect(handler.indexOf('invitesOffRefusal(')).toBeLessThan(handler.indexOf('makeOfflineTicket('));
    });
});
