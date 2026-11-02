/**
 * Home's card about the rule, its step-back sheet and Settings' row in the web app (DESIGN-balance-rule-fable.md §1, §2):
 * the real components against a stubbed node. Which card is owed is core's (known-rule.test.ts); this holds that the page
 * draws it, keeps it once put away, calls the real route, and says nothing the node didn't.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { pseudoLocalise, setLanguage } from '@beanpool/core';
import { ConfirmedCard, ConfirmedSettingsRow } from './ConfirmedCard';
import { forgetMemberRule } from '../lib/known-rule';

vi.mock('../lib/identity', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/identity')>()),
    loadIdentity: async () => null,
}));

const KEY = 'ab'.repeat(32);
const CONFIRMED_AT = '2026-10-20T00:00:00.000Z';
const RULE = { known: true, knownFloor: 1000, debtLinePct: 50, quietDays: 60, ruleFrom: '2026-10-01T00:00:00.000Z', debtLineFrom: null, quietDaysFrom: null };

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const node = { rule: RULE as unknown, ruleStatus: 200, me: { confirmed: true, confirmedAt: CONFIRMED_AT } as unknown, stepBack: json as unknown as () => Response, posts: [] as Array<{ path: string; body: unknown }> };

beforeEach(() => {
    localStorage.clear();
    forgetMemberRule();
    node.rule = RULE;
    node.ruleStatus = 200;
    node.me = { confirmed: true, confirmedAt: CONFIRMED_AT };
    node.posts = [];
    node.stepBack = () => json(200, { id: 'c1', status: 'revoked', owing: false });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        if (path.endsWith('/api/community/known-rule')) return json(node.ruleStatus, node.rule);
        if (path.endsWith('/api/community/me')) return json(200, node.me);
        if (path.endsWith('/api/names/step-back')) {
            node.posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
            return node.stepBack();
        }
        return json(404, {});
    }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setLanguage('en'); });

const card = (onOpenGuide = () => {}) => render(<ConfirmedCard publicKey={KEY} onOpenGuide={onOpenGuide} />);

describe('Home\'s card', () => {
    it('says the rule in the community\'s numbers, the way out, and where the rest is', async () => {
        const guide = vi.fn();
        card(guide);
        await screen.findByText("You're confirmed.");
        expect(screen.getByText('An admin confirmed you as a member they know. Your credit line can now go to 1,000 Beans.')).toBeInTheDocument();
        expect(screen.getByText('If you owe more than half your credit line, or stay in debit for 60 days without a sale, the admins can see your balance. Each look is logged.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'The guide says what else an admin can see.' }));
        expect(guide).toHaveBeenCalled();
    });

    it('shows once: OK keeps it away after a reload', async () => {
        card();
        fireEvent.click(await screen.findByTestId('confirmed-card-ok'));
        expect(screen.queryByTestId('confirmed-card')).toBeNull();
        cleanup();
        forgetMemberRule();
        card();
        await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/community/me'), expect.anything()));
        await new Promise(r => setTimeout(r, 0));
        expect(screen.queryByTestId('confirmed-card')).toBeNull();
    });

    it('shows again after a re-confirmation', async () => {
        card();
        fireEvent.click(await screen.findByTestId('confirmed-card-ok'));
        cleanup();
        forgetMemberRule();
        node.me = { confirmed: true, confirmedAt: '2026-11-01T00:00:00.000Z' };
        card();
        expect(await screen.findByTestId('confirmed-card')).toBeInTheDocument();
    });

    it('a member already confirmed is told the date the rule starts, and what stepping back can\'t hide', async () => {
        node.rule = { ...RULE, ruleFrom: '2099-11-16T04:00:00.000Z' };
        node.me = { confirmed: true, confirmedAt: '2026-10-01T00:00:00.000Z' };
        card();
        await screen.findByTestId('rule-changes-card');
        expect(screen.getByRole('heading').textContent).toBe("Your community's rule on what the admins can see changes on 16 November.");
        expect(screen.getByText(/This replaces anything you agreed to before/)).toBeInTheDocument();
        expect(screen.getByText(/until you're back within it/)).toBeInTheDocument();
    });

    it('draws nothing for an older node, a plain community or an unconfirmed member', async () => {
        for (const set of [() => { node.ruleStatus = 404; node.rule = { error: 'Not found' }; }, () => { node.rule = { known: false }; }, () => { node.me = { confirmed: false, confirmedAt: null }; }, () => { node.me = { publicKey: KEY }; }]) {
            set();
            forgetMemberRule();
            const { container, unmount } = card();
            await waitFor(() => expect(fetch).toHaveBeenCalled());
            await new Promise(r => setTimeout(r, 0));
            expect(container.textContent).toBe('');
            unmount();
            node.ruleStatus = 200;
            node.rule = RULE;
            node.me = { confirmed: true, confirmedAt: CONFIRMED_AT };
        }
    });

    it('goes through the words layer', async () => {
        setLanguage('xx');
        card();
        await screen.findByText(pseudoLocalise("You're confirmed."));
        expect(screen.getByText(pseudoLocalise("I'd rather stay unconfirmed"))).toBeInTheDocument();
    });
});

describe('"I\'d rather stay unconfirmed"', () => {
    const open = async () => {
        card();
        fireEvent.click(await screen.findByTestId('confirmed-card-step-back'));
        await screen.findByRole('heading', { name: 'Step back from being confirmed?' });
    };

    it('calls the step-back route, naming nobody, and the card goes once they\'ve read it', async () => {
        await open();
        fireEvent.click(screen.getByTestId('step-back-confirm'));
        expect((await screen.findByTestId('step-back-done')).textContent).toBe("You've stepped back. You have the ordinary credit line now.");
        expect(node.posts).toEqual([{ path: expect.stringContaining('/api/names/step-back'), body: {} }]);
        fireEvent.click(screen.getByTestId('step-back-close'));
        expect(screen.queryByTestId('confirmed-card')).toBeNull();
    });

    it('says so when they still owe past the ordinary line', async () => {
        node.stepBack = () => json(200, { id: 'c1', status: 'revoked', owing: true });
        await open();
        fireEvent.click(screen.getByTestId('step-back-confirm'));
        expect((await screen.findByTestId('step-back-done')).textContent).toMatch(/until you're back within it/);
    });

    it('"Keep it" changes nothing and calls nothing', async () => {
        await open();
        fireEvent.click(screen.getByTestId('step-back-keep'));
        expect(screen.queryByTestId('step-back-sheet')).toBeNull();
        expect(node.posts).toEqual([]);
        expect(screen.getByTestId('confirmed-card')).toBeInTheDocument();
    });

    it('a refusal is the node\'s words, the sheet stays, and nothing claims it worked', async () => {
        node.stepBack = () => json(409, { error: "You aren't confirmed.", code: 'not_confirmed' });
        await open();
        fireEvent.click(screen.getByTestId('step-back-confirm'));
        expect((await screen.findByTestId('step-back-error')).textContent).toBe("You aren't confirmed.");
        expect(screen.queryByTestId('step-back-done')).toBeNull();
    });

    it('no answer is "could not be reached", never a success', async () => {
        node.stepBack = () => { throw new TypeError('Failed to fetch'); };
        await open();
        fireEvent.click(screen.getByTestId('step-back-confirm'));
        expect((await screen.findByTestId('step-back-error')).textContent).toBe('Not saved: the community could not be reached.');
    });
});

describe('Settings\' row', () => {
    it('a confirmed member: the row, the rule under it, and the same sheet', async () => {
        render(<ConfirmedSettingsRow publicKey={KEY} />);
        fireEvent.click(await screen.findByTestId('confirmed-settings-row'));
        expect(screen.getByText(/^If you owe more than half your credit line/)).toBeInTheDocument();
        fireEvent.click(await screen.findByTestId('step-back-confirm'));
        await screen.findByTestId('step-back-done');
        fireEvent.click(screen.getByTestId('step-back-close'));
        expect(screen.queryByTestId('confirmed-settings-row')).toBeNull();
    });

    it('a member who isn\'t confirmed, or an older node: no row', async () => {
        node.me = { confirmed: false, confirmedAt: null };
        const { container, unmount } = render(<ConfirmedSettingsRow publicKey={KEY} />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        await new Promise(r => setTimeout(r, 0));
        expect(container.textContent).toBe('');
        unmount();
        forgetMemberRule();
        node.ruleStatus = 404;
        const old = render(<ConfirmedSettingsRow publicKey={KEY} />);
        await new Promise(r => setTimeout(r, 0));
        expect(old.container.textContent).toBe('');
    });
});
