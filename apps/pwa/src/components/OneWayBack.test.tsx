/**
 * "Your account has one way back" (two-doors design §2.5, slice S5; DESIGN-home-default-fable.md §2.5): shown only when
 * the node's Home answer says the 12 words are the member's only way back (`me.wayBack`, or the 12-words door's
 * `cards.safety`) and they haven't said they still have them; on the landing screen it can be put away, comes back once
 * after a post that stays up and once when the first week is over, then lives in Settings only; in Settings it stays
 * until a sign-in is added or the member says they still have their words. Away from Home (Settings) the card asks for
 * that answer itself (`GET /api/home?cards=safety`). "Add a sign-in" asks the node which sign-ins it offers for this
 * member and leaves for the one chosen. Never a gate: nothing here blocks anything. The node is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as api from '../lib/api';
import type { HomeAnswer } from '../lib/home-cards';
import { generateIdentity, type BeanPoolIdentity } from '../lib/identity';
import { loadPendingLink } from '../lib/link-signin';
import { OneWayBackCard, ONE_WAY_BACK, ONE_WAY_BACK_WORDS } from './OneWayBack';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
    return { ...actual, getHome: vi.fn(), getCommunityMe: vi.fn() };
});

const DAY = 24 * 3600_000;

/**
 * The Home answer as routes/home-answer.ts sends it, for the member whose standing is named: `words`, the 12-words door's
 * own with no sign-in (`cards.safety`, `me.wayBack` words, probation on its words rules); `ordinary`, a member with a
 * sign-in's copy linked here (`wayBack` covered); undefined, an answer with neither (a node from before both). `where`:
 * the worldwide community by default (where the door's card says "one way back"), or a local one.
 */
function standing(rules: 'words' | 'ordinary' | undefined, keptPosts = 0, weekOver = false, where: 'global' | 'local' = 'global'): api.HomeRead {
    const joinedAt = new Date(Date.now() - (weekOver ? 8 : 1) * DAY).toISOString();
    const answer = {
        generatedAt: new Date().toISOString(), profile: where, features: {}, layout: null,
        me: {
            joinedAt, isKeeper: false, interests: [], area: null, firstOffer: false, standing: 'member',
            probation: rules ? { onProbation: true, rules, keptPosts, keptPostsNeeded: 3, ageEndsAt: null } : null,
            ...(rules === 'words' ? { wayBack: 'words', wordsKept: false } : rules === 'ordinary' ? { wayBack: 'covered', wordsKept: false } : {}),
        },
        cards: rules === 'words' ? { safety: { words: true, signInLinked: false } } : {},
    } as unknown as HomeAnswer;
    return { notModified: false, answer, etag: null };
}

/** The same answer for a member who came by invite and has no sign-in: words are their only way back, no `safety`. */
function invitedRead(over: { kept?: boolean; where?: 'global' | 'local' } = {}): api.HomeRead {
    const read = standing(undefined, 0, false, over.where ?? 'local') as Extract<api.HomeRead, { notModified: false }>;
    const me = { ...read.answer.me!, wayBack: 'words' as const, wordsKept: !!over.kept, probation: { onProbation: true, rules: 'ordinary' as const, keptPosts: 0, keptPostsNeeded: 3, ageEndsAt: null } };
    return { ...read, answer: { ...read.answer, me } };
}

/** The 12-words door's own member who said they still have their words: the node leaves `safety` out, its rules still say words. */
function doorKeptRead(where: 'global' | 'local' = 'global'): api.HomeRead {
    const read = standing('words', 0, false, where) as Extract<api.HomeRead, { notModified: false }>;
    return { ...read, answer: { ...read.answer, me: { ...read.answer.me!, wordsKept: true }, cards: {} } };
}

let identity: BeanPoolIdentity;
beforeEach(async () => {
    localStorage.clear();
    identity = await generateIdentity('Bea');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.mocked(api.getHome).mockReset();
});

