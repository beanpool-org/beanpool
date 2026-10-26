import { describe, it, expect } from 'vitest';
import {
    fitNeedsYou, needsYouRowOrder, isOwnInviteChange,
    NEEDS_YOU_PRIORITY, NEEDS_YOU_SLOT, type NeedsYouKind,
} from '../needs-you';

describe('needs-you core helpers', () => {
    const items = [
        { kind: 'deal' as NeedsYouKind },
        { kind: 'vote' as NeedsYouKind },
        { kind: 'message' as NeedsYouKind },
        { kind: 'group' as NeedsYouKind },
    ];

    it('NEEDS_YOU_PRIORITY is ordered highest first', () => {
        expect(NEEDS_YOU_PRIORITY).toEqual(['admin', 'knock', 'deal', 'vote', 'invite', 'message', 'group']);
        expect(NEEDS_YOU_SLOT).toBe(48);
    });

    it('fitNeedsYou fits items into slot width', () => {
        expect(fitNeedsYou(items, 0)).toEqual({ shown: [], hidden: 0 });
        expect(fitNeedsYou(items, 208, 48)).toEqual({ shown: items, hidden: 0 });
        expect(fitNeedsYou(items, 116, 48)).toEqual({ shown: [items[0]], hidden: 3 });
        expect(fitNeedsYou(items.slice(0, 2), 116, 48)).toEqual({ shown: items.slice(0, 2), hidden: 0 });
        expect(fitNeedsYou(items, 50, 48)).toEqual({ shown: [], hidden: 4 });
    });

    it('needsYouRowOrder orders right-aligned with more first', () => {
        expect(needsYouRowOrder(fitNeedsYou(items, 208, 48))).toEqual(['group', 'message', 'vote', 'deal']);
        expect(needsYouRowOrder(fitNeedsYou(items, 116, 48))).toEqual(['more', 'deal']);
    });

    it('isOwnInviteChange detects invite events for me', () => {
        const ME = 'my-pubkey';
        expect(isOwnInviteChange({ type: 'group_member_invited', member: { memberPubkey: ME } }, ME)).toBe(true);
        expect(isOwnInviteChange({ type: 'group_member_invited', member: { memberPubkey: 'other' } }, ME)).toBe(false);
        expect(isOwnInviteChange({ type: 'group_member_updated', member: { memberPubkey: ME } }, ME)).toBe(true);
        expect(isOwnInviteChange({ type: 'group_member_removed', memberPubkey: ME }, ME)).toBe(true);
        expect(isOwnInviteChange({ type: 'group_member_removed', memberPubkey: 'other' }, ME)).toBe(false);
        expect(isOwnInviteChange(null, ME)).toBe(false);
        expect(isOwnInviteChange({}, null)).toBe(false);
    });
});
