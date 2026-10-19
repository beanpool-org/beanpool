/**
 * The enterprise / project page in the member's language (words S3, web sweep W2): every sentence the page draws, says
 * to a screen reader or asks in a confirm goes through t()/tn(), written whole for a project (leader, collaborators) and
 * for an enterprise (lead keeper, keepers), with the phone's keys (S3h) where the English is the same. What members
 * wrote (the name, the purpose, listings, memos, messages, names) is shown as written.
 *
 * Not drawn here: the keepers' votes (EnterpriseDecisions, its own words test), the map-pin picker (the same), the
 * report box (sweep W1), and Example Valley's sample page, whose marker (LocalCommunityMark, core's word() keys drawn
 * as they are on the phone too) and sample header (ShowcasePreviews, sweep W3) are not this sweep's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { formatDate } from '@beanpool/core';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import * as api from '../lib/api';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-w2.test-support';

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../components/EnterpriseDecisions', () => ({ EnterpriseDecisions: () => null }));

const ENT = 'enterprise-eggs';
const ALICE = 'lead-alice';
const BOB = 'keeper-bob';
const CARA = 'keeper-cara';
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const BOB_ID = { publicKey: BOB, callsign: 'Bob' } as any;
const ALICE_ID = { publicKey: ALICE, callsign: 'Alice' } as any;
const DAN_ID = { publicKey: 'member-dan', callsign: 'Dan' } as any;

const KEEPERS = [
    { publicKey: ALICE, callsign: 'Alice', role: 'lead', backing: 0 },
    { publicKey: BOB, callsign: 'Bob', role: 'keeper', backing: 20 },
    { publicKey: CARA, callsign: 'Cara', role: 'keeper', backing: 0, suspended: true },
];
const INACTIVITY = { leadPubkey: ALICE, leadCallsign: 'Alice', daysInactive: 40, isEligible: true, autoPromoted: false };

/** An enterprise in a busy week: in deficit, with bids, deals, requests, a keeper change and a succession vote. */
function busy(over: Record<string, unknown> = {}) {
    return {
        publicKey: ENT, name: 'Community Eggs', purpose: 'Eggs for the street', status: 'active', paused: false, lifecycle: 'ongoing',
        balance: -12.5, creditLine: 200, liveOffers: 2, earnedSurplus: 30, workingCapitalCeiling: null,
        deferredClaims: [{ id: 'c1', status: 'pending', amount: 8 }],
        pendingBids: [{ id: 'bid-1', post_title: 'Clean the coop', credits: 10, peer_callsign: 'Dan' }],
        activeDeals: [
            { id: 'deal-1', post_id: 'p1', post_title: 'Egg delivery', credits: 6, action_required: 'fulfill', peer_callsign: 'Eve' },
            { id: 'deal-2', post_id: 'p3', post_title: 'Fix the fence', credits: 15, action_required: 'release', peer_callsign: null, price_type: 'fixed' },
        ],
        keepers: KEEPERS,
        isLeadOrSoleKeeperOrAdmin: true,
        keeperRequests: [
            { id: 'req-1', enterprisePubkey: ENT, memberPubkey: 'member-dan', callsign: 'Dan', pledgedBacking: 5, status: 'pending', createdAt: at(-DAY), canBackPledge: false },
            { id: 'req-2', enterprisePubkey: ENT, memberPubkey: 'member-fay', callsign: 'Fay', pledgedBacking: 0, status: 'pending', createdAt: at(-DAY), canBackPledge: true, pendingChange: { appliesAt: at(2 * DAY + 60_000) } },
        ],
        keeperChanges: [{
            id: 'chg-1', enterprisePubkey: ENT, kind: 'add', memberPubkey: 'member-gus', memberCallsign: 'Gus', requestId: 'req-0', pledgedBacking: 4,
            proposedBy: ALICE, proposedByCallsign: 'Alice', status: 'pending', createdAt: at(-DAY), appliesAt: at(2 * DAY + 60_000),
            resolvedAt: null, resolvedBy: null,
        }],
        leadInactivity: INACTIVITY,
        succession: {
            inactivity: INACTIVITY,
            proposals: [{
                id: 'prop-1', enterprisePubkey: ENT, leadPubkey: ALICE, candidatePubkey: CARA, candidateCallsign: 'Cara', status: 'active',
                votesCount: 1, noVotesCount: 0, requiredVotes: 2, totalEligible: 2, deadlineAt: at(13 * DAY + 60_000), votes: [],
            }],
        },
        posts: [
            { id: 'p1', type: 'offer', title: 'Dozen eggs', description: 'Free range', credits: 6, price_type: 'hourly', repeatable: true },
            { id: 'p2', type: 'need', title: 'Coop cleaning', credits: 10 },
        ],
        flow: [
            { id: 'f1', memo: 'Egg sale', amount: 6, incoming: true, timestamp: at(-2 * DAY) },
            { id: 'f2', memo: '', amount: 2, incoming: false, timestamp: at(-DAY) },
        ],
        lat: -28.55, lng: 153.5,
        ...over,
    };
}

