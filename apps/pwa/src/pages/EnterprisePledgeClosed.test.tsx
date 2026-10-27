import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

// The node takes a pledge only while an enterprise is active (#1374 NB, 2026-10-02). The pledge box used to show on a
// funded enterprise too, and a member who filled it in was told "Pledge Failed" with the node's refusal. Now a funded or
// closed enterprise shows a plain sentence where the box was.

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../components/ReportModal', () => ({
    ReportModal: () => null,
}));

vi.mock('../components/EnterpriseLocationPicker', () => ({
    EnterpriseLocationPicker: () => null,
}));

const member: BeanPoolIdentity = {
    publicKey: 'member-pubkey',
    privateKey: 'member-private-key-hex',
    callsign: 'Ann',
    createdAt: '2026-09-17T00:00:00.000Z',
};

const well = (status: string, currentAmount: number) => ({
    publicKey: 'enterprise-well-pubkey',
    name: 'Village Well',
    purpose: 'Clean water',
    avatar: null,
    balance: currentAmount,
    creditLine: 0,
    goalAmount: 20,
    currentAmount,
    lifecycle: 'bounded',
    status,
    paused: false,
    keepers: [{ publicKey: 'keeper-pubkey', callsign: 'Keeper' }],
    posts: [],
    flow: [],
});

const ledger = {
    enterprise: { publicKey: 'enterprise-well-pubkey', name: 'Village Well', status: 'active', balance: 0 },
    period: { since: null, until: null },
    summary: { totalIncome: 0, totalSpend: 0, netChange: 0, startingBalance: 0, endingBalance: 0, transactionCount: 0 },
    entries: [],
};

async function openWell(status: string, currentAmount: number) {
    vi.spyOn(api, 'getTreasury').mockResolvedValue(well(status, currentAmount) as any);
    render(<TreasuryDetailPage identity={member} isMember={true} pubkey="enterprise-well-pubkey" onBack={() => {}} />);
    await screen.findByRole('heading', { level: 1, name: 'Village Well' });
}

describe('The pledge box on an enterprise that is not taking pledges', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 50, keeperOf: [] } as any);
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue(ledger as any);
        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({ conversation: {}, messages: [], readOnly: false } as any);
    });

    it('a funded enterprise says it has reached its goal, with no box to pledge in', async () => {
        await openWell('funded', 20);
        expect(screen.getByText('This project has reached its goal, so it isn’t taking more pledges.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Pledge Beans/ })).not.toBeInTheDocument();
        expect(screen.queryByPlaceholderText('Amount (🫘)')).not.toBeInTheDocument();
        expect(screen.queryByText('Back this initiative')).not.toBeInTheDocument();
    });

    it('a funded enterprise whose raised figure reads short of the goal is still not taking pledges: the node goes by its status', async () => {
        await openWell('funded', 15);
        expect(screen.getByText('This project has reached its goal, so it isn’t taking more pledges.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Pledge Beans/ })).not.toBeInTheDocument();
    });

    it('an enterprise winding up, or closed, says so, with no box', async () => {
        await openWell('winding_up', 5);
        expect(screen.getByText('This project is winding up, so it isn’t taking pledges.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Pledge Beans/ })).not.toBeInTheDocument();
    });

    it('a closed enterprise says it has closed, with no box', async () => {
        await openWell('completed', 5);
        expect(screen.getByText('This project has closed, so it isn’t taking pledges.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Pledge Beans/ })).not.toBeInTheDocument();
    });

    it('an active enterprise still has its pledge box, and no such sentence', async () => {
        await openWell('active', 5);
        expect(screen.getByText('Back this initiative')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Pledge Beans/ })).toBeInTheDocument();
        expect(screen.queryByText(/isn’t taking/)).not.toBeInTheDocument();
    });

    it('an enterprise whose deadline has passed says its deadline has passed, with no box to pledge in', async () => {
        const expiredWell = {
            ...well('active', 5),
            deadlineAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        };
        vi.spyOn(api, 'getTreasury').mockResolvedValue(expiredWell as any);
        render(<TreasuryDetailPage identity={member} isMember={true} pubkey="enterprise-well-pubkey" onBack={() => {}} />);
        await screen.findByRole('heading', { level: 1, name: 'Village Well' });
        expect(screen.getByText("This project's deadline has passed: it takes no more pledges.")).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Pledge Beans/ })).not.toBeInTheDocument();
        expect(screen.queryByPlaceholderText('Amount (🫘)')).not.toBeInTheDocument();
    });

    // The badge and the box are one rule, the node's (#2500, its deciding review): a deadline is the chosen day, so on that
    // day the badge says "Ends today" in the OK colour beside the box, and once it is over "Expired" beside the sentence.
    it.each([
        ['an hour after its deadline: "Ends today", and the box', 1, 'Ends today', true],
        ['23 hours after: "Ends today", and the box', 23, 'Ends today', true],
        ['25 hours after: "Expired", and the sentence', 25, 'Expired', false],
    ] as const)('%s', async (_when, hoursAgo, badge, open) => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue({
            ...well('active', 5),
            deadlineAt: new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString(),
        } as any);
        render(<TreasuryDetailPage identity={member} isMember={true} pubkey="enterprise-well-pubkey" onBack={() => {}} />);
        await screen.findByRole('heading', { level: 1, name: 'Village Well' });
        expect(screen.getByText(`⏳ ${badge}`).className).toContain(open ? 'bg-bp-chip-ok-tint' : 'bg-bp-chip-danger-tint');
        expect(screen.queryByRole('button', { name: /Pledge Beans/ }) !== null).toBe(open);
        expect(screen.queryByText("This project's deadline has passed: it takes no more pledges.") !== null).toBe(!open);
    });
});

