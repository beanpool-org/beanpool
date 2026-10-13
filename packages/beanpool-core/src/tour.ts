/**
 * The one-minute tour (scratch/global-node/DESIGN-getting-started-fable.md §2–§3): a bar at the bottom of the screen
 * that moves the app to each real tab in turn, one or two sentences a step, Skip and Next, "Step 2 of 7". Nothing is
 * overlaid and nothing behind the bar is blocked. This module is the steps (derived from the tabs this node shows, so
 * no step points at something that isn't there), their words, the last step's three chips, and the two records:
 *
 * - **On the account** (`tour` preference, own-read like `home.layout`): `{ v: 1, state: 'done' | 'skipped' | 'open', at }`.
 *   Done or skipped, the Getting started card never returns on any device; "Take the tour again" writes `open`.
 * - **On the device** (per account): `{ v: 1, step, startedAt }`, the step a tour part way is at, so a killed app's card
 *   says "Pick up the tour at step n".
 *
 * Pure: no I/O and no Node built-ins (the barrel is bundled for the phone).
 */
import { defaultCards, homeCardType, starterCards, type HomeNodeFacts, type HomeReaderRole } from './home-frame.js';

// ── The steps ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type TourApp = 'phone' | 'web';
export type TourStepId = 'home' | 'market' | 'map' | 'talk' | 'chat' | 'people' | 'commons' | 'ledger' | 'top' | 'cards';

export interface TourStep {
    id: TourStepId;
    /**
     * The tab the app shows for this step, in its own words: the phone's route name (`index`, `market`, `map`, `chats`,
     * `projects`, `ledger`) or the web app's tab (`home`, `marketplace`, `map`, `projects`, `messages`, `people`, `ledger`).
     * The top-bar step stays on Home; the last step is Home.
     */
    tab: string;
    words: string;
}

/** The longest a step's words may be: four lines at 320 dp and the app's 1.2× cap, so the bar stays under 170 dp. */
export const TOUR_STEP_MAX_CHARS = 110;

/** What the tour needs to know of the node. */
export interface TourNodeFacts {
    /** The worldwide community. */
    global: boolean;
    /** Beans are on (Commons and Ledger are tabs). A node that doesn't say counts as on. */
    beans: boolean;
    /** The global showcase shows Commons and Ledger as previews (DESIGN-global-showcase W3). */
    showcase?: boolean;
}

/**
 * The words, by step. Map, Beans and Ledger reuse the Tips card's founder-approved sentences (home-tips.ts). Global's
 * own words where they differ.
 */
export const TOUR_WORDS = {
    home: 'Home is a short list of cards: what needs you, what\'s on nearby, what to do next. You add cards at the end.',
    market: 'Neighbours post Offers and Needs here. Tap + ADD POST to put up your own.',
    marketGlobal: 'People post things free or for swap here. Tap + ADD POST to put up your own.',
    map: 'What\'s near you: green pins are Offers, orange are Needs, purple are events.',
    talk: 'Messages, Groups and People live here. A chat with one person is locked end to end.',
    chat: 'Your messages. A chat with one person is locked end to end.',
    people: 'Members, friends and invites.',
    commons: 'Where your community decides things together: Decisions, events and shared enterprises.',
    commonsGlobal: 'Where a local community decides things together. This one is an example.',
    ledger: 'Beans count help given and received. Everyone starts at zero, and zero is a fine place to be.',
    ledgerGlobal: 'In a local community, help earns Beans and getting help spends them. This is an example ledger.',
    topPhone: 'Up top: the bean is your community and the guide, ? explains this screen, the sliders are Settings.',
    topWeb: 'At the top: ? explains the screen you\'re on; Settings is where the whole guide lives.',
    cards: 'Add your first cards: tap one to put it on Home. Or tap Done and Home starts with the usual five.',
} as const;

/**
 * The tour's steps for this app on this node, in the app's tab order: Home, each tab the node shows, the top bar, and
 * back to Home to add the first cards. Commons and Ledger only where they are tabs (Beans on, or global's previews).
 */
export function tourSteps(app: TourApp, node: TourNodeFacts): TourStep[] {
    const g = node.global;
    const moneyTabs = node.beans || (g && node.showcase === true);
    const steps: TourStep[] = [{ id: 'home', tab: app === 'phone' ? 'index' : 'home', words: TOUR_WORDS.home }];
    steps.push({ id: 'market', tab: app === 'phone' ? 'market' : 'marketplace', words: g ? TOUR_WORDS.marketGlobal : TOUR_WORDS.market });
    steps.push({ id: 'map', tab: 'map', words: TOUR_WORDS.map });
    const commons: TourStep = { id: 'commons', tab: 'projects', words: g ? TOUR_WORDS.commonsGlobal : TOUR_WORDS.commons };
    const ledger: TourStep = { id: 'ledger', tab: 'ledger', words: g ? TOUR_WORDS.ledgerGlobal : TOUR_WORDS.ledger };
    if (app === 'phone') {
        // The phone's tabs: Home · Market · Map · Talk · Commons · Ledger.
        steps.push({ id: 'talk', tab: 'chats', words: TOUR_WORDS.talk });
        if (moneyTabs) steps.push(commons, ledger);
        steps.push({ id: 'top', tab: 'index', words: TOUR_WORDS.topPhone });
        steps.push({ id: 'cards', tab: 'index', words: TOUR_WORDS.cards });
    } else {
        // The web app's: Home · Market · Map · Commons · Chat · People · Ledger.
        if (moneyTabs) steps.push(commons);
        steps.push({ id: 'chat', tab: 'messages', words: TOUR_WORDS.chat });
        steps.push({ id: 'people', tab: 'people', words: TOUR_WORDS.people });
        if (moneyTabs) steps.push(ledger);
        steps.push({ id: 'top', tab: 'home', words: TOUR_WORDS.topWeb });
        steps.push({ id: 'cards', tab: 'home', words: TOUR_WORDS.cards });
    }
    return steps;
}

