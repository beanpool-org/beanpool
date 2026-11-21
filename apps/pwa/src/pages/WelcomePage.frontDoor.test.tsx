/**
 * The web's front door, Your invite and Your name (DESIGN-onboarding-home-landing-fable.md §5, slice W1; Marty, 21 Nov 2026:
 * "Yes, all of Fable's picks", and "a standard people are used to rather than a long page"). The phone's first screens in
 * the same words and order: I have an invite, No invite? Look around, I've used BeanPool before, More ways in ›. The front
 * door has no dot; Your name is the first of the join's dots.
 *
 * One row per way in the brief names (an invite link, a typed code, look around, I've used BeanPool before), each walked
 * on the real page with a stubbed node, then drawn at 320 px with 130 % text in light, Classic dark and Dark. Carries the
 * cases of the screens it replaces: "Used BeanPool before?" (the ways back, best first, and Start a new account instead)
 * and the community card's doors (its ?door=invite, ?door=signin and ?door=ask, its Look around, its rule).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { brandColours, brandGrounds, contrastRatio, type BrandSet } from '@beanpool/core';
import { WelcomePage } from './WelcomePage';
import { loadIdentity } from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { GLOBAL_COMMUNITY_URL } from '../components/MembersOnlyListings';
import { frontDoor, inviteThenName, photoNext, pressJoin, typeInvite, typeName } from './welcome-join.test-support';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const LOCAL = { memberCount: 9, postCount: 3, transactionCount: 6, commonsBalance_c: 0, profile: 'local', features: { door: 'members' } };
const CARD = {
    name: 'Riverside Commons', host: 'riverside.example', members: 9, area: { name: 'Riverside and around', radiusKm: 15 },
    joining: 'requests', askUrl: 'https://open.example/?ask=riverside.example', globalUrl: 'https://open.example',
};
const CODE = 'BP-7K3X-9M2W';
const RULE = { known: true, knownFloor: 100000, debtLinePct: 50, quietDays: 60, ruleFrom: '2026-11-16T04:00:00.000Z', debtLineFrom: null, quietDaysFrom: null };

type Stub = { card?: unknown; check?: unknown; rule?: unknown };
function stubNode({ card = CARD, check = { valid: true, inviterCallsign: 'Asha', communityName: 'Riverside Commons' }, rule = 404 }: Stub = {}) {
    const asked: Array<{ path: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        asked.push({ path, method: init.method ?? 'GET' });
        if (path === '/api/community/info') return json(200, LOCAL);
        if (path === '/api/community/card') {
            if (card instanceof Promise) return card;
            return card === 404 ? json(404, { error: 'Not Found' }) : json(200, card);
        }
        if (path.startsWith('/api/invite/check')) return check === 'down' ? Promise.reject(new TypeError('Failed to fetch')) : json(200, check);
        if (path === '/api/community/known-rule') return rule === 404 ? json(404, { error: 'Not found' }) : json(200, rule);
        if (path === '/api/invite/redeem') return json(200, { success: true, member: {} });
        return json(404, { error: 'Not Found' });
    }));
    return asked;
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/');
    document.documentElement.classList.remove('dark');
    document.documentElement.style.fontSize = '';
});

const posts = (asked: Array<{ method: string }>) => asked.filter((a) => a.method !== 'GET').length;
const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the front door', () => {
    it("the phone's words in the phone's order, no dot, and More ways in where this community offers something", async () => {
        stubNode();
        render(<WelcomePage onComplete={vi.fn()} onAsked={vi.fn()} />);
        const door = await frontDoor();
        expect(within(door).getByRole('heading', { name: 'BeanPool' })).toBeInTheDocument();
        expect(door).toHaveTextContent('Trade skills, goods and favours with your neighbours.');
        const invite = screen.getByTestId('front-door-invite');
        const look = await screen.findByTestId('front-door-look-around');
        const before = screen.getByTestId('front-door-used-before');
        expect([invite.textContent, look.textContent, before.textContent]).toEqual(['I have an invite', 'No invite? Look around', "I've used BeanPool before"]);
        expect(follows(invite, look) && follows(look, before)).toBe(true);
        expect(screen.queryByTestId('step-dots')).toBeNull();
        // The long page's parts are gone: the FAQ, the restore box, the old question.
        expect(screen.queryByText(/Frequently Asked Questions/)).toBeNull();
        expect(screen.queryByText('Used BeanPool before?')).toBeNull();
        expect(screen.queryByLabelText('Invite link or code')).toBeNull();
        fireEvent.click(await screen.findByTestId('front-door-more'));
        expect(within(screen.getByTestId('front-door-more-sheet')).getByTestId('welcome-ask-to-join')).toHaveTextContent('Ask a community to join');
    });

    it('a community that takes no requests: no More ways in', async () => {
        stubNode({ card: { ...CARD, joining: 'invite' } });
        render(<WelcomePage onComplete={vi.fn()} onAsked={vi.fn()} />);
        await screen.findByTestId('front-door-look-around');
        expect(screen.queryByTestId('front-door-more')).toBeNull();
    });

    it("More ways in › Ask a community to join: this community's own request form, and back", async () => {
        stubNode();
        render(<WelcomePage onComplete={vi.fn()} onAsked={vi.fn()} />);
        fireEvent.click(await screen.findByTestId('front-door-more'));
        fireEvent.click(screen.getByTestId('welcome-ask-to-join'));
        expect(await screen.findByTestId('welcome-ask-form')).toBeInTheDocument();
    });

    it("the card's ?door=ask opens on the request form; ?door=signin on the ways back; ?door=invite on Your invite; each leaves the address", async () => {
        stubNode();
        window.history.replaceState(null, '', '/app?door=ask');
        render(<WelcomePage onComplete={vi.fn()} onAsked={vi.fn()} />);
        expect(await screen.findByTestId('welcome-ask-form')).toBeInTheDocument();
        expect(window.location.search).toBe('');
        cleanup();

        window.history.replaceState(null, '', '/app?door=signin');
        render(<WelcomePage onComplete={vi.fn()} />);
        expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
        expect(window.location.search).toBe('');
        cleanup();

        window.history.replaceState(null, '', '/app?door=invite');
        render(<WelcomePage onComplete={vi.fn()} />);
        expect(await screen.findByTestId('your-invite')).toBeInTheDocument();
        await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Invite link or code')));
        expect(window.location.search).toBe('');
    });
});

describe('the four ways in', () => {
    it('an invite link: straight to Your name, greeted by who invited and to where, the first of three dots', async () => {
        stubNode();
        window.history.replaceState(null, '', `/app?invite=${CODE}`);
        render(<WelcomePage onComplete={vi.fn()} />);
        const band = await screen.findByTestId('invite-greeting');
        await waitFor(() => expect(band).toHaveTextContent('Asha invited you to Riverside Commons'));
        expect(screen.queryByTestId('front-door')).toBeNull();
        expect(screen.getByTestId('step-dots-steps')).toHaveTextContent('Step 1 of 3');
        expect(screen.getAllByTestId('step-dots-on')).toHaveLength(1);
        expect(screen.getAllByTestId('step-dots-off')).toHaveLength(2);
        expect(screen.getByLabelText('What should we call you?')).toHaveAttribute('placeholder', 'Your name or nickname');
        expect(screen.getByText('You can change it later.')).toBeInTheDocument();
        expect(screen.getByTestId('name-step-join')).toHaveTextContent('Join');
        // The pencil: Your invite, the code in its box.
        fireEvent.click(screen.getByRole('button', { name: 'Change the invite' }));
        expect(screen.getByLabelText('Invite link or code')).toHaveValue(CODE);
    });

    it("a typed code: I have an invite, Your invite's box, Next, Your name; an empty box says what it needs", async () => {
        const asked = stubNode({ check: { valid: true, communityName: 'Riverside Commons' } });
        render(<WelcomePage onComplete={vi.fn()} />);
        fireEvent.click(await screen.findByTestId('front-door-invite'));
        expect(screen.getByRole('heading', { name: 'Your invite' })).toBeInTheDocument();
        expect(screen.getByText('Have the link? Tap it again.')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('your-invite-next'));
        expect(screen.getByTestId('your-invite-note')).toHaveTextContent('An invite code is required to join this node.');
        typeInvite(CODE);
        expect(screen.queryByTestId('your-invite-note')).toBeNull();
        fireEvent.click(screen.getByTestId('your-invite-next'));
        // No inviter in the answer: the community alone.
        await waitFor(() => expect(screen.getByTestId('invite-greeting')).toHaveTextContent("You're invited to Riverside Commons"));
        expect(posts(asked)).toBe(0);
        // ‹ goes back to the front door.
        fireEvent.click(screen.getByTestId('step-dots-back'));
        expect(await frontDoor()).toBeInTheDocument();
    });

    it("the invite check doesn't answer: You're invited, and Join works", async () => {
        stubNode({ check: 'down' });
        render(<WelcomePage onComplete={vi.fn()} />);
        await inviteThenName(CODE);
        expect(screen.getByTestId('invite-greeting')).toHaveTextContent("You're invited");
        expect(screen.getByTestId('invite-greeting')).not.toHaveTextContent('Riverside');
        typeName('Rowan');
        pressJoin();
        expect(await screen.findByText('Choose your look')).toBeInTheDocument();
    });

    it("look around: the global community this community names, with ?ask=; at a node too old to send a card, BeanPool's global community; nothing while the card is on its way", async () => {
        stubNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        expect(await screen.findByTestId('front-door-look-around')).toHaveAttribute('href', 'https://open.example/?ask=riverside.example');
        cleanup();

        stubNode({ card: 404 });
        render(<WelcomePage onComplete={vi.fn()} />);
        expect(await screen.findByTestId('front-door-look-around')).toHaveAttribute('href', GLOBAL_COMMUNITY_URL);
        cleanup();

        stubNode({ card: new Promise(() => {}) });
        render(<WelcomePage onComplete={vi.fn()} />);
        await frontDoor();
        expect(screen.queryByTestId('front-door-look-around')).toBeNull();
    });

    it("look around over the lobby: back to the lobby's listings", async () => {
        stubNode();
        const onBack = vi.fn();
        render(<WelcomePage onComplete={vi.fn()} onBack={onBack} />);
        fireEvent.click(await screen.findByTestId('front-door-look-around'));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("I've used BeanPool before: the ways back, sign-in first, then the 12 words, then an admin's code; Back to the front door", async () => {
        stubNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        fireEvent.click(await screen.findByTestId('front-door-used-before'));
        expect(screen.getByText('Sign in to your account')).toBeInTheDocument();
        const signIn = screen.getByTestId('member-restore-signin');
        const words = screen.getByRole('button', { name: /Recover with 12 Words/ });
        const rekey = screen.getByRole('button', { name: /An admin gave me a re-key code/ });
        expect(follows(signIn, words) && follows(words, rekey)).toBe(true);
        fireEvent.click(words);
        expect(screen.queryByText('Sign in to your account')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Back to Restore Options|← Back/ }));
        expect(await screen.findByText('Sign in to your account')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '← Back' }));
        expect(await frontDoor()).toBeInTheDocument();
    });

    it('Start a new account instead: said plainly, opens Your invite, makes nothing and sends nothing', async () => {
        const asked = stubNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        fireEvent.click(await screen.findByTestId('front-door-used-before'));
        expect(screen.getByTestId('start-new-instead')).toHaveTextContent("Can't bring your account back? You can start again, but that makes a new account. Your old account stays as it is, and the two can never be joined into one.");
        fireEvent.click(screen.getByTestId('start-new-instead-button'));
        expect(await screen.findByTestId('your-invite')).toBeInTheDocument();
        expect(posts(asked)).toBe(0);
        expect(await loadIdentity()).toBeNull();
    });
});

describe("the community's rule on Your name", () => {
    it('rule on: its lines above Join, and nothing to tick; rule off: none', async () => {
        stubNode({ rule: RULE });
        render(<WelcomePage onComplete={vi.fn()} />);
        await inviteThenName(CODE);
        const rule = await screen.findByTestId('join-rule');
        expect(follows(rule, screen.getByTestId('name-step-join'))).toBe(true);
        expect(rule.querySelector('input')).toBeNull();
        cleanup();

        stubNode();
        render(<WelcomePage onComplete={vi.fn()} />);
        await inviteThenName(CODE);
        expect(screen.queryByTestId('join-rule')).toBeNull();
    });
});

describe('How it Works left the join', () => {
    it('name, photo, the way back, in: three dots, and the way back goes in with no tour', async () => {
        stubNode();
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        await inviteThenName(CODE);
        typeName('Rowan');
        pressJoin();
        await screen.findByText('Choose your look');
        expect(screen.getByTestId('step-dots-steps')).toHaveTextContent('Step 2 of 3');
        // No picture: Skip for now, and the community's line (it asks for one before a post).
        expect(screen.getByTestId('photo-step-next')).toHaveTextContent('Skip for now');
        expect(screen.getByTestId('photo-step-note')).toHaveTextContent('This community asks for a picture before you post.');
        // Choose a picture holds a photo or an avatar.
        expect(screen.queryByTitle('Green Bean')).toBeNull();
        fireEvent.click(screen.getByTestId('photo-step-choose'));
        expect(screen.getByRole('button', { name: /Camera/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Gallery/ })).toBeInTheDocument();
        fireEvent.click(screen.getByTitle('Green Bean'));
        expect(screen.getByTestId('photo-step-next')).toHaveTextContent('Next');
        expect(screen.queryByTestId('photo-step-note')).toBeNull();
        photoNext();
        await screen.findByTestId('backup-words');
        expect(screen.getByTestId('step-dots-steps')).toHaveTextContent('Step 3 of 3');
        fireEvent.click(screen.getByTestId('backup-next'));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(screen.queryByText(/How it Works|Let's Begin|Where to Start/)).toBeNull();
    });
});

/**
 * Drawn at 320 px with 130 % text (the old-phone floor, memory product-audience-small-screens). jsdom lays nothing out,
 * so what can push a 320 px page sideways is read off the elements: no fixed width wider than the screen, every label
 * free to wrap, every button at least a 48 px target. The colours are the central tokens' (brand-colours.ts) in each set.
 */
