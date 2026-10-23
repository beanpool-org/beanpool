/**
 * Whether an Offer or Need on the map's post form can be posted, and what its button says (MapPage).
 *
 * One rule for both, so the label and the disabled state can't disagree. Where Beans are marked (the global node:
 * no price box, the form says "In a local community this is a price in Beans"), no price is asked and none is
 * required — the post goes with credits 0, as handleCreatePost sends. Before 14 Oct both checks still asked for a
 * price there, so an Offer on global could never be posted ("✏️ Fill required fields" with every visible field filled).
 * The label is in the member's language.
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
    /** False where a Need's photo is optional (Beans off: postRulesFor().needPhoto). Left out, a photo is required. */
    photoRequired?: boolean;
    needBlocked: boolean;
    posting: boolean;
};

export function offerNeedSubmit(f: OfferNeedForm): { disabled: boolean; label: string } {
    const priceMissing = !f.priceMarked && f.credits === '';
    const fieldsMissing = !f.title.trim() || !f.description.trim() || priceMissing;
    const disabled = f.needBlocked || f.posting || fieldsMissing || !f.hasLocation || (f.photoRequired !== false && f.photoCount === 0);
    const label = f.posting ? t('Posting...')
        : f.needBlocked ? t('🟢 List an Offer first to post Needs')
        : !f.hasLocation ? t('📍 Map location required')
        : fieldsMissing ? t('✏️ Fill required fields')
        : f.type === 'offer' ? t('Post Offer') : t('Post Need');
    return { disabled, label };
}
