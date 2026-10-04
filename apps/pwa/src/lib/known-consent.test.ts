import { describe, it, expect } from 'vitest';
import { readKnownConsent, shouldOfferConsent, consentHeading, readConsentTerms, joinAsksConsent } from './known-consent';

const TERMS = { known: true, debtLinePct: 50, quietDays: 60, version: '1:50:60', text: 'In this community, the admins can see your balance…', confirmed: true, consentedAt: null, consentedVersion: null };

describe('known consent (web)', () => {
    it('the join step asks only in a known community; an older node (404 body) shows nothing', () => {
        expect(joinAsksConsent(readConsentTerms(TERMS))).toBe(true);
        expect(joinAsksConsent(readConsentTerms({ ...TERMS, known: false }))).toBe(false);
        expect(readConsentTerms({ error: 'Not found' })).toBeNull();
        expect(joinAsksConsent(null)).toBe(false);
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
});
