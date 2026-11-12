/**
 * WelcomePage's join step in a known community (DESIGN-balance-rule-fable.md §2, §5): the rule in the community's own
 * numbers, from the public route, with nothing to tick and no consent sent. A plain community or an older node shows
 * nothing and joins as before. The node is a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

type Call = { path: string };

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const LOCAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: { openJoin: false } };
const CODE = 'BP-7K3X-9M2W';
const KNOWN = { known: true, knownFloor: 100000, debtLinePct: 50, quietDays: 60, ruleFrom: '2026-11-16T04:00:00.000Z', debtLineFrom: null, quietDaysFrom: null };

function stubNode(rule: unknown) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        calls.push({ path });
        if (path === '/api/community/info') return json(200, LOCAL);
        if (path === '/api/community/known-rule') return rule === 404 ? json(404, { error: 'Not found' }) : json(200, rule);
        if (path.startsWith('/api/invite/check')) return json(200, { valid: true });
        if (path === '/api/invite/redeem') return json(200, { success: true, member: {} });
        return json(200, {});
    }));
    return {
        redeem: () => calls.find((c) => c.path === '/api/invite/redeem'),
        consents: () => calls.filter((c) => c.path.includes('consent')),
    };
}

async function fillIn() {
    await screen.findByText(/Join with Invite Code/);
    fireEvent.change(screen.getByLabelText('Invite Code'), { target: { value: CODE } });
    fireEvent.change(screen.getByLabelText('Your Callsign (Name)'), { target: { value: 'Rowan' } });
}
const join = () => fireEvent.click(screen.getByRole('button', { name: 'Create Identity & Join →' }));

beforeEach(() => {
    window.history.replaceState({}, '', '/welcome');
    sessionStorage.clear();
    localStorage.clear();
    resetCapturedAuthReturn();
    Object.defineProperty(window, 'indexedDB', { value: memoryIndexedDB(), configurable: true });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('"Is my data private?"', () => {
    const ANSWER = "Your balance and your trades are private. If your community has a rule on when the admins can see a balance, it's under How this community works.";

    it.each([['a known community', KNOWN], ['a plain community', { known: false }], ['an older node', 404]])('says private, and where a rule would be, in %s', async (_name, rule) => {
        stubNode(rule);
        render(<WelcomePage onComplete={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: /Is my data private\?/ }));
        const answer = await screen.findByText(/Your identity is an Ed25519 key/);
        expect(answer.textContent).toContain(ANSWER);
        expect(answer.textContent).not.toMatch(/trades are not/);
    });
});

describe('the join step', () => {
    it('states the rule in the community\'s numbers, with nothing to tick', async () => {
        stubNode(KNOWN);
        render(<WelcomePage onComplete={() => {}} />);
        await fillIn();
        const box = await screen.findByTestId('join-rule');
        expect(within(box).getByText(/can owe up to 1,000 Beans \(the known floor\)/)).toBeInTheDocument();
        expect(within(box).getByText("The admins also keep a list of confirmed members who owe more than half their credit line, or are in debit and haven't made a sale for 60 days.")).toBeInTheDocument();
        expect(within(box).queryByRole('checkbox')).toBeNull();
    });

    it('a line other than 50 says its number', async () => {
        stubNode({ ...KNOWN, debtLinePct: 30, quietDays: 90 });
        render(<WelcomePage onComplete={() => {}} />);
        await fillIn();
        expect(await within(await screen.findByTestId('join-rule')).findByText(/owe more than 30% of their credit line, or are in debit and haven't made a sale for 90 days/)).toBeInTheDocument();
    });

    it('joining asks and sends no consent', async () => {
        const node = stubNode(KNOWN);
        render(<WelcomePage onComplete={() => {}} />);
        await fillIn();
        await screen.findByTestId('join-rule');
        join();
        await waitFor(() => expect(node.redeem()).toBeTruthy());
        await new Promise(r => setTimeout(r, 0));
        expect(node.consents()).toEqual([]);
    });

    for (const [name, rule] of [['an older node (404)', 404], ['a plain community', { known: false }]] as const) {
        it(`${name}: no rule line, and the join goes on`, async () => {
            const node = stubNode(rule);
            render(<WelcomePage onComplete={() => {}} />);
            await fillIn();
            await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/community/known-rule', expect.anything()));
            await new Promise(r => setTimeout(r, 0));
            expect(screen.queryByTestId('join-rule')).toBeNull();
            join();
            await waitFor(() => expect(node.redeem()).toBeTruthy());
        });
    }
});
