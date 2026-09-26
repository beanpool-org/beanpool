/**
 * WelcomePage's invite join (review 4108355836, #1171): the new key is held in memory until the node takes the invite,
 * and only then saved, through the guarded write (one browser, one account; a join that went out from this browser is
 * settled first). The node is a stubbed fetch; nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import { generateIdentity, loadIdentity, savePendingJoin, PENDING_JOIN_TTL_MS, type BeanPoolIdentity, type PendingJoin } from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB, type MemoryIndexedDB } from '../lib/memory-indexeddb';

type Call = { path: string; body: any; headers: Record<string, string> };
type Handler = (body: any, call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const LOCAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { openJoin: false } };
const GLOBAL_SHUT = { ...LOCAL, profile: 'global' };
const CODE = 'BP-7K3X-9M2W';
const MIN = 60_000;

function stubNode(info: unknown, handlers: Record<string, Handler> = {}) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const call: Call = { path: String(input), body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string> };
        calls.push(call);
        if (call.path === '/api/community/info') return json(200, info);
        if (call.path.startsWith('/api/invite/check')) return json(200, { valid: true });
        const key = Object.keys(handlers).find((k) => call.path === k || call.path.startsWith(k));
        return key ? handlers[key](call.body, call) : json(200, {});
    }));
    return { calls, redeems: () => calls.filter((c) => c.path === '/api/invite/redeem') };
}

async function submitInvite(name = 'Rowan') {
    await screen.findByText(/Join with Invite Code/);
    fireEvent.change(screen.getByLabelText('Invite Code'), { target: { value: CODE } });
    fireEvent.change(screen.getByLabelText('Your Callsign (Name)'), { target: { value: name } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Identity & Join →' }));
}

const tryAgain = () => fireEvent.click(screen.getByRole('button', { name: 'Create Identity & Join →' }));

let idb: MemoryIndexedDB;
const peekPending = () => idb.peek('beanpool-identity', 'keys', 'pending-join') as PendingJoin | undefined;

beforeEach(() => {
    idb = memoryIndexedDB();
    vi.stubGlobal('indexedDB', idb);
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('an invite join saves its key only once the node has taken the invite (review 4108355836)', () => {
    it('a code the node refuses: nothing saved, the form says why and stays; the retry sends the same key, and that key is saved', async () => {
        let n = 0;
        const node = stubNode(LOCAL, {
            '/api/invite/redeem': () => (++n === 1 ? json(400, { error: 'Invalid invite code' }) : json(200, { success: true, member: {} })),
        });
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();

        expect(await screen.findByText('Invalid invite code')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create Identity & Join →' })).not.toBeDisabled());
        expect(await loadIdentity()).toBeNull();
        expect(peekPending()).toBeUndefined();
        expect(screen.queryByText(/Choose your look/)).toBeNull();

        tryAgain();
        await screen.findByText(/Choose your look/);
        const [first, second] = node.redeems();
        expect(node.redeems()).toHaveLength(2);
        expect(second.body.publicKey).toBe(first.body.publicKey);
        expect(await loadIdentity()).toMatchObject({ publicKey: first.body.publicKey, callsign: 'Rowan', mnemonic: expect.any(Array) });
        expect((await loadIdentity())!.mnemonic).toHaveLength(12);
        expect(peekPending()).toBeUndefined();
    });

    it("no answer from the node: nothing saved; the retry sends the same key, the node (which had taken it) says it's a member, and it is saved", async () => {
        let n = 0;
        const node = stubNode(LOCAL, {
            '/api/invite/redeem': () => {
                if (++n === 1) throw new TypeError('Failed to fetch');
                return json(200, { success: true, alreadyMember: true });
            },
        });
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();

        expect(await screen.findByText("Can't reach the community right now. Try again in a minute.")).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create Identity & Join →' })).not.toBeDisabled());
        expect(await loadIdentity()).toBeNull();

        tryAgain();
        await screen.findByText(/Choose your look/);
        const [first, second] = node.redeems();
        expect(second.body.publicKey).toBe(first.body.publicKey);
        expect((await loadIdentity())?.publicKey).toBe(first.body.publicKey);
    });

    it('an invite that another key has used: "already been used" is not taken as joined, and nothing is saved', async () => {
        stubNode(LOCAL, { '/api/invite/redeem': () => json(400, { error: 'This invite has already been used' }) });
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();

        expect(await screen.findByText('This invite has already been used')).toBeInTheDocument();
        expect(await loadIdentity()).toBeNull();
        expect(screen.queryByText(/Choose your look/)).toBeNull();
    });

    it('taken at once: exactly the key the node took is saved, the redeem signed by it, and the photo step follows', async () => {
        const node = stubNode(LOCAL, { '/api/invite/redeem': () => json(200, { success: true, member: {} }) });
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();

        await screen.findByText(/Choose your look/);
        expect(node.redeems()).toHaveLength(1);
        const [redeem] = node.redeems();
        // Signed with the key it names, though that key was not saved here yet.
        expect(redeem.headers['X-Public-Key']).toBe(redeem.body.publicKey);
        expect(redeem.headers['X-Signature']).toEqual(expect.any(String));
        expect(await loadIdentity()).toMatchObject({ publicKey: redeem.body.publicKey, callsign: 'Rowan' });
        expect(peekPending()).toBeUndefined();
    });

    // Not a behaviour this change makes: what Back does is the open card invite-back-step. Pinned so a change to it is seen.
    it('← Back on the photo step, today: the saved key stays, and the next try is told this browser already has an account, with nothing redeemed again', async () => {
        const node = stubNode(LOCAL, { '/api/invite/redeem': () => json(200, { success: true, member: {} }) });
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();
        await screen.findByText(/Choose your look/);
        const saved = await loadIdentity();

        fireEvent.click(screen.getByRole('button', { name: '← Back' }));
        tryAgain();
        expect(await screen.findByTestId('welcome-held')).toHaveTextContent('Rowan');
        expect(await loadIdentity()).toEqual(saved);
        expect(node.redeems()).toHaveLength(1);
    });
});

describe('a join sent from another tab while the invite is at the node (#1171 deciding pass: the check is in the save)', () => {
    it('the key is not saved and that join is settled first; once it can no longer land, the same key is saved, and the sent join is kept', async () => {
        const other: BeanPoolIdentity = await generateIdentity('Bea');
        const t0 = Date.now();
        let n = 0;
        const node = stubNode(GLOBAL_SHUT, {
            '/api/invite/redeem': async () => {
                if (++n === 1) {
                    // Another tab sends a join after this page asked, and before it saves.
                    await savePendingJoin({ identity: other, provider: 'google', nonce: null, startedAt: t0, expiresAt: t0 + PENDING_JOIN_TTL_MS, restored: false, sentAt: t0 });
                    return json(200, { success: true, member: {} });
                }
                return json(200, { success: true, alreadyMember: true });
            },
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
        });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await submitInvite();

        expect(await screen.findByTestId('join-held')).toHaveTextContent('may still go through');
        expect(await loadIdentity()).toBeNull();
        expect(peekPending()).toMatchObject({ identity: { publicKey: other.publicKey }, sentAt: t0 });

        // That join can no longer land: back to the invite page, and the same key goes in.
        vi.spyOn(Date, 'now').mockReturnValue(t0 + 12 * MIN);
        fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
        await screen.findByText(/Join with Invite Code/);
        tryAgain();
        await screen.findByText(/Choose your look/);
        const [first, second] = node.redeems();
        expect(second.body.publicKey).toBe(first.body.publicKey);
        expect((await loadIdentity())?.publicKey).toBe(first.body.publicKey);
        // The other tab's key: only the node's word or the member lets it go.
        expect(peekPending()).toMatchObject({ identity: { publicKey: other.publicKey }, sentAt: t0 });
        expect(onComplete).not.toHaveBeenCalled();
    });
});
