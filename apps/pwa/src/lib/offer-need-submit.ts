/**
 * Whether an Offer or Need on the map's post form can be posted, and what its button says (MapPage).
 *
 * One rule for both, so the label and the disabled state can't disagree. Where Beans are marked (the global node:
 * no price box, the form says "In a local community this is a price in Beans"), no price is asked and none is
 * required — the post goes with credits 0, as handleCreatePost sends. Every new Offer and Need carries at least one
 * photo (Marty, 26 Oct: market-photo-required). The label is in the member's language.
 */
import { t } from '@beanpool/core';

export type OfferNeedForm = {
    type: 'offer' | 'need';
    title: string;
    description: string;
    credits: string;
    priceMarked: boolean;
    hasLocation: boolean;
    photoCount: number;
    /** False where a photo is optional; left out, a photo is required. */
    photoRequired?: boolean;
    needBlocked: boolean;
    posting: boolean;
};

export function offerNeedSubmit(f: OfferNeedForm): { disabled: boolean; label: string } {
    const priceMissing = !f.priceMarked && f.credits === '';
    const fieldsMissing = !f.title.trim() || !f.description.trim() || priceMissing;
    const photoMissing = f.photoRequired !== false && f.photoCount === 0;
    const disabled = f.needBlocked || f.posting || fieldsMissing || !f.hasLocation || photoMissing;
    const label = f.posting ? t('Posting...')
        : f.needBlocked ? t('🟢 List an Offer first to post Needs')
        : !f.hasLocation ? t('📍 Map location required')
        : photoMissing ? t('📷 Add a photo')
        : fieldsMissing ? t('✏️ Fill required fields')
        : f.type === 'offer' ? t('Post Offer') : t('Post Need');
    return { disabled, label };
}