const LEDGER = {
    enterprise: { publicKey: ENT, name: 'Community Eggs', status: 'active', paused: false, balance: -12.5 },
    period: { since: null, until: null },
    summary: { totalIncome: 120, totalSpend: 40, netChange: 78, startingBalance: -90.5, endingBalance: -12.5, transactionCount: 3 },
    entries: [
        { id: 'e1', timestamp: at(-3 * DAY), direction: 'income', amount: 120, fee: 2, netAmount: 118, counterparty: 'member-dan', counterpartyName: 'Dan', memo: 'Veggie box', runningBalance: 29.5 },
        { id: 'e2', timestamp: at(-2 * DAY), direction: 'spend', amount: 40, fee: 0, netAmount: 40, counterparty: 'member-eve', counterpartyName: '', memo: '', runningBalance: -12.5 },
    ],
};

const THREAD = {
    conversation: { id: ENT, type: 'enterprise_thread' },
    readOnly: false,
    messages: [
        { id: 'm1', conversationId: ENT, authorPubkey: 'member-dan', authorCallsign: 'Dan', authorAvatar: null, ciphertext: b64('Hello keepers'), nonce: 'plaintext-v1', type: 'text', timestamp: at(-DAY) },
        { id: 'm2', conversationId: ENT, authorPubkey: 'member-eve', authorCallsign: 'Eve', authorAvatar: null, ciphertext: b64('removed by a keeper'), nonce: 'plaintext-v1', type: 'removed', metadata: JSON.stringify({ removed: true }), timestamp: at(-DAY) },
        { id: 'm3', conversationId: ENT, authorPubkey: 'member-hal', authorCallsign: 'Hal', authorAvatar: null, ciphertext: '', nonce: 'plaintext-v1', type: 'removed', metadata: JSON.stringify({ accountDeleted: true }), timestamp: at(-DAY) },
    ],
};

/** What members wrote, shown as written: names (and the initials the thread draws for them), titles, memos, messages. */
const OTHERS = [
    'Community Eggs', 'Eggs for the street', 'Clean the coop', 'Egg delivery', 'Fix the fence', 'Dozen eggs', 'Free range', 'Coop cleaning',
    'Egg sale', 'Veggie box', 'Hello keepers', 'Alice', 'Bob', 'Cara', 'Dan', 'Eve', 'Fay', 'Gus', 'Hal', 'New Roof', 'A roof for the hall',
];
const INITIALS = ['D', 'E', 'H'];

let said: string[] = [];

function node(treasury: unknown, o: { ledger?: unknown; thread?: unknown; keeperOf?: string[] } = {}) {
    vi.spyOn(api, 'getTreasury').mockResolvedValue(treasury as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 50, keeperOf: o.keeperOf ?? [] } as any);
    const ledger = o.ledger ?? LEDGER;
    if (ledger instanceof Error) vi.spyOn(api, 'getEnterpriseLedger').mockRejectedValue(ledger);
    else vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue(ledger as any);
    const thread = o.thread ?? THREAD;
    if (thread instanceof Error) vi.spyOn(api, 'getEnterpriseThread').mockRejectedValue(thread);
    else vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue(thread as any);
}

async function draw(identity: any, props: Record<string, unknown> = {}) {
    await act(async () => {
        render(<TreasuryDetailPage identity={identity} pubkey={ENT} onBack={() => {}} {...props} />);
    });
}

const clean = (extra: readonly string[] = []) => bypassing(document.body, { others: [...OTHERS, ...extra], said });

