/**
 * What the Market shows with no listing to show (utils/market-empty-state.ts, app/(tabs)/market.tsx): a community's
 * refusal said as one, whatever else holds, and "Having trouble connecting" only for a first sync with no answer at all
 * (scratch/global-node/DESIGN-global-entry-fable.md §1.3, §C.3, §E, P3).
 */
import { describe, it, expect } from 'vitest';
import { marketEmptyState, refusalLines } from '../market-empty-state';

const PREVIEW = 'This community is in a private preview. Ask its owner for an invite.';
const waiting = { hasActiveFilters: false, firstSyncDone: false, syncTimedOut: true };

describe("the Market's state with nothing to show", () => {
    it('no answer at all: still loading, then "Having trouble connecting"', () => {
        expect(marketEmptyState({ refusal: null, hasActiveFilters: false, firstSyncDone: false, syncTimedOut: false })).toEqual({ kind: 'loading' });
        expect(marketEmptyState({ refusal: null, ...waiting })).toEqual({ kind: 'trouble_connecting' });
    });

    it('members only: its card, never "trouble connecting"', () => {
        expect(marketEmptyState({ refusal: { code: 'members_only' }, ...waiting })).toEqual({ kind: 'refused', refusal: { code: 'members_only' } });
    });

    it("a private preview: the node's own sentence, never \"trouble connecting\"", () => {
        const refusal = { code: 'private_preview' as const, sentence: 'Ask Ana for an invite.' };
        const state = marketEmptyState({ refusal, ...waiting });
        expect(state).toEqual({ kind: 'refused', refusal });
        expect(refusalLines(refusal)).toEqual({ title: 'Ask Ana for an invite.', body: null });
        // A node that sent no sentence: the server's own words, through the words layer.
        expect(refusalLines({ code: 'private_preview', sentence: null })).toEqual({ title: PREVIEW, body: null });
    });

    it('a closed account: the closed sentence with the community\'s name, never "trouble connecting"', () => {
        const refusal = { code: 'account_closed' as const, community: 'Mullumbimby' };
        expect(marketEmptyState({ refusal, ...waiting })).toEqual({ kind: 'refused', refusal });
        expect(refusalLines(refusal)).toEqual({
            title: 'Your account in Mullumbimby was closed',
            body: 'You deleted it, or the community removed it. Your other communities are not affected.',
        });
        expect(refusalLines({ code: 'account_closed' }).title).toBe('Your account here was closed.');
    });

    it('a refusal is said whatever else holds: before the first sync ends, after it, and with filters on', () => {
        for (const rest of [
            { hasActiveFilters: false, firstSyncDone: false, syncTimedOut: false },
            { hasActiveFilters: false, firstSyncDone: true, syncTimedOut: false },
            { hasActiveFilters: true, firstSyncDone: true, syncTimedOut: true },
        ]) {
            expect(marketEmptyState({ refusal: { code: 'account_closed', community: 'X' }, ...rest }).kind).toBe('refused');
        }
    });

    it('with no refusal, as before: the feed once synced, and "no items" for filters', () => {
        expect(marketEmptyState({ refusal: null, hasActiveFilters: false, firstSyncDone: true, syncTimedOut: false })).toEqual({ kind: 'feed' });
        expect(marketEmptyState({ refusal: null, hasActiveFilters: true, firstSyncDone: false, syncTimedOut: true })).toEqual({ kind: 'no_matches' });
    });
});
