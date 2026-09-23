import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * An onboarding step is reported ONCE per identity per node — the browser's half of the rule
 * the phone keeps (apps/native/utils/__tests__/onboarding-event-once.test.ts).
 *
 * A reload, a re-render or a tab reopened part way through a join used to add another tally
 * each time, which is how 20 people who joined were shown to an operator as 56 reaching
 * step 3. The node cannot deduplicate it: M2 gives its counter table no column that could
 * tell those reports apart, deliberately and permanently.
 */

vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => identity) }));

let identity: { publicKey: string; privateKey: string } | null = null;

import { recordOnboardingEvent, setNodeApiUrl } from './api';

const fetchMock = vi.fn();

/** Every POST the browser actually made to the funnel endpoint, with its parsed body. */
function funnelPosts(): { url: string; body: any }[] {
    return (fetchMock.mock.calls as any[][])
        .filter(call => String(call[0]).includes('/api/funnel-event'))
        .map(call => ({ url: String(call[0]), body: JSON.parse(call[1].body) }));
}

beforeEach(() => {
    localStorage.clear();
    identity = { publicKey: 'me-pub', privateKey: '00'.repeat(32) };
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    setNodeApiUrl(null);
    vi.unstubAllGlobals();
});

describe('recordOnboardingEvent counts a step once per person', () => {
    it('sends the first report, and marks it under this origin and identity', async () => {
        await recordOnboardingEvent('protection_shown');
        expect(funnelPosts()).toHaveLength(1);
        // The variant marks this as a per-person count, so the operator's screen can add these
        // up without mixing in the old one-per-showing rows sitting beside them.
        expect(funnelPosts()[0].body).toEqual({ event: 'protection_shown', variant: 'once' });
        // Same-origin is the normal case — the flag still names the node, via the origin.
        expect(localStorage.getItem(`bp_funnel_once:${window.location.origin}:me-pub:protection_shown`)).toBe('1');
    });

    it('does not send it again for the same identity on the same node', async () => {
        await recordOnboardingEvent('protection_shown');
        await recordOnboardingEvent('protection_shown');
        await recordOnboardingEvent('protection_shown');
        expect(funnelPosts()).toHaveLength(1);
    });

    it('keeps each step separate: finishing the guide is still counted', async () => {
        await recordOnboardingEvent('protection_shown');
        await recordOnboardingEvent('guide_complete');
        expect(funnelPosts().map(p => p.body.event)).toEqual(['protection_shown', 'guide_complete']);
    });

    it('carries the sub-type where a step has one', async () => {
        await recordOnboardingEvent('protection_choice', 'skip');
        expect(funnelPosts()[0].body).toEqual({ event: 'protection_choice', variant: 'once:skip' });
    });

    it('reports again on a DIFFERENT node — joining a second community is a second join', async () => {
        setNodeApiUrl('https://alpha.example.org');
        await recordOnboardingEvent('protection_shown');
        setNodeApiUrl('https://beta.example.org');
        await recordOnboardingEvent('protection_shown');
        expect(funnelPosts().map(p => p.url)).toEqual([
            'https://alpha.example.org/api/funnel-event',
            'https://beta.example.org/api/funnel-event',
        ]);
    });

    it('reports again for a DIFFERENT identity — a shared browser is not the same person', async () => {
        await recordOnboardingEvent('protection_shown');
        identity = { publicKey: 'someone-else-pub', privateKey: '11'.repeat(32) };
        await recordOnboardingEvent('protection_shown');
        expect(funnelPosts()).toHaveLength(2);
    });

    it('does not retire the step when the report never lands', async () => {
        // Marked before the request, somebody joining on a flaky connection would be counted
        // for a request that never arrived, and missing from the funnel forever.
        fetchMock.mockRejectedValueOnce(new Error('offline'));
        await recordOnboardingEvent('guide_complete');
        expect(localStorage.length).toBe(0);

        await recordOnboardingEvent('guide_complete');
        expect(funnelPosts()).toHaveLength(2);
        expect(localStorage.length).toBe(1);
    });

    it('stays silent, and marks nothing, before there is an identity to count', async () => {
        identity = null;
        await expect(recordOnboardingEvent('guide_complete')).resolves.toBeUndefined();
        expect(funnelPosts()).toHaveLength(0);
        expect(localStorage.length).toBe(0);
    });
});