describe('who it is for: the node says so', () => {
    it('a member who joined with 12 words and has no sign-in: the card, in the design\'s words', async () => {
        vi.mocked(api.getHome).mockResolvedValue(standing('words'));
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} />);
        expect(await screen.findByTestId('one-way-back-text')).toHaveTextContent(ONE_WAY_BACK);
        expect(ONE_WAY_BACK).toBe('Your account has one way back: your 12 words. Check you still have them, or add a sign-in.');
    });

    it('anyone else, a node that does not say, or no answer: nothing', async () => {
        const answers = [async () => standing('ordinary'), async () => standing(undefined), async () => { throw new Error('offline'); }];
        for (const answer of answers) {
            vi.mocked(api.getHome).mockImplementation(answer);
            render(<OneWayBackCard identity={identity} placement="settings" onSeeWords={() => {}} />);
            await waitFor(() => expect(api.getHome).toHaveBeenCalled());
            await new Promise((r) => setTimeout(r, 20));
            expect(screen.queryByTestId('one-way-back-settings')).toBeNull();
            cleanup();
            vi.mocked(api.getHome).mockClear();
        }
    });
});

// The parity read of D2 against D3 (row 11): after Home's two returns the design says "then Settings only" (§2.5), and the
// phone's Settings keeps the card for every member whose words are the only way back. The web's Settings asked `/me`,
// whose `rules` says how a member joined, so a member who came by invite had no reminder anywhere once Home's returns
// were over. Settings now reads the Home answer's `me`, as Home does.
describe('in Settings: every member whose words are the only way back, from the Home answer, as on the phone', () => {
    const settings = (onKept?: () => void) =>
        render(<OneWayBackCard identity={identity} placement="settings" onSeeWords={() => {}} onKept={onKept} />);

    it('asks the Home answer for this card alone, and never `/me`', async () => {
        vi.mocked(api.getHome).mockResolvedValue(invitedRead());
        settings();
        await screen.findByTestId('one-way-back-settings');
        expect(api.getHome).toHaveBeenCalledWith({ cards: ['safety'] });
        expect(api.getCommunityMe).not.toHaveBeenCalled();
    });

    it('a member who came by invite: the card, in the words for where an admin can set them up again, with only what works there', async () => {
        vi.mocked(api.getHome).mockResolvedValue(invitedRead());
        settings(vi.fn());
        const card = await screen.findByTestId('one-way-back-settings');
        expect(screen.getByRole('heading')).toHaveTextContent('Your way back in');
        expect(screen.getByTestId('one-way-back-text')).toHaveTextContent(ONE_WAY_BACK_WORDS.lineShort);
        expect(card.textContent).not.toContain('one way back');
        // The node takes no sign-in from them (404 invite_only): never offered.
        expect(screen.queryByTestId('add-sign-in')).toBeNull();
        expect(screen.getByTestId('one-way-back-words')).toBeInTheDocument();
        expect(screen.getByTestId('one-way-back-kept')).toHaveTextContent(ONE_WAY_BACK_WORDS.kept);
        // No "Hide this for now" in Settings: it stays until done.
        expect(screen.queryByRole('button', { name: 'Hide this for now' })).toBeNull();
    });

    it('"I still have my 12 words" in Settings: kept on the account (onKept), the card goes at once, and nothing is offered in its place', async () => {
        const onKept = vi.fn();
        vi.mocked(api.getHome).mockResolvedValue(invitedRead());
        settings(onKept);
        fireEvent.click(await screen.findByTestId('one-way-back-kept'));
        expect(onKept).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('one-way-back-settings')).toBeNull();
        expect(screen.queryByTestId('one-way-back-quiet')).toBeNull();
        cleanup();
        // The next visit: the account says so.
        vi.mocked(api.getHome).mockResolvedValue(invitedRead({ kept: true }));
        settings(onKept);
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(2));
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(screen.queryByTestId('one-way-back-settings')).toBeNull();
    });

    it('"One way back" only on the global community: the 12-words door\'s own member on a local one is told "how you get back in" (§2.5)', async () => {
        vi.mocked(api.getHome).mockResolvedValue(standing('words', 0, false, 'local'));
        settings(vi.fn());
        await screen.findByTestId('one-way-back-settings');
        expect(screen.getByRole('heading')).toHaveTextContent('Your way back in');
        expect(screen.getByTestId('one-way-back-text')).toHaveTextContent(ONE_WAY_BACK_WORDS.lineLocal);
        expect(screen.getByTestId('add-sign-in')).toBeInTheDocument();
        cleanup();
        vi.mocked(api.getHome).mockResolvedValue(standing('words', 0, false, 'global'));
        settings(vi.fn());
        await screen.findByTestId('one-way-back-settings');
        expect(screen.getByRole('heading')).toHaveTextContent('One way back');
        expect(screen.getByTestId('one-way-back-text')).toHaveTextContent(ONE_WAY_BACK);
    });

    it('the 12-words door\'s own member who said they still have them: no warning, a sign-in still offered quietly, as on the phone', async () => {
        const onKept = vi.fn();
        vi.mocked(api.getHome).mockResolvedValue(standing('words'));
        settings(onKept);
        fireEvent.click(await screen.findByTestId('one-way-back-kept'));
        expect(onKept).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('one-way-back-settings')).toBeNull();
        expect(screen.getByTestId('one-way-back-quiet')).toContainElement(screen.getByTestId('add-sign-in'));
        cleanup();
        // Said before (on Home, the phone, sign-up): the node leaves `safety` out; Settings still offers the sign-in quietly.
        vi.mocked(api.getHome).mockResolvedValue(doorKeptRead());
        settings(onKept);
        expect(await screen.findByTestId('one-way-back-quiet')).toContainElement(screen.getByTestId('add-sign-in'));
        expect(screen.queryByTestId('one-way-back-settings')).toBeNull();
    });
});

