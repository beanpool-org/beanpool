import { describe, it, expect } from 'vitest';
import { readKnownConsent, shouldOfferConsent, consentHeading, readConsentTerms, joinAsksConsent } from '../known-consent';

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

    it('asks again when the community changes its lines', () => {
        const changed = readKnownConsent({ ...TERMS, version: '1:90:30', consentedAt: '2026-10-04T00:00:00Z', consentedVersion: '1:50:60' })!;
        expect(shouldOfferConsent(changed)).toBe(true);
        expect(consentHeading(changed)).toBe('Your community changed what its admins can see');
        expect(consentHeading(readKnownConsent(TERMS)!)).toBe("What this community's admins can see");
    });

    it('the join screen asks only in a known community, and an older node (404 body) shows nothing', () => {
        const terms = readConsentTerms({ known: true, debtLinePct: 50, quietDays: 60, version: '1:50:60', text: TERMS.text });
        expect(joinAsksConsent(terms)).toBe(true);
        expect(joinAsksConsent(readConsentTerms({ known: false, version: '1:50:60', text: TERMS.text }))).toBe(false);
        expect(readConsentTerms({ error: 'Not found' })).toBeNull();
        expect(joinAsksConsent(null)).toBe(false);
    });
});
