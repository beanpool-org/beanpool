import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
    memberKeysPaths, memberSearchPath, membersNearPath, membersOnDemandOn, useMembersOnDemand, useMemberSearch,
    MEMBERS_ON_DEMAND_SEEN_PREFIX, MEMBERS_SEARCH_DEBOUNCE_MS, MEMBERS_REQUEST_TIMEOUT_MS, membersNear, searchMembers,
    forgetRecentLookups, membersByKeys, RECENT_LOOKUP_MS, dayBudgetWords, getMembersWhole, isMembersOnDemandRefusal,
} from './members-on-demand';
import * as api from './api';

const info = vi.hoisted(() => ({ read: (async () => ({})) as () => Promise<unknown> }));
vi.mock('./visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(() => info.read()) }));

// Each case asks the node afresh: an answer kept from the last case isn't this one's.
beforeEach(() => forgetRecentLookups());

describe('members on demand: the requests the web app builds (DESIGN-global-members-by-area §2.1)', () => {
    it('reads the switch only when the node says true', () => {
        expect(membersOnDemandOn({ features: { membersOnDemand: true } } as never)).toBe(true);
        expect(membersOnDemandOn({ features: {} } as never)).toBe(false);
        expect(membersOnDemandOn(null)).toBe(false);
        expect(membersOnDemandOn({ features: { membersOnDemand: 'yes' } } as never)).toBe(false);
        // Where anyone can join in a minute the node refuses the whole directory (403 members_on_demand): asked for too.
        expect(membersOnDemandOn({ features: { openMembership: true } } as never)).toBe(true);
        expect(membersOnDemandOn({ features: { openMembership: 'yes' } } as never)).toBe(false);
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

describe('members on demand: a whole read refused 403 members_on_demand is the node saying so (review of #1999, item 1)', () => {
    const GLOBAL_NODE = 'https://global.example.test';
    const refused = () => Object.assign(new Error('On this community people are found by name or by key, not listed whole'), { status: 403, code: 'members_on_demand' });
    beforeEach(() => { localStorage.clear(); localStorage.setItem('bp_node_url', GLOBAL_NODE); info.read = async () => { throw new TypeError('Failed to fetch'); }; });
    afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

    it('tells the refusal from any other failure', () => {
        expect(isMembersOnDemandRefusal(refused())).toBe(true);
        expect(isMembersOnDemandRefusal(Object.assign(new Error('x'), { status: 403, code: 'members_only' }))).toBe(false);
        expect(isMembersOnDemandRefusal(Object.assign(new Error('x'), { status: 503, code: 'members_on_demand' }))).toBe(false);
        expect(isMembersOnDemandRefusal(new TypeError('Failed to fetch'))).toBe(false);
        expect(isMembersOnDemandRefusal(null)).toBe(false);
    });

    it('a never-answered node whose info read failed: the hook says false, the refused whole read turns every hook on the page true, and it is kept', async () => {
        vi.spyOn(api, 'getMembers').mockRejectedValue(refused());
        const first = renderHook(() => useMembersOnDemand());
        const second = renderHook(() => useMembersOnDemand());
        await waitFor(() => expect(first.result.current).toBe(false));
        await waitFor(() => expect(second.result.current).toBe(false));
        await act(async () => { await expect(getMembersWhole()).rejects.toMatchObject({ code: 'members_on_demand' }); });
        expect(first.result.current).toBe(true);
        expect(second.result.current).toBe(true);
        expect(localStorage.getItem(MEMBERS_ON_DEMAND_SEEN_PREFIX + GLOBAL_NODE)).toBe('1');
        first.unmount();
        second.unmount();
        // The next page open that can't ask still knows.
        const later = renderHook(() => useMembersOnDemand());
        await waitFor(() => expect(later.result.current).toBe(true));
        later.unmount();
    });

    it('any other failure of the whole read switches nothing and is the caller\'s to say', async () => {
        vi.spyOn(api, 'getMembers').mockRejectedValue(new TypeError('Failed to fetch'));
        const hook = renderHook(() => useMembersOnDemand());
        await waitFor(() => expect(hook.result.current).toBe(false));
        await act(async () => { await expect(getMembersWhole()).rejects.toThrow('Failed to fetch'); });
        expect(hook.result.current).toBe(false);
        expect(localStorage.getItem(MEMBERS_ON_DEMAND_SEEN_PREFIX + GLOBAL_NODE)).toBeNull();
        hook.unmount();
    });

    it('a local node reads whole exactly as before', async () => {
        const rows = [{ publicKey: 'c'.repeat(64), callsign: 'Cleo', joinedAt: '2026-01-01', invitedBy: '', inviteCode: '' }];
        const whole = vi.spyOn(api, 'getMembers').mockResolvedValue(rows as never);
        await expect(getMembersWhole()).resolves.toEqual(rows);
        expect(whole).toHaveBeenCalledTimes(1);
    });
});

describe("members on demand: never spending a member's day of lookups in the background (Marty's call 3, 15 Oct 2026)", () => {
    const card = (k: string, callsign: string) => ({ publicKey: k.repeat(64), callsign, joinedAt: '2026-01-01T00:00:00.000Z' });
    beforeEach(() => forgetRecentLookups());
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('the same search or "near you" asked again soon is answered without asking the node; after two minutes it asks', async () => {
        vi.useFakeTimers();
        const cards = vi.spyOn(api, 'getMemberCards').mockResolvedValue([card('e', 'Alma')]);
        await searchMembers('al');
        await membersNear({ lat: -28.5, lng: 153.5 });
        vi.advanceTimersByTime(RECENT_LOOKUP_MS - 1);
        expect(await searchMembers('al')).toEqual([card('e', 'Alma')]);
        await membersNear({ lat: -28.5, lng: 153.5 });
        expect(cards.mock.calls.map(c => c[0])).toEqual(['/api/members?q=al&limit=20', '/api/members?lat=-28.5&lng=153.5&limit=50']);
        vi.advanceTimersByTime(1);
        await searchMembers('al');
        expect(cards).toHaveBeenCalledTimes(3);
    });

    it('a read by key is never kept, nor a refusal', async () => {
        const cards = vi.spyOn(api, 'getMemberCards').mockResolvedValue([card('e', 'Alma')]);
        await membersByKeys(['e'.repeat(64)]);
        await membersByKeys(['e'.repeat(64)]);
        expect(cards).toHaveBeenCalledTimes(2);
        cards.mockRejectedValueOnce(Object.assign(new Error('You have searched for people by name 100 times today'), { status: 429, code: 'people_search_day_budget' }));
        await expect(searchMembers('zo')).rejects.toThrow();
        await searchMembers('zo');
        expect(cards).toHaveBeenCalledTimes(4);
    });
});

describe("members on demand: a spent day says so in the node's words (#1965 review N4)", () => {
    it('only for a day budget, and only with words', () => {
        const spent = Object.assign(new Error('You have searched for people by name 100 times today'), { status: 429, code: 'people_search_day_budget' });
        expect(dayBudgetWords(spent)).toBe('You have searched for people by name 100 times today');
        expect(dayBudgetWords(Object.assign(new Error('Too many'), { status: 429, code: 'rate_limited' }))).toBeNull();
        expect(dayBudgetWords(new TypeError('Failed to fetch'))).toBeNull();
        expect(dayBudgetWords(Object.assign(new Error(' '), { code: 'nearest_people_day_budget' }))).toBeNull();
        expect(dayBudgetWords(null)).toBeNull();
    });
    it('the search box carries them with its failed state', async () => {
        vi.spyOn(api, 'getMemberCards').mockRejectedValue(Object.assign(new Error('You have searched for people by name 100 times today'), { status: 429, code: 'people_search_day_budget' }));
        const { result } = renderHook(() => useMemberSearch('al', true));
        await waitFor(() => expect(result.current.state).toBe('failed'), { timeout: 3000 });
        expect(result.current.refusal).toBe('You have searched for people by name 100 times today');
        vi.restoreAllMocks();
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
        expect(result.current).toEqual({ found: [card('e', 'Alma')], state: 'idle', refusal: null });
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
        expect(result.current).toEqual({ found: [card('e', 'Alma')], state: 'idle', refusal: null });
        await act(async () => { answerOld([card('f', 'Alder')]); await Promise.resolve(); });
        expect(result.current).toEqual({ found: [card('e', 'Alma')], state: 'idle', refusal: null });
    });
});

describe('members on demand: a node that never answers (review of #1861, N4)', () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
    const neverAnswers = () => {
        const signals: AbortSignal[] = [];
        vi.spyOn(api, 'getMemberCards').mockImplementation((_path: string, signal?: AbortSignal) => {
            if (signal) signals.push(signal);
            return new Promise(() => {});
        });
        return signals;
    };

    it('the near read and the search give up after 30 s, not before, and stop their requests', async () => {
        expect(MEMBERS_REQUEST_TIMEOUT_MS).toBe(30_000);
        vi.useFakeTimers();
        const signals = neverAnswers();
        const outcomes: string[] = [];
        membersNear({ lat: -28.6, lng: 153.6 }).then(() => outcomes.push('near answered'), () => outcomes.push('near gave up'));
        searchMembers('al').then(() => outcomes.push('search answered'), () => outcomes.push('search gave up'));
        await vi.advanceTimersByTimeAsync(MEMBERS_REQUEST_TIMEOUT_MS - 1);
        expect(outcomes).toEqual([]);
        expect(signals.map(s => s.aborted)).toEqual([false, false]);
        await vi.advanceTimersByTimeAsync(1);
        expect(outcomes.sort()).toEqual(['near gave up', 'search gave up']);
        expect(signals.map(s => s.aborted)).toEqual([true, true]);
    });

    it('a search box whose search never answers says it failed once the limit passes', async () => {
        vi.useFakeTimers();
        neverAnswers();
        const { result } = renderHook(() => useMemberSearch('al', true));
        await act(async () => { await vi.advanceTimersByTimeAsync(MEMBERS_SEARCH_DEBOUNCE_MS + MEMBERS_REQUEST_TIMEOUT_MS - 1); });
        expect(result.current.state).toBe('searching');
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(result.current).toEqual({ found: null, state: 'failed', refusal: null });
    });
});
