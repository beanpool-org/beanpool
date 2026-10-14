/**
 * The owner's recovery banner against a pile of strangers' sessions (PR #1456 deciding review). Strangers can open any
 * number of sessions against a name, so the node sends the count and the newest few, and one Stop takes them all. The
 * banner must show the node's count, stop everything in ONE request, and say "all cancelled" only when the node says
 * nothing is left. Against a node from before, it stops them one by one and still tells the truth.
 *
 * The node is a stubbed fetch; nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecoveryAlertBanner } from './RecoveryAlertBanner';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

interface Sent { path: string; body: any }
let sent: Sent[];
let alerts: string[];
const originalFetch = globalThis.fetch;

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const listed = (n: number) => Array.from({ length: n }, (_, i) => ({
    collectionId: `c-${i}`, generation: 1, startedAt: new Date(Date.now() - i * 1000).toISOString(),
}));

/** A node: `mine` answers the list, `cancel` each Stop request in turn. */
function node(mine: () => Response, cancel: (body: any) => Response): void {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), 'https://mullum.test').pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        sent.push({ path, body });
        if (path === '/api/recovery/collect/mine') return mine();
        if (path === '/api/recovery/collect/cancel') return cancel(body);
        throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
}

const cancels = () => sent.filter(s => s.path === '/api/recovery/collect/cancel');

async function pressStop(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: /Stop It Now/ }));
    await waitFor(() => expect(alerts.length).toBe(1));
}

beforeEach(() => {
    sent = [];
    alerts = [];
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'alert').mockImplementation((m?: unknown) => { alerts.push(String(m)); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Stop It Now against a pile of sessions', () => {
    it("shows the node's count, not how many it was sent, and stops all of them in one request", async () => {
        node(() => json(200, { count: 2100, collections: listed(3) }), () => json(200, { cancelled: true, stopped: 2100, live: 0 }));
        render(<RecoveryAlertBanner />);
        expect(await screen.findByText(/2100 active sessions/)).toBeTruthy();

        await pressStop();
        expect(cancels()).toEqual([{ path: '/api/recovery/collect/cancel', body: {} }]);
        expect(alerts[0]).toMatch(/All active recovery sessions have been cancelled/);
        await waitFor(() => expect(screen.queryByText(/active session/)).toBeNull());
    });

    it('never says "all cancelled" when the node says some are still live', async () => {
        node(() => json(200, { count: 40, collections: listed(3) }), () => json(200, { cancelled: true, stopped: 36, live: 4 }));
        render(<RecoveryAlertBanner />);
        await pressStop();
        expect(alerts[0]).not.toMatch(/All active recovery sessions have been cancelled/);
        expect(alerts[0]).toMatch(/Not all stopped: 4 recovery sessions are still active/);
        expect(cancels().length).toBe(1);
    });

    it('a node from before one Stop: one request per session, and the words count the ones that failed', async () => {
        let n = 0;
        node(() => json(200, { collections: listed(3) }), (body) => {
            if (!body?.collectionId) return json(400, { error: 'Which session?' });
            return ++n === 2 ? json(429, { error: 'Too many attempts. Try again in 30s' }) : json(200, { cancelled: true });
        });
        render(<RecoveryAlertBanner />);
        expect(await screen.findByText(/3 active sessions/)).toBeTruthy();
        await pressStop();
        expect(cancels().map(c => c.body?.collectionId ?? null)).toEqual([null, 'c-0', 'c-1', 'c-2']);
        expect(alerts[0]).toMatch(/Not all stopped: 1 recovery session is still active/);
    });

    it('...and "all cancelled" there only when every one went through', async () => {
        node(() => json(200, { collections: listed(2) }), (body) => (body?.collectionId ? json(200, { cancelled: true }) : json(400, { error: 'Which session?' })));
        render(<RecoveryAlertBanner />);
        await pressStop();
        expect(alerts[0]).toMatch(/All active recovery sessions have been cancelled/);
    });
});