beforeEach(() => {
    vi.restoreAllMocks();
    said = [];
    vi.spyOn(window, 'confirm').mockImplementation((m?: string) => { said.push(String(m)); return false; });
    vi.spyOn(window, 'alert').mockImplementation((m?: string) => { said.push(String(m)); });
    vi.spyOn(window, 'prompt').mockImplementation((m?: string) => { said.push(String(m)); return null; });
});
afterEach(() => { cleanup(); backToEnglish(); });

describe('the enterprise page in the pseudo-locale', () => {
    it("a keeper's view of a busy week: every card, every line and every control came through t()", async () => {
        node(busy(), { keeperOf: [ENT] });
        await showIn('xx');
        await draw(BOB_ID);
        expect(await screen.findByRole('heading', { level: 1, name: 'Community Eggs' })).toBeInTheDocument();
        await screen.findByText('Hello keepers');
        expect(screen.getByText(xx('Enterprise Balance'))).toBeInTheDocument();
        expect(screen.getByText(xx('Keepers ({n})').replace('{n}', '3'))).toBeInTheDocument();
        expect(screen.getByText(xx('removed by a keeper'))).toBeInTheDocument();
        expect(screen.getByText(xx('This message was deleted'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Yes, make {name} lead keeper').replace('{name}', 'Cara') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Object: {change}').replace('{change}', xx('Adding {name} as a keeper, backing {n} beans').replace('{name}', 'Gus').replace('{n}', '4')) })).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(60);
        expect(clean(INITIALS)).toEqual([]);

        // Each season control's confirmation, in turn.
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Pause for Season').replace(/[[\]~]/g, '.')) }));
        expect(screen.getByText(xx('Confirm Pause for Season'))).toBeInTheDocument();
        expect(clean(INITIALS)).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: xx('Cancel') }));
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Start Wind-Up').replace(/[[\]~]/g, '.')) }));
        expect(screen.getByText(xx('Start Enterprise Wind-Up'))).toBeInTheDocument();
        expect(clean(INITIALS)).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: xx('Cancel') }));

        // The post form, with the Market's categories.
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Post Offer').replace(/[[\]~]/g, '.')) }));
        const form = screen.getByRole('dialog');
        expect(within(form).getByRole('heading', { name: xx('Post Enterprise Offer') })).toBeInTheDocument();
        expect(within(form).getByRole('option', { name: xx('{emoji} {label}').replace('{emoji}', '🥕').replace('{label}', xx('Food & Produce')) })).toBeInTheDocument();
        expect(clean(INITIALS)).toEqual([]);
        fireEvent.click(within(form).getByRole('button', { name: xx('Cancel') }));

        // What a keeper is asked before acting, and what a refusal with no words of its own says.
        fireEvent.click(screen.getByRole('button', { name: xx('Step down as a keeper') }));
        // The bid's Decline (the operator controls come before the requests to join, which have one each too).
        fireEvent.click(screen.getAllByRole('button', { name: xx('Decline') })[0]);
        fireEvent.click(screen.getByRole('button', { name: xx('Release Payment ({amount} 🫘)').replace('{amount}', '15') }));
        fireEvent.click(screen.getAllByRole('button', { name: xx('Remove message from {name}').replace('{name}', 'Dan') })[0]);
        expect(said).toHaveLength(4);
        vi.spyOn(api, 'treasuryApprove').mockRejectedValue(new Error(''));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: xx('Approve Bid ({amount} 🫘)').replace('{amount}', '10') })); });
        expect(await screen.findByText(xx('Failed to approve bid.'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Dismiss') })).toBeInTheDocument();
        expect(clean(INITIALS)).toEqual([]);
    });

    it('paused: the banner, its warning and resuming', async () => {
        node(busy({
            balance: 40, paused: true, pausedFloorSnapshot: -200, pauseExpiresAt: '2026-12-14T12:00:00.000Z', pauseDaysRemaining: 3,
            keeperRequests: [], keeperChanges: [], leadInactivity: null, succession: null, pendingBids: [], activeDeals: [],
        }), { keeperOf: [ENT] });
        await showIn('xx');
        await draw(ALICE_ID);
        // The date in the language's own words too (xx writes its month names as it writes everything).
        const until = formatDate(new Date('2026-12-14T12:00:00.000Z'), 'day-month', { width: 'long' });
        expect(until).not.toBe('14 December');
        expect(await screen.findByText(xx('Paused for the season. Credit held at {n} beans until {date}.').replace('{n}', '200').replace('{date}', until))).toBeInTheDocument();
        expect(screen.getByText(xx('Pause credit floor snapshot expires in {n} days').replace('{n}', '3'))).toBeInTheDocument();
        expect(screen.getAllByText(xx('⏸️ Paused')).length).toBe(2);
        expect(clean(INITIALS)).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Resume Enterprise').replace(/[[\]~]/g, '.')) }));
        expect(screen.getByText(xx('Confirm Resume Enterprise'))).toBeInTheDocument();
        expect(clean(INITIALS)).toEqual([]);
    });

    it('winding up past its grace: the banner, stopping and finalising', async () => {
        node(busy({
            balance: 40, status: 'winding_up', windUpInitiatedBy: ALICE, windUpInitiatedAt: at(-8 * DAY), windUpGraceEndsAt: at(-DAY),
            keeperRequests: [], keeperChanges: [], leadInactivity: null, succession: null, pendingBids: [], activeDeals: [],
        }), { keeperOf: [ENT] });
        await showIn('xx');
        await draw(ALICE_ID);
        expect(await screen.findByText(xx('Winding up ({n} days left · started by {name})').replace('{n}', '0').replace('{name}', 'Alice'))).toBeInTheDocument();
        expect(screen.getByText(xx('The 7-day grace period has elapsed. Ready to be finalised.'))).toBeInTheDocument();
        expect(clean(INITIALS)).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Stop Wind-Up').replace(/[[\]~]/g, '.')) }));
        expect(screen.getByText(xx('Stop Enterprise Wind-Up'))).toBeInTheDocument();
        expect(clean(INITIALS)).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: xx('Keep Winding Up') }));
        fireEvent.click(screen.getByRole('button', { name: new RegExp(xx('Finalise Wind-Up').replace(/[[\]~]/g, '.')) }));
        expect(screen.getByText(xx('Finalise Enterprise Wind-Up'))).toBeInTheDocument();
        expect(clean(INITIALS)).toEqual([]);
    });

    it("a project raising Beans, to a member: the funding, the pledge box, asking to join, and a refused pledge", async () => {
        node(busy({
            name: 'New Roof', purpose: 'A roof for the hall', lifecycle: 'bounded', balance: 120, goalAmount: 500, currentAmount: 120,
            deadlineAt: at(5 * DAY), availableToBack: 30, isLeadOrSoleKeeperOrAdmin: false, keeperRequests: [], keeperChanges: [],
            leadInactivity: null, succession: null, pendingBids: [], activeDeals: [], keepers: KEEPERS.slice(0, 2),
        }));
        await showIn('xx');
        await draw(DAN_ID);
        expect(await screen.findByText(xx('raised of {goal} 🫘 goal').replace('{goal}', '500'))).toBeInTheDocument();
        expect(screen.getByText(xx('Ask to join as a collaborator'))).toBeInTheDocument();
        expect(screen.getByText(xx('Collaborators ({n})').replace('{n}', '2'))).toBeInTheDocument();
        expect(screen.getByRole('slider', { name: xx('Back this project with your standing: 0 to {n}').replace('{n}', '30') })).toBeInTheDocument();
        expect(clean(INITIALS)).toEqual([]);
        fireEvent.change(screen.getByPlaceholderText(xx('Amount (🫘)')), { target: { value: '0' } });
        await act(async () => { fireEvent.submit(screen.getByPlaceholderText(xx('Amount (🫘)')).closest('form')!); });
        expect(screen.getByText(xx('Please enter a positive amount of Beans to pledge.'))).toBeInTheDocument();
        expect(clean([...INITIALS, '0'])).toEqual([]);
    });

    it('a request waiting, a wound-up project, and a guest', async () => {
        node(busy({
            name: 'New Roof', purpose: 'A roof for the hall', lifecycle: 'bounded', balance: 0, isLeadOrSoleKeeperOrAdmin: false,
            keeperRequests: [], keeperChanges: [], leadInactivity: null, succession: null, pendingBids: [], activeDeals: [],
            myPendingRequest: { id: 'req-9', enterprisePubkey: ENT, memberPubkey: 'member-dan', pledgedBacking: 7, status: 'pending', createdAt: at(-DAY) },
        }));
        await showIn('xx');
        await draw(DAN_ID);
        expect(await screen.findByText(xx('Your request to join is waiting'))).toBeInTheDocument();
        expect(clean(INITIALS)).toEqual([]);
        cleanup();

        node(busy({ name: 'New Roof', lifecycle: 'bounded', status: 'completed', balance: 0, keeperRequests: [], keeperChanges: [], leadInactivity: null, succession: null }), { thread: { ...THREAD, readOnly: true } });
        await draw(DAN_ID);
        expect(await screen.findByText(xx('This project has completed its purpose and wound up permanently. Surplus was returned to the Commons, collaborators were released, and listings are closed.'))).toBeInTheDocument();
        expect(screen.getByText(xx('This project has wound up. Discussion is read-only for accountability.'))).toBeInTheDocument();
        expect(screen.getAllByText(xx('Closed')).length).toBe(2);
        expect(clean(INITIALS)).toEqual([]);
        cleanup();

        node(busy({ keeperRequests: [], keeperChanges: [], leadInactivity: null, succession: null }), { ledger: new Error(''), thread: new Error('') });
        await draw(DAN_ID, { isMember: false });
        expect(await screen.findByText(xx('The full income and spend record is visible to members.'))).toBeInTheDocument();
        expect(screen.getByText(xx('The discussion is open to members.'))).toBeInTheDocument();
        expect(clean(INITIALS)).toEqual([]);
    });

    it('the page that cannot load, and the one that is not there', async () => {
        vi.spyOn(api, 'getTreasury').mockRejectedValue(new Error(''));
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue(LEDGER as any);
        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue(THREAD as any);
        await showIn('xx');
        await draw(DAN_ID);
        expect(await screen.findByText(xx("Couldn't load this group"))).toBeInTheDocument();
        expect(screen.getByText(xx('Check your connection and try again.'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Go back') })).toBeInTheDocument();
        expect(clean()).toEqual([]);
        cleanup();

        vi.spyOn(api, 'getTreasury').mockResolvedValue(null as any);
        await draw(DAN_ID);
        expect(await screen.findByText(xx('Group not found.'))).toBeInTheDocument();
        expect(clean()).toEqual([]);
    });
});

describe('the enterprise page in English', () => {
    it('nothing is bracketed, and the words are as they were', async () => {
        node(busy(), { keeperOf: [ENT] });
        await draw(BOB_ID);
        await screen.findByText('Hello keepers');
        expect(bracketed()).toBe(0);
        expect(screen.getByText('Enterprise Balance')).toBeInTheDocument();
        expect(screen.getByRole('alert').textContent).toBe('⚠️ In Deficit: This enterprise is currently in deficit (-12.5 🫘). Credit buys inputs and supplies, but keepers can only be paid from profit. Keepers cannot be paid while the enterprise is in deficit.');
        expect(screen.getByText('Uncapped')).toBeInTheDocument();
        expect(screen.getByText('Pending Wage Claims (1)')).toBeInTheDocument();
        expect(screen.getByText('Clean the coop').parentElement!.nextElementSibling!.textContent).toBe('Bidder: Dan');
        expect(screen.getByRole('button', { name: 'Approve Bid (10 🫘)' })).toBeInTheDocument();
        expect(screen.getByText('6 🫘 in escrow')).toBeInTheDocument();
        expect(screen.getByText('Egg delivery').parentElement!.nextElementSibling!.textContent).toBe('Customer: Eve');
        expect(screen.getByText('Fix the fence').parentElement!.nextElementSibling!.textContent).toBe('Worker: Member');
        expect(screen.getByText('On the map at -28.550, 153.500')).toBeInTheDocument();
        expect(screen.getByText('Asking to join as keepers (2)')).toBeInTheDocument();
        expect(screen.getAllByText(/^Backing pledge:/).map((e) => e.textContent)).toEqual(['Backing pledge: 5 🫘', 'Backing pledge: 0 🫘']);
        expect(screen.getByText(/^Approved\. Joins when the objection window ends \(2 days/)).toBeInTheDocument();
        expect(screen.getByText('Keeper changes waiting (1)')).toBeInTheDocument();
        expect(screen.getByText('Adding Gus as a keeper, backing 4 beans')).toBeInTheDocument();
        expect(screen.getByText(/^Active Succession Proposal:/).textContent).toBe('Active Succession Proposal: Move the lead keeper role to Cara');
        expect(screen.getByRole('button', { name: 'No, do not make Cara lead keeper' })).toBeInTheDocument();
        expect(screen.getByText('Keepers (3)')).toBeInTheDocument();
        expect(screen.getByText('Lead keeper')).toBeInTheDocument();
        expect(screen.getByText('Suspended')).toBeInTheDocument();
        expect(screen.getByText('+20 🫘')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Step down as a keeper' })).toBeInTheDocument();
        expect(screen.getByTestId('ledger-fee-note').textContent).toBe('Came in is before fees: 2.00 🫘 in fees came off it.');
        // Came in and went out, and the rows they came in and went out on.
        expect(screen.getAllByText('+120.00 🫘')).toHaveLength(2);
        expect(screen.getAllByText('-40.00 🫘')).toHaveLength(2);
        expect(screen.getAllByText('Starting balance:', { exact: false })[0].textContent).toBe('Starting balance: -90.50 🫘');
        expect(screen.getByText('Enterprise Listings (2)')).toBeInTheDocument();
        expect(screen.getByText('offer')).toBeInTheDocument();
        expect(screen.getByText('need')).toBeInTheDocument();
        expect(screen.getByText('/hourly')).toBeInTheDocument();
        expect(screen.getByText('🔄 recurring')).toBeInTheDocument();
        expect(screen.getAllByText('Transfer')).toHaveLength(2);
        expect(screen.getByText('removed by a keeper')).toBeInTheDocument();
        expect(screen.getByText('This message was deleted')).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Message the enterprise' })).toHaveAttribute('placeholder', 'Message the enterprise...');
        expect(screen.getByRole('button', { name: /Report Enterprise/ }).textContent).toBe('🛡️ Report Enterprise');

        fireEvent.click(screen.getByRole('button', { name: 'Step down as a keeper' }));
        fireEvent.click(screen.getByRole('button', { name: 'Release Payment (15 🫘)' }));
        fireEvent.click(screen.getAllByRole('button', { name: 'Remove message from Dan' })[0]);
        expect(said[0]).toMatch(/^Step down as a keeper\? /);
        expect(said[1]).toBe('Release payment of 15 🫘 for "Fix the fence"? This action cannot be reversed.');
        expect(said[2]).toBe('Are you sure you want to remove this message? It will show as "removed by a keeper".');

        fireEvent.click(screen.getByRole('button', { name: /Start Wind-Up/ }));
        expect(screen.getByText('Cannot wind up an enterprise in deficit (-12.5 🫘). Debt must be resolved or written off first.')).toBeInTheDocument();
        expect(screen.getByText(/^Winding up returns/).textContent).toBe('Winding up returns 0.00 beans to the Commons, releases 3 keepers, and closes Community Eggs for good. Any keeper can stop this for the next 7 days.');
    });

    it("a project's words: the funding, asking to join, and the collaborators", async () => {
        node(busy({
            name: 'New Roof', purpose: 'A roof for the hall', lifecycle: 'bounded', balance: 120, goalAmount: 500, currentAmount: 120,
            deadlineAt: at(5 * DAY), availableToBack: 30, isLeadOrSoleKeeperOrAdmin: false, keeperRequests: [], keeperChanges: [],
            leadInactivity: null, succession: null, pendingBids: [], activeDeals: [], keepers: KEEPERS.slice(0, 2),
        }));
        await draw(DAN_ID);
        await screen.findByText('Funding Progress');
        expect(bracketed()).toBe(0);
        expect(screen.getByText('raised of 500 🫘 goal').parentElement!.textContent).toBe('120 🫘 raised of 500 🫘 goal');
        expect(screen.getByText(/days left$/).textContent).toBe('⏳ 5 days left');
        expect(screen.getByText("🔒 Pledges are held securely in the project's account, spendable only on transparent offers and needs that the whole community can see.")).toBeInTheDocument();
        expect(screen.getByText('Ask to join as a collaborator')).toBeInTheDocument();
        expect(screen.getByText('Help run this project. You can back it with your earned trading standing to expand its credit floor.')).toBeInTheDocument();
        expect(screen.getByText('Back this project with your standing: 0 … 30')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Request to join as a collaborator' })).toBeInTheDocument();
        expect(screen.getByText('Collaborators (2)')).toBeInTheDocument();
        expect(screen.getByText('Leader')).toBeInTheDocument();
        expect(screen.getByText('Project Listings (2)')).toBeInTheDocument();
    });
});
