/**
 * A yes to a browser's request to join (DESIGN-shared-listing-door-fable.md §2.1, slice A1): the invite a member's yes
 * made is bound to the key the request was signed with, so the welcome page redeems it WITH THAT KEY (lib/knock-key.ts,
 * held in this browser since Send), never a new one (before A1 the web's invite form made a new key, which the node
 * refuses). Then the wizard as after any invite: Your Photo, Safety Backup with the 12 words shown for the first time.
 * A refused redeem leaves the browser waiting, with its key. The node is a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import { loadIdentity, type BeanPoolIdentity } from '../lib/identity';
import { commitKnockKey, draftKnockKey, isKnockKey, knockWaitingKey } from '../lib/knock-key';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

type Call = { path: string; body: Record<string, unknown>; headers: Record<string, string> };
function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const LOCAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { openJoin: false } };
const YES = { invite: 'BP-KN0C-K1NV', name: 'Castlemaine BeanPool' };

let calls: Call[];
let redeem: (call: Call) => Response;
let held: BeanPoolIdentity;

beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    localStorage.clear();
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
    calls = [];
    redeem = (call) => json(200, { success: true, member: { publicKey: call.body.publicKey, callsign: call.body.callsign } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const call: Call = { path: String(input), body: init.body ? JSON.parse(String(init.body)) : {}, headers: (init.headers ?? {}) as Record<string, string> };
        calls.push(call);
        if (call.path === '/api/community/info') return json(200, LOCAL);
        if (call.path.startsWith('/api/invite/check')) return json(200, { valid: true });
        if (call.path === '/api/invite/redeem') return redeem(call);
        if (call.path.startsWith('/api/community/membership/')) return json(200, { isMember: false, callsign: null });
        return json(200, {});
    }));
    held = await commitKnockKey(await draftKnockKey(), 'Sam');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    resetCapturedAuthReturn();
});

describe("a yes to this browser's request", () => {
    it('Join redeems the invite with the asking key, then the wizard shows its 12 words for the first time', async () => {
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} knockYes={YES} onBackToRequest={vi.fn()} />);
        // Straight to the photo: nothing typed, no new key.
        fireEvent.click(await screen.findByTitle('Green Bean'));
        const redeems = calls.filter(c => c.path === '/api/invite/redeem');
        expect(redeems).toHaveLength(1);
        expect(redeems[0].body).toMatchObject({ code: YES.invite, publicKey: held.publicKey, callsign: 'Sam' });
        expect(redeems[0].headers['X-Public-Key']).toBe(held.publicKey);
        // A member now: the waiting mark is gone, the same key stays, with its words.
        expect(isKnockKey(held)).toBe(false);
        expect(await knockWaitingKey()).toBeNull();
        expect((await loadIdentity())?.publicKey).toBe(held.publicKey);

        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        const words = await screen.findByTestId('backup-words');
        for (const w of held.mnemonic!) expect(words.textContent).toContain(w);
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('a refused redeem leaves it waiting: the key and its mark stay, the words the community said, Back to my request', async () => {
        redeem = () => json(400, { error: 'This invite was made for another key.' });
        const back = vi.fn();
        render(<WelcomePage onComplete={vi.fn()} knockYes={YES} onBackToRequest={back} />);
        expect((await screen.findByTestId('knock-join-error')).textContent).toBe('This invite was made for another key.');
        expect(screen.queryByTitle('Green Bean')).toBeNull();
        expect((await loadIdentity())?.publicKey).toBe(held.publicKey);
        expect(isKnockKey(held)).toBe(true);
        await waitFor(() => expect(screen.getByTestId('knock-join-back')).not.toBeDisabled());
        fireEvent.click(screen.getByTestId('knock-join-back'));
        expect(back).toHaveBeenCalledTimes(1);
    });

    it('I have an invite while waiting: the invite form joins with the same key, never a second one', async () => {
        render(<WelcomePage onComplete={vi.fn()} onBackToRequest={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
        fireEvent.change(screen.getByLabelText('Invite Code'), { target: { value: 'BP-7K3X-9M2W' } });
        fireEvent.change(screen.getByLabelText('Your Callsign (Name)'), { target: { value: 'Sam R' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create Identity & Join →' }));
        await screen.findByTitle('Green Bean');
        const [r] = calls.filter(c => c.path === '/api/invite/redeem');
        expect(r.body.publicKey).toBe(held.publicKey);
        expect((await loadIdentity())?.publicKey).toBe(held.publicKey);
        expect(screen.queryByText('This browser already has an account')).toBeNull();
    });
});
