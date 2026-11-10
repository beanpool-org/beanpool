/**
 * A local community's public card on the welcome page and the shared post's page (front doors S15; the shared-listing
 * door A1, DESIGN-shared-listing-door-fable.md §2.1, §2.3): what it says and where each door goes. Ask to join opens the
 * form right here and asks THIS community, at its own address; the key is written to the browser only when Send is
 * tapped. As the node's own page at `/` has them (apps/server routes/community-card.ts, test-community-card.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readCommunityCard, type CommunityCard } from '@beanpool/core';

const apiMocks = vi.hoisted(() => ({ getNodeApiUrl: vi.fn(() => 'https://castlemaine.beanpool.org') }));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), ...apiMocks }));

import { CommunityCardPanel } from './CommunityCardPanel';
import { askDoor, lookAroundUrl, setAccountHint, takeWelcomeDoor, ACCOUNT_HINT_COOKIE } from '../lib/community-card';
import { loadIdentity } from '../lib/identity';
import { KNOCK_KEY_STORE } from '../lib/knock-key';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { hearNodeVersionForTests, resetNodeVersionGateForTests } from '../lib/node-version-gate';

const CARD: CommunityCard = {
    name: 'Castlemaine BeanPool', host: 'castlemaine.beanpool.org', members: 9,
    area: { name: 'Castlemaine and around', radiusKm: 15 }, joining: 'requests',
    askUrl: 'https://castlemaine.beanpool.org/app?door=ask', globalUrl: 'https://global.beanpool.org',
};
/** A self-hoster's node: its own domain, no global community, not in our directory. */
const SELF_HOSTED: CommunityCard = { ...CARD, name: 'Riverbend Commons', host: 'pool.riverbend.example', askUrl: 'https://pool.riverbend.example/app?door=ask', globalUrl: null };
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const NOTE = 'Makes your account here and sends your request to Castlemaine BeanPool. Its members decide. No invite needed.';

type Call = { url: string; init: RequestInit };
let calls: Call[];
beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    localStorage.clear();
    calls = [];
    // Every fetch is read: the communities are heard new enough, so the version gate's own read is not among them.
    resetNodeVersionGateForTests();
    for (const community of ['https://castlemaine.beanpool.org', 'https://pool.riverbend.example']) hearNodeVersionForTests(community);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/api/join/knock')) return new Response(JSON.stringify({ knock: { status: 'pending' } }), { status: 201 });
        return new Response('{}', { status: 404 });
    }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

const noop = () => {};

