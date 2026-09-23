import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from './App';
import { TopologyModule } from './components/modules/TopologyModule';
import { PublicAddressPanel } from './components/modules/PublicAddressPanel';
import { ActivityPauseProvider } from './lib/activity-pause';
import type { NodeProfile } from './lib/profiles';

/**
 * What one open Node Settings tab costs the node it is watching.
 *
 * Measured on the test node on 2026-09-23: 8.28 GB out in three hours from a single tab, because
 * the five-second diagnostics tick dragged the whole ~4 MB `/api/local/admin/data` payload behind
 * it on every tick, for every saved profile, whether or not anyone was looking. Closing the tab
 * took the host from 867 KB/s to zero within ten seconds.
 *
 * These tests pin the three things that fixed it: the payload is fetched at most once every five
 * minutes per node, everything automatic stops while the tab is hidden or the operator is away,
 * and nothing is ever fetched twice over for the same node at the same time.
 *
 * NOTE ON FAKE TIMERS: advance the clock in steps, each in its own `act(...)`. React only flushes
 * state updates — and therefore only tears down an interval that has just been paused — when an
 * `act` scope ends, so one long `advanceTimersByTimeAsync` across a pause boundary measures the
 * test harness rather than the app.
 */

/**
 * The stepping above is what makes these tests expensive: the ten-minute idle tests walk the clock
 * a simulated second at a time, so one test drives 600-700 React flushes over a full App tree.
 * That is ~130 ms on a developer machine and ~2.3 s on a loaded one, and it went over Vitest's
 * 5 s default on CI, where four suites share two cores.
 *
 * Worth knowing about that failure: when Vitest times out a test parked inside `act(...)` with
 * fake timers installed, it fails the test but cannot cancel the continuation. The orphan keeps
 * stepping the clock and opening `act` scopes underneath whichever test runs next, so every
 * remaining test in the file renders into an empty container and fails too — one slow test is
 * reported as ten broken ones. The budget below is what stops that, and it is deliberately far
 * larger than the slowest run measured (2.3 s) rather than trimmed to fit it.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const DIAGNOSTICS = '/api/local/admin/diagnostics';
const DATA = '/api/local/admin/data';
const GATEWAY = '/api/local/admin/gateway';
const LOGS = '/api/local/admin/public-address/logs';
const HARVESTER = '/api/manager/backups/status';

let calls: string[] = [];
let dataPayload: Record<string, unknown> = { success: true, health: { flags: [] }, reports: [], members: [] };
/** Endpoints whose response never settles, so an "in flight" request can be held open. */
let stalled: string[] = [];
/** Endpoints that answer, badly — every fragment listed here returns a 503. */
let failing: string[] = [];
/**
 * Requests to hold open and hand back later, one entry per set of fragments that must all appear
 * in the URL (so a single node's data payload can be held while the other node's answers).
 */
let holds: string[][] = [];
let held: { href: string; resolve: (body: unknown) => void }[] = [];

function jsonOk(body: unknown) {
    return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) } as unknown as Response);
}

function installFetch() {
    calls = [];
    stalled = [];
    failing = [];
    holds = [];
    held = [];
    vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
            const href = String(url);
            calls.push(href);
            if (stalled.some((fragment) => href.includes(fragment))) {
                return new Promise(() => {});
            }
            if (holds.some((fragments) => fragments.every((fragment) => href.includes(fragment)))) {
                return new Promise((resolve) => {
                    held.push({ href, resolve: (body) => resolve(jsonOk(body)) });
                });
            }
            if (failing.some((fragment) => href.includes(fragment))) {
                return Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable' } as unknown as Response);
            }
            if (href.includes(GATEWAY)) {
                return jsonOk({ features: { marketplace: true }, corsAllowedOrigins: ['*'], rateLimiting: { enabled: true } });
            }
            if (href.includes(DATA)) {
                return jsonOk(dataPayload);
            }
            if (href.includes(LOGS)) {
                return jsonOk({ success: true, logs: [{ timestamp: '12:00:01', step: '1/4', message: 'Requesting tunnel', type: 'info' }] });
            }
            return jsonOk({ success: true, communityName: 'Testville', health: { flags: [] }, reports: [], logs: [] });
        }),
    );
}

