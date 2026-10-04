import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunityHealthPanel, readHealth } from './CommunityHealthPanel';
import type { NodeProfile } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

/** People & Safety → "Community health" (community modes slice 6): the totals, the two lines (an owner's), the access log. */

const NODE: NodeProfile = { id: 'n1', name: 'Mullum', url: 'https://mullum.test', adminPassword: 'pw' };
const OWNER_KEY: RolesViewer = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' };
const ADMIN_KEY: RolesViewer = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' };
const HEALTH = {
    totals: { beansInCirculation: 4200, sumOfCredit: 4200, sumOfDebt: 3900, membersInDebit: 7, commonsPot: 300, tradesThisMonth: 41 },
    settings: { debtLinePct: 50, quietDays: 60 }, known: true,
    log: [
        { id: 'l2', actor: 'a'.repeat(64), actorCallsign: 'Ada', action: 'offboard_preview', subject: 'k'.repeat(64), subjectCallsign: 'Kim', at: '2026-10-04T07:00:00.000Z' },
        { id: 'l1', actor: 'a'.repeat(64), actorCallsign: 'Ada', action: 'exceptions_opened', at: '2026-10-04T06:00:00.000Z' },
    ],
};

function mockNode(read: { ok: boolean; status?: number; body: unknown } = { ok: true, body: HEALTH }) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes('/api/local/admin/community-health')) {
            if (init?.method === 'POST') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...HEALTH.settings, ...JSON.parse(String(init.body)) }) });
            return Promise.resolve({ ok: read.ok, status: read.status ?? 200, json: () => Promise.resolve(read.body) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('CommunityHealthPanel', () => {
    beforeEach(() => { vi.unstubAllGlobals(); });

    it('reads only a whole answer', () => {
        expect(readHealth(HEALTH)).toMatchObject({ known: true, settings: { debtLinePct: 50, quietDays: 60 } });
        expect(readHealth({ error: 'Not found' })).toBeNull();
    });

    it('shows nothing on a node older than the panel', async () => {
        const f = mockNode({ ok: false, status: 404, body: { error: 'Not found' } });
        const { container } = render(<CommunityHealthPanel activeNode={NODE} viewer={OWNER_KEY} />);
        await waitFor(() => expect(f).toHaveBeenCalled());
        expect(container.querySelector('[data-testid="community-health-panel"]')).toBeNull();
    });

    it('shows the totals in Beans and who opened the list, and no member balance', async () => {
        mockNode();
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        const panel = await screen.findByTestId('community-health-panel');
        expect(panel).toHaveTextContent('Debt owed (all balances below 0)3,900 Beans');
        expect(panel).toHaveTextContent('Members in debit7');
        expect(panel).toHaveTextContent('Trades this month41');
        expect(screen.getByTestId('health-log')).toHaveTextContent('Ada opened it on');
        expect(screen.getByTestId('health-log')).toHaveTextContent("Ada saw Kim's balance while removing them on");
        expect(panel.textContent).not.toMatch(/Ʀ|csv|export/i);
    });

    it('an owner saves the two lines', async () => {
        const f = mockNode();
        render(<CommunityHealthPanel activeNode={NODE} viewer={OWNER_KEY} />);
        const pct = await screen.findByLabelText('Past this % of their credit line');
        fireEvent.change(pct, { target: { value: '80' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save the lines' }));
        await screen.findByText(/Saved\./);
        const post = f.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
        expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({ debtLinePct: 80, quietDays: 60 });
    });

    it('an admin sees the lines and why they are not theirs to change', async () => {
        const f = mockNode();
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        expect(await screen.findByText('Only an owner of this community can change these lines.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Save the lines' }));
        expect(f.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
    });
});
