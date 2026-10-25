/**
 * The needs-you icons in App's own header row and side bar, on ONE mounted header as the app runs (PR #2478, deciding review
 * at 6113c9ad): the tab and the needs change in place, never by loading the page again.
 *
 * 1. Stuck hidden: one tab with no room (the Map's logo) hid the icons on every tab after it, because the icons' box went
 *    and its measure went with it.
 * 2. Titles cut: the icons' room was measured against the sync chip as drawn (dot or words) while the chip chose by the
 *    icons' room, and the two could settle on a cut "Commons".
 * 3. The side bar: every kind drawn in its 256 px row pushed Settings off the side bar.
 *
 * jsdom lays nothing out. The header's rule is CSS: the tab's title takes its own words first (`flex: 1 0 auto`, never
 * wider than the row), and the icons' slot takes what is left, up to a slot for each kind (`flex: 0 1 <kinds × 44 px>`),
 * and on the map no further than the logo. `layoutStub` gives the slot the width that rule gives it in Chromium
 * (e2e/header-alerts-shots.mjs measures the real one at every width); the slot then draws what the phone's fitNeedsYou
 * draws in it. Everything else is the real App.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { App } from './App';
import { recordHomeAnswer, resetHomeStoreForTests } from './lib/home-store';
import type { NeedsItem } from './lib/home-cards';

// A plain function, not a mock: each test's restoreAllMocks would empty a vi.fn() (no media query matches; the app reads
// window.innerWidth beside it).
if (typeof window !== 'undefined') {
    window.matchMedia = window.matchMedia || ((media: string) => ({
        matches: false, media, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    }) as MediaQueryList);
}

vi.mock('./components/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('./components/SyncStatus', () => ({ SyncStatus: () => <div data-testid="sync-status">Synced</div> }));
vi.mock('./components/ProfileSetup', () => ({ ProfileSetup: () => <div>Profile setup</div> }));

vi.mock('./lib/identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'my-user-pubkey', privateKey: 'my-user-privkey', callsign: 'Alice' })),
    updateCallsign: vi.fn(),
}));

vi.mock('./lib/sync', () => ({
    connectToAnchor: vi.fn(),
    onSyncActivity: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn(() => () => {}),
    onSocketOpen: vi.fn(() => () => {}),
}));

/** What the node says needs the member right now: Home's reads and the header's own both answer with it. */
const node = vi.hoisted(() => ({ needs: [] as unknown[] }));
const answer = (items: unknown[]) => ({
    generatedAt: new Date().toISOString(),
    profile: 'local',
    features: { beans: true, decisions: true, invites: true },
    me: { joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: [], area: null, firstOffer: true, standing: 'member' },
    layout: { v: 2, cards: [{ id: 'c1', type: 'community' }], dismissed: {}, updatedAt: null },
    cards: { community: { name: 'Mullumbimby', members: 42 }, needs: { items } },
});

vi.mock('./lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    registerMember: vi.fn(async () => ({ ok: true })),
    checkMembership: vi.fn(async () => ({ isMember: true })),
    getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.82' })),
    getMyActiveRecoveryCollections: vi.fn(async () => ({ count: 0, collections: [] })),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(async () => ({ success: true, marked: 0 })),
    getMemberProfile: vi.fn(async () => ({ publicKey: 'my-user-pubkey', avatar: null, bio: '', contact: null })),
    getHome: vi.fn(async () => ({ notModified: false, etag: null, answer: answer(node.needs) })),
}));

