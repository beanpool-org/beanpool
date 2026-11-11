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
import { generateMnemonic } from '../lib/mnemonic';

type Call = { path: string; body: Record<string, unknown>; headers: Record<string, string> };
function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const LOCAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: { openJoin: false } };
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

    it('a refused redeem leaves it waiting: the key and its mark stay, our own words (never the node\'s sentence), Back to my request', async () => {
        redeem = () => json(400, { error: 'This invite was made for another key.' });
        const back = vi.fn();
        render(<WelcomePage onComplete={vi.fn()} knockYes={YES} onBackToRequest={back} />);
        expect((await screen.findByTestId('knock-join-error')).textContent)
            .toBe("This yes from Castlemaine BeanPool couldn't be used. Go back to your request to see where it stands.");
        expect(document.body.textContent).not.toContain('This invite was made for another key.');
        // A refusal says the same again, so it offers no Try again: Back to my request is the way on.
        expect(screen.queryByTestId('knock-join-retry')).toBeNull();
        expect(screen.queryByTitle('Green Bean')).toBeNull();
        expect((await loadIdentity())?.publicKey).toBe(held.publicKey);
        expect(isKnockKey(held)).toBe(true);
        await waitFor(() => expect(screen.getByTestId('knock-join-back')).not.toBeDisabled());
        fireEvent.click(screen.getByTestId('knock-join-back'));
        expect(back).toHaveBeenCalledTimes(1);
    });

    it("Try again after a first redeem that didn't get through sends the request's name again, and joins (review 4508428682)", async () => {
        let first = true;
        const ok = redeem;
        redeem = (call) => {
            if (first) { first = false; throw new TypeError('Failed to fetch'); }
            return ok(call);
        };
        render(<WelcomePage onComplete={vi.fn()} knockYes={YES} onBackToRequest={vi.fn()} />);
        expect((await screen.findByTestId('knock-join-error')).textContent).toBe("Can't reach the community right now. Try again in a minute.");
        fireEvent.click(screen.getByTestId('knock-join-retry'));
        fireEvent.click(await screen.findByTitle('Green Bean'));
        const redeems = calls.filter(c => c.path === '/api/invite/redeem');
        expect(redeems.map(r => r.body.callsign)).toEqual(['Sam', 'Sam']);
        expect(redeems.map(r => r.body.publicKey)).toEqual([held.publicKey, held.publicKey]);
        expect(document.body.textContent).not.toContain('callsign are required');
        expect((await loadIdentity())?.publicKey).toBe(held.publicKey);
        expect(isKnockKey(held)).toBe(false);
    });

    it('12 words refused while waiting: the held screen says the request waits and goes back to it, never "Open {name}" (review 4508428601)', async () => {
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} onBackToRequest={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
        fireEvent.click(screen.getByRole('button', { name: 'Restore existing identity' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Recover with 12 Words' }));
        fireEvent.change(await screen.findByLabelText('Recovery word 1'), { target: { value: generateMnemonic().join(' ') } });
        fireEvent.click(screen.getByRole('button', { name: 'Recover Identity' }));
        expect((await screen.findByTestId('welcome-held')).textContent)
            .toBe('Your request to join as Sam is waiting in this browser, so nothing here replaced it. A browser holds one account.');
        expect(screen.getByTestId('welcome-held-hint').textContent)
            .toBe('To use another account here, go back to your request and choose “Already a member”. That forgets the request first.');
        expect(screen.queryByRole('button', { name: 'Open Sam' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: '← Back to my request' }));
        // Handed back to the root, which shows a marked key the waiting page only (App.knockWaiting.test.tsx).
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onComplete.mock.calls[0][0].publicKey).toBe(held.publicKey);
        expect(isKnockKey(held)).toBe(true);
        expect((await loadIdentity())?.publicKey).toBe(held.publicKey);
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
