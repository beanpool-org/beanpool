import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * An onboarding step is reported ONCE per identity per node.
 *
 * The protection screen is drawn on every remount — a back-and-forward, an app restart part
 * way through a join, a re-render — and each of those used to be another tally. That is how
 * an operator watching 20 people join came to be shown 56 of them reaching step 3, at 350%.
 *
 * The node cannot fix this: M2 gives `onboarding_funnel` no column that could tell those 56
 * reports apart, deliberately and permanently. So the device holds the one bit, and these
 * tests pin the three things that bit has to get right — not reporting twice, still
 * reporting on a DIFFERENT node, and still reporting for a DIFFERENT identity. Getting
 * either of the last two wrong turns the fix into a silent under-count, which is the harder
 * failure to notice: the number simply looks plausible and is low.
 */

// db.ts pulls in device modules at import time; stub them at the boundary, as the other
// db.ts tests do. AsyncStorage is a REAL in-memory store here, because what is under test is
// what gets written to it and read back.
const store = new Map<string, string>();
let anchorUrl: string | null = 'https://alpha.example.org';

vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? anchorUrl : store.get(k) ?? null)),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));

let identity: { publicKey: string; privateKey: string; callsign: string } | null =
    { publicKey: 'me-pub', privateKey: 'me-priv', callsign: 'Me' };
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => identity) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async () => ({})),
}));

import { recordOnboardingEvent } from '../db';

const fetchMock = vi.fn();

/** Every POST the phone actually made to the funnel endpoint, with its parsed body. */
function funnelPosts(): { url: string; body: any }[] {
    return (fetchMock.mock.calls as any[][])
        .filter(call => String(call[0]).includes('/api/funnel-event'))
        .map(call => ({ url: String(call[0]), body: JSON.parse(call[1].body) }));
}

beforeEach(() => {
    store.clear();
    anchorUrl = 'https://alpha.example.org';
    identity = { publicKey: 'me-pub', privateKey: 'me-priv', callsign: 'Me' };
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    (globalThis as any).fetch = fetchMock;
});

describe('recordOnboardingEvent counts a step once per person', () => {
    it('sends the first report, and marks it as sent', async () => {
        await recordOnboardingEvent('protection_shown');
        expect(funnelPosts()).toHaveLength(1);
        expect(funnelPosts()[0].url).toBe('https://alpha.example.org/api/funnel-event');
        // The variant marks this as a per-person count, so the operator's screen can add these
        // up without mixing in the old one-per-showing rows sitting beside them.
        expect(funnelPosts()[0].body).toEqual({ event: 'protection_shown', variant: 'once' });
        expect([...store.keys()]).toEqual(['bp_funnel_once:https://alpha.example.org:me-pub:protection_shown']);
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
        await recordOnboardingEvent('protection_choice', 'words');
        expect(funnelPosts()[0].body).toEqual({ event: 'protection_choice', variant: 'once:words' });
    });

    it('reports again on a DIFFERENT node — joining a second community is a second join', async () => {
        await recordOnboardingEvent('protection_shown');
        anchorUrl = 'https://beta.example.org';
        await recordOnboardingEvent('protection_shown');
        expect(funnelPosts().map(p => p.url)).toEqual([
            'https://alpha.example.org/api/funnel-event',
            'https://beta.example.org/api/funnel-event',
        ]);
    });

    it('treats the same node with a trailing slash as the same node', async () => {
        await recordOnboardingEvent('protection_shown');
        anchorUrl = 'https://alpha.example.org/';
        await recordOnboardingEvent('protection_shown');
        expect(funnelPosts()).toHaveLength(1);
    });

    it('reports again for a DIFFERENT identity — a re-keyed or handed-on phone is someone else', async () => {
        await recordOnboardingEvent('protection_shown');
        identity = { publicKey: 'someone-else-pub', privateKey: 'k', callsign: 'Them' };
        await recordOnboardingEvent('protection_shown');
        expect(funnelPosts()).toHaveLength(2);
    });

    it('does not retire the step when the report never lands', async () => {
        // Written before the request, a member joining on a flaky connection would be marked
        // as counted for a request that never arrived, and would be missing from the funnel
        // forever. Under-counting a retry is recoverable; that is not.
        fetchMock.mockRejectedValueOnce(new Error('offline'));
        await recordOnboardingEvent('guide_complete');
        expect(store.size).toBe(0);

        await recordOnboardingEvent('guide_complete');
        expect(funnelPosts()).toHaveLength(2);
        expect(store.size).toBe(1);
    });

    it('stays silent, and marks nothing, when the phone is not anchored to a node', async () => {
        anchorUrl = null;
        await expect(recordOnboardingEvent('guide_complete')).resolves.toBeUndefined();
        expect(funnelPosts()).toHaveLength(0);
        expect(store.size).toBe(0);
    });
});
