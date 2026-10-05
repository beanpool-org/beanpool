import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunityHealthPanel, logWho, readHealth } from './CommunityHealthPanel';
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
    tradeLog: [
        { id: 't4', actor: 'a'.repeat(64), actorCallsign: 'Ada', action: 'stranded_escrows_read', tradeIds: ['t9'], at: '2026-10-04T09:00:00.000Z' },
        { id: 't3', actor: 'a'.repeat(64), actorCallsign: 'Ada', action: 'alerts_read', subject: 'k'.repeat(64), subjectCallsign: 'Kim', at: '2026-10-04T08:30:00.000Z' },
        { id: 't2', actor: 'a'.repeat(64), actorCallsign: 'Ada', action: 'dispute_opened', tradeIds: ['t8'], at: '2026-10-04T08:00:00.000Z' },
        { id: 't1', actor: 'a'.repeat(64), actorCallsign: 'Ada', action: 'disputes_listed', tradeIds: ['t8'], at: '2026-10-04T07:30:00.000Z' },
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

    it('displays loading state indicator while fetching community health data', async () => {
        let resolveFetch: (v: any) => void = () => {};
        const fetchPromise = new Promise((res) => { resolveFetch = res; });
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(fetchPromise));

        render(<CommunityHealthPanel activeNode={NODE} viewer={OWNER_KEY} />);
        expect(screen.getByTestId('community-health-loading')).toHaveTextContent('Loading community health…');

        resolveFetch({ ok: true, json: () => Promise.resolve(HEALTH) });
        await waitFor(() => expect(screen.queryByTestId('community-health-loading')).toBeNull());
        expect(screen.getByTestId('community-health-panel')).toBeInTheDocument();
    });

    it('shows nothing on a node older than the panel after loading finishes', async () => {
        const f = mockNode({ ok: false, status: 404, body: { error: 'Not found' } });
        const { container } = render(<CommunityHealthPanel activeNode={NODE} viewer={OWNER_KEY} />);
        await waitFor(() => expect(f).toHaveBeenCalled());
        await waitFor(() => expect(screen.queryByTestId('community-health-loading')).toBeNull());
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

    it('lists the looks at trades and alerts apart from the balance looks, each with its own words', async () => {
        mockNode();
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        const trades = await screen.findByTestId('health-trade-log');
        expect(trades).toHaveTextContent('Ada opened the escrows a member’s removal left stuck on');
        expect(trades).toHaveTextContent('Ada read the alerts that named Kim on');
        expect(trades).toHaveTextContent('Ada opened a dispute on');
        expect(trades).toHaveTextContent('Ada opened the disputes list on');
        expect(trades).not.toHaveTextContent('opened it on');
        expect(screen.getByTestId('health-log')).not.toHaveTextContent('disputes');
    });

    // #1613's actor survey: a token's look was logged under its maker's key, so a script read as a person.
    it('a look an automation token made says "by token <name>"; a person\'s says nothing more', async () => {
        const token = { id: 'abcdef012345', name: 'nightly report' };
        expect(logWho({ id: 'l', actor: 'a'.repeat(64), actorCallsign: 'Ada', token, at: '2026-10-05T01:00:00Z' })).toBe('Ada by token nightly report');
        expect(logWho({ id: 'l', actor: 'a'.repeat(64), actorCallsign: 'Ada', token: { id: 'abcdef012345', name: '' }, at: '2026-10-05T01:00:00Z' })).toBe('Ada by token abcdef012345');
        expect(logWho({ id: 'l', actor: 'a'.repeat(64), actorCallsign: 'Ada', token: null, at: '2026-10-05T01:00:00Z' })).toBe('Ada');
        mockNode({ ok: true, body: { ...HEALTH,
            log: [{ id: 'b1', actor: 'a'.repeat(64), actorCallsign: 'Ada', action: 'offboard_preview', subjectCallsign: 'Kim', token, at: '2026-10-05T01:00:00Z' }],
            tradeLog: [
                { id: 't1', actor: 'a'.repeat(64), actorCallsign: 'Ada', action: 'disputes_listed', token, at: '2026-10-05T01:00:00Z' },
                { id: 't2', actor: 'a'.repeat(64), actorCallsign: 'Ada', action: 'dispute_opened', token: null, at: '2026-10-05T00:00:00Z' },
            ] } });
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        const trades = await screen.findByTestId('health-trade-log');
        const [byToken, byPerson] = Array.from(trades.querySelectorAll('li'));
        expect(byToken).toHaveTextContent('Ada by token nightly report opened the disputes list on');
        expect(byPerson).toHaveTextContent('Ada opened a dispute on');
        expect(byPerson).not.toHaveTextContent('token');
        expect(screen.getByTestId('health-log')).toHaveTextContent("Ada by token nightly report saw Kim's balance while removing them on");
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