describe('on the landing screen: put away, it comes back twice, then lives in Settings only', () => {
    async function shown(s: api.HomeRead): Promise<boolean> {
        cleanup();
        vi.mocked(api.getHome).mockResolvedValue(s);
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} />);
        await waitFor(() => expect(api.getHome).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 20));
        return !!screen.queryByTestId('one-way-back-landing');
    }
    const hide = () => fireEvent.click(screen.getByRole('button', { name: 'Hide this for now' }));

    it('after their next post that stays up, and when the first week is over', async () => {
        expect(await shown(standing('words', 0))).toBe(true);
        hide();
        expect(screen.queryByTestId('one-way-back-landing')).toBeNull();
        expect(await shown(standing('words', 0))).toBe(false);
        // A post that stayed up: once more.
        expect(await shown(standing('words', 1))).toBe(true);
        hide();
        expect(await shown(standing('words', 2))).toBe(false);
        // The first week over: once more.
        expect(await shown(standing('words', 2, true))).toBe(true);
        hide();
        expect(await shown(standing('words', 5, true))).toBe(false);
        // Settings keeps it.
        cleanup();
        render(<OneWayBackCard identity={identity} placement="settings" onSeeWords={() => {}} />);
        expect(await screen.findByTestId('one-way-back-settings')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Hide this for now' })).toBeNull();
    });

    // The two returns are independent (design §2.5, the guide page): neither waits for the other (review 4161724137).
    it('put away with no post since: it still comes back when the first week is over, then once after a post', async () => {
        expect(await shown(standing('words', 0))).toBe(true);
        hide();
        expect(await shown(standing('words', 0))).toBe(false);
        // The week is over, and there has been no post: once more.
        expect(await shown(standing('words', 0, true))).toBe(true);
        hide();
        expect(await shown(standing('words', 0, true))).toBe(false);
        // Then a post that stayed up: once more, its own return.
        expect(await shown(standing('words', 1, true))).toBe(true);
        hide();
        expect(await shown(standing('words', 4, true))).toBe(false);
    });

    it('✕ always puts it away until the next return is due, even when both returns are due at once', async () => {
        expect(await shown(standing('words', 0))).toBe(true);
        hide();
        // A post stayed up, and the week is over too: one return, and ✕ puts it away for both.
        expect(await shown(standing('words', 1, true))).toBe(true);
        hide();
        expect(screen.queryByTestId('one-way-back-landing')).toBeNull();
        expect(await shown(standing('words', 1, true))).toBe(false);
        expect(await shown(standing('words', 3, true))).toBe(false);
    });

    it('first seen after the week is over: ✕ puts it away, and it comes back once after a post', async () => {
        expect(await shown(standing('words', 0, true))).toBe(true);
        hide();
        expect(screen.queryByTestId('one-way-back-landing')).toBeNull();
        expect(await shown(standing('words', 0, true))).toBe(false);
        expect(await shown(standing('words', 1, true))).toBe(true);
        hide();
        expect(await shown(standing('words', 2, true))).toBe(false);
    });

    it('"See my 12 words" opens them, and the landing card is done', async () => {
        const onSeeWords = vi.fn();
        vi.mocked(api.getHome).mockResolvedValue(standing('words'));
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={onSeeWords} />);
        fireEvent.click(await screen.findByTestId('one-way-back-words'));
        expect(onSeeWords).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('one-way-back-landing')).toBeNull();
        expect(await shown(standing('words', 3, true))).toBe(false);
    });
});

