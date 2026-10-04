import { describe, it, expect } from 'vitest';
import { readKnownConsent, shouldOfferConsent, consentHeading, readConsentTerms, joinAsksConsent, showsConsentCard, canWithdrawConsent } from '../known-consent';

const TERMS = { known: true, debtLinePct: 50, quietDays: 60, version: '1:50:60', text: 'In this community, the admins can see your balance…', confirmed: true, consentedAt: null, consentedVersion: null };

describe('known consent', () => {
    it('reads only a whole answer', () => {
        expect(readKnownConsent(TERMS)).toMatchObject({ known: true, version: '1:50:60', consentedVersion: null });
        expect(readKnownConsent({ error: 'Not found', code: 'feature_off' })).toBeNull();
        expect(readKnownConsent(null)).toBeNull();
    });

    it('is offered in a known community until the member agrees to the current text', () => {
        expect(shouldOfferConsent(readKnownConsent(TERMS))).toBe(true);
        expect(shouldOfferConsent(readKnownConsent({ ...TERMS, consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '1:50:60' }))).toBe(false);
        expect(shouldOfferConsent(readKnownConsent({ ...TERMS, known: false }))).toBe(false);
        expect(shouldOfferConsent(null)).toBe(false);
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

    it('asks again when the community changes its lines', () => {
        const changed = readKnownConsent({ ...TERMS, version: '1:90:30', consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '1:50:60' })!;
        expect(shouldOfferConsent(changed)).toBe(true);
        expect(consentHeading(changed)).toBe('Your community changed what its admins can see');
        expect(consentHeading(readKnownConsent(TERMS)!)).toBe("What this community's admins can see");
    });

    it('asks again when the wording changes and the lines do not (wording 2, review r4176931267)', () => {
        expect(shouldOfferConsent(readKnownConsent({ ...TERMS, version: '2:50:60', consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '1:50:60' }))).toBe(true);
    });

    it('asks again at wording 3 (round 4: posts and messages counts, the ring and inactivity alerts, the operator\'s copies)', () => {
        const onTwo = readKnownConsent({ ...TERMS, version: '3:50:60', consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '2:50:60' })!;
        expect(shouldOfferConsent(onTwo)).toBe(true);
        expect(shouldOfferConsent(readKnownConsent({ ...TERMS, version: '3:50:60', consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '3:50:60' }))).toBe(false);
    });

    it('asks again at wording 4 (review r4177156495: what the two alerts with Beans fire on)', () => {
        const onThree = readKnownConsent({ ...TERMS, version: '4:50:60', consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '3:50:60' })!;
        expect(shouldOfferConsent(onThree)).toBe(true);
        expect(shouldOfferConsent(readKnownConsent({ ...TERMS, version: '4:50:60', consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '4:50:60' }))).toBe(false);
    });

    it('asks again at wording 5 (queue item 29: every look at the disputes and alerts is logged, member stats show only totals)', () => {
        const onFour = readKnownConsent({ ...TERMS, version: '5:50:60', consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '4:50:60' })!;
        expect(shouldOfferConsent(onFour)).toBe(true);
        expect(shouldOfferConsent(readKnownConsent({ ...TERMS, version: '5:50:60', consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '5:50:60' }))).toBe(false);
    });

    it('the join screen asks only in a known community, and an older node (404 body) shows nothing', () => {
        const terms = readConsentTerms({ known: true, debtLinePct: 50, quietDays: 60, version: '1:50:60', text: TERMS.text });
        expect(joinAsksConsent(terms)).toBe(true);
        expect(joinAsksConsent(readConsentTerms({ known: false, version: '1:50:60', text: TERMS.text }))).toBe(false);
        expect(readConsentTerms({ error: 'Not found' })).toBeNull();
        expect(joinAsksConsent(null)).toBe(false);
    });
});
