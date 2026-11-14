/**
 * The web app's first screen at a server nobody has claimed yet (DESIGN-new-operator-path-fable.md S4): GET /api/local/claim
 * answers `unclaimed: true`, so the community's card, whose Ask to join nobody could answer, gives way to the phone's
 * no-owner card (apps/native/components/NoOwnerCard.tsx) in the same words and order: "‹name› has no owner yet", the address,
 * "If you installed it, claim it with the one-time code on the server.", then Claim ‹name›. Claiming is the phone's, so
 * Claim opens this server's Settings, whose no-owner page has the QR and the phone's routes. A server with an owner, or one
 * too old to answer, shows its card as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const LOCAL = { memberCount: 1, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: { door: 'members' } };
const CARD = {
    name: 'Apollo Bay', host: 'apollobay.beanpool.org', members: 1, area: null,
    joining: 'requests', askUrl: null, globalUrl: null,
};

function stubNode(claim: unknown) {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        asked.push(path);
        if (path === '/api/community/info') return json(200, LOCAL);
        if (path === '/api/community/card') return json(200, CARD);
        if (path === '/api/local/claim') return claim === 404 ? json(404, { error: 'Not Found' }) : json(200, claim);
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

describe('the welcome page at a server with no owner yet', () => {
    it("shows the phone's no-owner card in the phone's order, and Claim opens this server's Settings", async () => {
        const asked = stubNode({ unclaimed: true, codeId: 'a1b2c3d4e5f60718', salt: 'ab'.repeat(16), communityName: 'Apollo Bay', password: false });
        render(<WelcomePage onComplete={vi.fn()} />);
        const card = await screen.findByTestId('no-owner-card');
        expect(asked).toContain('/api/local/claim');
        const heading = screen.getByRole('heading', { name: 'Apollo Bay has no owner yet' });
        const address = screen.getByTestId('no-owner-card-address');
        const note = screen.getByText('If you installed it, claim it with the one-time code on the server.');
        const claim = screen.getByRole('link', { name: 'Claim Apollo Bay' });
        expect(address.textContent).toBe(window.location.origin);
        expect(claim.getAttribute('href')).toBe(`${window.location.origin}/settings`);
        // The phone's order: the name, the address, the sentence, then Claim.
        const order = [heading, address, note, claim];
        for (let i = 1; i < order.length; i++) {
            expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        }
        expect(card.contains(claim)).toBe(true);
        // The card's Ask to join, which nobody could answer, is not offered.
        expect(screen.queryByTestId('community-card')).toBeNull();
        expect(screen.queryByTestId('community-card-ask')).toBeNull();
    });

    it('a server with an owner shows its card as before, and no no-owner card', async () => {
        stubNode({ unclaimed: false, password: false });
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByTestId('community-card');
        expect(screen.queryByTestId('no-owner-card')).toBeNull();
    });

    it('a standby, or a server too old to answer the claim route, shows its card as before', async () => {
        stubNode({ unclaimed: false, standby: true, password: false });
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByTestId('community-card');
        expect(screen.queryByTestId('no-owner-card')).toBeNull();
        cleanup();

        const asked = stubNode(404);
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByTestId('community-card');
        await waitFor(() => expect(asked).toContain('/api/local/claim'));
        expect(screen.queryByTestId('no-owner-card')).toBeNull();
    });
});