describe('the card', () => {
    it('names the community, says its members, its area, that it takes requests; Ask to join and its line; Look around with ?ask=', () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(DESKTOP);
        render(<CommunityCardPanel card={CARD} onSignIn={noop} ask={{ onAsked: noop }} />);
        expect(screen.getByRole('heading', { name: 'Castlemaine BeanPool' })).toBeTruthy();
        expect(screen.getByTestId('community-card-members').textContent).toBe('9 members');
        expect(screen.getByTestId('community-card-area').textContent).toBe('Castlemaine and around, within about 15 km');
        expect(screen.getByTestId('community-card-joining').textContent).toBe('Takes requests to join');
        const ask = screen.getByTestId('community-card-ask');
        expect(ask.tagName).toBe('BUTTON');
        expect(ask.textContent).toBe('Ask to join');
        expect(screen.getByTestId('community-card-ask-note').textContent).toBe(NOTE);
        expect(screen.queryByText(/Look around global first/)).toBeNull();
        expect(screen.queryByText(/join there to get an account/)).toBeNull();
        expect(screen.getByTestId('community-card-global').getAttribute('href')).toBe('https://global.beanpool.org/?ask=castlemaine.beanpool.org');
    });

    it('Already a member opens the ways back', () => {
        const onSignIn = vi.fn();
        render(<CommunityCardPanel card={CARD} onSignIn={onSignIn} />);
        fireEvent.click(screen.getByTestId('community-card-signin'));
        expect(onSignIn).toHaveBeenCalledTimes(1);
    });

    it('nothing it was not sent: no member count, no area, "by invite" and no Ask to join', () => {
        render(<CommunityCardPanel card={{ ...CARD, members: null, area: null, joining: 'invite', askUrl: null }} onSignIn={noop} ask={{ onAsked: noop }} />);
        expect(screen.queryByTestId('community-card-members')).toBeNull();
        expect(screen.queryByTestId('community-card-area')).toBeNull();
        expect(screen.getByTestId('community-card-joining').textContent).toBe('Takes new members by invite');
        expect(screen.queryByTestId('community-card-ask')).toBeNull();
        expect(screen.queryByTestId('community-card-ask-note')).toBeNull();
    });

    it('compact (from the card\'s own "I have an invite"): the name and facts, no doors', () => {
        render(<CommunityCardPanel card={CARD} onSignIn={noop} ask={{ onAsked: noop }} compact />);
        expect(screen.getByRole('heading', { name: 'Castlemaine BeanPool' })).toBeTruthy();
        expect(screen.queryByTestId('community-card-ask')).toBeNull();
        expect(screen.queryByTestId('community-card-signin')).toBeNull();
    });

    it('a community with no name of its own shows its host', () => {
        render(<CommunityCardPanel card={{ ...CARD, name: null }} onSignIn={noop} />);
        expect(screen.getByRole('heading', { name: 'castlemaine.beanpool.org' })).toBeTruthy();
    });

    it('on an Android phone at the bare card: Ask to join opens the app, "or ask here in your browser" opens the form', () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID);
        render(<CommunityCardPanel card={CARD} onSignIn={noop} ask={{ onAsked: noop }} />);
        expect(screen.getByTestId('community-card-ask-app').getAttribute('href')).toContain('S.browser_fallback_url=' + encodeURIComponent(CARD.askUrl!));
        expect(screen.getByTestId('community-card-ask').textContent).toBe('or ask here in your browser');
        fireEvent.click(screen.getByTestId('community-card-ask'));
        expect(screen.getByTestId('community-card-ask-form-form')).toBeTruthy();
    });

    it('/app?door=ask (the card\'s fallback lands here): the form is open, never the app link again', () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID);
        render(<CommunityCardPanel card={CARD} onSignIn={noop} ask={{ onAsked: noop, open: true }} />);
        expect(screen.getByTestId('community-card-ask-form-form')).toBeTruthy();
        expect(screen.queryByTestId('community-card-ask-app')).toBeNull();
        expect(screen.getByRole('heading', { name: 'Ask to join Castlemaine BeanPool' })).toBeTruthy();
    });
});

