/**
 * What the Market shows when it has no listing to show (app/(tabs)/market.tsx ListEmptyComponent).
 *
 * A community that answered with a refusal (utils/members-only-listings.ts) is said as such, whatever else holds: its
 * members-only card, a private preview's own sentence, or a closed account's (design scratch/global-node/
 * DESIGN-global-entry-fable.md §C.3, §E). "Having trouble connecting" is only for a first sync that got no answer at all.
 */
import { t } from '@beanpool/core';
import type { Refusal } from './members-only-listings';

export type MarketEmptyState =
    | { kind: 'refused'; refusal: Refusal }
    | { kind: 'loading' }
    | { kind: 'trouble_connecting' }
    | { kind: 'feed' }
    | { kind: 'no_matches' };

export function marketEmptyState(s: {
    refusal: Refusal | null; hasActiveFilters: boolean; firstSyncDone: boolean; syncTimedOut: boolean;
}): MarketEmptyState {
    if (s.refusal) return { kind: 'refused', refusal: s.refusal };
    if (s.hasActiveFilters) return { kind: 'no_matches' };
    if (!s.firstSyncDone) return s.syncTimedOut ? { kind: 'trouble_connecting' } : { kind: 'loading' };
    return { kind: 'feed' };
}

/** A preview's or a closed account's lines: the node's own sentence for a preview, the closed sentence with its name. */
export function refusalLines(refusal: Exclude<Refusal, { code: 'members_only' }>): { title: string; body: string | null } {
    if (refusal.code === 'private_preview') {
        return { title: refusal.sentence ?? t('This community is in a private preview. Ask its owner for an invite.'), body: null };
    }
    return {
        title: refusal.community
            ? t('Your account in {name} was closed', { name: refusal.community })
            : t('Your account here was closed.'),
        body: t('You deleted it, or the community removed it. Your other communities are not affected.'),
    };
}
