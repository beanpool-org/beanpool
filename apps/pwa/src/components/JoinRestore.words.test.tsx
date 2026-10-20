/**
 * Joining, restoring, a re-key code and adding a sign-in in the member's language (words S3, web sweep W4): in the
 * pseudo-locale every word these screens write themselves came through t(), and so did every sentence the key-path lib
 * files write (components/key-lines.ts); what is left as written is what others wrote: a member's name, a sign-in's
 * name, the community's own words, an address, a code. The 12 words are never looked up. A change of language redraws
 * what is on the screen, a notice included. In English nothing is bracketed and the words are as they were.
 *
 * The node is a stubbed fetch, as in WebJoin.test.tsx and WebRestore.test.tsx; nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WebJoin } from './WebJoin';
import { WebRestore } from './WebRestore';
import { WebRekey } from './WebRekey';
import { AddSignIn } from './OneWayBack';
import { generateIdentity, savePendingJoin, savePendingRestore, PENDING_JOIN_TTL_MS, PENDING_RESTORE_TTL_MS, type BeanPoolIdentity } from '../lib/identity';
import { readAuthReturn, resetCapturedAuthReturn } from '../lib/web-join';
import { makeEphemeralKey } from '../lib/web-restore';
import type { WebRekeyDeps } from '../lib/web-rekey';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { chooseAndShowLanguage } from '../lib/language';
import { useLanguage } from '../lib/useLanguage';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';
import ruWords from '../../words/ru.json';

const RU = ruWords as Record<string, unknown>;
const ORIGIN = 'https://global.beanpool.org';
const NONCE = 'node-nonce-1';
/** What others wrote, shown as written: names, the sign-ins' names, the host. */
const OTHERS = ['Alice', 'Bea', 'Google', 'Apple', 'Facebook', 'global.beanpool.org', 'localhost:3000', 'localhost'];

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fakeJwt = (claims: Record<string, unknown>) => `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(claims))}.c2ln`;

type Handler = (body: unknown) => Response | Promise<Response>;
function stubNode(handlers: Record<string, Handler>) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        const key = Object.keys(handlers).find((k) => path === k || path.startsWith(k));
        return key ? handlers[key](body) : json(404, { error: 'Not Found' });
    }));
}
const nonceAnswer = () => json(200, {
    nonce: NONCE, expiresInSeconds: 600, providers: ['google', 'apple', 'facebook'],
    clientIds: { google: 'web-client', apple: 'org.beanpool.web', facebook: '818892721251369' },
});

let identity: BeanPoolIdentity;
beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    identity = await generateIdentity('Alice');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    backToEnglish();
});

/** Nothing on the screen bypassed t() but what others wrote, and the screen did say something through it. */
function allThroughWords(others: readonly string[] = OTHERS, atLeast = 2) {
    expect(bypassing(document.body, { others })).toEqual([]);
    expect(bracketed()).toBeGreaterThanOrEqual(atLeast);
}

async function seedPending() {
    const now = Date.now();
    await savePendingJoin({ identity, provider: 'google', nonce: NONCE, startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: false });
}
const googleReturn = () => readAuthReturn('/app/auth/google', `#state=${NONCE}&id_token=${fakeJwt({ sub: 'g-sub-1', nonce: NONCE })}`);
const cancelledReturn = () => readAuthReturn('/app/auth/google', `#state=${NONCE}&error=access_denied`);

function renderJoin(props: Partial<React.ComponentProps<typeof WebJoin>> = {}) {
    render(<WebJoin onJoined={vi.fn()} onRestore={vi.fn()} navigate={vi.fn()} origin={ORIGIN} authReturn={null} onLobby={vi.fn()} {...props} />);
}

