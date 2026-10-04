/**
 * WelcomePage's join step in a known community (community modes slice 6): the community's consent text is shown before
 * joining with an "I agree" tick that is never required; a ticked consent is recorded once the node has taken the
 * invite, signed by the key it took. A plain community (or an older node) shows nothing. The node is a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

type Call = { path: string; body: any; headers: Record<string, string> };

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const LOCAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { openJoin: false } };
const CODE = 'BP-7K3X-9M2W';
const TEXT = 'In this community, the admins can see your balance if it goes past 50% of your credit line or if you stay in debit for 60 days without a sale. That\'s how a LETS has always worked. Every look at your balance is logged, and you can take this back at any time in Settings. Whatever you choose, any admin can see some of your trades: a trade that isn\'t finished yet or that an admin settled (who with, the listing, the price, and your one-to-one chat with them, which they can\'t read if it is private), so a stuck trade can be settled; a trade whose Beans were left stuck when a member was removed on an older server (the trade\'s status, the listing, the price, its dates, the Beans left stuck, how many payments went through it, and the last one\'s amount and note); a fraud alert that names you if you and one member buy from each other back and forth, about evenly, past a limit, with the Beans in total and how evenly they went each way; one that names you, with the Beans in total and how many of the members you invited have traded with no one but you, if members you invited send you Beans past a limit within a set number of days, or if you are one of those members; one that names you, with how much of the group\'s trading is with each other but no Beans, if you are in a group of members, at least half of them new, who trade mostly with each other; and an alert that names you if no Beans have moved in or out of your account for a set number of days. Every look at one of those trades is logged, with who looked, when, and at which trades; a look at the alerts that name you is logged the first time each admin opens them, and again at that admin\'s first look after 24 hours, and the looks in between add no line. The owner and the admins can see that log. The member stats the admins see show how many posts you have up and messages you have sent, and of trades only the whole community\'s totals, not yours. Every member, admins included, sees your trust profile: how many trades you have finished and how many they cancelled, the share they finished, how many Bean payments you have sent to or received from members plus the trades you have finished, with how many different members you have paid, been paid by or traded with, how many payments and trades you have done with the member looking, and your Trust Points. That isn\'t logged, because every member can see it. Nothing else of your trades. Whoever runs this community\'s server holds its whole database, your balance and trades included, and its backups, snapshots and standby copies.';
const KNOWN = { known: true, debtLinePct: 50, quietDays: 60, version: '5:50:60', text: TEXT };

function stubNode(terms: unknown) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const call: Call = { path: String(input), body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string> };
        calls.push(call);
        if (call.path === '/api/community/info') return json(200, LOCAL);
        if (call.path === '/api/community/consent-terms') return terms === 404 ? json(404, { error: 'Not found' }) : json(200, terms);
        if (call.path.startsWith('/api/invite/check')) return json(200, { valid: true });
        if (call.path === '/api/invite/redeem') return json(200, { success: true, member: {} });
        return json(200, {});
    }));
    return {
        redeem: () => calls.find((c) => c.path === '/api/invite/redeem'),
        consents: () => calls.filter((c) => c.path === '/api/names/consent'),
    };
}

async function fillIn() {
    await screen.findByText(/Join with Invite Code/);
    fireEvent.change(screen.getByLabelText('Invite Code'), { target: { value: CODE } });
    fireEvent.change(screen.getByLabelText('Your Callsign (Name)'), { target: { value: 'Rowan' } });
}
const join = () => fireEvent.click(screen.getByRole('button', { name: 'Create Identity & Join →' }));

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the join step in a known community', () => {
    it('shows the text before joining; ticked, the consent goes once the node took the invite, signed by that key', async () => {
        const node = stubNode(KNOWN);
        render(<WelcomePage onComplete={vi.fn()} />);
        await fillIn();
        expect(await screen.findByText(TEXT)).toBeInTheDocument();
        const tick = screen.getByLabelText('I agree');
        expect(tick).not.toBeChecked();
        fireEvent.click(tick);
        expect(node.consents()).toHaveLength(0);
        join();
        await screen.findByText(/Choose your look/);
        await waitFor(() => expect(node.consents()).toHaveLength(1));
        const [consent] = node.consents();
        expect(consent.body).toEqual({ version: '5:50:60' });
        expect(consent.headers['X-Public-Key']).toBe(node.redeem()!.body.publicKey);
    });

    it('never required: unticked, the member joins and nothing is recorded', async () => {
        const node = stubNode(KNOWN);
        render(<WelcomePage onComplete={vi.fn()} />);
        await fillIn();
        await screen.findByText(TEXT);
        join();
        await screen.findByText(/Choose your look/);
        expect(node.redeem()).toBeDefined();
        expect(node.consents()).toHaveLength(0);
    });

    it.each([['a plain community', { ...KNOWN, known: false }], ['an older node (404)', 404]])('%s shows nothing', async (_, terms) => {
        const node = stubNode(terms);
        render(<WelcomePage onComplete={vi.fn()} />);
        await fillIn();
        join();
        await screen.findByText(/Choose your look/);
        expect(screen.queryByTestId('join-consent')).toBeNull();
        expect(node.consents()).toHaveLength(0);
    });
});
