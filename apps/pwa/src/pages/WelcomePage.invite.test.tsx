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
import { registerMember } from '../lib/api';
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
            // Asked after the 400, signed by the key, before the kept key goes (4112075324).
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
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

});

/*
 * ← Back on the photo step changes the name on the same account (Marty, card invite-back-step, 2026-09-27). Before, the
 * name form made a second key, which the saved one refused ("This browser already has an account"), and its Open went
 * into the app past the photo and the 12 words.
 */
describe('← Back on the photo step changes the name on the same account (card invite-back-step)', () => {
    /**
     * The node as it is for these steps: the invite taken once (engine/invites.ts), a member's name changed only by a
     * request signed with that member's key (routes/community.ts /api/profile/update, engine/members.ts updateProfile),
     * which refuses a name another member has with a 409 and never counts the member's own as taken, and the name check
     * with its `exclude` (isCallsignAvailable). Sam is another member's name. A redeem lands the name as the node does:
     * cut to 20 (routes/community.ts) and numbered past another member's (uniquifyCallsign), and answers with the new
     * member's card, or the card of `answerAbout` when that is set. `loseUpdate`: the next profile update lands and its
     * answer is lost. `onUpdate`: called as a profile update lands, before its answer.
     */
    function renameNode() {
        const state = {
            members: new Map<string, string>([['a-neighbour', 'Sam']]), usedBy: null as string | null, loseUpdate: false, loseRedeem: false,
            answerAbout: null as string | null, onUpdate: null as null | (() => void),
        };
        const takenBy = (name: string, exclude: string | null) =>
            [...state.members].some(([key, held]) => key !== exclude && held.toLowerCase() === name.trim().toLowerCase());
        const numbered = (name: string, exclude: string) => {
            let free = name;
            for (let n = 2; takenBy(free, exclude); n++) free = `${name.slice(0, 32 - String(n).length).trim()}${n}`;
            return free;
        };
        const cardOf = (key: string) => ({ publicKey: key, callsign: state.members.get(key), joinedAt: '2026-09-27T00:00:00.000Z', avatarUrl: null });
        const node = stubNode(LOCAL, {
            '/api/invite/check': () => json(200, state.usedBy ? { valid: false, reason: 'used' } : { valid: true }),
            '/api/invite/redeem': (body) => {
                if (state.members.has(body.publicKey)) return json(200, { success: true, alreadyMember: true, member: cardOf(body.publicKey) });
                if (state.usedBy) return json(400, { error: 'This invite has already been used' });
                state.usedBy = body.publicKey;
                state.members.set(body.publicKey, numbered(String(body.callsign).slice(0, 20).trim(), body.publicKey));
                if (state.loseRedeem) throw new TypeError('Failed to fetch');
                return json(200, { success: true, member: cardOf(state.answerAbout ?? body.publicKey) });
            },
            '/api/profile/update': (body, call) => {
                const signer = call.headers['X-Public-Key'];
                if (!signer || !call.headers['X-Signature'] || !state.members.has(signer)) return json(401, { error: 'A signed request is required' });
                if (typeof body.callsign === 'string') {
                    if (takenBy(body.callsign, signer)) {
                        return json(409, { error: 'callsign_taken', message: 'That name is already taken on this community. Try another.' });
                    }
                    state.members.set(signer, body.callsign.trim());
                }
                state.onUpdate?.();
                if (state.loseUpdate) {
                    state.loseUpdate = false;
                    throw new TypeError('Failed to fetch');
                }
                return json(200, { success: true, profile: { publicKey: signer, callsign: state.members.get(signer) } });
            },
            '/api/members/callsign-available/': (_body, call) => {
                const url = new URL(call.path, 'http://node.test');
                const name = decodeURIComponent(url.pathname.split('/').pop()!);
                const tooShort = name.trim().length < 2;
                return json(200, { callsign: name, available: !tooShort && !takenBy(name, url.searchParams.get('exclude')), tooShort });
            },
            '/api/community/membership/': (_body, call) => {
                const key = decodeURIComponent(call.path.split('/').pop()!);
                return json(200, { isMember: state.members.has(key), callsign: state.members.get(key) ?? null });
            },
            // The app's register as soon as the account opens (App.tsx registerMember), answered for a member as
            // routes/community.ts does (the name cut to 20) and engine/members.ts registerMemberInternal (renamed to that
            // when it differs other than in capitals, uniquified against the others).
            '/api/community/register': (body) => {
                const held = state.members.get(body.publicKey);
                const cut = String(body.callsign).slice(0, 20).trim();
                if (held !== undefined && cut.toLowerCase() !== held.toLowerCase()) state.members.set(body.publicKey, numbered(cut, body.publicKey));
                return json(200, { success: true, member: { publicKey: body.publicKey, callsign: state.members.get(body.publicKey) } });
            },
        });
        const updates = () => node.calls.filter((c) => c.path === '/api/profile/update');
        const nameChecks = () => node.calls.filter((c) => c.path.startsWith('/api/members/callsign-available/')).map((c) => new URL(c.path, 'http://node.test'));
        return { ...node, state, updates, nameChecks };
    }

    const nameField = () => screen.getByLabelText('Your Callsign (Name)');

    /** From the photo step: ← Back, then `name` in the field, then Next. */
    async function backAndRename(name: string) {
        fireEvent.click(screen.getByRole('button', { name: '← Back' }));
        await waitFor(() => expect(nameField()).toHaveValue('Rowan'));
        fireEvent.change(nameField(), { target: { value: name } });
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    }

    it('Back, a new name, Next: the same key, the invite redeemed once, the name changed on the node by that key, then the photo, the 12 words and the tour', async () => {
        const node = renameNode();
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} onBack={vi.fn()} />);
        await submitInvite();
        await screen.findByText(/Choose your look/);
        const saved = (await loadIdentity())!;
        expect(saved).toMatchObject({ publicKey: node.redeems()[0].body.publicKey, callsign: 'Rowan' });

        fireEvent.click(screen.getByRole('button', { name: '← Back' }));
        await waitFor(() => expect(nameField()).toHaveValue('Rowan'));
        // The name alone, on this account: no invite to type again, and no way off to another account from here.
        expect(screen.queryByLabelText('Invite Code')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Create Identity & Join →' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Restore existing identity' })).toBeNull();
        expect(screen.queryByRole('button', { name: '← Back to Home' })).toBeNull();
        expect(screen.queryByRole('button', { name: '← Back to the listings' })).toBeNull();

        fireEvent.change(nameField(), { target: { value: 'Robin' } });
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        await screen.findByText(/Choose your look/);
        expect(screen.getByText('Robin')).toBeInTheDocument();
        expect(screen.queryByTestId('welcome-held')).toBeNull();

        // One key, one redeem: the name went to the node as this member's own profile update, signed with that key.
        expect(node.redeems()).toHaveLength(1);
        const [update] = node.updates();
        expect(node.updates()).toHaveLength(1);
        expect(update.headers['X-Public-Key']).toBe(saved.publicKey);
        expect(update.body).toEqual({ publicKey: saved.publicKey, callsign: 'Robin' });
        expect(node.state.members.get(saved.publicKey)).toBe('Robin');
        expect(await loadIdentity()).toEqual({ ...saved, callsign: 'Robin' });
        expect(peekInviteSent()).toBeUndefined();
        expect(peekPending()).toBeUndefined();

        // Then its own 12 words, and only after them the app.
        await expectWordsOf(saved);
        expect(onComplete).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        fireEvent.click(await screen.findByRole('button', { name: "Let's Begin! 🚀" }));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(onComplete.mock.calls[0][0]).toMatchObject({ publicKey: saved.publicKey, callsign: 'Robin' });
        expect(node.redeems()).toHaveLength(1);
    });

    it('Back and the same name: nothing is sent, no error, and on to the photo and the 12 words', async () => {
        const node = renameNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();
        await screen.findByText(/Choose your look/);
        const saved = (await loadIdentity())!;

        await backAndRename('Rowan');
        await screen.findByText(/Choose your look/);
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByTestId('welcome-held')).toBeNull();
        expect(node.redeems()).toHaveLength(1);
        expect(node.updates()).toHaveLength(0);
        expect(await loadIdentity()).toEqual(saved);
        await expectWordsOf(saved);
    });

    it("Back and a name another member has: the node refuses it, the step stays and suggests free names (this key's own excluded); one tapped goes through", async () => {
        const node = renameNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();
        await screen.findByText(/Choose your look/);
        const saved = (await loadIdentity())!;

        await backAndRename('Sam');
        expect(await screen.findByRole('alert')).toHaveTextContent('"Sam" is already taken in this community. Pick one of the suggestions below, or choose another name.');
        expect(screen.queryByText(/Choose your look/)).toBeNull();
        expect(node.state.members.get(saved.publicKey)).toBe('Rowan');
        expect(await loadIdentity()).toEqual(saved);
        const offered = await screen.findAllByRole('button', { name: /^Use the name Sam / });
        expect(offered).toHaveLength(3);
        // Each suggestion was checked free on the node, with this member's own key left out, as a rename is.
        expect(node.nameChecks().length).toBeGreaterThanOrEqual(3);
        for (const check of node.nameChecks()) expect(check.searchParams.get('exclude')).toBe(saved.publicKey);

        const picked = offered[0].textContent!;
        fireEvent.click(offered[0]);
        expect(nameField()).toHaveValue(picked);
        expect(screen.queryByRole('alert')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        await screen.findByText(/Choose your look/);
        expect(node.state.members.get(saved.publicKey)).toBe(picked);
        expect(await loadIdentity()).toEqual({ ...saved, callsign: picked });
        expect(node.redeems()).toHaveLength(1);
        expect(node.updates().map((u) => u.headers['X-Public-Key'])).toEqual([saved.publicKey, saved.publicKey]);
    });

    it("its own name in other capitals is this member's, never taken: the node takes it", async () => {
        const node = renameNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();
        await screen.findByText(/Choose your look/);
        const saved = (await loadIdentity())!;

        await backAndRename('ROWAN');
        await screen.findByText(/Choose your look/);
        expect(screen.queryByRole('alert')).toBeNull();
        expect(node.state.members.get(saved.publicKey)).toBe('ROWAN');
        expect(await loadIdentity()).toEqual({ ...saved, callsign: 'ROWAN' });
    });

    /*
     * A join keeps 20 characters of a name (MAX_JOIN_CALLSIGN): the app's register, as soon as the account opens, sends
     * the name to /api/community/register, which cuts it to 20, and the node renames the member to the cut name
     * (deciding pass 4113903999). The rename step holds the same 20, and so do its suggestions.
     */
    it('a name longer than a join keeps (20 characters): refused on the step with a sentence and nothing sent; 20 goes through as typed', async () => {
        const node = renameNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();
        await screen.findByText(/Choose your look/);
        const saved = (await loadIdentity())!;

        await backAndRename('Rowan of the Valley Farm Wren');
        expect(await screen.findByRole('alert')).toHaveTextContent('Callsign must be at most 20 characters.');
        expect(nameField()).toHaveAttribute('maxlength', '20');
        expect(screen.queryByText(/Choose your look/)).toBeNull();
        expect(node.updates()).toHaveLength(0);
        expect(node.nameChecks()).toHaveLength(0);
        expect(node.state.members.get(saved.publicKey)).toBe('Rowan');
        expect(await loadIdentity()).toEqual(saved);

        fireEvent.change(nameField(), { target: { value: 'Rowan of the Valleys' } });
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        await screen.findByText(/Choose your look/);
        expect(node.state.members.get(saved.publicKey)).toBe('Rowan of the Valleys');
        expect(await loadIdentity()).toEqual({ ...saved, callsign: 'Rowan of the Valleys' });
    });

    it('a taken name whose suggestions would run past 20 characters: only names of 20 or fewer are checked and offered', async () => {
        const node = renameNode();
        node.state.members.set('another-neighbour', 'Samantha Greenwood');
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();
        await screen.findByText(/Choose your look/);

        await backAndRename('Samantha Greenwood');
        expect(await screen.findByRole('alert')).toHaveTextContent('"Samantha Greenwood" is already taken in this community.');
        const offered = await screen.findAllByRole('button', { name: /^Use the name / });
        expect(offered).toHaveLength(3);
        for (const chip of offered) expect(chip.textContent!.length).toBeLessThanOrEqual(20);
        expect(node.nameChecks().length).toBeGreaterThanOrEqual(3);
        for (const check of node.nameChecks()) expect(decodeURIComponent(check.pathname.split('/').pop()!).length).toBeLessThanOrEqual(20);
    });

    it('redeem, then a rename to a suggestion, then the app registers the member as it opens: the node keeps exactly the name they chose', async () => {
        const node = renameNode();
        node.state.members.set('another-neighbour', 'Samantha Greenwood');
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await submitInvite();
        await screen.findByText(/Choose your look/);
        const saved = (await loadIdentity())!;

        await backAndRename('Samantha Greenwood');
        const [first] = await screen.findAllByRole('button', { name: /^Use the name / });
        const picked = first.textContent!;
        fireEvent.click(first);
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        await screen.findByText(/Choose your look/);
        expect(node.state.members.get(saved.publicKey)).toBe(picked);
        await expectWordsOf(saved);
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        fireEvent.click(await screen.findByRole('button', { name: "Let's Begin! 🚀" }));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        const opened = onComplete.mock.calls[0][0] as BeanPoolIdentity;
        expect(opened).toMatchObject({ publicKey: saved.publicKey, callsign: picked });

        // What App.tsx does with the account it is handed, as soon as it opens.
        await registerMember(opened.publicKey, opened.callsign);
        expect(node.state.members.get(saved.publicKey)).toBe(picked);
        expect((await loadIdentity())!.callsign).toBe(picked);
    });

    it("the rename's answer lost: said so, the step stays on the same key, and Next again carries on", async () => {
        const node = renameNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();
        await screen.findByText(/Choose your look/);
        const saved = (await loadIdentity())!;

        node.state.loseUpdate = true;
        await backAndRename('Robin');
        expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the community right now. Try again in a minute.");
        await waitFor(() => expect(screen.getByRole('button', { name: 'Next →' })).not.toBeDisabled());
        expect(screen.queryByText(/Choose your look/)).toBeNull();
        expect((await loadIdentity())?.publicKey).toBe(saved.publicKey);

        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        await screen.findByText(/Choose your look/);
        expect(node.state.members.get(saved.publicKey)).toBe('Robin');
        expect(await loadIdentity()).toEqual({ ...saved, callsign: 'Robin' });
        expect(node.redeems()).toHaveLength(1);
        await expectWordsOf(saved);
    });

    it("a reload after the invite's answer was lost: the photo step comes from the kept key, and Back changes the name on that same key", async () => {
        const node = renameNode();
        node.state.loseRedeem = true;
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();
        expect(await screen.findByText(/Can't reach the community right now/)).toBeInTheDocument();
        const key = node.redeems()[0].body.publicKey;
        expect(await loadIdentity()).toBeNull();

        // The tab is gone, and this browser opens the page again: the kept key is asked about, saved, and goes on.
        cleanup();
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Choose your look/);
        const saved = (await loadIdentity())!;
        expect(saved.publicKey).toBe(key);

        await backAndRename('Robin');
        await screen.findByText(/Choose your look/);
        expect(node.redeems()).toHaveLength(1);
        expect(node.updates()[0].headers['X-Public-Key']).toBe(key);
        expect(node.state.members.get(key)).toBe('Robin');
        expect(await loadIdentity()).toEqual({ ...saved, callsign: 'Robin' });
        expect(peekInviteSent()).toBeUndefined();
        await expectWordsOf(saved);
    });

    it("a reload in the middle of a rename whose answer was lost: the one key stays this browser's account, with nothing kept to send again and nothing redeemed again", async () => {
        const node = renameNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitInvite();
        await screen.findByText(/Choose your look/);
        const saved = (await loadIdentity())!;
        node.state.loseUpdate = true;
        await backAndRename('Robin');
        expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the community right now.");

        // The app opens the saved account on the next load (App.tsx): the same key, and no second one anywhere. The node
        // has the new name; this browser's copy keeps the one it had until the app, opening, takes the node's (App.name.test).
        cleanup();
        expect(await loadIdentity()).toEqual(saved);
        expect(peekInviteSent()).toBeUndefined();
        expect(peekPending()).toBeUndefined();
        expect(node.redeems()).toHaveLength(1);
        expect(node.updates().map((u) => u.headers['X-Public-Key'])).toEqual([saved.publicKey]);
        expect(node.state.members.get(saved.publicKey)).toBe('Robin');
    });

    /*
     * The web app's name for the member is the community's (#1231's confirmation, NON-BLOCKING 4113964261 and
     * 4113964223). The node may number the name typed (another member holds it) or cut it to 20, and the redeem answers
     * with the name it kept: this browser keeps that one, so the photo step, ← Back's "the name people here see" and the
     * app all say what everyone else sees. A rename the node took is never left unsaved here without a word.
     */
    describe("this browser keeps the community's name for the member", () => {
        const registers = (node: ReturnType<typeof renameNode>) => node.calls.filter((c) => c.path === '/api/community/register');
        /** The write after the node's answer to the next profile update (this browser's copy of the new name) fails as a full disk's does, once. */
        const failTheSaveAfterTheUpdate = (node: ReturnType<typeof renameNode>) => {
            node.state.onUpdate = () => {
                node.state.onUpdate = null;
                idb.failNextCommit();
            };
        };

        it('the node numbers a name another member has (Sam → Sam2): this browser keeps Sam2 and shows it, ← Back shows it as the name people here see, and a register sends it', async () => {
            const node = renameNode();
            const onComplete = vi.fn();
            render(<WelcomePage onComplete={onComplete} />);
            await submitInvite('Sam');
            await screen.findByText(/Choose your look/);
            const [redeem] = node.redeems();
            expect(redeem.body.callsign).toBe('Sam');
            expect(node.state.members.get(redeem.body.publicKey)).toBe('Sam2');
            const saved = (await loadIdentity())!;
            expect(saved).toMatchObject({ publicKey: redeem.body.publicKey, callsign: 'Sam2', mnemonic: expect.any(Array) });
            expect(screen.getByText('Sam2')).toBeInTheDocument();
            expect(screen.getByTestId('joined-as-note')).toHaveTextContent("You're Sam2 here: Sam was taken. Tap ← Back to change it.");

            fireEvent.click(screen.getByRole('button', { name: '← Back' }));
            await waitFor(() => expect(nameField()).toHaveValue('Sam2'));
            expect(screen.getByText(/This is the name people here see/)).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
            await screen.findByText(/Choose your look/);
            expect(node.updates()).toHaveLength(0);

            await expectWordsOf(saved);
            fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
            fireEvent.click(await screen.findByRole('button', { name: "Let's Begin! 🚀" }));
            await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
            const opened = onComplete.mock.calls[0][0] as BeanPoolIdentity;
            expect(opened).toEqual(saved);

            // Whatever register goes with the account it is handed carries the node's name, so it renames nobody.
            await registerMember(opened.publicKey, opened.callsign);
            expect(registers(node).map((r) => r.body.callsign)).toEqual(['Sam2']);
            expect(node.state.members.get(saved.publicKey)).toBe('Sam2');
        });

        it('the node cuts a name longer than a join keeps (20 characters): this browser keeps the cut name, shows it and says why', async () => {
            const node = renameNode();
            render(<WelcomePage onComplete={vi.fn()} />);
            // The form takes no more than the node keeps. A longer name can still reach the node (a key kept from before
            // this, or a script), set here past the field's cut: the node's answer is what counts.
            await screen.findByText(/Join with Invite Code/);
            expect(screen.getByLabelText('Your Callsign (Name)')).toHaveAttribute('maxlength', '20');
            await submitInvite('Rowan of the Valley Farm Wren');
            await screen.findByText(/Choose your look/);
            const key = node.redeems()[0].body.publicKey;
            expect(node.state.members.get(key)).toBe('Rowan of the Valley');
            expect(await loadIdentity()).toMatchObject({ publicKey: key, callsign: 'Rowan of the Valley' });
            expect(screen.getByText('Rowan of the Valley')).toBeInTheDocument();
            expect(screen.getByTestId('joined-as-note')).toHaveTextContent("You're Rowan of the Valley here: a name here keeps 20 characters. Tap ← Back to change it.");

            fireEvent.click(screen.getByRole('button', { name: '← Back' }));
            await waitFor(() => expect(nameField()).toHaveValue('Rowan of the Valley'));
            fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
            await screen.findByText(/Choose your look/);
            expect(node.updates()).toHaveLength(0);
            expect(screen.queryByRole('alert')).toBeNull();
        });

        it("an earlier try landed (as Sam2) while its answer was lost, and the retry sent another name: the node's answer, the name that try joined with, is kept and said", async () => {
            const node = renameNode();
            node.state.loseRedeem = true;
            render(<WelcomePage onComplete={vi.fn()} />);
            await submitInvite('Sam');
            expect(await screen.findByText("Can't reach the community right now. Try again in a minute.")).toBeInTheDocument();
            await waitFor(() => expect(screen.getByRole('button', { name: 'Create Identity & Join →' })).not.toBeDisabled());
            const key = node.redeems()[0].body.publicKey;
            expect(node.state.members.get(key)).toBe('Sam2');

            fireEvent.change(screen.getByLabelText('Your Callsign (Name)'), { target: { value: 'Samuel' } });
            tryAgain();
            await screen.findByText(/Choose your look/);
            expect(node.redeems().map((r) => [r.body.publicKey, r.body.callsign])).toEqual([[key, 'Sam'], [key, 'Samuel']]);
            expect(await loadIdentity()).toMatchObject({ publicKey: key, callsign: 'Sam2' });
            expect(screen.getByText('Sam2')).toBeInTheDocument();
            expect(screen.getByTestId('joined-as-note')).toHaveTextContent('You joined as Sam2 on an earlier try. Tap ← Back to change it.');
        });

        it('an answer naming another key changes nothing here: this browser keeps the name it sent, with no note', async () => {
            const node = renameNode();
            node.state.answerAbout = 'a-neighbour';
            render(<WelcomePage onComplete={vi.fn()} />);
            await submitInvite('Rowan');
            await screen.findByText(/Choose your look/);
            const key = node.redeems()[0].body.publicKey;
            expect(await loadIdentity()).toMatchObject({ publicKey: key, callsign: 'Rowan' });
            expect(screen.getByText('Rowan')).toBeInTheDocument();
            expect(screen.queryByText('Sam')).toBeNull();
            expect(screen.queryByTestId('joined-as-note')).toBeNull();
        });

        it("the new name lands on the node but this browser can't keep it: said so with Try again, which keeps it here and carries on, sending nothing again", async () => {
            const node = renameNode();
            render(<WelcomePage onComplete={vi.fn()} />);
            await submitInvite();
            await screen.findByText(/Choose your look/);
            const saved = (await loadIdentity())!;

            failTheSaveAfterTheUpdate(node);
            await backAndRename('Robin');
            expect(await screen.findByRole('alert')).toHaveTextContent("Your new name is saved on the community, but this browser couldn't keep it. Try again.");
            expect(screen.queryByText(/Choose your look/)).toBeNull();
            expect(node.state.members.get(saved.publicKey)).toBe('Robin');
            expect(await loadIdentity()).toEqual(saved);

            fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
            await screen.findByText(/Choose your look/);
            expect(screen.getByText('Robin')).toBeInTheDocument();
            expect(await loadIdentity()).toEqual({ ...saved, callsign: 'Robin' });
            expect(node.updates()).toHaveLength(1);
            expect(node.redeems()).toHaveLength(1);
            await expectWordsOf(saved);
        });

        it('the new name not kept here, and the old one typed back: that goes to the node too, so the node and this browser agree', async () => {
            const node = renameNode();
            render(<WelcomePage onComplete={vi.fn()} />);
            await submitInvite();
            await screen.findByText(/Choose your look/);
            const saved = (await loadIdentity())!;
            failTheSaveAfterTheUpdate(node);
            await backAndRename('Robin');
            expect(await screen.findByRole('alert')).toHaveTextContent("couldn't keep it");

            fireEvent.change(nameField(), { target: { value: 'Rowan' } });
            fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
            await screen.findByText(/Choose your look/);
            expect(node.updates().map((u) => u.body.callsign)).toEqual(['Robin', 'Rowan']);
            expect(node.state.members.get(saved.publicKey)).toBe('Rowan');
            expect(await loadIdentity()).toEqual(saved);
        });

        it("the new name not kept here, and the tab closed instead: this browser opens its old name beside the node's new one, which the app then takes (App.name.test)", async () => {
            const node = renameNode();
            render(<WelcomePage onComplete={vi.fn()} />);
            await submitInvite();
            await screen.findByText(/Choose your look/);
            const saved = (await loadIdentity())!;
            failTheSaveAfterTheUpdate(node);
            await backAndRename('Robin');
            expect(await screen.findByRole('alert')).toHaveTextContent("couldn't keep it");

            // What the app opens with on the next load: this key with its old name here, and Robin on the node. App.tsx
            // takes the node's name then, and sends no register that would rename the member back (App.name.test).
            cleanup();
            expect(await loadIdentity()).toEqual(saved);
            expect(node.state.members.get(saved.publicKey)).toBe('Robin');
            expect(registers(node)).toHaveLength(0);
        });
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
        // The 400 alone didn't let the key go: the node was asked once, signed by the key, and said not a member (4112075324).
        const probes = () => node.calls.filter((c) => c.path.startsWith('/api/community/membership/'));
        expect(probes()).toHaveLength(1);
        expect(probes()[0].headers['X-Public-Key']).toBe(node.redeems()[0].body.publicKey);

        reopen();
        await screen.findByText(/Join with Invite Code/);
        expect(screen.queryByRole('heading', { name: 'Finish joining' })).toBeNull();
        // Nothing kept, so the reload asks the node nothing.
        expect(probes()).toHaveLength(1);
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

/** On from the photo step: the 12 words shown are `saved`'s, in order. */
async function expectWordsOf(saved: BeanPoolIdentity) {
    fireEvent.click(screen.getByTitle('Green Bean'));
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    const words = await screen.findByTestId('backup-words');
    expect(Array.from(words.children).map((c) => c.textContent)).toEqual(saved.mnemonic!.map((w, i) => `${i + 1}. ${w}`));
}

/*
 * Confirmation round 1 of the fix, 4112075324: a redeem's 400 lets the kept key go only once the node, asked with that
 * key, says it is not a member. An older node answered a ticket's fault after registering the member with that 400.
 */
describe("a redeem's 400 lets the kept key go only once the node says it is not a member (4112075324)", () => {
    // An offline ticket as a QR carries it (BP- and the ticket): the form sends it to /api/invite/redeem-offline as it is.
    const TICKET = `BP-${btoa(JSON.stringify({ p: '{"i":"ab","t":1}', s: 'c2lnbmF0dXJl' }))}`;

    /**
     * The node as it was before engine/invites.ts narrowed its catch: it writes the member for a ticket, then something
     * after the write throws, and the catch-all answers 400. `probeDown`: the membership probe gets no answer.
     */
    function nodeRegisteringThen400() {
        const state = { members: new Map<string, string>(), probeDown: false };
        const node = stubNode(LOCAL, {
            '/api/invite/redeem-offline': (body) => {
                state.members.set(body.publicKey, body.callsign);
                return json(400, { error: 'Malformed or broken offline ticket payload' });
            },
            '/api/community/membership/': (_body, call) => {
                if (state.probeDown) throw new TypeError('Failed to fetch');
                const key = decodeURIComponent(call.path.split('/').pop()!);
                return json(200, { isMember: state.members.has(key), callsign: state.members.get(key) ?? null });
            },
        });
        return {
            ...node,
            state,
            redeems: () => node.calls.filter((c) => c.path === '/api/invite/redeem-offline'),
            probes: () => node.calls.filter((c) => c.path.startsWith('/api/community/membership/')),
        };
    }

    async function submitTicket(name = 'Rowan') {
        await screen.findByText(/Join with Invite Code/);
        fireEvent.change(screen.getByLabelText('Invite Code'), { target: { value: TICKET } });
        fireEvent.change(screen.getByLabelText('Your Callsign (Name)'), { target: { value: name } });
        fireEvent.click(screen.getByRole('button', { name: 'Create Identity & Join →' }));
    }

    it("a ticket's 400 that came after the node wrote the member: the node is asked with the key, says member, and the key is saved with its 12 words", async () => {
        const node = nodeRegisteringThen400();
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitTicket();

        await screen.findByText(/Choose your look/);
        const [redeem] = node.redeems();
        expect(node.redeems()).toHaveLength(1);
        // Asked once, signed by the key it names.
        expect(node.probes()).toHaveLength(1);
        expect(node.probes()[0].headers['X-Public-Key']).toBe(redeem.body.publicKey);
        const saved = await loadIdentity();
        expect(saved).toMatchObject({ publicKey: redeem.body.publicKey, callsign: 'Rowan' });
        expect(saved!.mnemonic).toHaveLength(12);
        expect(peekInviteSent()).toBeUndefined();
        expect(screen.queryByText('Malformed or broken offline ticket payload')).toBeNull();
        await expectWordsOf(saved!);
    });

    it("a ticket's 400 after the node wrote the member, and no answer to the probe: the key stays on disk, and the reload's probe saves it and shows its 12 words", async () => {
        const node = nodeRegisteringThen400();
        node.state.probeDown = true;
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitTicket();

        expect(await screen.findByText('Malformed or broken offline ticket payload')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Create Identity & Join →' })).not.toBeDisabled());
        const [redeem] = node.redeems();
        expect(await loadIdentity()).toBeNull();
        expect(peekInviteSent()?.identity.publicKey).toBe(redeem.body.publicKey);

        // The tab is reloaded (or closed, or discarded), and the node answers now.
        node.state.probeDown = false;
        cleanup();
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Choose your look/);
        const saved = await loadIdentity();
        expect(saved).toMatchObject({ publicKey: redeem.body.publicKey, callsign: 'Rowan' });
        expect(saved!.mnemonic).toHaveLength(12);
        expect(peekInviteSent()).toBeUndefined();
        expect(node.redeems()).toHaveLength(1);
        await expectWordsOf(saved!);
    });

    it('a ticket the node refuses, and the node then says the key is not a member: the kept key goes, as a refused code\'s does', async () => {
        const node = stubNode(LOCAL, {
            '/api/invite/redeem-offline': () => json(400, { error: 'This offline ticket has expired (maximum 30 days issuance)' }),
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
        });
        render(<WelcomePage onComplete={vi.fn()} />);
        await submitTicket();

        expect(await screen.findByText('This offline ticket has expired (maximum 30 days issuance)')).toBeInTheDocument();
        await waitFor(() => expect(peekInviteSent()).toBeUndefined());
        expect(node.calls.filter((c) => c.path.startsWith('/api/community/membership/'))).toHaveLength(1);
        expect(await loadIdentity()).toBeNull();
    });
});

/*
 * #1218's deciding pass, 4112846555: the pre-flight cut an offline ticket's BP- off, and the node reads a code as a
 * ticket only by it, so every ticket was "not recognised" and never redeemed.
 */
describe('an offline ticket gets past the pre-flight (4112846555)', () => {
    const TICKET = `BP-${btoa(JSON.stringify({ p: '{"i":"ab","t":1}', s: 'c2lnbmF0dXJl' }))}`;
    const codeOf = (call: Call) => new URL(call.path, 'https://node.example').searchParams.get('code');

    it('the pre-flight asks about the ticket BP- and all, the node says yes, and the redeem sends the ticket alone', async () => {
        const node = stubNode(LOCAL, {
            // The node's check as it is (engine/members.ts checkInvite): a ticket only by its BP-, anything else is looked
            // up as an invite code, and this node has made none.
            '/api/invite/check': (_body, call) => json(200, codeOf(call)?.startsWith('BP-') ? { valid: true, inviterCallsign: 'Ana' } : { valid: false, reason: 'invalid' }),
            '/api/invite/redeem-offline': () => json(200, { success: true, member: {} }),
        });
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
        fireEvent.change(screen.getByLabelText('Invite Code'), { target: { value: TICKET } });
        fireEvent.change(screen.getByLabelText('Your Callsign (Name)'), { target: { value: 'Rowan' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create Identity & Join →' }));

        const checks = () => node.calls.filter((c) => c.path.startsWith('/api/invite/check'));
        await waitFor(() => expect(checks()).toHaveLength(1));
        expect(checks().map(codeOf)).toEqual([TICKET]);
        await screen.findByText(/Choose your look/);
        expect(checks()).toHaveLength(1);
        const redeems = node.calls.filter((c) => c.path === '/api/invite/redeem-offline');
        expect(redeems.map((c) => c.body.ticketB64)).toEqual([TICKET.slice(3)]);
        expect(screen.queryByText(/wasn't recognised/)).toBeNull();
        expect(await loadIdentity()).toMatchObject({ publicKey: redeems[0].body.publicKey, callsign: 'Rowan' });
    });
});

/*
 * Confirmation round 1 of the fix, 4112075367: on the open door, a kept invite key is settled before the door's lobby
 * is offered, so a door join never saves a second key beside it.
 */
describe('the open door comes after a kept invite key (4112075367)', () => {
    const GLOBAL_OPEN = { ...LOCAL, profile: 'global', features: { openJoin: true } };

    it('the open door, with a kept invite key the node gives no answer about: "Finish joining", not the lobby, and no second key', async () => {
        const kept = await generateIdentity('Rowan');
        await markInviteSent(kept, 'hash', Date.now());
        const node = stubNode(GLOBAL_OPEN, { '/api/community/membership/': () => { throw new TypeError('Failed to fetch'); } });
        render(<WelcomePage onComplete={vi.fn()} />);

        expect(await screen.findByRole('heading', { name: 'Finish joining' })).toBeInTheDocument();
        expect(screen.getByTestId('invite-sent-unreachable')).toHaveTextContent('Rowan');
        expect(screen.queryByTestId('join-screen-lobby')).toBeNull();
        expect(screen.queryByTestId('join-start')).toBeNull();
        expect(peekPending()).toBeUndefined();
        expect(await loadIdentity()).toBeNull();
        expect(peekInviteSent()?.identity.publicKey).toBe(kept.publicKey);
        expect(node.calls.filter((c) => c.path.startsWith('/api/join'))).toHaveLength(0);
    });

    it('the open door, with a kept invite key the node says is not a member while its send could still land: "Finish joining" waits; once none can, Retry lets it go and the lobby follows', async () => {
        const t0 = Date.now();
        const kept = await generateIdentity('Rowan');
        await markInviteSent(kept, 'hash', t0);
        stubNode(GLOBAL_OPEN, { '/api/community/membership/': () => json(200, { isMember: false, callsign: null }) });
        render(<WelcomePage onComplete={vi.fn()} />);

        expect(await screen.findByRole('heading', { name: 'Finish joining' })).toBeInTheDocument();
        expect(screen.getByTestId('invite-sent-unreachable')).toHaveTextContent("doesn't have you yet");
        expect(screen.queryByTestId('join-screen-lobby')).toBeNull();
        expect(peekInviteSent()?.identity.publicKey).toBe(kept.publicKey);

        // Still inside the window: said so, and the key stays.
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByText(/still doesn't have you/)).toBeInTheDocument();
        expect(peekInviteSent()?.identity.publicKey).toBe(kept.publicKey);
        expect(screen.queryByTestId('join-screen-lobby')).toBeNull();

        vi.spyOn(Date, 'now').mockReturnValue(t0 + 16 * MIN);
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByTestId('join-screen-lobby');
        expect(peekInviteSent()).toBeUndefined();
        expect(await loadIdentity()).toBeNull();
    });

    it('the open door, with a kept invite key the node has as a member: it is saved, and its photo and 12 words follow', async () => {
        const kept = await generateIdentity('Rowan');
        await markInviteSent(kept, 'hash', Date.now());
        stubNode(GLOBAL_OPEN, { '/api/community/membership/': () => json(200, { isMember: true, callsign: 'Rowan' }) });
        render(<WelcomePage onComplete={vi.fn()} />);

        await screen.findByText(/Choose your look/);
        expect(await loadIdentity()).toMatchObject({ publicKey: kept.publicKey, callsign: 'Rowan' });
        expect(peekInviteSent()).toBeUndefined();
        expect(peekPending()).toBeUndefined();
        await expectWordsOf(kept);
    });
});

/*
 * Confirmation 4112213080 on #1198: on the open door, a sent door join that can no longer land, stored beside a kept
 * invite record (two answers lost, and a failed door check in between), is settled only: it hands the page back, and
 * the kept invite key is asked about next. Before, the door join was shown first and never handed back, so the invite
 * key was never asked about and the door join's resend was refused because of it, on every load.
 */
describe('a sent door join that can no longer land, beside a kept invite key, on the open door (4112213080)', () => {
    const GLOBAL_OPEN = { ...LOCAL, profile: 'global', features: { openJoin: true } };

    /** A door join sent at t0 whose answer was lost, and, 30 minutes on, an invite sent with another key `inviteAgo` ago. */
    async function bothStored(inviteAgo: number) {
        const t0 = Date.now();
        const doorKey = await generateIdentity('Alice');
        const inviteKey = await generateIdentity('Rowan');
        await savePendingJoin({ identity: doorKey, provider: 'google', nonce: null, startedAt: t0, expiresAt: t0 + PENDING_JOIN_TTL_MS, restored: false, sentAt: t0 });
        vi.spyOn(Date, 'now').mockReturnValue(t0 + 30 * MIN);
        await markInviteSent(inviteKey, 'hash', t0 + 30 * MIN - inviteAgo);
        return { doorKey, inviteKey };
    }

    function node(members: Map<string, string>) {
        const n = stubNode(GLOBAL_OPEN, {
            '/api/community/membership/': (_body, call) => {
                const key = decodeURIComponent(call.path.split('/').pop()!);
                return json(200, { isMember: members.has(key), callsign: members.get(key) ?? null });
            },
            '/api/join/sso-nonce': () => json(200, {
                nonce: 'n1', expiresInSeconds: 600, providers: ['github'], githubFlow: 'node', clientIds: {},
            }),
            '/api/join/github/start': () => json(200, { sessionId: 'sess-1', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900, intervalSeconds: 1 }),
            '/api/join/github/poll': () => json(200, { status: 'ok', sub: 'gh-77' }),
            '/api/join': () => json(200, { success: true, member: { callsign: 'Alice' } }),
        });
        const probes = () => n.calls.filter((c) => c.path.startsWith('/api/community/membership/')).map((c) => decodeURIComponent(c.path.split('/').pop()!));
        const joins = () => n.calls.filter((c) => c.path === '/api/join');
        return { ...n, probes, joins };
    }

    it('the node took the invite: the door join hands the page back, the invite key is asked about, saved, and its 12 words follow', async () => {
        const { doorKey, inviteKey } = await bothStored(2 * MIN);
        const n = node(new Map([[inviteKey.publicKey, 'Rowan']]));
        render(<WelcomePage onComplete={vi.fn()} />);

        await screen.findByText(/Choose your look/);
        expect(n.probes()).toContain(doorKey.publicKey);
        expect(n.probes()).toContain(inviteKey.publicKey);
        expect(await loadIdentity()).toMatchObject({ publicKey: inviteKey.publicKey, callsign: 'Rowan' });
        expect(peekInviteSent()).toBeUndefined();
        // The door join's key: only the node's word or the member lets it go.
        expect(peekPending()).toMatchObject({ identity: { publicKey: doorKey.publicKey }, sentAt: expect.any(Number) });
        expect(screen.queryByTestId('join-screen-providers')).toBeNull();
        expect(n.joins()).toHaveLength(0);
        await expectWordsOf(inviteKey);
    });

    it('the invite never landed and no send with it can now: the invite key is let go, and the door join can be sent again and lands', async () => {
        const { doorKey, inviteKey } = await bothStored(20 * MIN);
        const n = node(new Map());
        render(<WelcomePage onComplete={vi.fn()} />);

        // The kept invite key was asked about, and let go.
        await waitFor(() => expect(n.probes()).toContain(inviteKey.publicKey));
        await waitFor(() => expect(peekInviteSent()).toBeUndefined());
        // Then the door join, which can no longer land, is offered again with its own key.
        expect(await screen.findByTestId('join-notice')).toHaveTextContent("Your join didn't reach the community. Sign in again to finish.");
        await screen.findByTestId('join-screen-providers');
        fireEvent.click(await screen.findByTestId('join-provider-github'));
        await screen.findByTestId('join-github-code');

        // Sent, not refused because of the invite key.
        await waitFor(() => expect(n.joins()).toHaveLength(1), { timeout: 4000 });
        expect(n.joins()[0].headers['X-Public-Key']).toBe(doorKey.publicKey);
        expect(screen.queryByText(/An invite sent from this browser is still being checked/)).toBeNull();
        await screen.findByText(/Choose your look/);
        expect((await loadIdentity())?.publicKey).toBe(doorKey.publicKey);
    });
});