function countOf(fragment: string) {
    return calls.filter((c) => c.includes(fragment)).length;
}

function seedProfiles(...urls: string[]) {
    localStorage.setItem(
        'bp_fleet_profiles',
        JSON.stringify(urls.map((url, i) => ({ id: i === 0 ? 'local-node' : `node-${i}`, name: `Node ${i}`, url, adminPassword: 'pw' }))),
    );
}

/** Advance the clock in one-second steps so React flushes between them. */
async function tick(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });
    }
}

/** Answer the requests held open for `fragment`, and let React settle. */
async function release(fragment: string, body: unknown) {
    const matching = held.filter((h) => h.href.includes(fragment));
    held = held.filter((h) => !h.href.includes(fragment));
    await act(async () => {
        matching.forEach((h) => h.resolve(body));
        await vi.advanceTimersByTimeAsync(0);
    });
}

function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
    act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
    });
}

/**
 * Everything these tests share through a global: the two storages the app reads its profiles,
 * active tab and dismissed flags out of, the stubbed `fetch` and its recorded calls, and the
 * `document.hidden` override that outlives the test that set it. Both describes run this, so a
 * test cannot inherit a dismissed flag or a hidden tab from the one before it.
 */
function resetSharedState() {
    localStorage.clear();
    sessionStorage.clear();
    dataPayload = { success: true, health: { flags: [] }, reports: [], members: [] };
    installFetch();
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    vi.useFakeTimers();
}

function restoreSharedState() {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
}

const IDLE_MS = 10 * 60 * 1000;

