/**
 * A yes from another community, used with the 12 words (DESIGN-global-yes-join-fable.md §3, slice Y0). The real case: CJ,
 * a member of the global community on the web, asked Byron from global's Find card, and Byron said yes; his key lives at
 * global's address, Byron's page is another, which the browser keeps apart. At Byron's page he restores with his 12
 * words, and Byron has that key as no member. The welcome page then reads the request's status there, signed by that key:
 *   - a yes: the key is kept as this browser's waiting key (lib/knock-key.ts), so the root opens the waiting page, whose
 *     "🎉 Byron said yes." and Join join with it; marked established, so the join has no Safety Backup step;
 *   - still waiting: the waiting page, "You asked to join Byron.";
 *   - nothing open: the restore goes on as before (the account saved, never a waiting key);
 *   - a member: in, as ever, and no status read.
 * The node is a stubbed fetch at https://byron.example.org (bp_node_url), a local community whose door is shut.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import { KnockWaitingPage } from './KnockWaitingPage';
import { generateIdentity, loadIdentity, seedViewedKey, type BeanPoolIdentity } from '../lib/identity';
import { isEstablishedKey, isKnockKey, knockWaitingKey } from '../lib/knock-key';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

const NODE = 'https://byron.example.org';
const LOCAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { openJoin: false } };
const CARD = { name: 'Byron Shire BeanPool', host: 'byron.example.org', members: 3, joining: 'requests' };

type Call = { path: string; method: string; body: Record<string, unknown>; headers: Record<string, string> };
function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let calls: Call[];
let member: boolean;
let knock: { status: 'none' } | { status: 'pending' } | { status: 'approved'; invite: string; expiresAt: string | null };
let account: BeanPoolIdentity;

beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    localStorage.clear();
    localStorage.setItem('bp_node_url', NODE);
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
    calls = [];
    member = false;
    knock = { status: 'approved', invite: 'KN0C-K1NV', expiresAt: null };
    account = await generateIdentity('CJ');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input).replace(NODE, '');
        const call: Call = { path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : {}, headers: (init.headers ?? {}) as Record<string, string> };
        calls.push(call);
        if (path === '/api/community/info') return json(200, LOCAL);
        if (path === '/api/community/card') return json(200, CARD);
        if (path.startsWith('/api/community/membership/')) return json(200, { isMember: member, callsign: member ? 'CJ' : null });
        if (path === '/api/join/knock/status') return json(200, knock);
        if (path.startsWith('/api/invite/check')) return json(200, { valid: true });
        if (path === '/api/invite/redeem') return json(200, { success: true, member: { publicKey: call.body.publicKey, callsign: call.body.callsign } });
        return json(200, {});
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    resetCapturedAuthReturn();
});

/** Already a member → Recover with 12 Words → the account's words → Recover Identity. */
async function restoreWithWords(onComplete: (id: BeanPoolIdentity) => void) {
    render(<WelcomePage onComplete={onComplete} start="restore" />);
    fireEvent.click(await screen.findByRole('button', { name: /Recover with 12 Words/ }));
    account.mnemonic!.forEach((w, i) => {
        fireEvent.change(screen.getByLabelText(`Recovery word ${i + 1}`), { target: { value: w } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recover Identity' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    return onComplete.mock.calls[0][0] as BeanPoolIdentity;
}

const statusReads = () => calls.filter(c => c.path === '/api/join/knock/status');

describe('12 words at a community that has the key as no member (slice Y0)', () => {
    it('a yes here: kept as the waiting key, established, and the waiting page says the yes with Join', async () => {
        const onComplete = vi.fn();
        const restored = await restoreWithWords(onComplete);
        expect(restored.publicKey).toBe(account.publicKey);
        // Read at this community, signed by the restored key; nothing redeemed or registered yet.
        expect(statusReads()).toHaveLength(1);
        expect(statusReads()[0].headers['X-Public-Key']).toBe(account.publicKey);
        expect(calls.some(c => c.path === '/api/invite/redeem' || c.path === '/api/community/register')).toBe(false);
        // The waiting key, never a member's: the root shows the waiting page for it.
        expect(isKnockKey(restored)).toBe(true);
        expect(isEstablishedKey(restored.publicKey)).toBe(true);
        expect((await knockWaitingKey())?.publicKey).toBe(account.publicKey);
        expect((await loadIdentity())?.mnemonic).toEqual(account.mnemonic);

        cleanup();
        const onJoin = vi.fn();
        render(<KnockWaitingPage identity={restored} onJoin={onJoin} onInvite={vi.fn()} onSignIn={vi.fn()} onForgotten={vi.fn()} />);
        await waitFor(() => expect(screen.getByTestId('knock-waiting-yes')).toHaveTextContent('🎉 Byron Shire BeanPool said yes.'));
        fireEvent.click(screen.getByTestId('knock-waiting-join'));
        expect(onJoin).toHaveBeenCalledWith({ invite: 'KN0C-K1NV', name: 'Byron Shire BeanPool' });
    });

    it('still waiting: the waiting page, which says the request with no date this browser never saw', async () => {
        knock = { status: 'pending' };
        const restored = await restoreWithWords(vi.fn());
        expect(isKnockKey(restored)).toBe(true);

        cleanup();
        render(<KnockWaitingPage identity={restored} onJoin={vi.fn()} onInvite={vi.fn()} onSignIn={vi.fn()} onForgotten={vi.fn()} />);
        await waitFor(() => expect(screen.getByTestId('knock-waiting-sent')).toHaveTextContent('You asked to join Byron Shire BeanPool.'));
        expect(await screen.findByTestId('knock-waiting-line')).toHaveTextContent('Your request arrived.');
        expect(screen.queryByTestId('knock-waiting-yes')).toBeNull();
    });

    it('nothing open: the restore goes on as before, the account saved and never a waiting key', async () => {
        knock = { status: 'none' };
        const restored = await restoreWithWords(vi.fn());
        expect(restored.publicKey).toBe(account.publicKey);
        expect(statusReads()).toHaveLength(1);
        expect(isKnockKey(restored)).toBe(false);
        expect(isEstablishedKey(restored.publicKey)).toBe(false);
        expect((await loadIdentity())?.publicKey).toBe(account.publicKey);
    });

    it('a member here: in, as ever, with no status read', async () => {
        member = true;
        const restored = await restoreWithWords(vi.fn());
        expect(restored.publicKey).toBe(account.publicKey);
        expect(statusReads()).toHaveLength(0);
        expect(isKnockKey(restored)).toBe(false);
    });

    it("the community can't say (an older node, 404): the restore goes on as before", async () => {
        vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
            const path = String(input).replace(NODE, '');
            if (path === '/api/community/info') return json(200, LOCAL);
            if (path.startsWith('/api/community/membership/')) return json(200, { isMember: false, callsign: null });
            if (path === '/api/join/knock/status') return json(404, { error: 'Not found', code: 'feature_off' });
            return json(200, {});
        });
        const restored = await restoreWithWords(vi.fn());
        expect(isKnockKey(restored)).toBe(false);
        expect((await loadIdentity())?.publicKey).toBe(account.publicKey);
    });
});

describe('the yes, joined with a restored account (slice Y0)', () => {
    it('asks the name the words carry none of, joins with the restored key, and has no Safety Backup step', async () => {
        await restoreWithWords(vi.fn());
        cleanup();
        calls.length = 0;

        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} knockYes={{ invite: 'KN0C-K1NV', name: 'Byron Shire BeanPool' }} onBackToRequest={vi.fn()} />);
        // A 12-words restore names no one: asked here, never sent empty.
        const field = await screen.findByLabelText('Your name here');
        expect(calls.some(c => c.path === '/api/invite/redeem')).toBe(false);
        fireEvent.change(field, { target: { value: 'CJ' } });
        fireEvent.click(screen.getByTestId('knock-join-name-go'));

        // Straight to the photo, joined with the restored key under the typed name.
        fireEvent.click(await screen.findByTitle('Green Bean'));
        const redeems = calls.filter(c => c.path === '/api/invite/redeem');
        expect(redeems).toHaveLength(1);
        expect(redeems[0].body).toMatchObject({ code: 'BP-KN0C-K1NV', publicKey: account.publicKey, callsign: 'CJ' });
        expect(redeems[0].headers['X-Public-Key']).toBe(account.publicKey);
        expect(isKnockKey(account)).toBe(false);
        expect(isEstablishedKey(account.publicKey)).toBe(false);
        expect(localStorage.getItem(seedViewedKey(account.publicKey))).toBe('true');
        // Three steps, no Safety Backup.
        const stepper = screen.getByTestId('onboarding-stepper');
        expect(stepper.textContent).not.toContain('Safety Backup');

        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        // How it works next, with the one line in the backup's place; the words are never shown again.
        expect(await screen.findByTestId('tour-words-kept')).toHaveTextContent('Your 12 words stay the same: the ones you came back with.');
        expect(screen.queryByTestId('backup-words')).toBeNull();
        expect(screen.getByTestId('onboarding-stepper').textContent).not.toContain('Safety Backup');
        // Back goes to the photo, not to a backup step.
        fireEvent.click(screen.getByRole('button', { name: '← Back' }));
        expect(await screen.findByTitle('Green Bean')).toBeTruthy();
        expect(screen.queryByTestId('backup-words')).toBeNull();
    });
});