/** "Step 2 of 7", as the bar's caption says it (the apps upper-case it with the caption style). */
export const tourStepCaption = (index: number, total: number): string => `Step ${index + 1} of ${total}`;

/**
 * The step a tab the member tapped during the tour belongs to (the tour follows, never scolds), or -1 for a tab with no
 * step. The first step naming the tab wins, so tapping Home goes back to step 1.
 */
export function tourStepForTab(steps: readonly TourStep[], tab: string): number {
    return steps.findIndex((s) => s.tab === tab);
}

// ── The last step's chips (§3) ────────────────────────────────────────────────────────────────────────────────────

/**
 * The three cards the last step offers, by profile: local First steps · New in the Market · Your Beans (Coming up where
 * Beans are off); global First steps · Near you · Coming up (Your Beans as an example once the showcase draws it); an
 * operator alone on a new node First steps · Grow your community · New in the Market. Only types this node shows this
 * reader, so nothing is offered that couldn't be drawn; never tier-worded.
 */
export function tourChips(answer: HomeNodeFacts, role: HomeReaderRole, opts: { members?: number | null } = {}): string[] {
    const global = answer.profile === 'global';
    const alone = !global && (role === 'owner' || role === 'admin') && opts.members === 1;
    const wanted = alone
        ? ['steps', 'invite', 'market', 'events']
        : global
          ? ['steps', 'market', 'events']
          : ['steps', 'market', 'beans', 'events'];
    const shown = wanted.filter((id) => homeCardType(id)?.onNode(answer, role) === true);
    return shown.slice(0, 3);
}

// ── The account's record ──────────────────────────────────────────────────────────────────────────────────────────

/** The preference key the tour is kept under on the account. */
export const TOUR_PREF_KEY = 'tour';

export type TourAccountState = 'done' | 'skipped' | 'open';
export interface TourRecord {
    v: 1;
    state: TourAccountState;
    at: string;
}

export const TOUR_RECORD_MESSAGE = "A tour record is { v: 1, state: 'done' | 'skipped' | 'open', at: date }.";

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const STATES: ReadonlySet<string> = new Set(['done', 'skipped', 'open']);

function isoDate(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > 40) return null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * The account's tour record, strictly (a member's write): the shape above, or null. A date in the future is held to
 * `now`; none sent is `now`.
 */
export function checkTourRecord(value: unknown, now: Date = new Date()): TourRecord | null {
    if (!isPlainObject(value) || value.v !== 1 || typeof value.state !== 'string' || !STATES.has(value.state)) return null;
    let at = now.toISOString();
    if (value.at !== undefined) {
        const when = isoDate(value.at);
        if (when === null) return null;
        at = Date.parse(when) > now.getTime() ? now.toISOString() : when;
    }
    return { v: 1, state: value.state as TourAccountState, at };
}

/** A stored or answered tour record, tolerantly: anything that isn't one is null (no record: the tour has not ended). */
export function readTourRecord(value: unknown): TourRecord | null {
    if (!isPlainObject(value) || value.v !== 1 || typeof value.state !== 'string' || !STATES.has(value.state)) return null;
    const at = isoDate(value.at);
    return at ? { v: 1, state: value.state as TourAccountState, at } : null;
}

/** Whether the tour has ended on this account (done or skipped): the Getting started card is never drawn again. */
export const tourEnded = (record: TourRecord | null | undefined): boolean => record?.state === 'done' || record?.state === 'skipped';

/** The record a Done, a Skip or a "Take the tour again" writes. */
export const tourRecord = (state: TourAccountState, now: number = Date.now()): TourRecord => ({ v: 1, state, at: new Date(now).toISOString() });

// ── The device's record ───────────────────────────────────────────────────────────────────────────────────────────

/** A tour part way, kept on the device per account: the step it is at (0-based) and when it began. */
export interface TourProgress {
    v: 1;
    step: number;
    startedAt: string;
}

/** A stored tour progress, tolerantly: a step that isn't a whole number from 0 is null (no tour part way). */
export function readTourProgress(value: unknown): TourProgress | null {
    if (!isPlainObject(value) || value.v !== 1) return null;
    if (typeof value.step !== 'number' || !Number.isInteger(value.step) || value.step < 0 || value.step > 64) return null;
    const startedAt = isoDate(value.startedAt);
    return startedAt ? { v: 1, step: value.step, startedAt } : null;
}

/** The step a resumed tour opens at: the kept one, held inside the steps this node has now (a tab may have gone). */
export const resumeStep = (progress: TourProgress | null, total: number): number =>
    progress ? Math.max(0, Math.min(progress.step, total - 1)) : 0;

/** The Getting started card's button: "Look around ›", or where a tour is part way, "Pick up the tour at step 3 ›". */
export function startCardButton(progress: TourProgress | null, total: number): string {
    if (!progress || progress.step === 0) return 'Look around ›';
    return `Pick up the tour at step ${resumeStep(progress, total) + 1} ›`;
}

/** The Getting started card's words (§1). */
export const START_CARD_WORDS = 'This is your Home. You choose what goes here. Before you start, take a one-minute look at the other tabs.';

/**
 * The cards a Home with no saved layout shows: Getting started while the tour hasn't ended, else the starter set (a Done
 * or Skip whose layout write never reached the node still leaves Home with something on it).
 */
export const newcomerCards = (record: TourRecord | null | undefined) => (tourEnded(record) ? starterCards() : defaultCards());