describe('Node Settings polling cadence', () => {
    beforeEach(resetSharedState);
    afterEach(restoreSharedState);

    it('costs one data payload and one gateway config per node per minute, not one per tick', async () => {
        seedProfiles('https://localhost:8443');
        await act(async () => {
            render(<App isFleetMode={true} />);
        });
        calls = [];

        await tick(60_000);

        // ~1 KB each, and the reason the screen is worth having open at all.
        expect(countOf(DIAGNOSTICS)).toBeGreaterThanOrEqual(11);
        expect(countOf(DIAGNOSTICS)).toBeLessThanOrEqual(13);
        // ~4 MB each. Before the fix these tracked the diagnostics count exactly.
        expect(countOf(DATA)).toBe(0);
        expect(countOf(GATEWAY)).toBe(0);
    });

    it('fetches the data payload again once the five minutes are up', async () => {
        seedProfiles('https://localhost:8443');
        await act(async () => {
            render(<App isFleetMode={true} />);
        });
        calls = [];

        await tick(4 * 60_000);
        expect(countOf(DATA)).toBe(0);

        await tick(2 * 60_000);
        expect(countOf(DATA)).toBe(1);
        expect(countOf(GATEWAY)).toBe(1);
    });

    it('costs nothing at all while the tab is hidden, and refreshes once on coming back', async () => {
        seedProfiles('https://localhost:8443');
        await act(async () => {
            render(<App isFleetMode={true} />);
        });

        setHidden(true);
        calls = [];
        await tick(60_000);
        expect(calls).toEqual([]);

        setHidden(false);
        expect(countOf(DIAGNOSTICS)).toBe(1);
    });

    it('stops after ten idle minutes, says so, and resumes on a keypress', async () => {
        seedProfiles('https://localhost:8443');
        await act(async () => {
            render(<App isFleetMode={true} />);
        });

        await tick(IDLE_MS - 60_000);
        expect(screen.queryByText(/Updates paused/i)).toBeNull();
        expect(countOf(DIAGNOSTICS)).toBeGreaterThan(0);

        await tick(2 * 60_000);
        expect(screen.getByText(/Updates paused while you.re away/i)).toBeInTheDocument();

        calls = [];
        await tick(60_000);
        expect(calls).toEqual([]);

        // Someone is back at the keyboard.
        await act(async () => {
            fireEvent.keyDown(window, { key: 'a' });
        });
        expect(countOf(DIAGNOSTICS)).toBe(1);
        expect(screen.queryByText(/Updates paused/i)).toBeNull();

        // ...and the five-second tick is running again.
        await tick(10_000);
        expect(countOf(DIAGNOSTICS)).toBeGreaterThanOrEqual(3);
    });

    it('resumes from the banner button as well as from input', async () => {
        seedProfiles('https://localhost:8443');
        await act(async () => {
            render(<App isFleetMode={true} />);
        });
        await tick(IDLE_MS + 60_000);
        calls = [];

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /resume/i }));
        });

        expect(countOf(DIAGNOSTICS)).toBe(1);
        expect(screen.queryByText(/Updates paused/i)).toBeNull();
    });

    it('a manual refresh fetches the data payload at once, inside the five-minute window', async () => {
        seedProfiles('https://localhost:8443', 'https://other.example.org');
        await act(async () => {
            render(<App isFleetMode={true} />);
        });
        await tick(30_000);
        calls = [];

        // Selecting a node is a human action: refreshAll runs, and it does not wait for a window.
        await act(async () => {
            fireEvent.click(screen.getAllByText('Node 1')[0]);
        });
        await tick(2_000);

        expect(countOf(DATA)).toBeGreaterThanOrEqual(1);
    });

    it('the fleet Refresh button refetches a node that is not the one on screen', async () => {
        seedProfiles('https://localhost:8443', 'https://other.example.org');
        await act(async () => {
            render(<App isFleetMode={true} />);
        });
        await tick(30_000);
        calls = [];

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Refresh Fleet Telemetry/i }));
        });
        await tick(2_000);

        // The second node has no section on screen, so `loadNodeData` never runs for it: the only
        // thing that can fetch its payload inside the five-minute window is the manual bypass in
        // `diagSuccess`. Without that bypass a fleet operator could press Refresh on a node showing
        // a stale alert and be told nothing new for another five minutes.
        const otherData = calls.filter((c) => c.includes('other.example.org') && c.includes(DATA));
        expect(otherData.length).toBeGreaterThanOrEqual(1);
    });

    it('never has two requests of the same kind in flight for one node', async () => {
        seedProfiles('https://localhost:8443');
        stalled = [DIAGNOSTICS, DATA];
        await act(async () => {
            render(<App isFleetMode={true} />);
        });

        await tick(60_000);

        // Twelve ticks went by against a node that never answers. Each kind of request was
        // issued once and then waited for, rather than piling a new one on every tick.
        expect(countOf(DIAGNOSTICS)).toBe(1);
        expect(countOf(DATA)).toBe(1);
    });

    it('shows a security flag within five minutes, and keeps a dismissed one hidden', async () => {
        dataPayload = {
            success: true,
            health: { flags: [{ id: 'flag-1', type: 'abuse', severity: 'critical', description: 'Spam wave' }] },
            reports: [],
            members: [],
        };
        seedProfiles('https://localhost:8443');
        await act(async () => {
            render(<App isFleetMode={true} />);
        });
        await tick(10_000);

        // The first load fetches at once, so the alert is on screen without waiting for a window.
        expect(screen.getAllByText(/ALERT \(Inspect\)/i).length).toBeGreaterThan(0);

        // Dismissed on the members screen, which writes the id to localStorage. The next tick
        // re-reads the flags from the copy already in hand — no second 4 MB — and the dot clears.
        localStorage.setItem('bp_dismissed_flags', JSON.stringify(['flag-1']));
        calls = [];
        await tick(10_000);
        expect(countOf(DATA)).toBe(0);
        expect(screen.queryAllByText(/ALERT \(Inspect\)/i).length).toBe(0);
    });

    it('retries a failed data payload instead of counting it as five minutes of refresh', async () => {
        // The five-minute window is stamped when the request goes out, so a node that answers
        // diagnostics but fails on `/data` — a 503, a 429, a dropped connection — used to record
        // the failure as a refresh and stop being checked for security flags until the window
        // rolled over. The nodes most likely to need the check are exactly the flaky ones.
        seedProfiles('https://localhost:8443');
        failing = [DATA];
        await act(async () => {
            render(<App isFleetMode={true} />);
        });
        await tick(5_000);
        calls = [];

        await tick(60_000);

        // Tried again well inside the five minutes...
        expect(countOf(DATA)).toBeGreaterThanOrEqual(1);
        // ...but backed off to roughly every thirty seconds rather than riding the 5-second tick,
        // which is the bandwidth bug this PR exists to fix.
        expect(countOf(DATA)).toBeLessThanOrEqual(3);
    });

    it('never paints a payload that arrived after the operator switched node', async () => {
        // Node 0's ~4 MB payload is in flight when the operator moves to Node 1. It must not
        // overwrite the screen they are now looking at: the sidebar copies are keyed by node id
        // and stay correct either way, but `nodeData` belongs to whichever node is on screen now.
        localStorage.setItem('bp_fleet_active_tab', 'members');
        seedProfiles('https://localhost:8443', 'https://other.example.org');
        await act(async () => {
            render(<App isFleetMode={true} />);
        });
        await tick(5_000);

        // Hold the next payload Node 0 asks for — the one the five-minute window is about to
        // trigger from the diagnostics tick, with no section of its own on screen to ask for it.
        holds = [['localhost:8443', DATA]];
        await tick(6 * 60_000);
        expect(held.length).toBeGreaterThanOrEqual(1);

        dataPayload = {
            success: true,
            health: { flags: [] },
            reports: [],
            members: [{ publicKey: 'bbbb', name: 'Bravo Member', standing: 'Newcomer' }],
        };
        await act(async () => {
            fireEvent.click(screen.getAllByText('Node 1')[0]);
        });
        await tick(2_000);
        expect(screen.getAllByText('Bravo Member').length).toBeGreaterThan(0);

        // Node 0's payload finally lands, long after Node 0 stopped being the node on screen.
        await release('localhost:8443', {
            success: true,
            health: { flags: [] },
            reports: [],
            members: [{ publicKey: 'aaaa', name: 'Alfa Member', standing: 'Newcomer' }],
        });

        expect(screen.queryByText('Alfa Member')).toBeNull();
        expect(screen.getAllByText('Bravo Member').length).toBeGreaterThan(0);
    });
});

