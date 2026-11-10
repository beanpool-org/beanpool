import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunityHealthPanel, firstTradeRows, logWho, needsRows, readHealth, readNeeds, readNewMembers } from './CommunityHealthPanel';
import type { NodeProfile } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

/** People & Safety → "Community health" (community modes slice 6): the totals, the two lines (an owner's), the access log. */

const NODE: NodeProfile = { id: 'n1', name: 'Mullum', url: 'https://mullum.test', adminPassword: 'pw' };
const OWNER_KEY: RolesViewer = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' };
const ADMIN_KEY: RolesViewer = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' };
const HEALTH = {
    // As engine/community-health.ts communityTotals sends them: the money figures whole hundredths of a Bean, in `*_c` fields.
    totals: { beansInCirculation_c: 420000, sumOfCredit_c: 389950, sumOfDebt_c: 390000, membersInDebit: 7, commonsPot_c: 30050, tradesThisMonth: 41 },
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

const WINDOW = { joined: 42, firstListing: 19, firstTrade: 10, daysToFirstListing: 3, daysFromListingToTrade: 12 };
const NEW_MEMBERS = { beans: true, anyTrades: true, minGroup: 5, last90Days: { ...WINDOW, joined: 12, firstListing: 7, firstTrade: 5, daysToFirstListing: 0, daysFromListingToTrade: 1 }, allTime: WINDOW };
const NEEDS = { deals: true, minGroup: 5, posted: 12, answeredWithinWeek: 10 };
const withNeeds = (needs: unknown) => ({ ok: true, body: { ...HEALTH, totals: { ...HEALTH.totals, newMembers: NEW_MEMBERS, needs } } });
const withNew = (newMembers: unknown) => ({ ok: true, body: { ...HEALTH, totals: { ...HEALTH.totals, newMembers } } });

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
        // To the cent, never rounded to a whole Bean, never 100 times over.
        expect(panel).toHaveTextContent('Credit held (all balances above 0)3,899.50 Beans');
        expect(panel).toHaveTextContent('Commons pot300.50 Beans');
        expect(panel).toHaveTextContent('Beans in circulation4,200 Beans');
        expect(panel).toHaveTextContent('Members in debit7');
        expect(panel).toHaveTextContent('Trades this month41');
        expect(screen.getByTestId('health-log')).toHaveTextContent('Ada opened it on');
        expect(screen.getByTestId('health-log')).toHaveTextContent("Ada saw Kim's balance while removing them on");
        expect(panel.textContent).not.toMatch(/Ʀ|csv|export/i);
    });

    it('reads only the node\'s *_c totals: an answer in the old names is not read as figures', async () => {
        expect(readHealth({ ...HEALTH, totals: { beansInCirculation: 4200, sumOfCredit: 4200, sumOfDebt: 3900, membersInDebit: 7, commonsPot: 300, tradesThisMonth: 41 } })).toBeNull();
        expect(readHealth({ ...HEALTH, totals: { ...HEALTH.totals, sumOfDebt_c: 3900.5 } })).toBeNull();
        expect(readHealth(HEALTH)?.totals).toMatchObject({ sumOfCredit_c: 389950, sumOfDebt_c: 390000, commonsPot_c: 30050 });
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

    it('shows how far new members get, both windows, in plain words', async () => {
        mockNode(withNew(NEW_MEMBERS));
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        expect(await screen.findByRole('heading', { name: 'From joining to a first trade' })).toBeInTheDocument();
        const all = screen.getByTestId('first-trade-all-time');
        expect(all).toHaveTextContent('All time');
        expect(all).toHaveTextContent('Joined42');
        expect(all).toHaveTextContent('Made a first listing19');
        expect(all).toHaveTextContent('Completed a first tradeAt least 10');
        expect(all).toHaveTextContent('Typical time from joining to a first listing3 days');
        expect(all).toHaveTextContent('Typical time from a first listing to a first trade12 days');
        const recent = screen.getByTestId('first-trade-90-days');
        expect(recent).toHaveTextContent('Last 90 days');
        expect(recent).toHaveTextContent('Joined12');
        expect(recent).toHaveTextContent('Typical time from joining to a first listingUnder a day');
        expect(recent).toHaveTextContent('Typical time from a first listing to a first trade1 day');
        expect(screen.getByTestId('first-trade')).toHaveTextContent('owners and admins only');
        expect(screen.getByTestId('first-trade')).toHaveTextContent('Typical means the middle person');
        expect(screen.getByTestId('first-trade')).toHaveTextContent('A figure is held back when fewer than 5 people are behind it, or fewer than 5 people separate the two columns.');
        expect(screen.getByTestId('first-trade')).toHaveTextContent('The wait for a first trade counts only people who listed before they traded.');
        expect(screen.getByTestId('first-trade')).toHaveTextContent('First trades go up in steps of 5');
    });

    it('a figure the node holds back says so, and is never a 0', async () => {
        mockNode(withNew({ ...NEW_MEMBERS,
            last90Days: { joined: 3, firstListing: 1, firstTrade: null, daysToFirstListing: null, daysFromListingToTrade: null },
            allTime: { joined: 3, firstListing: 1, firstTrade: null, daysToFirstListing: null, daysFromListingToTrade: null } }));
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        const recent = await screen.findByTestId('first-trade-90-days');
        expect(recent).toHaveTextContent('Joined3');
        expect(recent).toHaveTextContent('Made a first listing1');
        expect(recent).toHaveTextContent('Completed a first tradeHeld back');
        expect(recent).toHaveTextContent('Typical time from joining to a first listingHeld back');
        expect(recent).toHaveTextContent('Typical time from a first listing to a first tradeHeld back');
        expect(recent.textContent).not.toMatch(/At least|Under a day/);
    });

    it('a real 0 days reads as under a day, and only a held-back figure as held back', () => {
        const rows = new Map(firstTradeRows({ ...WINDOW, daysToFirstListing: 0, daysFromListingToTrade: null }, NEW_MEMBERS as never));
        expect(rows.get('Typical time from joining to a first listing')).toBe('Under a day');
        expect(rows.get('Typical time from a first listing to a first trade')).toBe('Held back');
    });

    it('a figure held back in a large group never says there are too few people', async () => {
        mockNode(withNew({ ...NEW_MEMBERS,
            last90Days: { joined: 60, firstListing: 60, firstTrade: null, daysToFirstListing: null, daysFromListingToTrade: null },
            allTime: { joined: 63, firstListing: 63, firstTrade: 60, daysToFirstListing: 2, daysFromListingToTrade: 8 } }));
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        const recent = await screen.findByTestId('first-trade-90-days');
        expect(recent).toHaveTextContent('Joined60');
        expect(recent).toHaveTextContent('Completed a first tradeHeld back');
        expect(screen.getByTestId('first-trade').textContent).not.toMatch(/too few/i);
    });

    it('with no Beans it says there are no trades to measure, and shows no trade figure at all', async () => {
        const off = { joined: 24, firstListing: 16, firstTrade: null, daysToFirstListing: 2, daysFromListingToTrade: null };
        mockNode(withNew({ beans: false, anyTrades: false, minGroup: 5, last90Days: off, allTime: off }));
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        expect(await screen.findByTestId('first-trade-no-beans')).toHaveTextContent('This community has no Beans, so there are no trades to measure.');
        for (const id of ['first-trade-90-days', 'first-trade-all-time']) {
            expect(screen.getByTestId(id)).toHaveTextContent('Joined24');
            expect(screen.getByTestId(id)).toHaveTextContent('Made a first listing16');
            expect(screen.getByTestId(id)).not.toHaveTextContent('first trade');
            expect(screen.getByTestId(id)).not.toHaveTextContent('Too few');
        }
        expect(screen.getByTestId('community-health-panel')).not.toHaveTextContent('Trades this month');
        // The typical time still shows, so its word is explained; nothing is said of trades that aren't there.
        expect(screen.getByTestId('first-trade')).toHaveTextContent('Typical means the middle person');
        expect(screen.getByTestId('first-trade')).not.toHaveTextContent('steps of');
        expect(screen.getByTestId('first-trade')).not.toHaveTextContent('listed before they traded');
    });

    it('a node with no trades says so plainly', async () => {
        const none = { joined: 31, firstListing: 9, firstTrade: 0, daysToFirstListing: 4, daysFromListingToTrade: null };
        mockNode(withNew({ beans: true, anyTrades: false, minGroup: 5, last90Days: none, allTime: none }));
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        const all = await screen.findByTestId('first-trade-all-time');
        expect(all).toHaveTextContent('Completed a first tradeNo trades yet');
        expect(all).toHaveTextContent('Typical time from a first listing to a first tradeNo trades yet');
        expect(all.textContent).not.toMatch(/Too few|At least/);
        expect(screen.queryByTestId('first-trade-no-beans')).toBeNull();
    });

    // Cold start N4: "Needs this month: posted, answered within a week", beside the first-trade block (engine/needs-this-month.ts).
    it('shows the Needs asked this month and how many were answered within a week, with what answered means', async () => {
        mockNode(withNeeds(NEEDS));
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        expect(await screen.findByRole('heading', { name: 'Needs this month' })).toBeInTheDocument();
        const block = screen.getByTestId('needs-this-month');
        expect(block).toHaveTextContent('Needs posted12');
        expect(block).toHaveTextContent('Answered within a weekAt least 10');
        expect(block).toHaveTextContent('A Need is answered when someone other than the person who asked puts in a request on it, whatever came of the request.');
        expect(block).toHaveTextContent('A Need still in its first week with no answer yet counts as posted only.');
        expect(block).toHaveTextContent('Answers go up in steps of 5, and a figure under 5 is held back, so the number never points at one person.');
        // Beside the first-trade block, not instead of it; counts only.
        expect(screen.getByTestId('first-trade')).toBeInTheDocument();
        expect(block.textContent).not.toMatch(/[0-9a-f]{32}/);
    });

    it('a Needs figure the node holds back says so and is never a 0; a month with no Needs reads 0', async () => {
        mockNode(withNeeds({ ...NEEDS, posted: 3, answeredWithinWeek: null }));
        const first = render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        const held = await screen.findByTestId('needs-this-month');
        expect(held).toHaveTextContent('Needs posted3');
        expect(held).toHaveTextContent('Answered within a weekHeld back');
        expect(held.textContent).not.toMatch(/At least|week0/);
        first.unmount();
        mockNode(withNeeds({ ...NEEDS, posted: 0, answeredWithinWeek: 0 }));
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        const none = await screen.findByTestId('needs-this-month');
        expect(none).toHaveTextContent('Needs posted0');
        expect(none).toHaveTextContent('Answered within a week0');
    });

    it('with no deals here it shows only the Needs asked, and says nothing of answers', async () => {
        mockNode(withNeeds({ deals: false, minGroup: 5, posted: 9, answeredWithinWeek: null }));
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        const block = await screen.findByTestId('needs-this-month');
        expect(block).toHaveTextContent('Needs posted9');
        expect(block).not.toHaveTextContent('Answered');
        expect(block).not.toHaveTextContent('steps of');
    });

    it('reads a whole Needs answer only; a node older than it shows the panel without the block', async () => {
        expect(readNeeds(NEEDS)).toEqual(NEEDS);
        expect(readNeeds({ ...NEEDS, answeredWithinWeek: 'many' })).toMatchObject({ answeredWithinWeek: null });
        expect(readNeeds({ posted: 4 })).toBeNull();
        expect(readNeeds(null)).toBeNull();
        expect(new Map(needsRows({ deals: true, minGroup: 5, posted: 6, answeredWithinWeek: 5 })).get('Answered within a week')).toBe('At least 5');
        mockNode();
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        await screen.findByTestId('community-health-panel');
        expect(screen.queryByTestId('needs-this-month')).toBeNull();
    });

    it('a node older than the measure shows the panel without it, and Trades this month stays', async () => {
        mockNode();
        render(<CommunityHealthPanel activeNode={NODE} viewer={ADMIN_KEY} />);
        const panel = await screen.findByTestId('community-health-panel');
        expect(screen.queryByTestId('first-trade')).toBeNull();
        expect(panel).toHaveTextContent('Trades this month41');
    });

    it('reads a half answer as none, and a field that is no number as held back', () => {
        expect(readNewMembers({ beans: true, last90Days: WINDOW })).toBeNull();
        expect(readNewMembers({ beans: 'yes', last90Days: WINDOW, allTime: WINDOW })).toBeNull();
        expect(readNewMembers(NEW_MEMBERS)).toMatchObject({ beans: true, anyTrades: true, minGroup: 5 });
        expect(readNewMembers({ ...NEW_MEMBERS, allTime: { ...WINDOW, firstTrade: '7', daysToFirstListing: 'soon' } })?.allTime)
            .toMatchObject({ firstTrade: null, daysToFirstListing: null });
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

describe('CommunityHealthPanel: the rule of being confirmed (balance rule S2)', () => {
    const FROM = '2026-11-16T04:00:00.000Z';
    beforeEach(() => { vi.unstubAllGlobals(); });

    it('says no member agreed to anything: being confirmed is enough', async () => {
        mockNode({ ok: true, body: { ...HEALTH, rule: { from: FROM, started: true, debtLineFrom: null, quietDaysFrom: null } } });
        render(<CommunityHealthPanel activeNode={NODE} viewer={OWNER_KEY} />);
        const panel = await screen.findByTestId('community-health-panel');
        expect(panel.textContent).toMatch(/a confirmed member shows on an admin's phone if they pass either line/);
        expect(panel.textContent).not.toMatch(/agreed/);
        expect(panel.textContent).not.toMatch(/stepped back/i);
        expect(screen.queryByTestId('health-rule-starts')).toBeNull();
    });

    it('during the 14 days, says when the rule starts, and doesn\'t say nobody is listed', async () => {
        mockNode({ ok: true, body: { ...HEALTH, rule: { from: FROM, started: false, debtLineFrom: null, quietDaysFrom: null } } });
        render(<CommunityHealthPanel activeNode={NODE} viewer={OWNER_KEY} />);
        expect((await screen.findByTestId('health-rule-starts')).textContent).toBe('The rule starts on 16 November. Until then, only members confirmed since the notice began are listed.');
    });

    it('shows "Applies from" beside a line that waits, and only that line', async () => {
        mockNode({ ok: true, body: { ...HEALTH, rule: { from: FROM, started: true, debtLineFrom: FROM, quietDaysFrom: null } } });
        render(<CommunityHealthPanel activeNode={NODE} viewer={OWNER_KEY} />);
        expect((await screen.findByTestId('health-debt-line-from')).textContent).toBe('Applies from 16 November');
        expect(screen.queryByTestId('health-quiet-days-from')).toBeNull();
    });

    it('reads the date again after a save: the answer to a save carries no dates', async () => {
        let reads = 0;
        const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
            if (init?.method === 'POST') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ debtLinePct: 30, quietDays: 60 }) });
            reads += 1;
            const rule = { from: FROM, started: true, debtLineFrom: reads > 1 ? FROM : null, quietDaysFrom: null };
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...HEALTH, settings: { debtLinePct: reads > 1 ? 30 : 50, quietDays: 60 }, rule }) });
        });
        vi.stubGlobal('fetch', fetchMock);
        render(<CommunityHealthPanel activeNode={NODE} viewer={OWNER_KEY} />);
        const pct = await screen.findByLabelText('Past this % of their credit line');
        fireEvent.change(pct, { target: { value: '30' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save the lines' }));
        expect((await screen.findByTestId('health-debt-line-from')).textContent).toBe('Applies from 16 November');
    });

    it('an older node states no rule: the panel loads as before', async () => {
        expect(readHealth(HEALTH)?.rule).toBeNull();
        mockNode();
        render(<CommunityHealthPanel activeNode={NODE} viewer={OWNER_KEY} />);
        await screen.findByTestId('community-health-panel');
        expect(screen.queryByTestId('health-rule-starts')).toBeNull();
    });
});