vi.mock('./pages/HomePage', () => ({ HomePage: () => <div data-testid="home-page" /> }));
vi.mock('./pages/MapPage', () => ({ MapPage: () => <div data-testid="map-page" /> }));
vi.mock('./pages/ProjectsPage', () => ({ ProjectsPage: () => <div data-testid="projects-page" /> }));
vi.mock('./pages/MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="marketplace-page" /> }));
vi.mock('./pages/MessagesPage', () => ({ MessagesPage: () => <div data-testid="messages-page" /> }));
vi.mock('./pages/PeoplePage', () => ({ PeoplePage: () => <div data-testid="people-page" /> }));

const ME = 'my-user-pubkey';
const DEAL: NeedsItem = { kind: 'deal', count: 1, accent: true, label: 'A deal is waiting for you', target: { to: 'deal', postId: 'p1', txId: 't1' } };
const VOTE: NeedsItem = { kind: 'vote', count: 1, accent: true, label: 'Vote closes tomorrow', target: { to: 'decide' } };
const INVITE: NeedsItem = { kind: 'invite', count: 1, accent: false, label: "You're invited to join Garden Club", target: { to: 'invite', id: 'g1' } };
const MESSAGE: NeedsItem = { kind: 'message', count: 1, accent: false, label: 'Unread message from Ana', target: { to: 'chat', conversationId: 'dm-ana' } };
const GROUP: NeedsItem = { kind: 'group', count: 3, accent: false, label: '3 new lines in Choir', target: { to: 'chat', conversationId: 'grp-choir' } };

/**
 * A 390 px header row as Chromium lays it out at 100% text: the row's middle (between the chip and the pill) is 206 px,
 * the pill 100 px at the right, and the Map tab's logo reaches past the pill's left edge (at 320–430 px it always does).
 * The title's words: Home 60 px, Commons 100 px, and its 12 px of padding.
 */
const MIDDLE = { left: 72, right: 278 };
const PILL = { left: 278, right: 378 };
const LOGO = { left: 110, right: 290 };
const WORDS: Record<string, number> = { Home: 60, Commons: 100, Market: 75 };
const rect = (left: number, right: number) => ({ width: right - left, height: 38, top: 0, left, right, bottom: 38, x: left, y: 0, toJSON() {} }) as DOMRect;

function layoutStub() {
    const rangeRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function (this: Range) {
        const w = WORDS[(this.startContainer.textContent ?? '').trim()] ?? 80;
        return rect(0, w);
    };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const el = this as HTMLElement;
        const header = el.closest('header');
        if (el.tagName === 'HEADER') return rect(0, 390);
        if (!header) return rect(0, 0);
        if (el.dataset.testid === 'header-pill') return rect(PILL.left, PILL.right);
        if (el.dataset.testid === 'header-logo') return rect(LOGO.left, LOGO.right);
        if (el.dataset.headerMiddle !== undefined) return rect(MIDDLE.left, MIDDLE.right);
        if (el.dataset.needsSlot !== undefined) {
            // The CSS rule: the title's words first, then up to the slot's basis, and no wider than its max-width.
            const title = header.querySelector<HTMLElement>('[data-testid="header-title"]');
            const room = (MIDDLE.right - MIDDLE.left) - (title ? (WORDS[title.textContent ?? ''] ?? 80) + 12 : 0);
            const basis = parseFloat(el.style.flexBasis) || 0;
            const cap = el.style.maxWidth ? parseFloat(el.style.maxWidth) : Infinity;
            const width = Math.max(0, Math.min(basis, cap, room));
            return rect(MIDDLE.right - width, MIDDLE.right);
        }
        return rect(0, 0);
    });
    return () => { Range.prototype.getBoundingClientRect = rangeRect; };
}

/** ResizeObserver as the browser runs it after a layout: every observer hears about what it watches. */
const observers = new Set<{ cb: ResizeObserverCallback; targets: Set<Element> }>();
class FakeResizeObserver {
    private entry: { cb: ResizeObserverCallback; targets: Set<Element> };
    constructor(cb: ResizeObserverCallback) { this.entry = { cb, targets: new Set() }; observers.add(this.entry); }
    observe(t: Element) { this.entry.targets.add(t); }
    unobserve(t: Element) { this.entry.targets.delete(t); }
    disconnect() { observers.delete(this.entry); }
}
function laidOut() {
    act(() => {
        for (const o of [...observers]) {
            const entries = [...o.targets].map(target => ({ target, contentRect: target.getBoundingClientRect() })) as unknown as ResizeObserverEntry[];
            if (entries.length) o.cb(entries, {} as ResizeObserver);
        }
    });
}

const header = () => document.querySelector('header') as HTMLElement;
const sidebar = () => document.querySelector('aside') as HTMLElement;
/** What the header row draws for the needs, left to right: each kind, "more" (•••) or "chip" (the count). */
const drawn = (root: HTMLElement = header()) => [...root.querySelectorAll<HTMLElement>('[data-testid^="header-needs-"]')]
    .filter(e => e.tagName === 'BUTTON').map(e => e.dataset.testid!.replace('header-needs-', ''));
const titleWords = () => header().querySelector('[data-testid="header-title"]')?.textContent ?? null;

async function needs(items: NeedsItem[]) {
    node.needs = items;
    // Home's read landing, as HomePage records it: the header draws from it on any tab.
    await act(async () => { recordHomeAnswer(answer(items) as never, ME); });
    laidOut();
}
async function goTo(tab: RegExp) {
    await act(async () => { fireEvent.click(within(sidebar()).getByRole('button', { name: tab })); });
    laidOut();
}

let restoreRange: () => void = () => {};
const innerWidth = window.innerWidth;
beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetHomeStoreForTests();
    node.needs = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    restoreRange = layoutStub();
});
afterEach(() => {
    restoreRange();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    observers.clear();
    window.innerWidth = innerWidth;
});

