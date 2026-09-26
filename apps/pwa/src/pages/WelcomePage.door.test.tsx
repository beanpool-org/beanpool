/**
 * WelcomePage on a node whose door is open (design G11-b): which page a visitor gets, the steps after the join, and a
 * key restored here that is not a member yet. The node is a stubbed fetch; the join screens themselves are covered
 * in components/WebJoin.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import {
    generateIdentity, identityFromMnemonic, importIdentity, loadIdentity, loadPendingJoin, savePendingJoin, PENDING_JOIN_TTL_MS,
    type BeanPoolIdentity, type PendingJoin,
} from '../lib/identity';
import { generateMnemonic } from '../lib/mnemonic';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

type Handler = (body: any, path: string) => Response;

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubNode(info: unknown | Error, handlers: Record<string, Handler> = {}) {
    const calls: Array<{ path: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body });
        if (path === '/api/community/info') {
            if (info instanceof Error) throw info;
            return json(200, info);
        }
        const key = Object.keys(handlers).find((k) => path === k || path.startsWith(k));
        if (key) return handlers[key](body, path);
        return json(200, {});
    }));
    return calls;
}

const GLOBAL_OPEN = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true } };

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let identity: BeanPoolIdentity;
beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
    identity = await generateIdentity('Alice');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetCapturedAuthReturn();
});

describe('which welcome a visitor gets', () => {
    it('the open door: the join lobby, and never the invite form', async () => {
        stubNode(GLOBAL_OPEN);
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByTestId('join-screen-lobby');
        expect(screen.queryByText(/Join with Invite Code/)).toBeNull();
    });

    it('a local community: the invite form, as today', async () => {
        stubNode({ ...GLOBAL_OPEN, profile: 'local', features: { openJoin: false } });
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
        expect(screen.queryByTestId('join-start')).toBeNull();
    });

    it('a global node whose door is shut: the invite form', async () => {
        stubNode({ ...GLOBAL_OPEN, features: { openJoin: false } });
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
    });

    it("an older node that says nothing about itself: the invite form", async () => {
        stubNode({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0 });
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
    });

    it('a sign-in return on an invite-only node: the token leaves the address bar, and the invite page shows as always', async () => {
        window.history.replaceState(null, '', `/app/auth/google#state=x&id_token=${b64url('{}')}.${b64url('{"sub":"s","nonce":"x"}')}.c2ln`);
        const calls = stubNode({ ...GLOBAL_OPEN, profile: 'local', features: { openJoin: false } });
        render(<WelcomePage onComplete={vi.fn()} />);
        expect(window.location.hash).toBe('');
        await screen.findByText(/Join with Invite Code/);
        expect(screen.queryByText(/No invite needed/)).toBeNull();
        expect(calls.some((c) => c.path.startsWith('/api/join'))).toBe(false);
    });

    it("no answer: says so in one line with Try again, and the page still works", async () => {
        stubNode(new TypeError('Failed to fetch'));
        render(<WelcomePage onComplete={vi.fn()} />);
        expect(await screen.findByTestId('door-unreachable')).toHaveTextContent("Can't reach the community right now.");
        expect(screen.getByText(/Join with Invite Code/)).toBeInTheDocument();
    });
});

describe('after the door says yes: the same steps every new member has', () => {
    it('photo, 12 words, tour; "Sign in" on the bar, no going back, the new name said, storage kept', async () => {
        await savePendingJoin({ identity, provider: 'google', nonce: 'n1', startedAt: Date.now(), expiresAt: Date.now() + PENDING_JOIN_TTL_MS, restored: false });
        const token = `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ sub: 'g1', nonce: 'n1' }))}.c2ln`;
        window.history.replaceState(null, '', `/app/auth/google#state=n1&id_token=${token}`);
        const calls = stubNode(GLOBAL_OPEN, {
            '/api/join': () => json(200, { success: true, member: { callsign: 'Alice2' } }),
        });
        const persist = vi.fn(async () => true);
        Object.defineProperty(navigator, 'storage', { value: { persist, persisted: vi.fn(async () => false) }, configurable: true });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);

        // The token left the address bar before anything else ran.
        expect(window.location.pathname).toBe('/app');
        expect(window.location.hash).toBe('');

        // Step 2, the photo.
        expect(await screen.findByTestId('joined-as-note')).toHaveTextContent("You're Alice2 here: Alice was taken.");
        expect(screen.getByTestId('onboarding-stepper')).toHaveTextContent('Sign in');
        expect(screen.queryByText('Your Name')).toBeNull();
        expect(screen.queryByRole('button', { name: '← Back' })).toBeNull();
        fireEvent.click(screen.getByTitle('Green Bean'));
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

        // Step 3, the 12 words of the key that joined.
        await screen.findByText(/Your Safety Backup/);
        for (const w of identity.mnemonic!) expect(screen.getAllByText(w).length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

        // Step 4, the tour, then in.
        fireEvent.click(await screen.findByRole('button', { name: "Let's Begin! 🚀" }));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(onComplete.mock.calls[0][0]).toMatchObject({ publicKey: identity.publicKey, callsign: 'Alice2' });
        expect(persist).toHaveBeenCalledTimes(1);
        expect((await loadIdentity())?.publicKey).toBe(identity.publicKey);
        // The door registered the member: nothing registers or redeems again.
        expect(calls.some((c) => c.path === '/api/community/register' || c.path === '/api/invite/redeem')).toBe(false);
        expect(calls.filter((c) => c.path === '/api/join')).toHaveLength(1);
    });
});

describe('the words screen after a door join that enrolled its sign-in (G11-c)', () => {
    /** Through the door with Google, the node answering `recovery` as given, to the 12 words. */
    async function toTheWords(recovery: unknown) {
        await savePendingJoin({ identity, provider: 'google', nonce: 'n1', startedAt: Date.now(), expiresAt: Date.now() + PENDING_JOIN_TTL_MS, restored: false });
        const token = `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ sub: 'g1', nonce: 'n1' }))}.c2ln`;
        window.history.replaceState(null, '', `/app/auth/google#state=n1&id_token=${token}`);
        const calls = stubNode(GLOBAL_OPEN, {
            '/api/join': () => json(200, { success: true, member: { callsign: 'Alice' }, provider: 'google', recovery }),
        });
        render(<WelcomePage onComplete={vi.fn()} />);
        fireEvent.click(await screen.findByTitle('Green Bean'));
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        await screen.findByText(/Your Safety Backup/);
        return calls;
    }

    it('stored: the words screen says the sign-in brings the account back too, and never "the only way"', async () => {
        const calls = await toTheWords({ enrolled: true, generation: 1, provider: 'google', enrolledSso: ['google'] });
        expect(calls.find((c) => c.path === '/api/join')?.body.recovery.shares).toHaveLength(1);
        expect(screen.getByTestId('backup-signin-recovery')).toHaveTextContent('Signing in with Google also brings this account back.');
        expect(screen.queryByText(/only/, { selector: 'strong' })).toBeNull();
        expect(screen.getByText(/They bring your identity back if you lose this device\./)).toBeInTheDocument();
        // The tickbox and the words are today's.
        for (const w of identity.mnemonic!) expect(screen.getAllByText(w).length).toBeGreaterThan(0);
        expect(screen.getByLabelText("I've written these words down somewhere safe")).not.toBeChecked();
    });

    it('not stored: the words screen is exactly as before', async () => {
        await toTheWords({ enrolled: false, error: 'The recovery keeper could not be stored.' });
        expect(screen.queryByTestId('backup-signin-recovery')).toBeNull();
        expect(screen.getByText(/way to recover your identity if you lose this device\./)).toBeInTheDocument();
        expect(screen.getAllByText('only', { selector: 'strong' }).length).toBeGreaterThan(0);
    });
});