describe('joining (WebJoin) in the pseudo-locale', () => {
    it('the lobby, "have you used BeanPool before?", bringing an account, the name (a taken one) and the sign-ins', async () => {
        await showIn('xx');
        stubNode({
            '/api/members/callsign-available/': () => json(200, { available: false }),
            '/api/join/sso-nonce': () => nonceAnswer(),
        });
        renderJoin();
        const join = await screen.findByTestId('join-start');
        await waitFor(() => expect(join).not.toBeDisabled());
        expect(join.textContent).toBe(xx('Join'));
        allThroughWords();

        fireEvent.click(screen.getByRole('button', { name: xx('Already have BeanPool?') }));
        expect(await screen.findByTestId('join-screen-restore')).toBeInTheDocument();
        allThroughWords();
        fireEvent.click(screen.getByRole('button', { name: xx('← Back') }));

        fireEvent.click(await screen.findByTestId('join-start'));
        expect(await screen.findByTestId('join-screen-guard')).toBeInTheDocument();
        allThroughWords();

        fireEvent.click(screen.getByTestId('join-new'));
        fireEvent.change(await screen.findByTestId('join-callsign'), { target: { value: 'Bea' } });
        await screen.findByText(/Bea/, { selector: 'p[role="status"]' }, { timeout: 3000 });
        allThroughWords();

        fireEvent.click(screen.getByTestId('join-name-next'));
        expect(await screen.findByTestId('join-provider-google')).toBeInTheDocument();
        expect(screen.getByTestId('join-as').textContent).toBe('Bea');
        allThroughWords();
    });

    it('the two doors: 12 words beside the sign-ins, and a node that shut the 12-words door says so', async () => {
        await showIn('xx');
        stubNode({
            '/api/members/callsign-available/': () => json(200, { available: true }),
            '/api/join/sso-nonce': () => nonceAnswer(),
            '/api/join/work': () => json(200, { work: null, turnstile: null }),
        });
        renderJoin({ wordsDoor: true, solveWork: () => ({ done: new Promise(() => {}), cancel: () => {} }) });
        const join = await screen.findByTestId('join-start');
        await waitFor(() => expect(join).not.toBeDisabled());
        fireEvent.click(join);
        fireEvent.click(await screen.findByTestId('join-new'));
        fireEvent.change(await screen.findByTestId('join-callsign'), { target: { value: 'Bea' } });
        fireEvent.click(screen.getByTestId('join-name-next'));
        expect(await screen.findByTestId('door-words')).toBeInTheDocument();
        await screen.findByTestId('join-words-problem');
        expect(screen.getByTestId('join-words-problem').textContent).toBe(xx("This community isn't taking 12-words accounts right now. Sign in to join."));
        await screen.findByTestId('join-provider-google');
        allThroughWords();
    });

    it('a sign-in that was cancelled, the network\'s limit with the community\'s own words, and "you\'re already here"', async () => {
        await showIn('xx');
        await seedPending();
        stubNode({ '/api/join/sso-nonce': () => nonceAnswer() });
        renderJoin({ authReturn: cancelledReturn() });
        expect((await screen.findByTestId('join-notice')).textContent).toBe(xx('Sign-in was cancelled.'));
        await screen.findByTestId('join-provider-google');
        allThroughWords();
        cleanup();

        const said = 'Too many new accounts have joined from this network in the last hour (5). Please try again later.';
        await seedPending();
        stubNode({
            '/api/join/sso-nonce': () => nonceAnswer(),
            '/api/join': () => json(429, { code: 'rate_limited', error: said }),
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
        });
        renderJoin({ authReturn: googleReturn() });
        const notice = await screen.findByTestId('join-notice');
        expect(notice.textContent).toContain(said);
        expect(notice.textContent).toContain(xx('Everyone joining from the same network counts together: at a campus, an office or a meetup it may be other people joining, not you.'));
        allThroughWords([...OTHERS, said]);
        cleanup();

        await seedPending();
        stubNode({
            '/api/join': () => json(409, { code: 'already_joined', error: 'node text' }),
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
        });
        renderJoin({ authReturn: googleReturn() });
        expect((await screen.findByTestId('join-already-joined')).textContent)
            .toBe(xx('This {provider} account already has a BeanPool identity here. Restore it instead.').replace('{provider}', 'Google'));
        allThroughWords();
    });

    it("no answer: \"we can't tell\", and the community's own words when it can't take a join", async () => {
        await showIn('xx');
        await seedPending();
        stubNode({
            '/api/join': () => { throw new TypeError('Failed to fetch'); },
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
        });
        renderJoin({ authReturn: googleReturn() });
        await waitFor(() => expect(screen.getByTestId('join-unknown').textContent).toBe(xx("We can't tell if that worked, and you're not in yet. Check your connection, then try again.")));
        allThroughWords();
        cleanup();

        await seedPending();
        stubNode({
            '/api/join': () => json(503, { code: 'sign_in_unavailable' }),
            '/api/community/membership/': () => json(200, { isMember: false, callsign: null }),
        });
        renderJoin({ authReturn: googleReturn() });
        expect((await screen.findByTestId('join-unavailable')).textContent)
            .toBe(xx('{provider} sign-in could not be checked right now. Please try again in a minute.').replace('{provider}', 'Google'));
        allThroughWords();
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        await seedPending();
        stubNode({ '/api/join/sso-nonce': () => nonceAnswer() });
        renderJoin({ authReturn: cancelledReturn() });
        expect((await screen.findByTestId('join-notice')).textContent).toBe('Sign-in was cancelled.');
        await screen.findByTestId('join-provider-google');
        expect(bracketed()).toBe(0);
        expect(screen.getByText('Joining as', { exact: false }).textContent).toBe('Joining as Alice');
        expect(screen.getByText(/^Why a sign-in\?/).textContent).toBe("Why a sign-in? It stops one person making many accounts. We keep only a scrambled reference to it, never your email or name from there. It also locks a copy of your account, so this sign-in can bring it back. The people who run this community's server can open that copy.");
    });
});

