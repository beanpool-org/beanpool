import { describe, it, expect } from 'vitest';
import { memberKeysPaths, memberSearchPath, membersNearPath, membersOnDemandOn } from './members-on-demand';

describe('members on demand: the requests the web app builds (DESIGN-global-members-by-area §2.1)', () => {
    it('reads the switch only when the node says true', () => {
        expect(membersOnDemandOn({ features: { membersOnDemand: true } } as never)).toBe(true);
        expect(membersOnDemandOn({ features: {} } as never)).toBe(false);
        expect(membersOnDemandOn(null)).toBe(false);
        expect(membersOnDemandOn({ features: { membersOnDemand: 'yes' } } as never)).toBe(false);
    });

    it('searches from 2 characters, trimmed, encoded, 20 at most', () => {
        expect(memberSearchPath('')).toBeNull();
        expect(memberSearchPath(' a ')).toBeNull();
        expect(memberSearchPath(' al ')).toBe('/api/members?q=al&limit=20');
        expect(memberSearchPath('a&b=c')).toBe('/api/members?q=a%26b%3Dc&limit=20');
        expect(memberSearchPath('Zoë')).toBe(`/api/members?q=${encodeURIComponent('Zoë')}&limit=20`);
    });

    it('asks for the 50 nearest only with a point', () => {
        expect(membersNearPath({ lat: -28.6, lng: 153.6 })).toBe('/api/members?lat=-28.6&lng=153.6&limit=50');
        expect(membersNearPath(null)).toBeNull();
        expect(membersNearPath(undefined)).toBeNull();
        expect(membersNearPath({ lat: Number.NaN, lng: 1 })).toBeNull();
    });

    it('asks for member keys only, each once, 100 a request, at most 3 requests', () => {
        const key = (i: number) => i.toString(16).padStart(64, '0');
        expect(memberKeysPaths([])).toEqual([]);
        // An escrow, a project, an upper-case key and a short one would each refuse the whole request: left out.
        expect(memberKeysPaths([key(1), key(1), 'escrow_x', 'project_y', 'A'.repeat(64), 'abc', key(2)]))
            .toEqual([`/api/members?keys=${key(1)}%2C${key(2)}`]);
        const paths = memberKeysPaths(Array.from({ length: 350 }, (_, i) => key(i + 1)));
        expect(paths).toHaveLength(3);
        const asked = paths.map(p => new URLSearchParams(p.split('?')[1]).get('keys')!.split(','));
        expect(asked.map(a => a.length)).toEqual([100, 100, 100]);
        expect(asked.flat()).toEqual(Array.from({ length: 300 }, (_, i) => key(i + 1)));
    });
});
