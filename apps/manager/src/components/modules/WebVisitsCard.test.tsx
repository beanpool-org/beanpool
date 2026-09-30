import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebVisitsCard } from './WebVisitsCard';
import * as nodeClient from '../../lib/node-client';
import type { NodeProfile } from '../../lib/profiles';
import type { WebVisitDay } from '../../lib/node-client';

vi.mock('../../lib/node-client', async () => {
    const actual = await vi.importActual('../../lib/node-client');
    return { ...actual, fetchWebVisits: vi.fn() };
});

const node: NodeProfile = { id: 'node-1', name: 'Node Alpha', url: 'https://alpha.beanpool.org', adminPassword: 'pw-alpha' };

/** 30 days ending 2026-09-29, oldest first, as the node sends them. */
function series(visitsOf: (i: number) => number, uniquesOf: (i: number) => number = (i) => Math.ceil(visitsOf(i) / 2)): WebVisitDay[] {
    const end = Date.UTC(2026, 8, 29);
    return Array.from({ length: 30 }, (_, i) => ({
        day: new Date(end - (29 - i) * 86_400_000).toISOString().slice(0, 10),
        visits: visitsOf(i),
        uniques: uniquesOf(i),
    }));
}

function answer(s: WebVisitDay[]) {
    vi.mocked(nodeClient.fetchWebVisits).mockResolvedValue({ days: 30, retentionDays: 400, series: s });
}

describe('WebVisitsCard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("asks this node for 30 days with its own sign-in, and shows that it is counting meanwhile", () => {
        vi.mocked(nodeClient.fetchWebVisits).mockImplementation(() => new Promise(() => {}));
        render(<WebVisitsCard node={node} />);
        expect(screen.getByRole('heading', { name: /Web app visits/i })).toBeInTheDocument();
        expect(screen.getByText('Counting…')).toBeInTheDocument();
        expect(nodeClient.fetchWebVisits).toHaveBeenCalledWith('https://alpha.beanpool.org', 'pw-alpha', 30, undefined);
    });

    it("renders with data: today's number, visitors, a sparkline ending on today, the 30-day total and a table", async () => {
        // Day 29 (today) has 12 visits by 5 visitors; the rest i % 4 visits.
        answer(series((i) => (i === 29 ? 12 : i % 4), (i) => (i === 29 ? 5 : i % 3)));
        render(<WebVisitsCard node={node} />);

        const today = await screen.findByTestId('web-visits-today');
        expect(today).toHaveTextContent('12');
        const card = screen.getByTestId('web-visits-card');
        expect(within(card).getByText(/visits · 5 visitors/)).toBeInTheDocument();
        expect(screen.getByTestId('web-visits-sparkline')).toBeInTheDocument();
        // The today dot sits at the right edge.
        expect(screen.getByTestId('web-visits-today-dot').style.left).toBe('100%');

        // At rest the readout gives the 30 days' total: 0+1+2+3 repeating over days 0..28, plus today's 12.
        const total = Array.from({ length: 29 }, (_, i) => i % 4).reduce((a, b) => a + b, 0) + 12;
        expect(screen.getByTestId('web-visits-readout')).toHaveTextContent(`${total} visits in 30 days`);

        const rows = within(card).getAllByRole('row');
        expect(rows).toHaveLength(31); // a header and 30 days
        expect(within(rows[1]).getAllByRole('cell').map((c) => c.textContent)).toEqual([expect.stringMatching(/29/), '12', '5']);
        expect(screen.queryByTestId('web-visits-empty')).toBeNull();
    });

    it('moves the readout to a day with the arrow keys, and back to the total when it loses focus', async () => {
        answer(series((i) => (i === 28 ? 7 : i === 29 ? 3 : 1), (i) => (i === 28 ? 4 : 1)));
        render(<WebVisitsCard node={node} />);
        const spark = await screen.findByTestId('web-visits-sparkline');
        spark.focus();
        fireEvent.keyDown(spark, { key: 'ArrowLeft' });
        const readout = screen.getByTestId('web-visits-readout');
        expect(readout).toHaveTextContent('7 visits · 4 visitors');
        expect(readout).not.toHaveTextContent('today');
        expect(readout).toHaveTextContent(/28/);
        fireEvent.keyDown(spark, { key: 'Home' });
        expect(readout).toHaveTextContent(/31/); // 2026-08-31, the oldest day
        fireEvent.keyDown(spark, { key: 'End' });
        expect(readout).toHaveTextContent('3 visits · 1 visitor — today');
        fireEvent.keyDown(spark, { key: 'ArrowLeft' });
        fireEvent.blur(spark);
        expect(readout).toHaveTextContent('38 visits in 30 days'); // 28 days of 1, then 7 and 3
    });

    it('renders when empty: no chart, and says what will count', async () => {
        answer(series(() => 0, () => 0));
        render(<WebVisitsCard node={node} />);
        expect(await screen.findByTestId('web-visits-empty')).toHaveTextContent(/No visits counted yet/);
        expect(screen.queryByTestId('web-visits-sparkline')).toBeNull();
        expect(screen.queryByTestId('web-visits-today')).toBeNull();
        expect(screen.queryByRole('table')).toBeNull();
    });

    it('renders when the node sends no days at all', async () => {
        vi.mocked(nodeClient.fetchWebVisits).mockResolvedValue({ days: 30, retentionDays: 400, series: [] });
        render(<WebVisitsCard node={node} />);
        expect(await screen.findByTestId('web-visits-empty')).toBeInTheDocument();
    });

    it("says so when the node's build does not count visits yet", async () => {
        vi.mocked(nodeClient.fetchWebVisits).mockRejectedValue(new Error("This node's build doesn't count web app visits yet. Update it to see them."));
        render(<WebVisitsCard node={node} />);
        expect(await screen.findByRole('alert')).toHaveTextContent(/doesn't count web app visits yet/);
        expect(screen.queryByTestId('web-visits-today')).toBeNull();
    });

    it('says what is and is not kept, whatever the state', async () => {
        answer(series(() => 0, () => 0));
        render(<WebVisitsCard node={node} />);
        await screen.findByTestId('web-visits-empty');
        expect(screen.getByText(/no cookies, and no internet address or browser is\s+kept/)).toBeInTheDocument();
    });
});