describe('Ask to join from the browser', () => {
    it('the key is written to this browser only on Send, then the knock goes to this community, signed by it, with toNode', async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(DESKTOP);
        const onAsked = vi.fn();
        render(<CommunityCardPanel card={CARD} onSignIn={noop} ask={{ onAsked }} />);
        fireEvent.click(screen.getByTestId('community-card-ask'));
        fireEvent.change(screen.getByTestId('community-card-ask-form-name'), { target: { value: 'Sam' } });
        fireEvent.change(screen.getByTestId('community-card-ask-form-message'), { target: { value: 'I read the ladder listing.' } });
        // Open and typed in: nothing in this browser yet, nothing sent.
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(await loadIdentity()).toBeNull();
        expect(localStorage.getItem(KNOCK_KEY_STORE)).toBeNull();
        expect(calls.filter(c => c.url.includes('/api/join/knock'))).toHaveLength(0);

        fireEvent.click(screen.getByTestId('community-card-ask-form-send'));
        await waitFor(() => expect(onAsked).toHaveBeenCalledTimes(1));
        const stored = await loadIdentity();
        expect(stored?.callsign).toBe('Sam');
        expect(stored?.mnemonic).toHaveLength(12);
        expect(localStorage.getItem(KNOCK_KEY_STORE)).toBe(stored!.publicKey);
        expect(onAsked.mock.calls[0][0].publicKey).toBe(stored!.publicKey);
        const knock = calls.find(c => c.url.endsWith('/api/join/knock'))!;
        expect(knock.url).toBe('https://castlemaine.beanpool.org/api/join/knock');
        expect((knock.init.headers as Record<string, string>)['X-Public-Key']).toBe(stored!.publicKey);
        expect(JSON.parse(String(knock.init.body))).toMatchObject({ callsign: 'Sam', message: 'I read the ladder listing.', toNode: 'castlemaine.beanpool.org' });
        // Remembered for the waiting page: this community, by name.
        const remembered = JSON.parse(localStorage.getItem('beanpool_knocks')!);
        expect(remembered).toMatchObject({ pubkey: stored!.publicKey, knocks: [{ url: 'https://castlemaine.beanpool.org', name: 'Castlemaine BeanPool' }] });
    });

    it('Cancel on the form writes nothing', async () => {
        render(<CommunityCardPanel card={CARD} onSignIn={noop} ask={{ onAsked: noop }} />);
        fireEvent.click(screen.getByTestId('community-card-ask'));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByTestId('community-card-ask-form-form')).toBeNull();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(await loadIdentity()).toBeNull();
    });

    it("a Send that didn't go through, then Cancel and Ask to join again: the same key signs, never a second one (review 4508428755)", async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(DESKTOP);
        let first = true;
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
            calls.push({ url: String(url), init });
            if (String(url).endsWith('/api/join/knock')) {
                if (first) { first = false; throw new TypeError('Failed to fetch'); }
                return new Response(JSON.stringify({ knock: { status: 'pending' } }), { status: 201 });
            }
            return new Response('{}', { status: 404 });
        }));
        const onAsked = vi.fn();
        render(<CommunityCardPanel card={CARD} onSignIn={noop} ask={{ onAsked }} />);
        fireEvent.click(screen.getByTestId('community-card-ask'));
        fireEvent.change(screen.getByTestId('community-card-ask-form-name'), { target: { value: 'Sam' } });
        fireEvent.change(screen.getByTestId('community-card-ask-form-message'), { target: { value: 'I read the ladder listing.' } });
        fireEvent.click(screen.getByTestId('community-card-ask-form-send'));
        await screen.findByTestId('community-card-ask-form-problem');
        // Saved and marked at Send, and kept: the knock may be sent again with it.
        const kept = (await loadIdentity())!;
        expect(localStorage.getItem(KNOCK_KEY_STORE)).toBe(kept.publicKey);

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        fireEvent.click(screen.getByTestId('community-card-ask'));
        // The name it asked with is there again; the words are typed again.
        await waitFor(() => expect((screen.getByTestId('community-card-ask-form-name') as HTMLInputElement).value).toBe('Sam'));
        fireEvent.change(screen.getByTestId('community-card-ask-form-message'), { target: { value: 'I read the ladder listing.' } });
        fireEvent.click(screen.getByTestId('community-card-ask-form-send'));
        await waitFor(() => expect(onAsked).toHaveBeenCalledTimes(1));
        expect(screen.queryByText('This browser already has an account, so the request was not sent.')).toBeNull();
        expect(onAsked.mock.calls[0][0].publicKey).toBe(kept.publicKey);
        const knocks = calls.filter(c => c.url.endsWith('/api/join/knock'));
        expect(knocks).toHaveLength(2);
        expect(knocks.map(k => (k.init.headers as Record<string, string>)['X-Public-Key'])).toEqual([kept.publicKey, kept.publicKey]);
        expect((await loadIdentity())?.publicKey).toBe(kept.publicKey);
        expect(localStorage.getItem(KNOCK_KEY_STORE)).toBe(kept.publicKey);
    });

    it("a self-hoster's card with no global link: Ask works, at its own address, and nothing links to us", async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(DESKTOP);
        apiMocks.getNodeApiUrl.mockReturnValue('https://pool.riverbend.example');
        const onAsked = vi.fn();
        const { container } = render(<CommunityCardPanel card={SELF_HOSTED} onSignIn={noop} ask={{ onAsked }} />);
        expect(screen.queryByTestId('community-card-global')).toBeNull();
        expect(container.innerHTML).not.toMatch(/beanpool\.org/);
        fireEvent.click(screen.getByTestId('community-card-ask'));
        fireEvent.change(screen.getByTestId('community-card-ask-form-name'), { target: { value: 'Sam' } });
        fireEvent.change(screen.getByTestId('community-card-ask-form-message'), { target: { value: 'Hello.' } });
        fireEvent.click(screen.getByTestId('community-card-ask-form-send'));
        await waitFor(() => expect(onAsked).toHaveBeenCalledTimes(1));
        expect(calls.map(c => new URL(c.url).host)).toEqual(['pool.riverbend.example']);
        expect(container.innerHTML).not.toMatch(/beanpool\.org/);
        apiMocks.getNodeApiUrl.mockReturnValue('https://castlemaine.beanpool.org');
    });
});

