/**
 * "Recover with 12 Words" on the web with a Turkish keyboard (review of #1941, N10): the 12 boxes take the words
 * typed with Turkish capitals (İ, or ı from a Turkish lowercase), show them as the listed words, and restore the
 * account those words make. The node is a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import { loadIdentity } from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

// Test phrase only: twelve listed words that start with "i". Never a real account's.
const PLAIN = 'item idea ice icon identify idle ignore ill illegal illness image imitate'.split(' ');
/** The public key SHA256(SHA256(the words)) makes, from origin/main 934ece92. */
const PINNED_PUBLIC_KEY = 'ecd6b6b61cea54584fee1dcbf4e3e7d626b02c255ba1be4a5431cb9de7773c94';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const GLOBAL_OPEN = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true } };

function stubMemberNode() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/community/info') return json(200, GLOBAL_OPEN);
        if (path.startsWith('/api/community/membership/')) return json(200, { isMember: true, callsign: 'Sam' });
        return json(200, {});
    }));
}

async function openWordBoxes() {
    await screen.findByTestId('join-screen-lobby');
    fireEvent.click(screen.getByRole('button', { name: 'Already have BeanPool?' }));
    const useWords = await screen.findByRole('button', { name: 'Use my 12 words' });
    await waitFor(() => expect(useWords).not.toBeDisabled());
    fireEvent.click(useWords);
    await screen.findByLabelText('Recovery word 1');
}

const boxValues = () => PLAIN.map((_, i) => (screen.getByLabelText(`Recovery word ${i + 1}`) as HTMLInputElement).value);

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetCapturedAuthReturn();
});

describe('the 12 words typed on a Turkish keyboard', () => {
    it('typed box by box in Turkish capitals: the boxes hold the listed words and the account comes back', async () => {
        stubMemberNode();
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await openWordBoxes();
        PLAIN.forEach((w, i) => {
            fireEvent.change(screen.getByLabelText(`Recovery word ${i + 1}`), { target: { value: w.toLocaleUpperCase('tr-TR') } });
        });
        expect(boxValues()).toEqual(PLAIN);
        fireEvent.click(screen.getByRole('button', { name: 'Recover Identity' }));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(await loadIdentity()).toMatchObject({ publicKey: PINNED_PUBLIC_KEY, mnemonic: PLAIN });
    });

    it('a phrase lowercased the Turkish way (\u0131) pasted into the first box: the same account', async () => {
        stubMemberNode();
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await openWordBoxes();
        const typed = PLAIN.join(' ').toUpperCase().toLocaleLowerCase('tr-TR');
        expect(typed).toContain('\u0131');
        fireEvent.change(screen.getByLabelText('Recovery word 1'), { target: { value: typed } });
        expect(boxValues()).toEqual(PLAIN);
        fireEvent.click(screen.getByRole('button', { name: 'Recover Identity' }));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(await loadIdentity()).toMatchObject({ publicKey: PINNED_PUBLIC_KEY, mnemonic: PLAIN });
    });
});
