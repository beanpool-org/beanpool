/**
 * "Your way back in" (two-doors design §2.5; DESIGN-home-default-fable.md §2.5; DESIGN-notify-and-backup-asks-fable.md §5.2,
 * amend2 slice B2): shown only when the node's Home answer says the 12 words are the member's only way back (`me.wayBack`,
 * or the 12-words door's `cards.safety`) and no way back is kept; on the landing screen it follows core's schedule
 * (way-back-schedule.ts, the phone's rule): from the first landing after a join here that kept none, then at the first
 * Beans, at 30 days, then every 90 days while there is something to lose; ✕ puts it away here and on the account, and the
 * account's put-away (the phone's ✕) counts here. One sentence on every card, in a browser's words. In Settings it stays
 * until a way back is kept. Away from Home (Settings) the card asks for that answer itself (`GET /api/home?cards=safety`).
 * "Add a sign-in" asks the node which sign-ins it offers for this member and leaves for the one chosen. Never a gate:
 * nothing here blocks anything. The node is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as api from '../lib/api';
import type { HomeAnswer } from '../lib/home-cards';
import { generateIdentity, type BeanPoolIdentity } from '../lib/identity';
import { loadPendingLink } from '../lib/link-signin';
import { keepWordsOnAccount } from '../lib/words-kept';
import { OneWayBackCard, ONE_WAY_BACK_WORDS, readWayBackHere, startWayBackShown, wayBackWordOf, type WayBackHere, type WayBackWord } from './OneWayBack';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
    return { ...actual, getHome: vi.fn(), getCommunityMe: vi.fn(), saveHomePreferences: vi.fn() };
});

const DAY = 24 * 3600_000;
/** The card's one sentence in a browser (core WAY_BACK_WORDS.lineBrowser), and its fact at the first Beans. */
const LINE = 'If this browser forgets your account, this is how you get back in.';
const BEANS_40 = "You have 40 Beans here now. Keep a way back in, so they don't go if this browser forgets your account.";

/**
 * The Home answer as routes/home-answer.ts sends it, for the member whose standing is named: `words`, the 12-words door's
 * own with no sign-in (`cards.safety`, `me.wayBack` words, probation on its words rules); `ordinary`, a member with a
 * sign-in's copy linked here (`wayBack` covered); undefined, an answer with neither (a node from before both). `where`:
 * the worldwide community by default, or a local one.
 */
function standing(rules: 'words' | 'ordinary' | undefined, joinedDaysAgo = 1, where: 'global' | 'local' = 'global'): api.HomeRead {
    const joinedAt = new Date(Date.now() - joinedDaysAgo * DAY).toISOString();
    const answer = {
        generatedAt: new Date().toISOString(), profile: where, features: {}, layout: null,
        me: {
            joinedAt, isKeeper: false, interests: [], area: null, firstOffer: false, standing: 'member',
            probation: rules ? { onProbation: true, rules, keptPosts: 0, keptPostsNeeded: 3, ageEndsAt: null } : null,
            ...(rules === 'words' ? { wayBack: 'words', wordsKept: false } : rules === 'ordinary' ? { wayBack: 'covered', wordsKept: false } : {}),
        },
        cards: rules === 'words' ? { safety: { words: true, signInLinked: false } } : {},
    } as unknown as HomeAnswer;
    return { notModified: false, answer, etag: null };
}

/** The same answer for a member who came by invite and has no sign-in: words are their only way back, no `safety`. */
function invitedRead(over: { kept?: boolean; where?: 'global' | 'local' } = {}): api.HomeRead {
    const read = standing(undefined, 1, over.where ?? 'local') as Extract<api.HomeRead, { notModified: false }>;
    const me = { ...read.answer.me!, wayBack: 'words' as const, wordsKept: !!over.kept, probation: { onProbation: true, rules: 'ordinary' as const, keptPosts: 0, keptPostsNeeded: 3, ageEndsAt: null } };
    return { ...read, answer: { ...read.answer, me } };
}