describe('where Ask to join goes', () => {
    it("on Android: the app's card screen, falling back to this community's own ask door", () => {
        expect(askDoor(CARD, true)).toEqual({
            href: 'intent://community-card?node=https%3A%2F%2Fcastlemaine.beanpool.org#Intent;scheme=beanpool;package=org.beanpool.pillar;'
                + `S.browser_fallback_url=${encodeURIComponent('https://castlemaine.beanpool.org/app?door=ask')};end`,
        });
    });
    it('elsewhere: the form here (no link); a community that takes no requests: nowhere', () => {
        expect(askDoor(CARD, false)).toEqual({ href: null });
        expect(askDoor(SELF_HOSTED, false)).toEqual({ href: null });
        expect(askDoor({ ...CARD, joining: 'invite' }, false)).toBeNull();
        expect(askDoor({ ...CARD, joining: 'open' }, true)).toBeNull();
    });
    it('Look around the global community carries ?ask=<host>, built through URL', () => {
        expect(lookAroundUrl(CARD)).toBe('https://global.beanpool.org/?ask=castlemaine.beanpool.org');
        expect(lookAroundUrl({ ...CARD, globalUrl: 'https://lobby.example.net/lobby/?a=b#top' })).toBe('https://lobby.example.net/lobby/?ask=castlemaine.beanpool.org');
        expect(lookAroundUrl(SELF_HOSTED)).toBeNull();
    });
});

describe("a node's answer, read as a card", () => {
    it('keeps the fields, drops anything else, and takes only https links', () => {
        const read = readCommunityCard({ ...CARD, extra: 'x', askUrl: 'javascript:alert(1)', globalUrl: 'http://global.example' });
        expect(read).toEqual({ ...CARD, askUrl: null, globalUrl: null });
        expect(readCommunityCard({ ...CARD, joining: 'maybe' })).toBeNull();
        expect(readCommunityCard({ ...CARD, host: 'evil.example/path', members: -1 })).toMatchObject({ host: null, members: null });
        expect(readCommunityCard(null)).toBeNull();
    });
});

describe('the hint the node reads at its bare address', () => {
    it('set while an account is kept here, cleared at sign-out: "1" and nothing else', () => {
        const doc = { cookie: '' };
        setAccountHint(true, doc, true);
        expect(doc.cookie).toBe(`${ACCOUNT_HINT_COOKIE}=1; Path=/; Max-Age=34560000; SameSite=Lax; Secure`);
        setAccountHint(false, doc, true);
        expect(doc.cookie).toBe(`${ACCOUNT_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`);
    });

    it("the card's ?door= opens the welcome page there, once, and leaves the address", () => {
        const replaced: string[] = [];
        const win = (search: string) => ({
            location: { search, pathname: '/app', hash: '' } as Location,
            history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); } } as unknown as History,
        });
        expect(takeWelcomeDoor(win('?door=invite'))).toBe('invite');
        expect(takeWelcomeDoor(win('?door=signin&lang=es'))).toBe('signin');
        expect(takeWelcomeDoor(win('?door=ask'))).toBe('ask');
        expect(takeWelcomeDoor(win('?door=elsewhere'))).toBeNull();
        expect(takeWelcomeDoor(win(''))).toBeNull();
        expect(replaced).toEqual(['/app', '/app?lang=es', '/app', '/app']);
    });
});
