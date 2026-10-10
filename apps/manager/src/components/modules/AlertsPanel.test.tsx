import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AlertsPanel } from './AlertsPanel';
import type { NodeProfile } from '../../lib/profiles';
import type { AlertsStatus } from '../../lib/node-client';

const node: NodeProfile = { id: 'node-1', name: 'Node', url: 'https://node.example.com', adminPassword: 'pw-owner' };

function status(over: Partial<AlertsStatus>): AlertsStatus {
    return {
        channel: null, channelProblem: null, lastOkAt: null, lastTriedAt: null, failedInARow: 0, error: null, nextTryAt: null,
        waiting: 0, dropped: 0, sentLastHour: 0, hourlyCap: 20, active: [], history: [], ...over,
    };
}

const json = (body: unknown, ok = true, code = 200) => ({ ok, status: code, statusText: '', json: async () => body });

describe('AlertsPanel', () => {
    beforeEach(() => { vi.restoreAllMocks(); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it("says in one line when the node answers that it is an owner's card", async () => {
        const words = "Only an owner of this node can see or change its alerts and where they're sent";
        vi.stubGlobal('fetch', vi.fn(async () => json({ error: words }, false, 403)));
        render(<AlertsPanel activeNode={node} />);
        expect(await screen.findByText(words)).toBeInTheDocument();
        expect(screen.queryByText('Send a test')).toBeNull();
    });

    it('shows what is active, the channel by its host only, and sends a test', async () => {
        const s = status({
            channel: { source: 'settings', format: 'ntfy', where: 'https://ntfy.sh/…', tokenSet: true },
            active: [{ key: 'disk.90', title: 'disk 90% full', priority: 4, since: Date.UTC(2026, 9, 10, 1), detail: 'The disk is 91% full.' }],
        });
        const calls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            calls.push(String(url));
            if (String(url).endsWith('/alerts/test')) return json({ ok: true, status: s });
            return json(s);
        }));
        render(<AlertsPanel activeNode={node} />);
        expect(await screen.findByText(/The disk is 91% full\./)).toBeInTheDocument();
        expect(screen.getByText('High')).toBeInTheDocument();
        expect(screen.getByText(/ntfy topic at https:\/\/ntfy\.sh\/…, with a token\./)).toBeInTheDocument();
        await userEvent.click(screen.getByText('Send a test'));
        await waitFor(() => expect(calls.some((c) => c.endsWith('/api/local/admin/alerts/test'))).toBe(true));
    });

    it('says the owners still get the app alerts when no channel is set', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json(status({}))));
        render(<AlertsPanel activeNode={node} />);
        expect(await screen.findByText('No channel: alerts reach the owners in the app only.')).toBeInTheDocument();
        expect(screen.getByText('Nothing needs you.')).toBeInTheDocument();
        expect(screen.getByText('Add a channel')).toBeInTheDocument();
    });
});