// On Home the Home answer alone says who the card is for, what works for them and its schedule's counts
// (lib/home-cards.ts wayBackOf, DESIGN-home-default-fable.md §2.5, slice D3), passed as `home`. `/me` is never asked there,
// so the card's first paint is what it settles on: no draw-then-pull (onDrawn [true, false], the jump PR #2411 fixed),
// no pop-in.
describe("on Home, the Home answer is the one word (`home`), and `/me` is never asked", () => {
    type Home = { forThem: boolean; canAddSignIn: boolean; startsAway: boolean; keptPosts: number; weekOverAt: number | null; global: boolean };
    const DOOR: Home = { forThem: true, canAddSignIn: true, startsAway: false, keptPosts: 0, weekOverAt: Date.now() + 6 * DAY, global: true };
    // A member who came by invite (or the genesis owner, or a sign-in joiner with no copy kept here): words only, no link.
    const INVITED: Home = { forThem: true, canAddSignIn: false, startsAway: true, keptPosts: 0, weekOverAt: Date.now() + 6 * DAY, global: false };
    const schedule = () => JSON.parse(localStorage.getItem(`beanpool_one_way_back_${identity.publicKey}`) || 'null');
    const landing = (home: Home, more: { onKept?: () => void; onDrawn?: (d: boolean) => void } = {}) =>
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={home} {...more} />);
    const card = () => screen.queryByTestId('one-way-back-landing');
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    it("the 12-words door's own member: drawn at the first paint, with a sign-in, in the open door's words", async () => {
        const drawn: boolean[] = [];
        landing(DOOR, { onDrawn: (d) => drawn.push(d) });
        expect(card()).toBeInTheDocument();
        expect(screen.getByTestId('one-way-back-text')).toHaveTextContent(ONE_WAY_BACK);
        expect(screen.getByTestId('add-sign-in')).toBeInTheDocument();
        await settle();
        expect(drawn).toEqual([true]);
        expect(api.getHome).not.toHaveBeenCalled();
    });

    it('the same member on a local community: "how you get back in", not "one way back" (an admin can set them up again)', () => {
        landing({ ...DOOR, global: false });
        expect(screen.getByTestId('one-way-back-text')).toHaveTextContent(ONE_WAY_BACK_WORDS.lineLocal);
        expect(screen.getByRole('heading')).toHaveTextContent('Your way back in');
        expect(screen.getByTestId('add-sign-in')).toBeInTheDocument();
    });

    it('an invited member on day one: not on Home (sign-up was its first showing; First steps says it), and /me is never asked', async () => {
        const drawn: boolean[] = [];
        landing(INVITED, { onDrawn: (d) => drawn.push(d) });
        expect(card()).toBeNull();
        await settle();
        expect(card()).toBeNull();
        expect(drawn).toEqual([false]);
        expect(api.getHome).not.toHaveBeenCalled();
        // Nothing is written for a card never shown.
        expect(schedule()).toBeNull();
    });

    it('an invited member: once after their first post, once when the first week is over, then never; and never a sign-in', async () => {
        const drawn: boolean[] = [];
        landing({ ...INVITED, keptPosts: 1 }, { onDrawn: (d) => drawn.push(d) });
        // At the first paint, not later: the counts are in Home's answer.
        expect(card()).toBeInTheDocument();
        expect(drawn).toEqual([true]);
        expect(screen.getByTestId('one-way-back-text')).toHaveTextContent(ONE_WAY_BACK_WORDS.lineShort);
        expect(screen.getByTestId('one-way-back-text')).not.toHaveTextContent('one way back');
        expect(screen.getByRole('heading')).toHaveTextContent('Your way back in');
        // "Add a sign-in" would be refused (404 invite_only, 409 not_words_member): never offered.
        expect(screen.queryByTestId('add-sign-in')).toBeNull();
        expect(screen.queryByText('Add a sign-in')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Hide this for now' }));
        expect(card()).toBeNull();
        expect(schedule()).toMatchObject({ dismissed: true, keptPostsAtDismissal: 0, postReturnShown: true, weekReturnShown: false });
        cleanup();
        // More posts: no third showing for posts.
        landing({ ...INVITED, keptPosts: 4 });
        expect(card()).toBeNull();
        cleanup();
        // The week is over: once more.
        landing({ ...INVITED, keptPosts: 4, weekOverAt: Date.now() - DAY });
        expect(card()).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Hide this for now' }));
        cleanup();
        landing({ ...INVITED, keptPosts: 9, weekOverAt: Date.now() - DAY });
        expect(card()).toBeNull();
        expect(api.getHome).not.toHaveBeenCalled();
    });

    it('"I still have my 12 words": kept on the account (onKept), and the card is done here at once', () => {
        const onKept = vi.fn();
        landing({ ...INVITED, keptPosts: 1 }, { onKept });
        fireEvent.click(screen.getByTestId('one-way-back-kept'));
        expect(onKept).toHaveBeenCalledTimes(1);
        expect(card()).toBeNull();
        expect(schedule()).toMatchObject({ checked: true });
        cleanup();
        landing({ ...INVITED, keptPosts: 3, weekOverAt: Date.now() - DAY }, { onKept });
        expect(card()).toBeNull();
    });

    it("Home's answer then says it is not for them (a sign-in linked, the words kept elsewhere): it goes", () => {
        const { rerender } = landing(DOOR);
        expect(card()).toBeInTheDocument();
        rerender(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={{ ...DOOR, forThem: false, canAddSignIn: false }} />);
        expect(card()).toBeNull();
    });

    it('not for them: nothing, first paint and after', async () => {
        const drawn: boolean[] = [];
        landing({ ...INVITED, forThem: false, keptPosts: 3, weekOverAt: Date.now() - DAY }, { onDrawn: (d) => drawn.push(d) });
        await settle();
        expect(card()).toBeNull();
        expect(drawn).toEqual([false]);
    });

    it('a ✕ an earlier visit kept before the counts came is settled by the counts in Home\'s answer', () => {
        localStorage.setItem(`beanpool_one_way_back_${identity.publicKey}`, JSON.stringify({ dismissed: true, awayBeforeCounts: Date.now() - DAY }));
        landing({ ...DOOR, keptPosts: 2 });
        expect(card()).toBeNull();
        expect(schedule()).toMatchObject({ dismissed: true, keptPostsAtDismissal: 2, awayBeforeCounts: null });
    });
});

