/**
 * "Used BeanPool before?" on the web's two choices, as the phone asks it first (Marty, 12 Nov idea 2, yes on 15 Nov):
 * the question above I'm Already a Member and I'm New Here; the ways back best first (sign-in, then the 12 words, then an
 * admin's code); Back from each; and "Start a new account instead", which says plainly that it makes a new account and
 * only opens the new-member page: nothing is made, and nothing is sent, until the person joins there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import { loadIdentity } from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const LOCAL = { memberCount: 9, postCount: 3, transactionCount: 6, commonsBalance_c: 0, profile: 'local', features: { door: 'members' } };

function stubNode() {
    const asked: Array<{ path: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        asked.push({ path, method: init.method ?? 'GET' });
        if (path === '/api/community/info') return json(200, LOCAL);
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

/** The page's two choices: from the new-member page it opens on, Back to Home. */
async function twoChoices() {
    render(<WelcomePage onComplete={vi.fn()} />);
    fireEvent.click(await screen.findByText('← Back to Home'));
    return screen.findByTestId('used-before');
}

describe('Used BeanPool before? on the web', () => {
    it('asks the question above its two answers', async () => {
        stubNode();
        const question = await twoChoices();
        expect(question.textContent).toBe('Used BeanPool before?');
        const returning = screen.getByTestId('used-before-returning');
        const isNew = screen.getByTestId('used-before-new');
        expect(returning.textContent).toBe("I'm Already a Member →");
        expect(isNew.textContent).toBe("I'm New Here");
        expect(question.compareDocumentPosition(returning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('I\'m Already a Member: the ways back, sign-in first, then the 12 words, then an admin\'s code, and Back to the question', async () => {
        stubNode();
        await twoChoices();
        fireEvent.click(screen.getByTestId('used-before-returning'));
        expect(screen.getByText('Sign in to your account')).toBeTruthy();
        const signIn = screen.getByTestId('member-restore-signin');
        const words = screen.getByRole('button', { name: /Recover with 12 Words/ });
        const rekey = screen.getByRole('button', { name: /An admin gave me a re-key code/ });
        expect(signIn.compareDocumentPosition(words) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(words.compareDocumentPosition(rekey) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '← Back' }));
        expect(screen.getByTestId('used-before')).toBeTruthy();
    });

    it('each way back opens, and its Back returns to the ways back', async () => {
        stubNode();
        await twoChoices();
        fireEvent.click(screen.getByTestId('used-before-returning'));
        fireEvent.click(screen.getByRole('button', { name: /Recover with 12 Words/ }));
        expect(screen.queryByText('Sign in to your account')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Back to Restore Options|← Back/ }));
        expect(await screen.findByText('Sign in to your account')).toBeTruthy();
    });

    it('Start a new account instead: said plainly, opens the new-member page, makes nothing and sends nothing', async () => {
        const asked = stubNode();
        await twoChoices();
        fireEvent.click(screen.getByTestId('used-before-returning'));
        const box = screen.getByTestId('start-new-instead');
        expect(box.textContent).toContain("Can't bring your account back? You can start again, but that makes a new account. Your old account stays as it is, and the two can never be joined into one.");
        const sentBefore = asked.filter((a) => a.method !== 'GET').length;
        fireEvent.click(screen.getByTestId('start-new-instead-button'));
        expect(screen.queryByText('Sign in to your account')).toBeNull();
        expect(await screen.findByText('← Back to Home')).toBeTruthy();
        expect(asked.filter((a) => a.method !== 'GET').length).toBe(sentBefore);
        expect(await loadIdentity()).toBeNull();
        // Back from there: the question again.
        fireEvent.click(screen.getByText('← Back to Home'));
        expect(screen.getByTestId('used-before')).toBeTruthy();
    });

    it('I\'m New Here: the new-member page, and nothing is made', async () => {
        stubNode();
        await twoChoices();
        fireEvent.click(screen.getByTestId('used-before-new'));
        expect(await screen.findByText('← Back to Home')).toBeTruthy();
        expect(await loadIdentity()).toBeNull();
    });
});
