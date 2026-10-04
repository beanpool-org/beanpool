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
const TEXT = 'In this community, the admins can see your balance if it goes past 50% of your credit line or if you stay in debit for 60 days without a sale. That\'s how a LETS has always worked. Every look at your balance is logged, and you can take this back at any time in Settings. Whatever you choose, any admin can see some of your trades, and those looks are not logged: a trade that isn\'t finished yet or that an admin settled (who with, the listing, the price, and your chat with them, which they can\'t read if it is private), so a stuck trade can be settled; how many trades you have finished or cancelled, and what the finished ones came to; and a fraud alert that names you, and how many Beans moved, if you trade mostly with one member, within a small group, or with members you invited. Nothing else of your trades.';
const KNOWN = { known: true, debtLinePct: 50, quietDays: 60, version: '2:50:60', text: TEXT };

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
        expect(consent.body).toEqual({ version: '2:50:60' });
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