// A project that ends short of its goal gives its backers their Beans back a week after its end date, unless the end date
// moves before then (Marty, board, 27 Oct 2026). Its page says so plainly in the goal card, and once the node has returned
// them (the page's pledgesReturnedAt), that they went back.
describe('The project page says when the Beans go back if the goal is not reached', () => {
    // 10:00 UTC is the same calendar day on every clock from UTC-10 to UTC+13, so the dates read the same wherever this runs.
    const NOW = Date.parse('2026-11-20T10:00:00.000Z');

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 50, keeperOf: [] } as any);
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue(ledger as any);
        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({ conversation: {}, messages: [], readOnly: false } as any);
    });
    afterEach(() => { vi.useRealTimers(); });

    async function openProject(over: Record<string, unknown>) {
        vi.spyOn(api, 'getTreasury').mockResolvedValue({ ...well('active', 5), ...over } as any);
        render(<TreasuryDetailPage identity={member} isMember={true} pubkey="enterprise-well-pubkey" onBack={() => {}} />);
        await screen.findByRole('heading', { level: 1, name: 'Village Well' });
    }

    it('before its end date: if the goal isn’t reached by then, everyone’s Beans go back a week after it, beside the pledge box', async () => {
        await openProject({ deadlineAt: '2026-11-30T10:00:00.000Z' });
        expect(screen.getByTestId('pledge-return-line').textContent).toBe('If the goal isn’t reached by 30 Nov 2026, everyone’s Beans go back on 7 Dec 2026.');
        expect(screen.getByRole('button', { name: /Pledge Beans/ })).toBeInTheDocument();
    });

    it('in the week after its end date: they go back on the day, unless the end date moves before then', async () => {
        await openProject({ deadlineAt: '2026-11-17T10:00:00.000Z' });
        expect(screen.getByTestId('pledge-return-line').textContent)
            .toBe('The goal wasn’t reached by 17 Nov 2026. Everyone’s Beans go back on 24 Nov 2026, unless the end date moves before then.');
        expect(screen.getByText("This project's deadline has passed: it takes no more pledges.")).toBeInTheDocument();
    });

    it('once the node has returned them: they went back, and nothing reads as still held', async () => {
        await openProject({ deadlineAt: '2026-11-10T10:00:00.000Z', currentAmount: 0, balance: 0, pledgesReturnedAt: '2026-11-17T10:00:30.000Z' });
        expect(screen.getByTestId('pledge-return-line').textContent).toBe('The goal wasn’t reached by 10 Nov 2026, so everyone’s Beans went back on 17 Nov 2026.');
        expect(screen.queryByText(/Pledges are held securely/)).not.toBeInTheDocument();
    });

    it('a project that reached its goal, or has no end date, says nothing of it', async () => {
        await openProject({ status: 'funded', currentAmount: 20, deadlineAt: '2026-11-30T10:00:00.000Z' });
        expect(screen.queryByTestId('pledge-return-line')).not.toBeInTheDocument();
    });

    it('nor does one with no end date', async () => {
        await openProject({ deadlineAt: null });
        expect(screen.queryByTestId('pledge-return-line')).not.toBeInTheDocument();
    });
});