describe("App's header row: one mounted header, the tab and the needs changing in place", () => {
    it('Home → Map → Home → Commons with needs 0 → 3 → 0 → 1: the icons come back after the map, and every title is whole', async () => {
        window.innerWidth = 390;
        render(<App />);
        await screen.findByTestId('home-page');
        laidOut();
        const slot = header().querySelector('[data-needs-slot]');

        expect(titleWords()).toBe('Home');
        expect(drawn()).toEqual([]);

        await needs([DEAL, VOTE, INVITE]);
        // 206 − (60 + 12) = 134 px beside "Home": a slot for each of the three, the deal nearest the pill.
        expect(drawn()).toEqual(['invite', 'vote', 'deal']);

        await goTo(/Map/);
        await screen.findByTestId('map-page');
        expect(titleWords()).toBeNull();
        // The logo reaches past the pill's left edge: no room beside it, so nothing is drawn under it.
        expect(drawn()).toEqual([]);

        await goTo(/Home/);
        expect(titleWords()).toBe('Home');
        expect(drawn()).toEqual(['invite', 'vote', 'deal']);

        await goTo(/Commons/);
        expect(titleWords()).toBe('Commons');
        // 206 − (100 + 12) = 94 px beside "Commons": two slots, the deal and ••• for the other two.
        expect(drawn()).toEqual(['more', 'deal']);

        await needs([]);
        expect(drawn()).toEqual([]);
        await needs([INVITE]);
        expect(drawn()).toEqual(['invite']);
        expect(titleWords()).toBe('Commons');

        // The slot was never taken down: the same element measured the whole way.
        expect(slot).not.toBeNull();
        expect(header().querySelector('[data-needs-slot]')).toBe(slot);
    });

    it("the rule is the row's own CSS: the title's words first, then the icons, a slot per kind, and none past the logo", async () => {
        window.innerWidth = 390;
        render(<App />);
        await screen.findByTestId('home-page');
        await needs([DEAL, VOTE, INVITE]);

        const title = header().querySelector<HTMLElement>('[data-testid="header-title"]')!;
        const titleBox = title.parentElement!;
        const middle = titleBox.parentElement!;
        const slot = middle.querySelector<HTMLElement>('[data-needs-slot]')!;
        // The title and the icons share the row's middle; the title's box never shrinks below its words (only below the
        // row's own width, where it is cut as before), and the icons' slot shrinks first, to nothing.
        expect(middle.dataset.headerMiddle).toBeDefined();
        expect(titleBox.style.flex).toBe('1 0 auto');
        expect(titleBox.style.maxWidth).toBe('100%');
        expect(slot.parentElement).toBe(middle);
        expect(slot.style.flex).toBe('0 1 132px');
        expect(slot.style.minWidth).toBe('0px');
        expect(slot.style.overflow).toBe('hidden');

        // A kind more or less changes the slot's basis, not the title's.
        await needs([DEAL, VOTE, INVITE, MESSAGE, GROUP]);
        expect(slot.style.flex).toBe('0 1 220px');
        await needs([INVITE]);
        expect(slot.style.flex).toBe('0 1 44px');

        // On the map the slot ends where the logo does (the middle's right edge less the logo's, and its 4 px).
        await goTo(/Map/);
        await screen.findByTestId('map-page');
        expect(slot.style.maxWidth).toBe('0px');
        await goTo(/Home/);
        expect(slot.style.maxWidth).toBe('');
    });
});

describe("App's side bar (wide screens): the icons get a row of their own", () => {
    it('five kinds: all drawn on their own row above the status and Settings, never in that row', async () => {
        window.innerWidth = 1280;
        render(<App />);
        await screen.findByTestId('home-page');
        await needs([DEAL, VOTE, INVITE, MESSAGE, GROUP]);

        const row = within(sidebar()).getByTestId('sidebar-needs-row');
        // 256 px side bar less its 12 px padding each side: 232 px, room for five 44 px slots; it wraps rather than cut.
        expect(row.className).toContain('flex-wrap');
        expect(drawn(row)).toEqual(['group', 'message', 'invite', 'vote', 'deal']);
        expect(within(row).queryByTestId('header-needs-more')).toBeNull();

        const settingsRow = within(sidebar()).getByTestId('sidebar-settings').parentElement!;
        expect(settingsRow.contains(row)).toBe(false);
        expect(row.contains(settingsRow)).toBe(false);
        expect(drawn(settingsRow)).toEqual([]);
        expect(within(settingsRow).getByTestId('sync-status')).toBeInTheDocument();
    });

    it('nothing needs you: no row at all', async () => {
        window.innerWidth = 1280;
        render(<App />);
        await screen.findByTestId('home-page');
        await needs([]);
        expect(within(sidebar()).queryByTestId('sidebar-needs-row')).toBeNull();
        expect(drawn(sidebar())).toEqual([]);
    });
});