describe('a change of language redraws the join, its notice included', () => {
    // As App does: the root re-renders when the language changes (lib/useLanguage.ts).
    const Live = (props: Partial<React.ComponentProps<typeof WebJoin>>) => {
        useLanguage();
        return <WebJoin onJoined={vi.fn()} onRestore={vi.fn()} navigate={vi.fn()} origin={ORIGIN} authReturn={null} {...props} />;
    };

    it('English → Russian → the pseudo-locale → English: the buttons, and a notice set before the change', async () => {
        stubNode({ '/api/join/sso-nonce': () => nonceAnswer() });
        render(<Live onLobby={vi.fn()} />);
        const join = await screen.findByTestId('join-start');
        expect(join.textContent).toBe('Join');
        await act(async () => { expect(await chooseAndShowLanguage('ru')).toBe(true); });
        expect(RU.Join).toBeTruthy();
        expect(screen.getByTestId('join-start').textContent).toBe(RU.Join);
        expect(screen.getByRole('button', { name: RU['← Back to the listings'] as string })).toBeInTheDocument();
        await act(async () => { expect(await chooseAndShowLanguage('en')).toBe(true); });
        expect(screen.getByTestId('join-start').textContent).toBe('Join');
        cleanup();

        await seedPending();
        render(<Live authReturn={cancelledReturn()} />);
        expect((await screen.findByTestId('join-notice')).textContent).toBe('Sign-in was cancelled.');
        await showIn('xx');
        expect(screen.getByTestId('join-notice').textContent).toBe(xx('Sign-in was cancelled.'));
        await showIn('en');
        expect(screen.getByTestId('join-notice').textContent).toBe('Sign-in was cancelled.');
    });
});

describe('getting an account back with a sign-in (WebRestore) in the pseudo-locale', () => {
    // More specific paths first: a key matches its own path and any path under it. Only Alice comes back with a sign-in.
    function recoveryNode(overrides: Record<string, Handler> = {}) {
        stubNode({
            '/api/recovery/collect/sso-nonce': () => json(200, { nonce: 'rn-1', expiresInSeconds: 600, clientIds: { google: 'web-client', apple: 'org.beanpool.web', facebook: '818892721251369' } }),
            ...overrides,
            '/api/recovery/lookup/Alice': () => json(200, [{ publicKey: identity.publicKey, callsign: 'Alice', canRecoverBySso: true }]),
            '/api/recovery/lookup/': () => json(200, []),
            '/api/recovery/collect': () => json(200, { collectionId: 'col-1', threshold: 1 }),
        });
    }
    const renderRestore = (props: Partial<React.ComponentProps<typeof WebRestore>> = {}) => render(
        <WebRestore onRestored={vi.fn(async () => true)} onHeld={vi.fn()} onExisting={vi.fn()} onBack={vi.fn()} onOtherWay={vi.fn()}
            navigate={vi.fn()} origin={ORIGIN} authReturn={null} {...props} />,
    );

    it('the name, no account by it, the accounts it could be, and the sign-ins', async () => {
        await showIn('xx');
        recoveryNode();
        renderRestore();
        const box = await screen.findByTestId('restore-callsign');
        allThroughWords();
        fireEvent.change(box, { target: { value: 'Zed' } });
        expect(await screen.findByTestId('restore-none', undefined, { timeout: 3000 })).toBeInTheDocument();
        allThroughWords([...OTHERS, 'Zed']);

        fireEvent.change(box, { target: { value: 'Alice' } });
        fireEvent.click(await screen.findByTestId('restore-candidate', undefined, { timeout: 3000 }));
        expect(await screen.findByTestId('restore-provider-google')).toBeInTheDocument();
        expect(screen.getByRole('heading').textContent).toBe(xx('Sign in as {name}').replace('{name}', 'Alice'));
        allThroughWords();
    });

    it('a sign-in that is no way back into the account: the lib file\'s sentence, translated, with the names as they are', async () => {
        await showIn('xx');
        recoveryNode({ '/api/recovery/collect/sso': () => json(400, { error: 'x' }) });
        const eph = makeEphemeralKey();
        const now = Date.now();
        await savePendingRestore({
            kind: 'restore', ephemeral: eph, account: { publicKey: identity.publicKey, callsign: 'Alice' }, collectionId: 'col-1',
            provider: 'google', nonce: 'rn-9', startedAt: now, expiresAt: now + PENDING_RESTORE_TTL_MS,
        });
        renderRestore({ authReturn: readAuthReturn('/app/auth/google', `#state=rn-9&id_token=${fakeJwt({ sub: 's', nonce: 'rn-9' })}`) });
        const notice = await screen.findByTestId('join-notice');
        expect(notice.textContent).toBe(xx("That {provider} account isn't a way back into {name}. Try the sign-in you joined with, or your 12 words.").replace('{provider}', 'Google').replace('{name}', 'Alice'));
        allThroughWords();
    });
});

