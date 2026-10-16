/**
 * The sample community's example invitations (@beanpool/core SAMPLE_COMMUNITY.invites, `EXAMPLE-1234`) are drawn on the
 * Invites screen in preview, and may be drawn as a QR. Typed, pasted, scanned or opened as a link, no parser on the phone
 * may read one as an invite, an offline ticket, a pairing, a claim, a shared post or a community address, and the
 * system-link rewrite (app/+native-intent.ts) sends it nowhere new. The node refuses it too (apps/server
 * test-sample-id-guard.ts, through /api/invite/check).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { emit: vi.fn() },
}));
vi.mock('expo-web-browser', () => ({
    maybeCompleteAuthSession: vi.fn(),
    dismissBrowser: vi.fn(async () => undefined),
}));

import { SAMPLE_COMMUNITY } from '@beanpool/core';
import { redirectSystemPath } from '../../app/+native-intent';
import { deepLinkNodeOrigin, extractInviteToken, extractNodeOrigin, normaliseInviteCode } from '../invite-parser';
import { claimCodeFromScan, claimRouteFromSystemPath, isClaimCode, parseClaimLink } from '../claim-link';
import { isUnreadablePairingQr, parsePairingQr } from '../pair-device-target';
import { postIdFromLink } from '../event-extras';

const CODES = SAMPLE_COMMUNITY.invites.map(i => i.code);
/** What a QR or a share could carry: the code alone, padded, in lower case, and in each place a link puts a code. */
const FORMS = CODES.flatMap(code => [code, ` ${code}\n`, code.toLowerCase(), `/${code}`, code.replace('-', '')]);
/** The node's own code shape (@beanpool/engine generateShortCode) and an offline ticket's prefix. */
const INVITE_SHAPE = /^(INV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}|BP-)/i;

describe('an example invite code is no invitation on the phone', () => {
    it('the fixture has three, each EXAMPLE-dddd', () => {
        expect(CODES).toEqual(['EXAMPLE-1234', 'EXAMPLE-5678', 'EXAMPLE-9012']);
    });

    it('the invite parser never turns it into an INV- code or a ticket', () => {
        for (const raw of FORMS) {
            const token = extractInviteToken(raw);
            const code = normaliseInviteCode(raw);
            expect(token, raw).not.toMatch(INVITE_SHAPE);
            expect(code, raw).not.toMatch(INVITE_SHAPE);
            expect(code.startsWith('INV'), raw).toBe(false);
        }
        // The check works: a real-shaped code, and 8 letters and digits, do become an INV- code.
        expect(normaliseInviteCode('inv-abcd-efgh')).toBe('INV-ABCD-EFGH');
        expect(normaliseInviteCode('ABCDEFGH')).toBe('INV-ABCD-EFGH');
    });

    it('it names no community address', () => {
        for (const raw of FORMS) {
            expect(extractNodeOrigin(raw), raw).toBeNull();
            expect(deepLinkNodeOrigin(raw, () => undefined), raw).toBeNull();
        }
    });

    it('it is no pairing, claim or shared-post link', () => {
        for (const raw of FORMS) {
            expect(parsePairingQr(raw), raw).toBeNull();
            expect(isUnreadablePairingQr(raw), raw).toBe(false);
            expect(parseClaimLink(raw), raw).toBeNull();
            expect(claimRouteFromSystemPath(raw), raw).toBeNull();
            expect(claimCodeFromScan(raw, 'https://a.example'), raw).toBeNull();
            expect(isClaimCode(raw), raw).toBe(false);
            expect(postIdFromLink(raw), raw).toBeNull();
        }
    });

    it('the system-link rewrite sends it nowhere new: no invite, claim, pair or post route', () => {
        for (const raw of FORMS) {
            for (const initial of [true, false]) {
                const to = redirectSystemPath({ path: raw, initial });
                expect(to, raw).toBe(raw);
                expect(String(to), raw).not.toMatch(/invite|claim|pair|post|join/i);
            }
        }
    });
});
