/**
 * The member's own name and picture name the community they were read for (utils/own-profile-anchor.ts): a row read for
 * any other community is never shown, not even while the new one's is on its way (Profile S1,
 * scratch/fable-design/DESIGN-per-community-profile-fable.md §3).
 */
import { describe, it, expect } from 'vitest';
import { UNKNOWN_OWN_PROFILE, ownCommunityRead, ownRowArrived, ownRowOf } from '../own-profile-anchor';

const A = 'https://mullum.example';
const B = 'https://bellingen.example';
const rowA = { callsign: 'Marty', avatarUrl: '/api/avatar/k?v=a', updatedAt: '2026-10-28T09:00:00.000Z' };
const rowB = { callsign: 'Marty B', avatarUrl: '/api/avatar/k?v=b', updatedAt: '2026-10-29T09:00:00.000Z' };

describe('own-profile-anchor', () => {
    it('a switch starts from unknown: nothing of the community before stays', () => {
        const onA = ownRowArrived(ownCommunityRead(UNKNOWN_OWN_PROFILE, A), A, rowA);
        expect(onA).toEqual({ community: A, read: true, ...rowA });
        expect(ownCommunityRead(onA, B)).toEqual({ ...UNKNOWN_OWN_PROFILE, community: B });
        // The same community read again keeps what it has.
        expect(ownCommunityRead(onA, A)).toBe(onA);
    });

    it("a late answer for A never paints while B is current", () => {
        const onB = ownCommunityRead(ownRowArrived(ownCommunityRead(UNKNOWN_OWN_PROFILE, A), A, rowA), B);
        expect(ownRowArrived(onB, A, rowA)).toBe(onB);
        expect(ownRowArrived(onB, B, rowB)).toEqual({ community: B, read: true, ...rowB });
    });

    it('a community holding no row yet is read, with nothing to draw (the preset by key)', () => {
        const none = ownRowArrived(ownCommunityRead(UNKNOWN_OWN_PROFILE, B), B, null);
        expect(none).toEqual({ community: B, read: true, callsign: null, avatarUrl: null, updatedAt: null });
    });

    it('an answer that changes nothing is the same state, so no reader draws again', () => {
        const onA = ownRowArrived(ownCommunityRead(UNKNOWN_OWN_PROFILE, A), A, rowA);
        expect(ownRowArrived(onA, A, { ...rowA })).toBe(onA);
        expect(ownRowArrived(onA, A, { ...rowA, updatedAt: rowB.updatedAt })).not.toBe(onA);
    });

    it('the strings a row holds for "none" are none', () => {
        expect(ownRowOf({ callsign: 'Marty', avatar_url: 'null', profile_updated_at: '' })).toEqual({ callsign: 'Marty', avatarUrl: null, updatedAt: null });
        expect(ownRowOf({ callsign: ' ', avatar_url: 'undefined', profile_updated_at: null })).toEqual({ callsign: null, avatarUrl: null, updatedAt: null });
        expect(ownRowOf(null)).toBeNull();
    });
});