describe('a re-key code (WebRekey) in the pseudo-locale', () => {
    function deps(answer: unknown): WebRekeyDeps {
        return {
            loadIdentity: async () => null,
            loadPendingJoin: async () => null,
            markPendingJoinSent: async (p: never, at: number) => ({ ...(p as object), sentAt: at }),
            completePendingJoin: async () => {},
            releaseSentPendingJoin: async () => ({ released: true, pending: null }),
            signReEnrollAsk: async () => ({ signature: 's', signedFor: 'f' }),
            signedFetchWithKey: async () => json(200, answer),
        } as unknown as WebRekeyDeps;
    }

    it('the form, a code that is not whole, the number to show the admin, and an admin who said no', async () => {
        await showIn('xx');
        render(<WebRekey onBound={vi.fn()} onBack={vi.fn()} deps={deps({ state: 'waiting', match: '42' })} />);
        allThroughWords(['RK-XXXX-XXXX'], 4);
        fireEvent.change(screen.getByLabelText(xx('The code')), { target: { value: 'RK-12' } });
        fireEvent.click(screen.getByRole('button', { name: xx('Continue') }));
        expect(screen.getByRole('alert').textContent).toBe(xx('That isn’t a whole re-key code. It starts RK- and has eight letters and numbers.'));
        fireEvent.change(screen.getByLabelText(xx('The code')), { target: { value: 'RK-AB12-CD34' } });
        fireEvent.click(screen.getByRole('button', { name: xx('Continue') }));
        expect(await screen.findByTestId('web-rekey-number')).toHaveTextContent('42');
        allThroughWords([window.location.host]);
        cleanup();

        render(<WebRekey initialCode="RK-AB12-CD34" onBound={vi.fn()} onBack={vi.fn()} deps={deps({ state: 'declined' })} />);
        fireEvent.click(screen.getByRole('button', { name: xx('Continue') }));
        expect((await screen.findByRole('alert')).textContent).toBe(xx('Your admin said this device isn’t yours, so nothing changed. Ask them to try again with you there.'));
        allThroughWords(['RK-XXXX-XXXX']);
    });
});

describe('adding a sign-in (OneWayBack AddSignIn) in the pseudo-locale', () => {
    it('the button, the sign-ins offered, a community that takes none, and why', async () => {
        await showIn('xx');
        stubNode({ '/api/join/link/sso-nonce': () => nonceAnswer() });
        render(<AddSignIn identity={identity} navigate={vi.fn()} origin={ORIGIN} />);
        allThroughWords();
        fireEvent.click(screen.getByTestId('add-sign-in-start'));
        expect(await screen.findByTestId('add-sign-in-google')).toBeInTheDocument();
        allThroughWords();
        cleanup();

        stubNode({ '/api/join/link/sso-nonce': () => json(404, {}) });
        render(<AddSignIn identity={identity} navigate={vi.fn()} origin={ORIGIN} />);
        fireEvent.click(screen.getByTestId('add-sign-in-start'));
        expect((await screen.findByTestId('add-sign-in-problem')).textContent).toBe(xx("This community doesn't take sign-ins right now."));
        allThroughWords();
    });
});
