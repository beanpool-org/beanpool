/**
 * WelcomePage's invite join (review 4108355836, #1171): the new key is held in memory until the node takes the invite,
 * and only then saved, through the guarded write (one browser, one account; a join that went out from this browser is
 * settled first). The node is a stubbed fetch; nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import {
    generateIdentity, importIdentity, loadIdentity, markInviteSent, savePendingJoin, PENDING_JOIN_TTL_MS, type BeanPoolIdentity, type PendingJoin,
} from '../lib/identity';
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
        if (call.path.startsWith('/api/invite/check') && !handlers['/api/invite/check']) return json(200, { valid: true });
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
/** The invite-sent slot, as stored: a key sent with an invite, until the node has settled it. */
const peekInviteSent = () => idb.peek('beanpool-identity', 'keys', 'invite-sent') as { identity: BeanPoolIdentity; sentAt: number } | undefined;

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
        expect(peekInviteSent()).toBeUndefined();
        expect(screen.queryByText(/Choose your look/)).toBeNull();

        tryAgain();
        await screen.findByText(/Choose your look/);
        const [first, second] = node.redeems();
        expect(node.redeems()).toHaveLength(2);
        expect(second.body.publicKey).toBe(first.body.publicKey);
        expect(await loadIdentity()).toMatchObject({ publicKey: first.body.publicKey, callsign: 'Rowan', mnemonic: expect.any(Array) });
        expect((await loadIdentity())!.mnemonic).toHaveLength(12);
        expect(peekPending()).toBeUndefined();
        expect(peekInviteSent()).toBeUndefined();
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

    // The node as it is (engine/members.ts checkInvite, engine/invites.ts redeemInvite): once a key has used the code,
    // the pre-flight says "used", and the redeem answers that key as a member before it looks at the code as used.
    function nodeTakingTheFirstRedeemAndLosingItsAnswer() {
        let usedBy: string | null = null;
        return stubNode(LOCAL, {
            '/api/invite/check': () => json(200, usedBy ? { valid: false, reason: 'used' } : { valid: true }),
            '/api/invite/redeem': (body) => {
                if (usedBy === null) {
                    usedBy = body.publicKey;
                    throw new TypeError('Failed to fetch');
                }
                return usedBy === body.publicKey
                    ? json(200, { success: true, alreadyMember: true })
                    : json(400, { error: 'This invite has already been used' });
            },
        });
    }

    it('the node took the invite and its answer was lost: the retry\'s pre-flight says "used", the redeem answers the same key as a member, and it is saved (review 4111871900)', async () => {
        const node = nodeTakingTheFirstRedeemAndLosingItsAnswer();
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();

        expect(await screen.findByText("Can't reach the community right now. Try again in a minute.")).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create Identity & Join →' })).not.toBeDisabled());
        expect(await loadIdentity()).toBeNull();

        tryAgain();
        await screen.findByText(/Choose your look/);
        const checks = node.calls.filter((c) => c.path.startsWith('/api/invite/check'));
        expect(checks).toHaveLength(2);
        const [first, second] = node.redeems();
        expect(node.redeems()).toHaveLength(2);
        expect(second.body.publicKey).toBe(first.body.publicKey);
        expect((await loadIdentity())?.publicKey).toBe(first.body.publicKey);
        expect(peekPending()).toBeUndefined();
    });

    it('a retry after the code was used by another key: the redeem refuses it, the node\'s words are shown, and nothing is saved', async () => {
        let checks = 0;
        let n = 0;
        const node = stubNode(LOCAL, {
            '/api/invite/check': () => json(200, ++checks === 1 ? { valid: true } : { valid: false, reason: 'used' }),
            '/api/invite/redeem': () => {
                if (++n === 1) throw new TypeError('Failed to fetch');
                return json(400, { error: 'This invite has already been used' });
            },
        });
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();
        expect(await screen.findByText("Can't reach the community right now. Try again in a minute.")).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create Identity & Join →' })).not.toBeDisabled());

        tryAgain();
        expect(await screen.findByText('This invite has already been used')).toBeInTheDocument();
        expect(node.redeems()).toHaveLength(2);
        expect(await loadIdentity()).toBeNull();
        expect(peekPending()).toBeUndefined();
        expect(screen.queryByText(/Choose your look/)).toBeNull();
        // The first send's answer never came, so the refusal of the second doesn't settle it: the key stays on disk.
        await waitFor(() => expect(peekInviteSent()).toMatchObject({ identity: { publicKey: node.redeems()[0].body.publicKey } }));
    });

    it('a first try on a code already used: the pre-flight stops it, and nothing is made, sent or saved', async () => {
        const node = stubNode(LOCAL, { '/api/invite/check': () => json(200, { valid: false, reason: 'used' }) });
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();

        expect(await screen.findByText(/This invite has already been used — each one works exactly once/)).toBeInTheDocument();
        expect(node.redeems()).toHaveLength(0);
        expect(await loadIdentity()).toBeNull();
        expect(peekPending()).toBeUndefined();
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
        expect(peekInviteSent()).toBeUndefined();
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

/*
 * A key sent with an invite survives a reload (deciding pass 4111943146). The node can take a redeem whose answer never
 * reaches the page; the key is on disk, in a slot of its own, from before the redeem goes, and the next load of the
 * page asks the node about it with that key.
 */
describe('a key sent with an invite survives a reload (deciding pass 4111943146)', () => {
    /**
     * The node as it is (engine/invites.ts): single-use codes, a key that is a member answered as one before the code is
     * looked at, and a membership probe that reads the same members. `loseAnswer`: it takes the redeem and the answer is
     * lost. `dropNext`: the next redeem never reaches it. `down`: the probe gets no answer. `onProbe`: runs as the probe
     * is answered.
     */
    function inviteNode(opts: { onTaken?: () => Promise<void> } = {}) {
        const state = {
            members: new Map<string, string>(), usedBy: null as string | null, loseAnswer: false, dropNext: false, down: false,
            onProbe: null as (() => void) | null,
        };
        const node = stubNode(LOCAL, {
            '/api/invite/check': () => json(200, state.usedBy ? { valid: false, reason: 'used' } : { valid: true }),
            '/api/invite/redeem': async (body) => {
                if (state.dropNext) {
                    state.dropNext = false;
                    throw new TypeError('Failed to fetch');
                }
                if (state.members.has(body.publicKey)) return json(200, { success: true, alreadyMember: true });
                if (state.usedBy) return json(400, { error: 'This invite has already been used' });
                state.usedBy = body.publicKey;
                state.members.set(body.publicKey, body.callsign);
                await opts.onTaken?.();
                if (state.loseAnswer) throw new TypeError('Failed to fetch');
                return json(200, { success: true, member: {} });
            },
            '/api/community/membership/': (_body, call) => {
                if (state.down) throw new TypeError('Failed to fetch');
                state.onProbe?.();
                const key = decodeURIComponent(call.path.split('/').pop()!);
                return json(200, { isMember: state.members.has(key), callsign: state.members.get(key) ?? null });
            },
        });
        const probes = () => node.calls.filter((c) => c.path.startsWith('/api/community/membership/')).map((c) => decodeURIComponent(c.path.split('/').pop()!));
        return { ...node, state, probes };
    }

    async function sendAndLoseTheAnswer() {
        await submitInvite();
        expect(await screen.findByText(/Can't reach the community right now/)).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create Identity & Join →' })).not.toBeDisabled());
    }

    /** The tab is gone (a reload, a closed tab, old Android discarding it), and this browser opens the page again. */
    function reopen() {
        cleanup();
        render(<WelcomePage onComplete={vi.fn()} />);
    }

    it('the node took the redeem and its answer was lost, then the tab was reloaded: the next load asks the node with the kept key, saves it, and shows its 12 words', async () => {
        const node = inviteNode();
        node.state.loseAnswer = true;
        render(<WelcomePage onComplete={vi.fn()} />);
        await sendAndLoseTheAnswer();
        const [redeem] = node.redeems();
        expect(await loadIdentity()).toBeNull();
        expect(peekInviteSent()?.identity.publicKey).toBe(redeem.body.publicKey);

        reopen();
        await screen.findByText(/Choose your look/);
        expect(node.probes()).toEqual([redeem.body.publicKey]);
        const saved = await loadIdentity();
        expect(saved).toMatchObject({ publicKey: redeem.body.publicKey, callsign: 'Rowan' });
        expect(saved!.mnemonic).toHaveLength(12);
        expect(peekInviteSent()).toBeUndefined();
        expect(node.redeems()).toHaveLength(1);
        expect(screen.queryByText(/already been used/)).toBeNull();

        // Its 12 words: the only copy of this member's key, shown before the tour.
        fireEvent.click(screen.getByTitle('Green Bean'));
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        const words = await screen.findByTestId('backup-words');
        // In order, as they are to be written down (a phrase can hold the same word twice).
        expect(Array.from(words.children).map((c) => c.textContent)).toEqual(saved!.mnemonic!.map((w, i) => `${i + 1}. ${w}`));
    });

    it('a code the node refuses: nothing saved, the sent key let go from disk, and a reload shows the invite form, asking the node nothing', async () => {
        const node = stubNode(LOCAL, {
            '/api/invite/redeem': () => json(400, { error: 'Invalid invite code' }),
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
        });
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();
        expect(await screen.findByText('Invalid invite code')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create Identity & Join →' })).not.toBeDisabled());
        expect(await loadIdentity()).toBeNull();
        expect(peekInviteSent()).toBeUndefined();

        reopen();
        await screen.findByText(/Join with Invite Code/);
        expect(screen.queryByRole('heading', { name: 'Finish joining' })).toBeNull();
        expect(node.calls.filter((c) => c.path.startsWith('/api/community/membership/'))).toHaveLength(0);
        expect(await loadIdentity()).toBeNull();
    });

    it('the node unreachable at the reload: the key is kept and "Finish joining" is shown, never "already used"; a Retry once it answers completes', async () => {
        const node = inviteNode();
        node.state.loseAnswer = true;
        render(<WelcomePage onComplete={vi.fn()} />);
        await sendAndLoseTheAnswer();
        const key = node.redeems()[0].body.publicKey;

        node.state.down = true;
        reopen();
        expect(await screen.findByRole('heading', { name: 'Finish joining' })).toBeInTheDocument();
        expect(screen.getByTestId('invite-sent-unreachable')).toHaveTextContent('Rowan');
        expect(screen.queryByText(/already been used/)).toBeNull();
        expect(screen.queryByText(/Join with Invite Code/)).toBeNull();
        expect(await loadIdentity()).toBeNull();
        expect(peekInviteSent()?.identity.publicKey).toBe(key);

        // Still no answer: said so, and the key stays.
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByText(/Still can't reach the community/)).toBeInTheDocument();
        expect(peekInviteSent()?.identity.publicKey).toBe(key);

        node.state.down = false;
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByText(/Choose your look/);
        expect((await loadIdentity())?.publicKey).toBe(key);
        expect(peekInviteSent()).toBeUndefined();
        expect(node.redeems()).toHaveLength(1);
    });

    it("a member at the reload, but this browser can't save it (a full disk): \"Finish joining\" says so, the key stays, and Retry saves it", async () => {
        const node = inviteNode();
        node.state.loseAnswer = true;
        render(<WelcomePage onComplete={vi.fn()} />);
        await sendAndLoseTheAnswer();
        const key = node.redeems()[0].body.publicKey;

        // The write after the probe (the save) fails as a full disk's does, once.
        node.state.onProbe = () => {
            node.state.onProbe = null;
            idb.failNextCommit();
        };
        reopen();
        expect(await screen.findByRole('heading', { name: 'Finish joining' })).toBeInTheDocument();
        expect(screen.getByTestId('invite-sent-unreachable')).toHaveTextContent("The community has you as Rowan, but this browser couldn't save the account.");
        expect(await loadIdentity()).toBeNull();
        expect(peekInviteSent()?.identity.publicKey).toBe(key);

        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByText(/Choose your look/);
        expect((await loadIdentity())?.publicKey).toBe(key);
        expect(peekInviteSent()).toBeUndefined();
    });

    it("another tab saved an account while the invite was at the node: that account stays, and the held screen offers the sent key's 12 words", async () => {
        const other = await generateIdentity('Bea');
        const node = inviteNode({ onTaken: () => importIdentity(other) });
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();

        expect(await screen.findByTestId('welcome-held')).toHaveTextContent('Bea');
        const [redeem] = node.redeems();
        const kept = peekInviteSent();
        expect(kept?.identity.publicKey).toBe(redeem.body.publicKey);
        expect((await loadIdentity())?.publicKey).toBe(other.publicKey);
        const sent = screen.getByTestId('welcome-held-sent');
        expect(sent).toHaveTextContent('The community took Rowan too');
        expect(sent).toHaveTextContent('This browser keeps Bea');

        const toggle = screen.getByRole('button', { name: "Show Rowan's 12 words" });
        fireEvent.click(toggle);
        const list = screen.getByRole('list', { name: "Rowan's 12 words" });
        expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(kept!.identity.mnemonic!.map((w, i) => `${i + 1}. ${w}`));
        fireEvent.click(screen.getByRole('button', { name: "Hide Rowan's 12 words" }));
        expect(screen.queryByRole('list', { name: "Rowan's 12 words" })).toBeNull();
        // Still there after this page is gone: nothing but the member's own sign-out takes it.
        cleanup();
        expect(peekInviteSent()?.identity.publicKey).toBe(redeem.body.publicKey);
    });

    it('not a member at the reload while the lost send could still land: the key is kept for the next try, which sends it and is saved', async () => {
        const node = inviteNode();
        node.state.dropNext = true;
        render(<WelcomePage onComplete={vi.fn()} />);
        await sendAndLoseTheAnswer();
        const key = node.redeems()[0].body.publicKey;

        reopen();
        await screen.findByText(/Join with Invite Code/);
        expect(node.probes()).toEqual([key]);
        expect(peekInviteSent()?.identity.publicKey).toBe(key);
        expect(screen.getByLabelText('Your Callsign (Name)')).toHaveValue('Rowan');

        fireEvent.change(screen.getByLabelText('Invite Code'), { target: { value: CODE } });
        tryAgain();
        await screen.findByText(/Choose your look/);
        expect(node.redeems().map((r) => r.body.publicKey)).toEqual([key, key]);
        expect((await loadIdentity())?.publicKey).toBe(key);
        expect(peekInviteSent()).toBeUndefined();
    });

    it("another tab's invite key is on disk, unsettled: this page sends nothing with a key of its own, asks about that one, and finishes it", async () => {
        const node = inviteNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
        // The other tab sent its key, and the node took it; that tab is gone.
        const theirs = await generateIdentity('Bea');
        await markInviteSent(theirs, 'their-hash', Date.now());
        node.state.members.set(theirs.publicKey, 'Bea');
        node.state.usedBy = theirs.publicKey;

        await submitInvite();
        await screen.findByText(/Choose your look/);
        expect(node.redeems()).toHaveLength(0);
        expect(node.probes()).toEqual([theirs.publicKey]);
        expect(await loadIdentity()).toMatchObject({ publicKey: theirs.publicKey, callsign: 'Bea' });
        expect(peekInviteSent()).toBeUndefined();
    });

    it('not a member at a reload long after the send: nothing can land any more, so the kept key is let go and the form starts afresh', async () => {
        const t0 = Date.now();
        const node = inviteNode();
        node.state.dropNext = true;
        render(<WelcomePage onComplete={vi.fn()} />);
        await sendAndLoseTheAnswer();
        const key = node.redeems()[0].body.publicKey;

        vi.spyOn(Date, 'now').mockReturnValue(t0 + 60 * MIN);
        reopen();
        await screen.findByText(/Join with Invite Code/);
        await waitFor(() => expect(peekInviteSent()).toBeUndefined());
        expect(node.probes()).toEqual([key]);
        expect(await loadIdentity()).toBeNull();
    });
});
