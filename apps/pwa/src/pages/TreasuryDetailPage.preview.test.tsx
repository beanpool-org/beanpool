/**
 * The enterprise page in preview (review of #2063): Example Valley's enterprise and project (a sample id) are the real
 * page fed the sample, every control a marker that opens the sheet, and the visit asks the node nothing: the real api
 * module runs under a fetch spy, so any request at all is seen, a write or a `sample-` id above all. A keeper row is
 * not a button (B3), the markers stand one to a row (B4), a marker's sheet keeps its own Escape (N1) and carries the
 * sheet's ways forward (N2). A real key where enterprises are a preview says why and asks nothing (N8). A local node
 * reads as before.
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { LOCAL_COMMUNITY_SHEET } from '@beanpool/core';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { sampleTreasuries, sampleTreasuryDetail } from '../components/ShowcasePreviews';

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

vi.mock('../components/EnterpriseDecisions', () => ({
    EnterpriseDecisions: () => <div data-testid="enterprise-decisions" />,
}));

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'member-charlie-pubkey',
    privateKey: 'mock-private-key-hex',
    callsign: 'Charlie',
    createdAt: '2026-01-01T00:00:00.000Z',
};

// Example Valley as the Commons preview hands it over (only ShowcasePreviews names the sample itself).
const [bakery, project] = sampleTreasuries();
const BAKERY = { id: bakery.publicKey, name: bakery.name, balance: bakery.balance, listing: sampleTreasuryDetail(bakery.publicKey).posts[0].title as string };
const PROJECT = { id: project.publicKey, title: project.name };

let calls: { url: string; method: string; body: string }[] = [];

beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: typeof init?.body === 'string' ? init.body : '' });
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }));
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Let anything the page started land, then: not one request, so no write and no sample id on the wire. */
async function askedNothing() {
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toEqual([]);
}

function renderPage(pubkey: string, extra: Partial<Parameters<typeof TreasuryDetailPage>[0]> = {}) {
    const props = { onBack: vi.fn(), onOpenProfile: vi.fn(), onNavigatePost: vi.fn(), onNearYou: vi.fn(), onGuide: vi.fn(), ...extra };
    render(<TreasuryDetailPage identity={mockIdentity} isMember={true} pubkey={pubkey} enterprisesPreview {...props} />);
    return props;
}

describe('TreasuryDetailPage in preview: Example Valley\'s enterprise', () => {
    it('is the real page fed the sample, marked, and asks the node nothing', async () => {
        renderPage(BAKERY.id);
        await waitFor(() => expect(screen.getAllByText(BAKERY.name).length).toBeGreaterThan(0));

        expect(screen.getByTestId('local-community-strip')).toBeInTheDocument();
        expect(screen.getByTestId('sample-header')).toBeInTheDocument();
        expect(screen.getAllByText('a neighbour').length).toBeGreaterThanOrEqual(2);
        expect(screen.getByText(BAKERY.listing)).toBeInTheDocument();
        expect(screen.getAllByText(new RegExp(String(BAKERY.balance))).length).toBeGreaterThan(0);
        // Not drawn in preview: the keepers' votes, Report, the thread's composer.
        expect(screen.queryByTestId('enterprise-decisions')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Report/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        // The thread says where talk happens, not "Start the conversation!"; Recent Activity is the P&L's rows (N4).
        expect(screen.getByTestId('thread-preview')).toHaveTextContent('In a local community');
        expect(screen.queryByText(/Start the conversation/)).toBeNull();
        expect(screen.queryByText('No recent activity.')).toBeNull();
        expect(screen.getAllByText('Sourdough orders').length).toBeGreaterThanOrEqual(2);
        await askedNothing();
    });

    it('every control is a marker that opens the sheet, with its ways forward, and asks nothing', async () => {
        const props = renderPage(BAKERY.id);
        await waitFor(() => expect(screen.getAllByText(BAKERY.name).length).toBeGreaterThan(0));

        const markers = screen.getAllByTestId('local-community-action').map(b => b.textContent?.replace(/🏘️.*$/u, '').trim());
        expect(markers).toEqual(['Post Offer', 'Post Need', 'To Commons', 'Pause for season', 'Start wind-up', 'Join as keeper']);
        for (const name of markers) {
            fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
            const sheet = await screen.findByTestId('local-community-sheet');
            expect(sheet).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features.enterprises);
            fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
            expect(screen.queryByTestId('local-community-sheet')).toBeNull();
        }
        // The sheet's ways forward are the app's (review N2).
        fireEvent.click(screen.getByRole('button', { name: /^Join as keeper/ }));
        fireEvent.click(await screen.findByTestId('local-community-near-you'));
        expect(props.onNearYou).toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: /^Post Offer/ }));
        fireEvent.click(await screen.findByTestId('local-community-guide'));
        expect(props.onGuide).toHaveBeenCalledWith(LOCAL_COMMUNITY_SHEET.guide.enterprises);
        // A listing tap goes nowhere.
        fireEvent.click(screen.getByText(BAKERY.listing));
        expect(props.onNavigatePost).not.toHaveBeenCalled();
        await askedNothing();
    });

    it('a keeper row is not a button: no profile opens, nothing is sent (B3)', async () => {
        const props = renderPage(BAKERY.id);
        const keepers = (await screen.findByText(/^Keepers \(3\)$/)).parentElement!;
        expect(within(keepers).getAllByText('a neighbour')).toHaveLength(3);
        expect(within(keepers).queryAllByRole('button')).toEqual([]);
        expect(screen.queryAllByRole('button', { name: /a neighbour/ })).toEqual([]);
        for (const row of within(keepers).getAllByText('a neighbour')) fireEvent.click(row);
        expect(props.onOpenProfile).not.toHaveBeenCalled();
        await askedNothing();
    });

    it('the markers stand one to a row, so at 320 px no pill runs off its button (B4)', async () => {
        renderPage(BAKERY.id);
        await waitFor(() => expect(screen.getAllByText(BAKERY.name).length).toBeGreaterThan(0));
        for (const name of [/^Post Offer/, /^Post Need/, /^Pause for season/, /^Start wind-up/]) {
            const grid = screen.getByRole('button', { name }).closest('.grid');
            expect(grid).toHaveClass('grid-cols-1');
            expect(grid).not.toHaveClass('grid-cols-2');
        }
    });

    it('Escape on a marker\'s sheet closes the sheet and leaves the page open; the next Escape goes back (N1)', async () => {
        const props = renderPage(BAKERY.id);
        await waitFor(() => expect(screen.getAllByText(BAKERY.name).length).toBeGreaterThan(0));
        fireEvent.click(screen.getByRole('button', { name: /^Start wind-up/ }));
        await screen.findByTestId('local-community-sheet');
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('local-community-sheet')).toBeNull();
        expect(props.onBack).not.toHaveBeenCalled();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(props.onBack).toHaveBeenCalledTimes(1);
    });
});