describe('a join whose answer was lost (review 4106075404)', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('reopened after ten minutes: the node says member, and the same steps follow, the 12 words of that key included', async () => {
        const t0 = Date.now();
        await savePendingJoin({ identity, provider: 'google', nonce: null, startedAt: t0 - 4 * 60_000, expiresAt: t0 + 6 * 60_000, restored: false, sentAt: t0 });
        vi.spyOn(Date, 'now').mockReturnValue(t0 + 11 * 60_000);
        const calls = stubNode(GLOBAL_OPEN, { '/api/community/membership/': () => json(200, { isMember: true, callsign: 'Alice' }) });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);

        // Step 2, the photo, as after any join.
        await screen.findByTestId('onboarding-stepper');
        fireEvent.click(await screen.findByTitle('Green Bean'));
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        // Step 3: the words the member never saw.
        await screen.findByText(/Your Safety Backup/);
        for (const w of identity.mnemonic!) expect(screen.getAllByText(w).length).toBeGreaterThan(0);
        expect((await loadIdentity())?.publicKey).toBe(identity.publicKey);
        expect(await loadPendingJoin()).toBeNull();
        expect(calls.some((c) => c.path.startsWith('/api/join'))).toBe(false);
        expect(onComplete).not.toHaveBeenCalled();
    });
});

