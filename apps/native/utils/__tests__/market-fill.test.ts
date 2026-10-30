/**
 * When the phone's Market fills a short nearby list from elsewhere (utils/market-fill.ts, core market-fill.ts), and the
 * type and category the read of elsewhere is narrowed by: the Market search's own.
 */
import { describe, expect, it } from 'vitest';
import { fillWanted, marketServerFilter, type FillInputs } from '../market-fill';
import type { NodeProfile } from '../node-profile';

const BY_AREA = { profile: 'global', features: { nearbyListings: { radiusKm: 250, max: 500 } } } as unknown as NodeProfile;
const LOCAL = { profile: 'local', features: {} } as unknown as NodeProfile;
const base: FillInputs = {
    profile: BY_AREA, member: true, noArea: false, searching: false, filter: 'all', groupFiltered: false, distancePicked: false, ready: true, shownNear: 3,
};

describe('fillWanted', () => {
    it('a member of a by-area community with fewer than 8 near them', () => {
        expect(fillWanted(base)).toBe(true);
        expect(fillWanted({ ...base, shownNear: 0 })).toBe(true);
        expect(fillWanted({ ...base, shownNear: 7 })).toBe(true);
    });

    it('from 8 near, no', () => {
        expect(fillWanted({ ...base, shownNear: 8 })).toBe(false);
        expect(fillWanted({ ...base, shownNear: 60 })).toBe(false);
    });

    it.each([
        ['a local community', { profile: LOCAL }],
        ['no profile yet', { profile: null }],
        ['no member', { member: false }],
        ['no area (they already have the newest worldwide)', { noArea: true }],
        ['a search typed (that is a read of the whole node)', { searching: true }],
        ['Events', { filter: 'events' as const }],
        ['a group', { groupFiltered: true }],
        ['a picked distance', { distancePicked: true }],
        ['a refusal or a first sync not landed', { ready: false }],
    ])('not for %s', (_name, change) => {
        expect(fillWanted({ ...base, ...change })).toBe(false);
    });

    it.each(['all', 'offers', 'needs', 'polls', 'for-you'] as const)('the %s pill is filled', (filter) => {
        expect(fillWanted({ ...base, filter })).toBe(true);
    });
});

describe('marketServerFilter: what the read of elsewhere is narrowed by, as the search narrows its own', () => {
    it('All asks for the post types with events; For You for none', () => {
        expect(marketServerFilter('all', 'all')).toEqual({ type: '&types=offer,need,poll,event', cat: '' });
        expect(marketServerFilter('for-you', 'all')).toEqual({ type: '', cat: '' });
    });

    it('a type, and a category while the chip is on screen', () => {
        expect(marketServerFilter('offers', 'all')).toEqual({ type: '&type=offer', cat: '' });
        expect(marketServerFilter('needs', 'services')).toEqual({ type: '&type=need', cat: '&category=services' });
    });

    it('no category under Polls or Events, which have no category chip', () => {
        expect(marketServerFilter('polls', 'services')).toEqual({ type: '&type=poll', cat: '' });
        expect(marketServerFilter('events', 'services')).toEqual({ type: '&type=event', cat: '' });
    });
});
