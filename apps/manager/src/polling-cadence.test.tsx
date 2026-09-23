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

const DIAGNOSTICS = '/api/local/admin/diagnostics';
const DATA = '/api/local/admin/data';
const GATEWAY = '/api/local/admin/gateway';
const LOGS = '/api/local/admin/public-address/logs';
const HARVESTER = '/api/manager/backups/status';

let calls: string[] = [];
let dataPayload: Record<string, unknown> = { success: true, health: { flags: [] }, reports: [], members: [] };
/** Endpoints whose response never settles, so an "in flight" request can be held open. */
let stalled: string[] = [];

function jsonOk(body: unknown) {
    return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) } as unknown as Response);
}

function installFetch() {
    calls = [];
    stalled = [];
    vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
            const href = String(url);
            calls.push(href);
            if (stalled.some((fragment) => href.includes(fragment))) {
                return new Promise(() => {});
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

function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
    act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
    });
}

const IDLE_MS = 10 * 60 * 1000;

describe('Node Settings polling cadence', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
        dataPayload = { success: true, health: { flags: [] }, reports: [], members: [] };
        installFetch();
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

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
});

describe('Section timers obey the same pause', () => {
    const activeNode: NodeProfile = { id: 'local-node', name: 'Local', url: 'https://localhost:8443', adminPassword: 'pw' };

    beforeEach(() => {
        localStorage.clear();
        installFetch();
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

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
