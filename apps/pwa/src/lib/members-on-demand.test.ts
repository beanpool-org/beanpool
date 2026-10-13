import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
    memberKeysPaths, memberSearchPath, membersNearPath, membersOnDemandOn, useMembersOnDemand, useMemberSearch,
    MEMBERS_ON_DEMAND_SEEN_PREFIX, MEMBERS_SEARCH_DEBOUNCE_MS,
} from './members-on-demand';
import * as api from './api';

const info = vi.hoisted(() => ({ read: (async () => ({})) as () => Promise<unknown> }));
vi.mock('./visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(() => info.read()) }));

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

describe('members on demand: a node that can\'t be asked counts as it last answered (review of #1861, N2)', () => {
    const GLOBAL_NODE = 'https://global.example.test';
    const LOCAL_NODE = 'https://local.example.test';
    const answers = (features: Record<string, unknown>) => { info.read = async () => ({ features }); };
    const fails = () => { info.read = async () => { throw new TypeError('Failed to fetch'); }; };
    const switchOnce = async () => {
        const { result, unmount } = renderHook(() => useMembersOnDemand());
        await waitFor(() => expect(result.current).not.toBeNull());
        const on = result.current;
        unmount();
        return on;
    };

    beforeEach(() => { localStorage.clear(); localStorage.setItem('bp_node_url', GLOBAL_NODE); });
    afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

    it('an offline start on a node that said yes still asks, never reads whole', async () => {
        answers({ membersOnDemand: true });
        expect(await switchOnce()).toBe(true);
        expect(localStorage.getItem(MEMBERS_ON_DEMAND_SEEN_PREFIX + GLOBAL_NODE)).toBe('1');
        fails();
        expect(await switchOnce()).toBe(true);
    });

    it('a node that has never answered this browser reads as before; another node\'s answer is not its', async () => {
        answers({ membersOnDemand: true });
        expect(await switchOnce()).toBe(true);
        localStorage.setItem('bp_node_url', LOCAL_NODE);
        fails();
        expect(await switchOnce()).toBe(false);
    });

    it('the node\'s newest answer wins and is the one kept', async () => {
        answers({ membersOnDemand: true });
        expect(await switchOnce()).toBe(true);
        answers({});
        expect(await switchOnce()).toBe(false);
        expect(localStorage.getItem(MEMBERS_ON_DEMAND_SEEN_PREFIX + GLOBAL_NODE)).toBe('0');
        fails();
        expect(await switchOnce()).toBe(false);
    });

    it('a store that can\'t be read or written is "never answered", never a broken page', async () => {
        vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
        vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
        answers({ membersOnDemand: true });
        expect(await switchOnce()).toBe(true);
        fails();
        expect(await switchOnce()).toBe(false);
    });
});

describe('members on demand: the search box (review of #1861, N3)', () => {
    const card = (k: string, callsign: string) => ({ publicKey: k.repeat(64), callsign, joinedAt: '2026-01-01T00:00:00.000Z' });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('asks only once the typing has paused for 400 ms, and only for what was typed last (L8)', async () => {
        vi.useFakeTimers();
        const cards = vi.spyOn(api, 'getMemberCards').mockResolvedValue([card('e', 'Alma')]);
        const { result, rerender } = renderHook(({ typed }) => useMemberSearch(typed, true), { initialProps: { typed: 'al' } });
        expect(result.current.state).toBe('searching');
        await act(async () => { vi.advanceTimersByTime(MEMBERS_SEARCH_DEBOUNCE_MS - 1); });
        expect(cards).not.toHaveBeenCalled();
        // A letter typed inside the pause starts it again.
        rerender({ typed: 'alm' });
        await act(async () => { vi.advanceTimersByTime(MEMBERS_SEARCH_DEBOUNCE_MS - 1); });
        expect(cards).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(cards.mock.calls.map(c => c[0])).toEqual(['/api/members?q=alm&limit=20']);
        expect(MEMBERS_SEARCH_DEBOUNCE_MS).toBe(400);
        await act(async () => { await Promise.resolve(); });
        expect(result.current).toEqual({ found: [card('e', 'Alma')], state: 'idle' });
    });

    it("an older search's late answer never replaces a newer one's, and the older request is stopped (L9)", async () => {
        vi.useFakeTimers();
        let answerOld: (v: api.MemberCard[]) => void = () => {};
        const signals: Record<string, AbortSignal | undefined> = {};
        vi.spyOn(api, 'getMemberCards').mockImplementation((path: string, signal?: AbortSignal) => {
            signals[path] = signal;
            // The first search's answer is slow; it arrives after the second's.
            if (path.includes('q=al&')) return new Promise(resolve => { answerOld = resolve; });
            return Promise.resolve([card('e', 'Alma')]);
        });
        const { result, rerender } = renderHook(({ typed }) => useMemberSearch(typed, true), { initialProps: { typed: 'al' } });
        await act(async () => { vi.advanceTimersByTime(MEMBERS_SEARCH_DEBOUNCE_MS); });
        rerender({ typed: 'alma' });
        expect(signals['/api/members?q=al&limit=20']?.aborted).toBe(true);
        await act(async () => { vi.advanceTimersByTime(MEMBERS_SEARCH_DEBOUNCE_MS); });
        await act(async () => { await Promise.resolve(); });
        expect(result.current).toEqual({ found: [card('e', 'Alma')], state: 'idle' });
        await act(async () => { answerOld([card('f', 'Alder')]); await Promise.resolve(); });
        expect(result.current).toEqual({ found: [card('e', 'Alma')], state: 'idle' });
    });
});