describe('adding a sign-in from the card', () => {
    it("asks the node for this member's link nonce, offers its sign-ins, and leaves for the one chosen", async () => {
        vi.mocked(api.getHome).mockResolvedValue(standing('words'));
        const calls: Array<{ path: string; headers: Record<string, string> }> = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
            calls.push({ path: String(input), headers: (init.headers ?? {}) as Record<string, string> });
            return new Response(JSON.stringify({
                nonce: 'link-n', expiresInSeconds: 600, providers: ['google', 'apple', 'facebook'],
                clientIds: { google: 'web-client', apple: 'org.beanpool.web', facebook: null }, vault: null,
            }), { status: 200 });
        }));
        const navigate = vi.fn();
        render(<OneWayBackCard identity={identity} placement="settings" onSeeWords={() => {}} navigate={navigate} origin="https://global.beanpool.org" />);
        fireEvent.click(await screen.findByTestId('add-sign-in-start'));
        fireEvent.click(await screen.findByTestId('add-sign-in-google'));
        expect(screen.queryByTestId('add-sign-in-facebook')).toBeNull();
        expect(calls[0].path).toBe('/api/join/link/sso-nonce');
        expect(calls[0].headers['X-Public-Key']).toBe(identity.publicKey);
        const url = new URL(navigate.mock.calls[0][0]);
        expect(url.searchParams.get('state')).toBe('link-n');
        expect(loadPendingLink()).toMatchObject({ publicKey: identity.publicKey, provider: 'google', nonce: 'link-n' });
    });

    // Review 4162062801: the node keeps a nonce ten minutes; one held over five is asked for again before the trip, as
    // WebJoin does, so time spent reading (the tour) doesn't come back as a failed sign-in.
    it('a nonce held more than five minutes is fetched again before the trip; a fresh one is used as it is', async () => {
        vi.mocked(api.getHome).mockResolvedValue(standing('words'));
        let n = 0;
        const asked: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            asked.push(String(input));
            n++;
            return new Response(JSON.stringify({
                nonce: `link-${n}`, expiresInSeconds: 600, providers: ['google'], clientIds: { google: 'web-client' }, vault: null,
            }), { status: 200 });
        }));
        const t0 = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
        const navigate = vi.fn();
        render(<OneWayBackCard identity={identity} placement="settings" onSeeWords={() => {}} navigate={navigate} origin="https://global.beanpool.org" />);
        fireEvent.click(await screen.findByTestId('add-sign-in-start'));
        await screen.findByTestId('add-sign-in-google');
        // Six minutes on the page.
        clock.mockReturnValue(t0 + 6 * 60_000);
        fireEvent.click(screen.getByTestId('add-sign-in-google'));
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        expect(asked.filter((p) => p === '/api/join/link/sso-nonce')).toHaveLength(2);
        expect(new URL(navigate.mock.calls[0][0]).searchParams.get('state')).toBe('link-2');
        expect(loadPendingLink(t0 + 6 * 60_000)).toMatchObject({ nonce: 'link-2' });
        cleanup();
        localStorage.clear();

        // Four minutes: the one held goes.
        navigate.mockClear();
        asked.length = 0;
        clock.mockReturnValue(t0);
        render(<OneWayBackCard identity={identity} placement="settings" onSeeWords={() => {}} navigate={navigate} origin="https://global.beanpool.org" />);
        fireEvent.click(await screen.findByTestId('add-sign-in-start'));
        await screen.findByTestId('add-sign-in-google');
        clock.mockReturnValue(t0 + 4 * 60_000);
        fireEvent.click(screen.getByTestId('add-sign-in-google'));
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        expect(asked.filter((p) => p === '/api/join/link/sso-nonce')).toHaveLength(1);
        clock.mockRestore();
    });

    // Vault rethink VR2: where this community keeps no copies (its rule `none`), a sign-in only lifts the limits.
    it('where this community keeps no copies: the sign-in is said to lift the limits, never to lock a copy or be a way back', async () => {
        vi.mocked(api.getHome).mockResolvedValue(standing('words'));
        render(<OneWayBackCard identity={identity} placement="settings" onSeeWords={() => {}} keepsNoCopies
            result={{ kind: 'linked', provider: 'google', recoveryStored: false, noCopies: true }} />);
        const add = await screen.findByTestId('add-sign-in');
        expect(add).toHaveTextContent(ONE_WAY_BACK_WORDS.whyNoCopies);
        expect(ONE_WAY_BACK_WORDS.whyNoCopies).toBe("A sign-in with Google, Apple or Facebook only lifts the limits on new 12-words accounts. We keep only a scrambled reference to it, never your email or name from there. This community keeps no copies of members' accounts, so your 12 words are your way back.");
        expect(add).not.toHaveTextContent(/locks a copy|second way back/);
        expect(screen.getByTestId('link-result')).toHaveTextContent("This community keeps no copies of members' accounts, so your 12 words are still your way back.");
        cleanup();

        // Anywhere else, as before.
        render(<OneWayBackCard identity={identity} placement="settings" onSeeWords={() => {}} />);
        expect(await screen.findByTestId('add-sign-in')).toHaveTextContent(ONE_WAY_BACK_WORDS.why);
    });

    it("a refusal is a sentence beside the button; the result of one that came back is said", async () => {
        vi.mocked(api.getHome).mockResolvedValue(standing('words'));
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'This account already has a sign-in.', code: 'already_linked' }), { status: 409 })));
        render(<OneWayBackCard identity={identity} placement="settings" onSeeWords={() => {}}
            result={{ kind: 'failed', provider: 'google', message: "This Google account already has another BeanPool account here, so it can't be added to this one. Choose another sign-in." }} />);
        expect(screen.getByTestId('link-result')).toHaveTextContent('This Google account already has another BeanPool account here');
        fireEvent.click(await screen.findByTestId('add-sign-in-start'));
        expect(await screen.findByTestId('add-sign-in-problem')).toHaveTextContent('This account already has a sign-in.');
    });
});
