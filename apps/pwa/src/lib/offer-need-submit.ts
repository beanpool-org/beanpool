/**
 * Whether an Offer or Need on the map's post form can be posted, and what its button says (MapPage).
 *
 * One rule for both, so the label and the disabled state can't disagree. Where Beans are marked (the global node:
 * no price box, the form says "In a local community this is a price in Beans"), no price is asked and none is
 * required — the post goes with credits 0, as handleCreatePost sends. Before 14 Oct both checks still asked for a
 * price there, so an Offer on global could never be posted ("✏️ Fill required fields" with every visible field filled).
 */
export type OfferNeedForm = {
    type: 'offer' | 'need';
    title: string;
    description: string;
    credits: string;
    priceMarked: boolean;
    hasLocation: boolean;
    photoCount: number;
    needBlocked: boolean;
    posting: boolean;
};

export function offerNeedSubmit(f: OfferNeedForm): { disabled: boolean; label: string } {
    const priceMissing = !f.priceMarked && f.credits === '';
    const fieldsMissing = !f.title.trim() || !f.description.trim() || priceMissing;
    const disabled = f.needBlocked || f.posting || fieldsMissing || !f.hasLocation || f.photoCount === 0;
    const label = f.posting ? 'Posting...'
        : f.needBlocked ? '🔵 List an Offer first to post Needs'
        : !f.hasLocation ? '📍 Map location required'
        : fieldsMissing ? '✏️ Fill required fields'
        : `Post ${f.type === 'offer' ? 'Offer' : 'Need'}`;
    return { disabled, label };
}