describe('drawn at 320 px with 130 % text, light and dark', () => {
    const SETS: BrandSet[] = ['light', 'dark', 'night'];

    function draw320(set: BrandSet) {
        window.innerWidth = 320;
        document.documentElement.style.fontSize = '130%';
        document.documentElement.classList.toggle('dark', set !== 'light');
    }

    function holds320(root: HTMLElement) {
        for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
            const w = el.style.width;
            if (w.endsWith('px')) expect(parseFloat(w), `${el.tagName} ${el.className}`).toBeLessThanOrEqual(288);
            expect(el.style.whiteSpace, el.textContent ?? '').not.toBe('nowrap');
        }
        for (const button of Array.from(root.querySelectorAll<HTMLElement>('button, a'))) {
            if (button.closest('[aria-hidden="true"]')) continue;
            expect(button.className, button.textContent ?? '').toMatch(/min-h-\[(4[48]|52)px\]|\bh-12\b|\bh-14\b/);
            if (button.textContent && button.textContent.trim().length > 3) expect(button.className, button.textContent).toMatch(/break-words/);
        }
    }

    for (const set of SETS) {
        it(`${set}: the front door, Your invite, Your name and the photo step hold, with their colours from the tokens`, async () => {
            draw320(set);
            stubNode();
            render(<WelcomePage onComplete={vi.fn()} />);
            holds320(await frontDoor());
            // The page and its card pad 1rem each side below 360 px, not 2rem (carried from the How it Works suite).
            for (const id of ['welcome-page', 'welcome-card']) {
                expect(screen.getByTestId(id).className.split(' ')).toEqual(expect.arrayContaining(['p-8', 'max-[359px]:px-4']));
            }
            await inviteThenName(CODE);
            holds320(screen.getByTestId('name-step'));
            typeName('Rowan');
            pressJoin();
            await screen.findByText('Choose your look');
            holds320(screen.getByTestId('photo-step-choose').parentElement!);

            const c = brandColours(set);
            const g = brandGrounds(set);
            // The block and the greeting band: white on the brand green, the same in every set.
            expect(contrastRatio(brandColours('light').commit.on, brandColours('light').commit.fill)).toBeGreaterThanOrEqual(4.5);
            // I have an invite: the call to action's words on its fill.
            expect(contrastRatio(c.cta.on, c.cta.fill)).toBeGreaterThanOrEqual(4.5);
            // The dots: the brand ink, 3:1 on the web's page and card.
            expect(contrastRatio(c.ink.brand, g.web.page)).toBeGreaterThanOrEqual(3);
            expect(contrastRatio(c.ink.brand, g.web.card)).toBeGreaterThanOrEqual(3);
        });
    }
});
