import { describe, it, expect } from 'vitest';
import { readKnownConsent, shouldOfferConsent, consentHeading, readConsentTerms, joinAsksConsent, showsConsentCard, canWithdrawConsent } from './known-consent';

const TERMS = { known: true, debtLinePct: 50, quietDays: 60, version: '1:50:60', text: 'In this community, the admins can see your balance…', confirmed: true, consentedAt: null, consentedVersion: null };

describe('known consent (web)', () => {
    it('the join step asks only in a known community; an older node (404 body) shows nothing', () => {
        expect(joinAsksConsent(readConsentTerms(TERMS))).toBe(true);
        expect(joinAsksConsent(readConsentTerms({ ...TERMS, known: false }))).toBe(false);
        expect(readConsentTerms({ error: 'Not found' })).toBeNull();
        expect(joinAsksConsent(null)).toBe(false);
    });

    it('a member who agreed always sees what they agreed to, and can withdraw it at any time (GDPR Art. 7(3))', () => {
        const agreed = readKnownConsent({ ...TERMS, consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '1:50:60' })!;
        expect(showsConsentCard(agreed)).toBe(true);
        expect(canWithdrawConsent(agreed)).toBe(true);
        // The owner turned the dial off later: the consent is still theirs to withdraw.
        expect(showsConsentCard({ ...agreed, known: false })).toBe(true);
        const withdrawn = readKnownConsent({ ...TERMS, withdrawnAt: '2026-10-05T00:00:00Z' })!;
        expect(withdrawn.withdrawnAt).toBe('2026-10-05T00:00:00Z');
        expect(canWithdrawConsent(withdrawn)).toBe(false);
        expect(showsConsentCard(withdrawn)).toBe(true);
        expect(readKnownConsent(TERMS)!.withdrawnAt).toBeNull();
        expect(showsConsentCard(readKnownConsent({ ...TERMS, known: false }))).toBe(false);
        expect(showsConsentCard(null)).toBe(false);
    });

    it('Settings offers it until the member agrees to the current text, and again when the lines change', () => {
        expect(shouldOfferConsent(readKnownConsent(TERMS))).toBe(true);
        expect(shouldOfferConsent(readKnownConsent({ ...TERMS, consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '1:50:60' }))).toBe(false);
        const changed = readKnownConsent({ ...TERMS, version: '1:90:30', consentedVersion: '1:50:60' })!;
        expect(shouldOfferConsent(changed)).toBe(true);
        expect(consentHeading(changed)).toBe('Your community changed what its admins can see');
        expect(shouldOfferConsent(readKnownConsent({ ...TERMS, known: false }))).toBe(false);
        expect(shouldOfferConsent(null)).toBe(false);
    });

    it('asks again at wording 4 though the lines are the same (review r4177156495: what the two alerts with Beans fire on)', () => {
        expect(shouldOfferConsent(readKnownConsent({ ...TERMS, version: '4:50:60', consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '3:50:60' }))).toBe(true);
        expect(shouldOfferConsent(readKnownConsent({ ...TERMS, version: '4:50:60', consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '4:50:60' }))).toBe(false);
    });

    it('asks again at wording 5 (queue item 29: every look at the disputes and alerts is logged, member stats show only totals)', () => {
        expect(shouldOfferConsent(readKnownConsent({ ...TERMS, version: '5:50:60', consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '4:50:60' }))).toBe(true);
        expect(shouldOfferConsent(readKnownConsent({ ...TERMS, version: '5:50:60', consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '5:50:60' }))).toBe(false);
    });
});