describe('TreasuryDetailPage in preview: Example Valley\'s project', () => {
    it('the pledge is the marker, never the form; the join card says the project\'s word', async () => {
        renderPage(PROJECT.id);
        await waitFor(() => expect(screen.getAllByText(PROJECT.title).length).toBeGreaterThan(0));
        expect(screen.queryByPlaceholderText(/Amount/)).toBeNull();
        const markers = screen.getAllByTestId('local-community-action').map(b => b.textContent?.replace(/🏘️.*$/u, '').trim());
        expect(markers).toContain('Pledge');
        expect(markers).toContain('Join as collaborator');
        expect(markers).not.toContain('Join as keeper');
        fireEvent.click(screen.getByRole('button', { name: /^Pledge/ }));
        expect(await screen.findByTestId('local-community-sheet')).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features.enterprises);
        await askedNothing();
    });
});

describe('TreasuryDetailPage: a real key', () => {
    it('where enterprises are a preview (the worldwide community): says why and asks nothing (N8)', async () => {
        renderPage('b'.repeat(64));
        const line = await screen.findByTestId('enterprise-elsewhere');
        expect(line).toHaveTextContent('Enterprises live in a local community');
        expect(screen.queryByText(BAKERY.name)).toBeNull();
        fireEvent.click(within(line).getByRole('button'));
        expect(await screen.findByTestId('local-community-sheet')).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features.enterprises);
        await askedNothing();
    });

    it('on a local node: read as before, the detail, its ledger and its thread; no strip, no marker', async () => {
        const detail = vi.spyOn(api, 'getTreasury').mockResolvedValue({
            publicKey: 'local-ent-1', name: 'Garden Bakery', purpose: 'Bread from the garden oven', balance: 50, creditLine: 100,
            liveOffers: 0, lifecycle: 'ongoing', status: 'active', keepers: [{ publicKey: 'kofi-key', callsign: 'Kofi', role: 'lead' }], posts: [],
        } as any);
        const ledger = vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({ entries: [], summary: null } as any);
        const thread = vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({ conversation: null, messages: [], readOnly: false } as any);
        const onOpenProfile = vi.fn();
        render(<TreasuryDetailPage identity={mockIdentity} isMember={true} pubkey="local-ent-1" onBack={vi.fn()} onOpenProfile={onOpenProfile} />);
        await waitFor(() => expect(screen.getAllByText('Garden Bakery').length).toBeGreaterThan(0));
        expect(detail).toHaveBeenCalledWith('local-ent-1');
        expect(ledger).toHaveBeenCalled();
        expect(thread).toHaveBeenCalled();
        expect(screen.queryByTestId('local-community-strip')).toBeNull();
        expect(screen.queryAllByTestId('local-community-action')).toEqual([]);
        // A keeper row still opens that keeper's profile.
        fireEvent.click(screen.getByRole('button', { name: /Kofi/ }));
        expect(onOpenProfile).toHaveBeenCalledWith('kofi-key');
    });
});
