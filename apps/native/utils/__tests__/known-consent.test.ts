import { describe, it, expect } from 'vitest';
import { consentTextParts, readKnownConsent, saveKnownConsent, shouldOfferConsent, consentHeading, readConsentTerms, joinAsksConsent, showsConsentCard, canWithdrawConsent } from '../known-consent';

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

    // Rehearsal 5 Oct, d2: signedRequestWithMethod answers the parsed JSON, so the card's old `(res as Response).json()`
    // threw on every saved answer and showed "could not be reached" while the node had saved it.
    it('a saved Withdraw or I agree shows the saved state at once, with no error', async () => {
        const agreed = { ...TERMS, consentedAt: '2026-10-05T00:00:00Z', consentedVersion: '1:50:60' };
        const saved = await saveKnownConsent(async () => agreed);
        expect(saved).toEqual({ consent: readKnownConsent(agreed) });
        const withdrawn = await saveKnownConsent(async () => ({ ...TERMS, withdrawnAt: '2026-10-05T01:00:00Z' }));
        expect('consent' in withdrawn && canWithdrawConsent(withdrawn.consent)).toBe(false);
        expect('consent' in withdrawn && withdrawn.consent.withdrawnAt).toBe('2026-10-05T01:00:00Z');
    });

    it('a real failure still says it was not saved', async () => {
        expect(await saveKnownConsent(async () => { throw new TypeError('Network request failed'); }))
            .toEqual({ error: 'Not saved: the community could not be reached.' });
        expect(await saveKnownConsent(async () => { throw new Error('The community changed what admins can see. Read it again.'); }))
            .toEqual({ error: 'The community changed what admins can see. Read it again.' });
        expect(await saveKnownConsent(async () => { throw new Error('Request failed: 500'); })).toEqual({ error: 'Not saved. Try again later.' });
        expect(await saveKnownConsent(async () => ({ error: 'odd' }))).toEqual({ error: 'Not saved. Try again later.' });
    });
});

// Rehearsal 5 Oct, d1: the wording-5 text as the node serves it at 50% and 60 days (apps/server engine/community-health.ts).
const V5_TEXT = 'In this community, the admins can see your balance if it goes past 50% of your credit line or if you stay in debit for 60 days without a sale. That\'s how a LETS has always worked. Every look at your balance is logged, and you can take this back at any time in Settings. Whatever you choose, any admin can see some of your trades: a trade that isn\'t finished yet or that an admin settled (who with, the listing, the price, and your one-to-one chat with them, which they can\'t read if it is private), so a stuck trade can be settled; a trade whose Beans were left stuck when a member was removed on an older server (the trade\'s status, the listing, the price, its dates, the Beans left stuck, how many payments went through it, and the last one\'s amount and note); a fraud alert that names you if you and one member buy from each other back and forth, about evenly, past a limit, with the Beans in total and how evenly they went each way; one that names you, with the Beans in total and how many of the members you invited have traded with no one but you, if members you invited send you Beans past a limit within a set number of days, or if you are one of those members; one that names you, with how much of the group\'s trading is with each other but no Beans, if you are in a group of members, at least half of them new, who trade mostly with each other; and an alert that names you if no Beans have moved in or out of your account for a set number of days. Every look at one of those trades is logged, with who looked, when, and at which trades; a look at the alerts that name you is logged the first time each admin opens them, and again at that admin\'s first look after 24 hours, and the looks in between add no line. The owner and the admins can see that log. The member stats the admins see show how many posts you have up and messages you have sent, and of trades only the whole community\'s totals, not yours. Every member, admins included, sees your trust profile: how many of your trades were finished and how many were cancelled, and the share finished, how many Bean payments you have sent to or received from members plus the trades you have finished, with how many different members you have paid, been paid by or traded with, how many payments and trades you have done with the member looking, and your Trust Points. That isn\'t logged, because every member can see it. Nothing else of your trades. Whoever runs this community\'s server holds its whole database, your balance and trades included, and its backups, snapshots and standby copies.';

describe('the consent text, laid out without changing a word', () => {
    it('is the summary, then the list lead, one item per clause, and each later sentence: joined, the text again', () => {
        const { summary, rest } = consentTextParts(V5_TEXT);
        expect([summary, ...rest.map((b) => b.text)].join(' ')).toBe(V5_TEXT);
        expect(summary).toBe('In this community, the admins can see your balance if it goes past 50% of your credit line or if you stay in debit for 60 days without a sale. That\'s how a LETS has always worked. Every look at your balance is logged, and you can take this back at any time in Settings.');
        expect(rest[0]).toEqual({ text: 'Whatever you choose, any admin can see some of your trades:', item: false });
        const items = rest.filter((b) => b.item);
        expect(items).toHaveLength(6);
        expect(items[0].text.startsWith('a trade that isn\'t finished yet')).toBe(true);
        expect(items[1].text.startsWith('a trade whose Beans were left stuck')).toBe(true);
        expect(items[5].text).toBe('and an alert that names you if no Beans have moved in or out of your account for a set number of days.');
        expect(rest[rest.length - 1].text).toBe('Whoever runs this community\'s server holds its whole database, your balance and trades included, and its backups, snapshots and standby copies.');
        expect(rest.every((b) => b.text.length < 700)).toBe(true);
    });

    it('a text that does not split that way comes back whole', () => {
        expect(consentTextParts('One plain sentence.')).toEqual({ summary: 'One plain sentence.', rest: [] });
        expect(consentTextParts('See: a; b.')).toEqual({ summary: 'See: a; b.', rest: [] });
        expect(consentTextParts('')).toEqual({ summary: '', rest: [] });
    });
});
