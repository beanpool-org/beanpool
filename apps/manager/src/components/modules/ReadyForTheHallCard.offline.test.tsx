/**
 * "Ready for the hall" must read with the internet unplugged (lights-out H4): in the hall, Settings is served by the laptop and
 * the only thing the page may talk to is that laptop. These tests use the real node client (no mock of it) and stand in for the
 * network with a fetch that records where each request goes.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadyForTheHallCard } from './ReadyForTheHallCard';
import type { DiagnosticsResponse, StandbyHealthBanner } from '../../lib/node-client';
import type { NodeProfile } from '../../lib/profiles';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const MIN = 60_000;
const DAY = 24 * 3600_000;

const health: StandbyHealthBanner = {
    incident: null,
    standbys: [{ id: 's1', label: 'The standby at 192.168.8.20', lastPullAt: NOW - MIN, lastCopyAt: NOW - 90_000, lastExactAt: NOW - 90_000, healthy: true, paired: 'this' }],
};
const diag: DiagnosticsResponse = {
    status: 'healthy', uptimeSeconds: 1, cpuLoadPercent: 1, memoryUsageMb: 1, totalMemoryMb: 1, dbSizeBytes: 1, walSizeBytes: 1,
    activeWsConnections: 0, p2pActivePeers: 0, communityName: 'Hall', callsign: null, standbyHealth: health,
};

/** The laptop itself, as the browser reaches it in the hall: the page's own origin. */
const laptop = (): NodeProfile => ({ id: 'hall', name: 'Hall laptop', url: window.location.origin, automationToken: 'pw' });

const answers: Record<string, unknown> = {
    '/api/local/admin/takeover/status': {
        state: 'sealed', message: 'ok', envelopeId: 'e1', sealedAt: null, sealReason: null,
        recipients: { owners: [], codes: [] }, skippedOwners: [], recoveryCode: { codeId: 7, createdAt: '2026-10-01T00:00:00.000Z' },
    },
    '/api/local/admin/takeover/words-checks': {
        owners: [{ pubkey: 'a', callsign: 'anna', wordsCheckedAt: NOW - DAY }, { pubkey: 'b', callsign: 'ben', wordsCheckedAt: NOW - 2 * DAY }],
    },
};

describe('ReadyForTheHallCard with no internet', () => {
    const asked: string[] = [];
    beforeEach(() => {
        asked.length = 0;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        localStorage.clear();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('asks nothing but this node: every request goes to the page\'s own origin', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
            const url = String(input);
            asked.push(url);
            const path = new URL(url, window.location.origin).pathname;
            const body = answers[path];
            return { ok: !!body, status: body ? 200 : 404, statusText: '', json: async () => body ?? {} } as unknown as Response;
        }));
        render(<ReadyForTheHallCard activeNode={laptop()} diag={diag} />);
        await waitFor(() => expect(screen.getByTestId('hall-line-code').getAttribute('data-state')).toBe('ok'));
        await waitFor(() => expect(screen.getByTestId('hall-line-owners').getAttribute('data-state')).toBe('ok'));
        expect(asked.length).toBeGreaterThan(0);
        for (const url of asked) expect(new URL(url, window.location.origin).origin, url).toBe(window.location.origin);
        expect(screen.getByTestId('hall-text-copy').textContent).toBe('Last copy 1 minute ago.');
        expect(screen.getByTestId('hall-text-code').textContent).toMatch(/^Recovery code #7/);
    });

    it('even a node reached by a LAN address is asked through this page\'s own origin, never directly elsewhere', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
            asked.push(String(input));
            return { ok: false, status: 503, statusText: 'no', json: async () => ({}) } as unknown as Response;
        }));
        render(<ReadyForTheHallCard activeNode={{ ...laptop(), url: 'http://192.168.8.1:8080' }} diag={diag} />);
        await waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(2));
        for (const url of asked) expect(new URL(url, window.location.origin).origin, url).toBe(window.location.origin);
    });

    it('with every request failing as it does with no network, the whole card still reads: what it cannot read says so, and it notes what it holds', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        localStorage.setItem('bp_hall_ready:hall', JSON.stringify({ drillAt: NOW - 3 * DAY, downloadedAt: NOW - DAY }));
        render(<ReadyForTheHallCard activeNode={laptop()} diag={diag} />);
        await waitFor(() => expect(screen.getByTestId('hall-text-code').textContent).toBe('Could not read this from the server.'));
        await waitFor(() => expect(screen.getByTestId('hall-text-owners').textContent).toBe('Could not read this from the server.'));
        expect(screen.getByTestId('hall-line-code').getAttribute('data-state')).toBe('unknown');
        expect(screen.getByTestId('hall-line-owners').getAttribute('data-state')).toBe('unknown');
        // What comes with the page itself still reads: the diagnostics the screen holds, and this browser's notes.
        expect(screen.getByTestId('hall-line-copy').getAttribute('data-state')).toBe('ok');
        expect(screen.getByTestId('hall-line-drill').getAttribute('data-state')).toBe('ok');
        expect(screen.getByTestId('hall-line-download').getAttribute('data-state')).toBe('ok');
        expect(screen.getByTestId('hall-line-apk').getAttribute('data-state')).toBe('amber');
        expect(screen.getByTestId('hall-summary').textContent).toBe('3 of 7 ready.');
    });

    it('its code names no other address: no web address, picture, font or script in what it draws or what it is made of', () => {
        const here = __dirname;
        const sources = [
            join(here, 'ReadyForTheHallCard.tsx'),
            join(here, '..', '..', 'lib', 'hall-ready.ts'),
        ].map((f) => readFileSync(f, 'utf8'));
        for (const src of sources) {
            expect(src).not.toMatch(/https?:\/\//);
            expect(src).not.toMatch(/<img|<link|<script|<iframe|@import|url\(/);
            // Its only way out is the node client (which asks this node); no fetch of its own.
            expect(src).not.toMatch(/\bfetch\s*\(/);
            expect(src).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
        }
        expect(sources[0]).toMatch(/from '\.\.\/\.\.\/lib\/node-client'/);
    });
});
