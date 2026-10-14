import { describe, it, expect } from 'vitest';
import { offerNeedSubmit, type OfferNeedForm } from './offer-need-submit';

const filled: OfferNeedForm = {
    type: 'offer', title: 'Vibe coding', description: 'Vibe coding for your project', credits: '',
    priceMarked: true, hasLocation: true, photoCount: 1, needBlocked: false, posting: false,
};

describe('posting an Offer or Need from the map', () => {
    it('on the global node (Beans marked, no price box) a filled Offer can be posted with no price', () => {
        expect(offerNeedSubmit(filled)).toEqual({ disabled: false, label: 'Post Offer' });
    });

    it('in a local community (Beans on) the price is still required', () => {
        expect(offerNeedSubmit({ ...filled, priceMarked: false })).toEqual({ disabled: true, label: '✏️ Fill required fields' });
        expect(offerNeedSubmit({ ...filled, priceMarked: false, credits: '0' })).toEqual({ disabled: false, label: 'Post Offer' });
    });

    it('title, description, location and a photo are still required everywhere', () => {
        expect(offerNeedSubmit({ ...filled, title: ' ' }).disabled).toBe(true);
        expect(offerNeedSubmit({ ...filled, description: '' }).label).toBe('✏️ Fill required fields');
        expect(offerNeedSubmit({ ...filled, hasLocation: false }).label).toBe('📍 Map location required');
        expect(offerNeedSubmit({ ...filled, photoCount: 0 }).disabled).toBe(true);
    });

    it('where a Need\'s photo is optional (Beans off), a Need with no photo can be posted; left out, the photo is required', () => {
        const need: OfferNeedForm = { ...filled, type: 'need', photoCount: 0 };
        expect(offerNeedSubmit({ ...need, photoRequired: false })).toEqual({ disabled: false, label: 'Post Need' });
        expect(offerNeedSubmit({ ...need, photoRequired: true }).disabled).toBe(true);
        expect(offerNeedSubmit(need).disabled).toBe(true);
    });

    it('a Need waits for an Offer first, and the button says so', () => {
        expect(offerNeedSubmit({ ...filled, type: 'need', needBlocked: true })).toEqual({ disabled: true, label: '🟢 List an Offer first to post Needs' });
    });
});