describe('Section timers obey the same pause', () => {
    const activeNode: NodeProfile = { id: 'local-node', name: 'Local', url: 'https://localhost:8443', adminPassword: 'pw' };

    beforeEach(resetSharedState);
    afterEach(restoreSharedState);

    it("Topology's harvester poll stops when the operator is away", async () => {
        await act(async () => {
            render(
                <ActivityPauseProvider>
                    <TopologyModule activeNode={activeNode} diag={null} profiles={[activeNode]} onRefresh={() => {}} />
                </ActivityPauseProvider>,
            );
        });

        calls = [];
        await tick(60_000);
        expect(countOf(HARVESTER)).toBeGreaterThan(0);

        await tick(IDLE_MS);
        calls = [];
        await tick(60_000);
        expect(countOf(HARVESTER)).toBe(0);
    });

    it('a domain claim already running keeps its own log monitor going', async () => {
        // The claim request never settles: the operator is still waiting on it when the ten
        // minutes are up, and its log monitor is the only thing telling them what is happening.
        stalled = ['/public-address/claim'];
        await act(async () => {
            render(
                <ActivityPauseProvider>
                    <PublicAddressPanel activeNode={activeNode} onRefreshDiag={() => {}} />
                </ActivityPauseProvider>,
            );
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });

        const nameInput = screen.getAllByPlaceholderText(/e\.g\. cairns/i)[0];
        await act(async () => {
            fireEvent.change(nameInput, { target: { value: 'cairns' } });
        });
        await act(async () => {
            fireEvent.submit(nameInput.closest('form')!);
        });

        await tick(IDLE_MS + 60_000);
        calls = [];
        await tick(10_000);

        // Still reporting progress, four log polls to the ten seconds, pause or no pause.
        expect(countOf(LOGS)).toBeGreaterThanOrEqual(3);
    });
});