describe('a key restored here on the open door', () => {
    async function restoreWithWords(words: string[]) {
        await screen.findByTestId('join-screen-lobby');
        fireEvent.click(screen.getByRole('button', { name: 'Already have BeanPool?' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Use my 12 words' }));
        fireEvent.change(await screen.findByLabelText('Recovery word 1'), { target: { value: words.join(' ') } });
        fireEvent.click(screen.getByRole('button', { name: 'Recover Identity' }));
    }

    it('not a member here: nothing saved as the identity, and it goes through the door with the same key', async () => {
        const words = generateMnemonic();
        stubNode(GLOBAL_OPEN, {
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
            '/api/members/callsign-available/': () => json(200, { available: true }),
            '/api/join/sso-nonce': () => json(200, { nonce: 'n', expiresInSeconds: 600, providers: ['google'], clientIds: { google: 'g' } }),
        });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await restoreWithWords(words);
        // The 12 words carry no name: the door asks for one, for the same key.
        fireEvent.change(await screen.findByTestId('join-callsign'), { target: { value: 'Rowan' } });
        fireEvent.click(screen.getByTestId('join-name-next'));
        await screen.findByTestId('join-provider-google');
        const pending = (await loadPendingJoin())!;
        expect(pending.restored).toBe(true);
        expect(pending.identity.mnemonic).toEqual(words);
        expect(await loadIdentity()).toBeNull();
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('already a member here: straight in with the name the node holds', async () => {
        stubNode(GLOBAL_OPEN, { '/api/community/membership/': () => json(200, { isMember: true, callsign: 'Sam' }) });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await restoreWithWords(generateMnemonic());
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(onComplete.mock.calls[0][0]).toMatchObject({ callsign: 'Sam' });
        expect((await loadIdentity())?.callsign).toBe('Sam');
        expect(await loadPendingJoin()).toBeNull();
    });

    it('already a member here: a join started in this browser and never sent is cleared', async () => {
        stubNode(GLOBAL_OPEN, { '/api/community/membership/': () => json(200, { isMember: true, callsign: 'Sam' }) });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await screen.findByTestId('join-screen-lobby');
        // Left by another tab, say, while this one shows the lobby.
        await savePendingJoin({ identity, provider: 'google', nonce: null, startedAt: Date.now(), expiresAt: Date.now() + PENDING_JOIN_TTL_MS, restored: false });
        await restoreWithWords(generateMnemonic());
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect((await loadIdentity())?.callsign).toBe('Sam');
        expect(await loadPendingJoin()).toBeNull();
    });

    // Changed for review 4106962311 (decision 3): this case used to restore Sam here and leave the sent join behind,
    // where no page would ever ask about it again. The join that went out is now settled before any restore is saved.
    it('already a member here, while a join that went out from this browser waits: that join is settled first; it landed, so it is kept and said', async () => {
        const sentAt = Date.now();
        // Every key is a member here: Sam's, and the one the earlier join sent (Alice).
        const calls = stubNode(GLOBAL_OPEN, {
            '/api/community/membership/': (_b, path) => json(200, { isMember: true, callsign: path.endsWith(identity.publicKey) ? 'Alice' : 'Sam' }),
        });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await screen.findByTestId('join-screen-lobby');
        // Left by another tab, say, while this one shows the lobby.
        await savePendingJoin({ identity, provider: 'google', nonce: null, startedAt: sentAt, expiresAt: sentAt + PENDING_JOIN_TTL_MS, restored: false, sentAt });
        await restoreWithWords(generateMnemonic());
        // The earlier join's key is this browser's account now, with the steps and its 12 words to come; Sam isn't added.
        expect(await screen.findByTestId('joined-as-note')).toHaveTextContent('This browser had already joined as Alice');
        expect(await loadIdentity()).toMatchObject({ publicKey: identity.publicKey, mnemonic: identity.mnemonic });
        expect(await loadPendingJoin()).toBeNull();
        expect(calls.some((c) => c.path === `/api/community/membership/${identity.publicKey}`)).toBe(true);
        expect(onComplete).not.toHaveBeenCalled();
    });

    it("the node can't be reached: says so on the words screen and saves nothing", async () => {
        stubNode(GLOBAL_OPEN, { '/api/community/membership/': () => { throw new TypeError('Failed to fetch'); } });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await restoreWithWords(generateMnemonic());
        expect(await screen.findByText("Can't reach the community right now. Try again in a minute.")).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Recover Identity' })).toBeInTheDocument();
        expect(await loadIdentity()).toBeNull();
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('not a member here, while a join that went out may still land: the member is told and waits; once it can no longer land, they choose to let it go, and the account they brought goes in', async () => {
        const t0 = Date.now();
        const words = generateMnemonic();
        const sam = await identityFromMnemonic(words, '');
        const calls = stubNode(GLOBAL_OPEN, {
            '/api/community/membership/': (_b, path) => json(200, path.endsWith(sam.publicKey) ? { isMember: true, callsign: 'Sam' } : { isMember: false, callsign: null }),
            '/api/join/sso-nonce': () => json(409, { code: 'already_member', error: 'This key is already a member of this community.' }),
        });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await screen.findByTestId('join-screen-lobby');
        await savePendingJoin({ identity, provider: 'google', nonce: null, startedAt: t0, expiresAt: t0 + PENDING_JOIN_TTL_MS, restored: false, sentAt: t0 });
        await restoreWithWords(words);

        expect(await screen.findByTestId('join-held')).toHaveTextContent('may still go through');
        expect(await loadIdentity()).toBeNull();
        expect(await loadPendingJoin()).toMatchObject({ identity: { publicKey: identity.publicKey }, sentAt: t0 });
        expect(calls.some((c) => c.path === `/api/community/membership/${identity.publicKey}`)).toBe(true);
        expect(onComplete).not.toHaveBeenCalled();

        vi.spyOn(Date, 'now').mockReturnValue(t0 + 12 * 60_000);
        fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Use Sam instead' }));
        fireEvent.click(await screen.findByTestId('join-abandon-confirm'));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(onComplete.mock.calls[0][0]).toMatchObject({ publicKey: sam.publicKey });
        expect((await loadIdentity())?.publicKey).toBe(sam.publicKey);
        expect(await loadPendingJoin()).toBeNull();
    });
});

describe('a join that went out is settled wherever the page lands, the door open or shut (review 4106962311)', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    const MIN = 60_000;
    const GLOBAL_SHUT = { ...GLOBAL_OPEN, features: { openJoin: false } };
    const probed = (calls: Array<{ path: string }>, key: string) => calls.some((c) => c.path === `/api/community/membership/${key}`);

    async function seedSent(sentAgo: number): Promise<PendingJoin> {
        const t = Date.now() - sentAgo;
        const p: PendingJoin = { identity, provider: 'google', nonce: null, startedAt: t - 2 * MIN, expiresAt: t + 8 * MIN, restored: false, sentAt: t };
        await savePendingJoin(p);
        return p;
    }

    it("the reviewer's case: the door shut, a join sent 50 minutes ago that landed: the node is asked before any invite page, and the member is in, with the steps and the 12 words", async () => {
        await seedSent(50 * MIN);
        const calls = stubNode(GLOBAL_SHUT, { '/api/community/membership/': () => json(200, { isMember: true, callsign: 'Alice' }) });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);

        // Step 2, the photo, as after any join; never the invite page.
        fireEvent.click(await screen.findByTitle('Green Bean'));
        expect(screen.queryByText(/Join with Invite Code/)).toBeNull();
        expect(probed(calls, identity.publicKey)).toBe(true);
        expect(await loadIdentity()).toMatchObject({ publicKey: identity.publicKey, mnemonic: identity.mnemonic });
        expect(await loadPendingJoin()).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        await screen.findByText(/Your Safety Backup/);
        for (const w of identity.mnemonic!) expect(screen.getAllByText(w).length).toBeGreaterThan(0);
        expect(calls.some((c) => c.path.startsWith('/api/join'))).toBe(false);
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('the door shut, a join the node says never landed and can no longer land: asked first, then the invite page; a restore there goes ahead', async () => {
        const sent = await seedSent(50 * MIN);
        const words = generateMnemonic();
        const sam = await identityFromMnemonic(words, '');
        const calls = stubNode(GLOBAL_SHUT, { '/api/community/membership/': () => json(200, { isMember: false, callsign: null }) });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);

        await screen.findByText(/Join with Invite Code/);
        expect(probed(calls, identity.publicKey)).toBe(true);
        // Not a member and can't become one: kept as it was (only the node's refusal or the member lets it go).
        expect(await loadPendingJoin()).toMatchObject({ identity: { publicKey: identity.publicKey }, sentAt: sent.sentAt });

        fireEvent.click(screen.getByRole('button', { name: 'Restore existing identity' }));
        fireEvent.click(await screen.findByRole('button', { name: /Recover with 12 Words/ }));
        fireEvent.change(await screen.findByLabelText('Recovery word 1'), { target: { value: words.join(' ') } });
        fireEvent.click(screen.getByRole('button', { name: 'Recover Identity' }));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect((await loadIdentity())?.publicKey).toBe(sam.publicKey);
    });

    it('the door shut, a join sent two minutes ago that the node does not have yet: the member is told to wait, never shown the invite page, and checking again after the window lets the page go on', async () => {
        await seedSent(2 * MIN);
        stubNode(GLOBAL_SHUT, { '/api/community/membership/': () => json(200, { isMember: false, callsign: null }) });
        render(<WelcomePage onComplete={vi.fn()} />);

        expect(await screen.findByTestId('join-held')).toHaveTextContent('may still go through');
        expect(screen.queryByText(/Join with Invite Code/)).toBeNull();
        // The door is shut: nothing offers to join again.
        expect(screen.queryByRole('button', { name: /Finish joining/ })).toBeNull();
        expect(screen.queryByText(/No invite needed/)).toBeNull();
        expect(await loadIdentity()).toBeNull();

        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * MIN);
        fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
        await screen.findByText(/Join with Invite Code/);
        expect((await loadPendingJoin())?.identity.publicKey).toBe(identity.publicKey);
    });

    it("the door shut and the node can't be asked: the member is told the account is kept and to try again, never shown the invite page", async () => {
        await seedSent(50 * MIN);
        let reachable = false;
        stubNode(GLOBAL_SHUT, {
            '/api/community/membership/': () => {
                if (!reachable) throw new TypeError('Failed to fetch');
                return json(200, { isMember: true, callsign: 'Alice' });
            },
        });
        render(<WelcomePage onComplete={vi.fn()} />);

        await waitFor(() => expect(screen.getByTestId('join-checking')).toHaveTextContent("We can't tell yet whether you joined as Alice."));
        expect(screen.queryByText(/Join with Invite Code/)).toBeNull();
        expect(screen.queryByRole('button', { name: '← Back' })).toBeNull();

        reachable = true;
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await screen.findByTitle('Green Bean');
        expect((await loadIdentity())?.publicKey).toBe(identity.publicKey);
    });

    it('the invite page, and another tab sends a join before the member uses an invite: that join is settled first, and no identity is made', async () => {
        const calls = stubNode(GLOBAL_SHUT, {
            '/api/invite/check': () => json(200, { valid: true }),
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
        });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await screen.findByText(/Join with Invite Code/);
        await seedSent(0);

        fireEvent.change(screen.getByLabelText('Invite Code'), { target: { value: 'BP-7K3X-9M2W' } });
        fireEvent.change(screen.getByLabelText('Your Callsign (Name)'), { target: { value: 'Rowan' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create Identity & Join →' }));

        expect(await screen.findByTestId('join-held')).toHaveTextContent('may still go through');
        expect(probed(calls, identity.publicKey)).toBe(true);
        expect(await loadIdentity()).toBeNull();
        expect(calls.some((c) => c.path.startsWith('/api/invite/redeem'))).toBe(false);
        expect(onComplete).not.toHaveBeenCalled();
    });
});

describe('one browser, one account on the welcome page too (review 4106962020, decision 1)', () => {
    it('another tab saves an account while this one is on the invite page: the invite never replaces it, and the page offers to open it', async () => {
        const calls = stubNode({ ...GLOBAL_OPEN, profile: 'local', features: { openJoin: false } }, {
            '/api/invite/check': () => json(200, { valid: true }),
        });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await screen.findByText(/Join with Invite Code/);
        await importIdentity(identity); // another tab

        fireEvent.change(screen.getByLabelText('Invite Code'), { target: { value: 'BP-7K3X-9M2W' } });
        fireEvent.change(screen.getByLabelText('Your Callsign (Name)'), { target: { value: 'Rowan' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create Identity & Join →' }));

        expect(await screen.findByTestId('welcome-held')).toHaveTextContent('Alice');
        expect(await loadIdentity()).toMatchObject({ publicKey: identity.publicKey, mnemonic: identity.mnemonic });
        expect(calls.some((c) => c.path.startsWith('/api/invite/redeem'))).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'Open Alice' }));
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onComplete.mock.calls[0][0]).toMatchObject({ publicKey: identity.publicKey });
    });

    it('a 12-word restore on the invite page after another tab saved an account: refused, and the page offers to open it', async () => {
        stubNode({ ...GLOBAL_OPEN, profile: 'local', features: { openJoin: false } });
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await screen.findByText(/Join with Invite Code/);
        await importIdentity(identity); // another tab

        fireEvent.click(screen.getByRole('button', { name: 'Restore existing identity' }));
        fireEvent.click(await screen.findByRole('button', { name: /Recover with 12 Words/ }));
        fireEvent.change(await screen.findByLabelText('Recovery word 1'), { target: { value: generateMnemonic().join(' ') } });
        fireEvent.click(screen.getByRole('button', { name: 'Recover Identity' }));

        expect(await screen.findByTestId('welcome-held')).toHaveTextContent('Alice');
        expect((await loadIdentity())?.publicKey).toBe(identity.publicKey);
        expect(onComplete).not.toHaveBeenCalled();
    });
});