/** The 12-words door's own member who said they still have their words: the node leaves `safety` out, its rules still say words. */
function doorKeptRead(where: 'global' | 'local' = 'global'): api.HomeRead {
    const read = standing('words', 1, where) as Extract<api.HomeRead, { notModified: false }>;
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
    vi.restoreAllMocks();
    vi.mocked(api.getHome).mockReset();
    vi.mocked(api.saveHomePreferences).mockReset();
    document.documentElement.classList.remove('dark');
});

describe('who it is for: the node says so', () => {
    it('a member who joined with 12 words and has no sign-in: the card, in its one sentence for a browser', async () => {
        vi.mocked(api.getHome).mockResolvedValue(standing('words'));
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} />);
        expect(await screen.findByTestId('one-way-back-text')).toHaveTextContent(LINE);
        expect(screen.getByRole('heading')).toHaveTextContent('Your way back in');
        // Never the phone's words in a browser.
        expect(screen.getByTestId('one-way-back-landing').textContent).not.toMatch(/phone/);
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

// The parity read of D2 against D3 (row 11): the phone's Settings keeps the card for every member whose words are the only
// way back. The web's Settings asked `/me`, whose `rules` says how a member joined, so a member who came by invite had no
// reminder anywhere once Home's returns were over. Settings now reads the Home answer's `me`, as Home does.
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

    it('a member who came by invite: the card, in its one sentence, with only what works there', async () => {
        vi.mocked(api.getHome).mockResolvedValue(invitedRead());
        settings(vi.fn());
        await screen.findByTestId('one-way-back-settings');
        expect(screen.getByRole('heading')).toHaveTextContent('Your way back in');
        expect(screen.getByTestId('one-way-back-text')).toHaveTextContent(LINE);
        // The node takes no sign-in from them (404 invite_only): never offered.
        expect(screen.queryByTestId('add-sign-in')).toBeNull();
        expect(screen.getByTestId('one-way-back-words')).toBeInTheDocument();
        expect(screen.getByTestId('one-way-back-kept')).toHaveTextContent(ONE_WAY_BACK_WORDS.kept);
        // No "Hide this for now" in Settings: it stays until a way back is kept.
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

    // The phone's card says one sentence everywhere, the worldwide community's door included, where it once said "one way
    // back" (DESIGN-notify-and-backup-asks-fable.md §5.1); the web's card now says the same, in a browser's words.
    it('one sentence on every card, the worldwide community and a local one alike; "Add a sign-in" where the node takes one', async () => {
        for (const where of ['local', 'global'] as const) {
            vi.mocked(api.getHome).mockResolvedValue(standing('words', 1, where));
            settings(vi.fn());
            await screen.findByTestId('one-way-back-settings');
            expect(screen.getByRole('heading'), where).toHaveTextContent('Your way back in');
            expect(screen.getByTestId('one-way-back-text'), where).toHaveTextContent(LINE);
            expect(screen.getByTestId('add-sign-in'), where).toBeInTheDocument();
            cleanup();
        }
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

// ── Home's card on core's schedule (slice B2) ─────────────────────────────────────────────────────────────────────────

/** A Home answer for the card: the member, when they joined, their Beans and deals, and whether they kept a way back. */
function homeAnswer(o: { door?: boolean; joinedDaysAgo: number; balance_c?: number; deals?: number; wordsKept?: boolean; now: number }): HomeAnswer {
    return {
        generatedAt: new Date(o.now).toISOString(), profile: 'local', features: {}, layout: null,
        me: {
            joinedAt: new Date(o.now - o.joinedDaysAgo * DAY).toISOString(), isKeeper: false, interests: [], area: null, firstOffer: false, standing: 'member',
            probation: null, wayBack: 'words', wordsKept: !!o.wordsKept,
        },
        cards: {
            ...(o.door ? { safety: { words: true, signInLinked: false } } : {}),
            ...(o.balance_c !== undefined ? { beans: { balance_c: o.balance_c, room_c: 20000, tier: 'Resident', activated: true, frozen: false } } : {}),
            ...(o.deals !== undefined ? { deals: { open: o.deals, waiting: 0, waitingOnMe: null } } : {}),
        },
    } as unknown as HomeAnswer;
}

const hereKey = () => `beanpool_one_way_back_${identity.publicKey}`;
const keepHere = (here: WayBackHere | Record<string, unknown>) => localStorage.setItem(hereKey(), JSON.stringify(here));

/** The card on Home at 320 px with the text at 130 %, in light or dark (the `dark` class Tailwind's dark: reads). */
function landing(home: WayBackWord, o: { dark?: boolean; accountPutAwayAt?: string | null; onDrawn?: (drawn: boolean) => void } = {}) {
    document.documentElement.classList.toggle('dark', !!o.dark);
    return render(
        <div style={{ width: 320, fontSize: '130%' }}>
            <OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={home} accountPutAwayAt={o.accountPutAwayAt} onDrawn={o.onDrawn} />
        </div>,
    );
}
const card = () => screen.queryByTestId('one-way-back-landing');

/**
 * What the card stands on at 320 px with 130 % text, in both colour sets (jsdom draws no pixels, so its classes say it):
 * every palette colour has its dark partner, the words wrap, nothing has a fixed width but the 44 px ✕, and every button
 * is a 44 px target.
 */
function holdsAt320(root: HTMLElement) {
    const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const COLOUR = /^(bg|text|border)-(nature|emerald|amber|oat|red)-/;
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
        const c = classes(el);
        for (const light of c.filter(k => COLOUR.test(k))) {
            const kind = light.split('-')[0];
            expect(c.some(k => k.startsWith(`dark:${kind}-`)), `${light} has a dark partner on <${el.tagName.toLowerCase()} class="${c.join(' ')}">`).toBe(true);
        }
        const fixed = c.filter(k => /^w-\[|^w-\d/.test(k));
        if (el.getAttribute('aria-label') === 'Hide this for now') expect(fixed).toEqual(['w-11']);
        else expect(fixed, el.outerHTML.slice(0, 120)).toEqual([]);
    }
    for (const b of Array.from(root.querySelectorAll('button'))) expect(classes(b).some(k => k === 'min-h-[44px]'), `${b.textContent} is 44 px tall`).toBe(true);
    for (const p of [root.querySelector('h2')!, screen.getByTestId('one-way-back-text')]) expect(classes(p)).toContain('break-words');
}

describe("Home's card on core's schedule, in a browser's words (slice B2): one table, at 320 px with 130 % text, light and dark", () => {
    // Each row: this browser's record, Home's answer, the account's put-away, the day; then whether the card is up and what
    // it says. Every row goes red when its line goes (named beside it): the record read, the account's put-away, the join's
    // "Later", sign-up as the first showing, the first Beans, the 30 days, something to lose, a way back kept.
    type Row = {
        name: string;
        here?: WayBackHere | Record<string, unknown>;
        answer: Omit<Parameters<typeof homeAnswer>[0], 'now'>;
        accountPutAwayDay?: number;
        owed?: boolean;
        /** Days since joining. */
        day: number;
        up: string | null;
    };
    const J = (d: number) => d * DAY;
    const ROWS: Row[] = [
        // the join here kept no way back (WelcomePage startWayBackShown): up from the first landing (`here.shownFrom`)
        { name: 'the first landing after the join\'s Later', here: { shownFrom: J(0) }, answer: { joinedDaysAgo: 0 }, day: 0, up: LINE },
        { name: 'day 3 after Later, not put away yet', here: { shownFrom: J(0) }, answer: { joinedDaysAgo: 3 }, day: 3, up: LINE },
        // no record here, not the door's own: sign-up was its first showing (`home.startsAway`)
        { name: 'a member this browser never saw join, on day one: put away at the join', answer: { joinedDaysAgo: 0 }, day: 0, up: null },
        // the 12-words door's own, no record here: up from the first landing (`startsAway` false)
        { name: "the 12-words door's own, no record here: up", answer: { door: true, joinedDaysAgo: 0 }, day: 0, up: LINE },
        // ✕ here (`here.putAwayAt`)
        { name: 'put away here on day 1', here: { shownFrom: J(0), putAwayAt: J(1) }, answer: { joinedDaysAgo: 2 }, day: 2, up: null },
        // ✕ on the phone or another browser (`accountPutAwayAt`)
        { name: 'put away on the phone on day 1', here: { shownFrom: J(0) }, answer: { joinedDaysAgo: 2 }, accountPutAwayDay: 1, day: 2, up: null },
        // the first Beans (core wayBackBeansSeen on Home's `beans.balance_c`), in the browser's words with the amount
        { name: 'the first Beans after the ✕: back with the fact', here: { shownFrom: J(0), putAwayAt: J(1) }, answer: { joinedDaysAgo: 5, balance_c: 4000 }, day: 5, up: BEANS_40 },
        { name: 'the Beans return already put away', here: { shownFrom: J(0), putAwayAt: J(6), beansAt: J(5) }, answer: { joinedDaysAgo: 7, balance_c: 4000 }, day: 7, up: null },
        // 30 days after joining (`home.joinedAt`)
        { name: 'day 29: still away', here: { putAwayAt: J(1) }, answer: { joinedDaysAgo: 29 }, day: 29, up: null },
        { name: 'day 30: once more', here: { putAwayAt: J(1) }, answer: { joinedDaysAgo: 30 }, day: 30, up: LINE },
        { name: 'day 30 put away by a member this browser never saw join (put away at the join): once more', answer: { joinedDaysAgo: 30 }, day: 30, up: LINE },
        // every 90 days, only with something to lose (a balance, or an open deal: `home.balance_c`, `home.holds`)
        { name: 'day 120, put away on day 30, Beans here: back', here: { putAwayAt: J(30), beansAt: J(4) }, answer: { joinedDaysAgo: 120, balance_c: 4000 }, day: 120, up: LINE },
        { name: 'day 120, put away on day 30, an open deal: back', here: { putAwayAt: J(30) }, answer: { joinedDaysAgo: 120, balance_c: 0, deals: 1 }, day: 120, up: LINE },
        { name: 'day 120, put away on day 30, nothing to lose: away', here: { putAwayAt: J(30) }, answer: { joinedDaysAgo: 120, balance_c: 0, deals: 0 }, day: 120, up: null },
        { name: 'day 119, put away on day 30, Beans here: not yet', here: { putAwayAt: J(30), beansAt: J(4) }, answer: { joinedDaysAgo: 119, balance_c: 4000 }, day: 119, up: null },
        // a way back kept: never (Home's `me.wordsKept`; said here and still owed to the node)
        { name: 'kept on the account, with Beans and a year gone', here: { putAwayAt: J(30) }, answer: { joinedDaysAgo: 400, balance_c: 4000, wordsKept: true }, day: 400, up: null },
        { name: 'kept here, not yet heard by the node', here: { shownFrom: J(0) }, answer: { joinedDaysAgo: 0 }, owed: true, day: 0, up: null },
        // a record from before (its flags, no times): read as no record
        { name: 'a record from before, its put-away flag and no date: as a member this browser never saw join', here: { dismissed: true, keptPostsAtDismissal: 0, postReturnShown: true, weekReturnShown: true, checked: true }, answer: { joinedDaysAgo: 2 }, day: 2, up: null },
    ];

    it.each(ROWS.flatMap((r) => [{ ...r, dark: false }, { ...r, dark: true }]))('$name (dark: $dark)', (r) => {
        const joined = Date.UTC(2026, 10, 21, 2, 0);
        const now = joined + r.day * DAY;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        // The rows' times are days after joining.
        if (r.here) keepHere(Object.fromEntries(Object.entries(r.here).map(([k, v]) => [k, typeof v === 'number' ? joined + v : v])));
        if (r.owed) {
            // Said here, and the node didn't take it (offline): owed, sent again at the next landing (lib/words-kept.ts).
            vi.mocked(api.saveHomePreferences).mockRejectedValue(new TypeError('Failed to fetch'));
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            keepWordsOnAccount(identity.publicKey, 'test');
        }
        const home = { ...wayBackWordOf(homeAnswer({ ...r.answer, now })) };
        const drawn: boolean[] = [];
        landing(home, { dark: r.dark, onDrawn: (d) => drawn.push(d), accountPutAwayAt: r.accountPutAwayDay !== undefined ? new Date(joined + r.accountPutAwayDay * DAY).toISOString() : null });
        // Settled at the first paint: never drawn and pulled, never popping in a beat later (a card arriving late moved
        // every card after it, PR #2411).
        expect(drawn).toEqual([r.up !== null]);
        if (r.up === null) {
            expect(card()).toBeNull();
            return;
        }
        expect(card()).toBeInTheDocument();
        expect(screen.getByTestId('one-way-back-text').textContent).toBe(r.up);
        expect(screen.getByRole('heading')).toHaveTextContent('Your way back in');
        expect(document.documentElement.classList.contains('dark')).toBe(r.dark);
        holdsAt320(card()!);
    });
});

describe("on Home, the Home answer is the one word (`home`), and `/me` is never asked", () => {
    const NOW = Date.UTC(2026, 10, 21, 2, 0);
    const at = (day: number) => vi.spyOn(Date, 'now').mockReturnValue(NOW + day * DAY);
    const home = (o: Omit<Parameters<typeof homeAnswer>[0], 'now'>, day: number) => wayBackWordOf(homeAnswer({ ...o, joinedDaysAgo: day, now: NOW + day * DAY }));
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    it("the 12-words door's own member: drawn at the first paint, with a sign-in, and nothing asked", async () => {
        at(0);
        const drawn: boolean[] = [];
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={home({ door: true }, 0)} onDrawn={(d) => drawn.push(d)} />);
        expect(card()).toBeInTheDocument();
        expect(screen.getByTestId('one-way-back-text')).toHaveTextContent(LINE);
        expect(screen.getByTestId('add-sign-in')).toBeInTheDocument();
        await settle();
        expect(drawn).toEqual([true]);
        expect(api.getHome).not.toHaveBeenCalled();
    });

    it('an invited member on day one with no record here: not on Home (sign-up was its first showing), and nothing is written', async () => {
        at(0);
        const drawn: boolean[] = [];
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={home({}, 0)} onDrawn={(d) => drawn.push(d)} />);
        await settle();
        expect(card()).toBeNull();
        expect(drawn).toEqual([false]);
        expect(localStorage.getItem(hereKey())).toBeNull();
    });

    it("a join here that kept no way back (startWayBackShown): up from the first landing, never a sign-in where the node takes none; a record already here is kept", () => {
        at(0);
        startWayBackShown(identity.publicKey, NOW);
        expect(readWayBackHere(identity.publicKey)).toEqual({ shownFrom: NOW });
        // Once only: a second Next (a join that failed and was tried again) or a later join keeps what is there.
        startWayBackShown(identity.publicKey, NOW + DAY);
        expect(readWayBackHere(identity.publicKey)).toEqual({ shownFrom: NOW });
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={home({}, 0)} />);
        expect(card()).toBeInTheDocument();
        expect(screen.queryByTestId('add-sign-in')).toBeNull();
    });

    it('✕: put away here and on the account at the same moment; then back at the first Beans, at 30 days, and at 120 days with Beans', () => {
        at(0);
        startWayBackShown(identity.publicKey, NOW);
        const onPutAway = vi.fn();
        const { unmount } = render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={home({}, 0)} onPutAway={onPutAway} />);
        fireEvent.click(screen.getByRole('button', { name: 'Hide this for now' }));
        expect(card()).toBeNull();
        expect(onPutAway).toHaveBeenCalledWith(NOW);
        expect(readWayBackHere(identity.publicKey)).toEqual({ shownFrom: NOW, putAwayAt: NOW });
        unmount();

        const visit = (day: number, o: Omit<Parameters<typeof homeAnswer>[0], 'now' | 'joinedDaysAgo'> = {}) => {
            cleanup();
            at(day);
            render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={home(o, day)} />);
            return card();
        };
        const away = () => fireEvent.click(screen.getByRole('button', { name: 'Hide this for now' }));

        expect(visit(4)).toBeNull();
        // The first Beans: back once, with how many.
        expect(visit(5, { balance_c: 4000 })).toBeInTheDocument();
        expect(screen.getByTestId('one-way-back-text').textContent).toBe(BEANS_40);
        // Kept once in this browser, at the paint that saw them.
        expect(readWayBackHere(identity.publicKey).beansAt).toBe(NOW + 5 * DAY);
        away();
        expect(visit(6, { balance_c: 4000 })).toBeNull();
        expect(visit(29, { balance_c: 4000 })).toBeNull();
        // 30 days after joining: once more, the one sentence.
        expect(visit(30, { balance_c: 4000 })).toBeInTheDocument();
        expect(screen.getByTestId('one-way-back-text').textContent).toBe(LINE);
        away();
        expect(visit(119, { balance_c: 4000 })).toBeNull();
        // 90 days after that put-away, with Beans still here.
        expect(visit(120, { balance_c: 4000 })).toBeInTheDocument();
        away();
        expect(visit(209, { balance_c: 4000 })).toBeNull();
        // Spent to nothing, with no deal: no more 90-day returns.
        expect(visit(300, { balance_c: 0 })).toBeNull();
        expect(api.getHome).not.toHaveBeenCalled();
    });

    it("the account's put-away counts here when it is the later one, and this browser's when it is", () => {
        at(2);
        startWayBackShown(identity.publicKey, NOW);
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={home({}, 2)} accountPutAwayAt={new Date(NOW + DAY).toISOString()} />);
        expect(card()).toBeNull();
        cleanup();
        // A put-away on the phone before the first Beans here: the Beans still bring it once.
        at(5);
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={home({ balance_c: 4000 }, 5)} accountPutAwayAt={new Date(NOW + DAY).toISOString()} />);
        expect(screen.getByTestId('one-way-back-text').textContent).toBe(BEANS_40);
        cleanup();
        // Unreadable: as none.
        at(2);
        localStorage.clear();
        startWayBackShown(identity.publicKey, NOW);
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={home({}, 2)} accountPutAwayAt="not a date" />);
        expect(card()).toBeInTheDocument();
    });

    it('"See my 12 words" opens them, and the card stays on its schedule: looking at them is not keeping them, as on the phone', () => {
        at(0);
        startWayBackShown(identity.publicKey, NOW);
        const onSeeWords = vi.fn();
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={onSeeWords} home={home({}, 0)} />);
        fireEvent.click(screen.getByTestId('one-way-back-words'));
        expect(onSeeWords).toHaveBeenCalledTimes(1);
        expect(card()).toBeInTheDocument();
        expect(readWayBackHere(identity.publicKey)).toEqual({ shownFrom: NOW });
    });

    it('"I still have my 12 words": kept on the account (onKept), and the card is done here at once', () => {
        at(0);
        startWayBackShown(identity.publicKey, NOW);
        const onKept = vi.fn();
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={home({}, 0)} onKept={onKept} />);
        fireEvent.click(screen.getByTestId('one-way-back-kept'));
        expect(onKept).toHaveBeenCalledTimes(1);
        expect(card()).toBeNull();
        cleanup();
        // The node heard it: Home's answer says so from then on.
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={home({ wordsKept: true, balance_c: 4000 }, 40)} />);
        expect(card()).toBeNull();
    });

    it("Home's answer then says it is not for them (a sign-in linked, the words kept elsewhere): it goes", () => {
        at(0);
        const door = home({ door: true }, 0);
        const { rerender } = render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={door} />);
        expect(card()).toBeInTheDocument();
        rerender(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={{ ...door, forThem: false, canAddSignIn: false }} />);
        expect(card()).toBeNull();
    });

    it('not for them: nothing, first paint and after, and the first Beans are not kept for a card that is not theirs', async () => {
        at(40);
        const drawn: boolean[] = [];
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} home={home({ wordsKept: true, balance_c: 4000 }, 40)} onDrawn={(d) => drawn.push(d)} />);
        await settle();
        expect(card()).toBeNull();
        expect(drawn).toEqual([false]);
        expect(localStorage.getItem(hereKey())).toBeNull();
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
