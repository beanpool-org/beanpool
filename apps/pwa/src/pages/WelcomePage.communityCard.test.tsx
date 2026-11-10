/**
 * A stranger at a local community's web app (front doors S15): its public card above the invite form, from the node's
 * GET /api/community/card; the card's own doors at the bare address land here with `?door=invite` (the form) and
 * `?door=signin` (the ways back). A node too old to send a card: the page as before, its "No invite?" box and all. While
 * the card is on its way, neither: the box's Look around links BeanPool's global community, which a node may name none of.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const LOCAL = { memberCount: 9, postCount: 3, transactionCount: 6, commonsBalance_c: 0, profile: 'local', features: { door: 'members' } };
const CARD = {
    name: 'Castlemaine BeanPool', host: 'castlemaine.beanpool.org', members: 9, area: { name: 'Castlemaine and around', radiusKm: 15 },
    joining: 'requests', askUrl: 'https://global.beanpool.org/?ask=castlemaine.beanpool.org', globalUrl: 'https://global.beanpool.org',
};

function stubNode(card: unknown, rule: unknown = 404) {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        asked.push(path);
        if (path === '/api/community/info') return json(200, LOCAL);
        if (path === '/api/community/card' && card instanceof Promise) return card;
        if (path === '/api/community/card') return card === 404 ? json(404, { error: 'Not Found' }) : json(200, card);
        if (path === '/api/community/known-rule') return rule === 404 ? json(404, { error: 'Not found' }) : json(200, rule);
        return json(404, { error: 'Not Found' });
    }));
    return asked;
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/');
});

describe("a local community's card on its welcome page", () => {
    it('is drawn above the invite form, which stays below it; the old "No invite?" box goes', async () => {
        stubNode(CARD);
        render(<WelcomePage onComplete={vi.fn()} />);
        const card = await screen.findByTestId('community-card');
        expect(screen.getByRole('heading', { name: 'Castlemaine BeanPool' })).toBeTruthy();
        // The form's heading says which community the code is for (join names N1, §2.5).
        const form = screen.getByRole('heading', { name: 'Join Castlemaine BeanPool with an invite' });
        // The card comes first in the page.
        expect(card.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.queryByTestId('welcome-no-invite')).toBeNull();
        expect(screen.queryByText(/Join with Invite Code/)).toBeNull();
    });

    it("the invite form's heading names the community by its card: its name, else its address; a node with no card keeps the form's old heading", async () => {
        stubNode({ ...CARD, name: null });
        render(<WelcomePage onComplete={vi.fn()} />);
        expect(await screen.findByRole('heading', { name: 'Join castlemaine.beanpool.org with an invite' })).toBeTruthy();
        cleanup();

        stubNode(404);
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
        expect(screen.queryByRole('heading', { name: /with an invite/ })).toBeNull();
    });

    it('Already a member opens the ways back', async () => {
        stubNode(CARD);
        render(<WelcomePage onComplete={vi.fn()} />);
        fireEvent.click(await screen.findByTestId('community-card-signin'));
        expect(screen.getByText('Sign in to your account')).toBeTruthy();
    });

    it("the card's ?door=signin opens on the ways back, and leaves the address", async () => {
        stubNode(CARD);
        window.history.replaceState(null, '', '/app?door=signin');
        render(<WelcomePage onComplete={vi.fn()} />);
        expect(await screen.findByText('Sign in to your account')).toBeTruthy();
        expect(window.location.search).toBe('');
    });

    it("the card's ?door=invite opens on the form, its code box focused, under the card's name alone", async () => {
        stubNode(CARD);
        window.history.replaceState(null, '', '/app?door=invite');
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByTestId('community-card');
        expect(screen.queryByTestId('community-card-ask')).toBeNull();
        expect(document.activeElement?.id).toBe('inviteCode');
    });

    it('while the card is on its way: the form, and neither the card nor the old box with its link to BeanPool\'s global community', async () => {
        let answer!: (r: Response) => void;
        const asked = stubNode(new Promise<Response>((resolve) => { answer = resolve; }));
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
        await waitFor(() => expect(asked).toContain('/api/community/card'));
        expect(screen.queryByTestId('welcome-no-invite')).toBeNull();
        expect(screen.queryByTestId('look-around-global')).toBeNull();
        expect(screen.queryByTestId('community-card')).toBeNull();
        // The card comes: drawn, and still no box.
        await act(async () => { answer(json(200, { ...CARD, askUrl: null, globalUrl: null })); });
        await screen.findByTestId('community-card');
        expect(screen.queryByTestId('welcome-no-invite')).toBeNull();
        expect(document.querySelector('a[href^="https://global.beanpool.org"]')).toBeNull();
    });

    it('a node too old to send a card: the page as before', async () => {
        stubNode(404);
        render(<WelcomePage onComplete={vi.fn()} />);
        expect(await screen.findByTestId('welcome-no-invite')).toBeTruthy();
        expect(screen.queryByTestId('community-card')).toBeNull();
    });
});

/**
 * The rule on the card's page (Marty, board card balance-rule-other-doors, 3 Nov 2026: "Yes, show the sentence"). On the
 * web the card is drawn on the community's own join page, above the invite form, and that page already states the rule
 * where the community confirms its members: the same sentence as the phone's card. Nothing to tick.
 */
describe("the community's rule on its card's page", () => {
    const RULE = { known: true, knownFloor: 10000, debtLinePct: 50, quietDays: 60, debtLineFrom: null, quietDaysFrom: null };
    const SENTENCE = "The admins can see a confirmed member's balance if they owe more than half their credit line, or are in debit and haven't made a sale for 60 days. Each look is logged.";

    it('rule on: the card, then the sentence on the same page, and nothing to tick', async () => {
        stubNode(CARD, RULE);
        render(<WelcomePage onComplete={vi.fn()} />);
        const card = await screen.findByTestId('community-card');
        const rule = await screen.findByTestId('join-rule');
        expect(rule.textContent).toContain(SENTENCE);
        expect(card.compareDocumentPosition(rule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    });

    it('rule off: the card, and no sentence', async () => {
        const asked = stubNode(CARD, { known: false });
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByTestId('community-card');
        await waitFor(() => expect(asked).toContain('/api/community/known-rule'));
        await act(async () => {});
        expect(screen.queryByTestId('join-rule')).toBeNull();
        expect(document.body.textContent).not.toContain('The admins can see');
    });
});
