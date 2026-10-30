/**
 * Your garden G0 on the web (grow-food slice G0: the planting guide), drawn through the Tools page with the tool as the
 * registry ships it: the zone line in plain words from a place the community's server already tells the member (its
 * Home answer's community place, else the member's area; the browser's position is never asked), Change, the crop
 * page, every word through t() in the pseudo-locale, and both doors: the Tools page's row (the Commons tab's Tools and
 * Home's Your shop and tools open that page) and Home's card, which Add a card offers on every node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GARDEN, HOME_CARD_TYPES, TOOLS, toolHomeCardType } from '@beanpool/core';
import { ToolsPage, type ToolsPageProps } from '../../../pages/ToolsPage';
import { TOOL_APPS } from '../../index';
import { ToolHomeCard } from '../../home-card';
import { readToolRecord, resetToolStoreForTest, writeToolRecord } from '../../store';
import { PLACE_WAIT_MS, resetPlacesForTest } from '../../builder';
import { homeCacheKey, resetHomeCacheForTest, writeCachedHome } from '../../../lib/home-cache';
import { memoryIndexedDB } from '../../../lib/memory-indexeddb';
import { endAccountEpoch, resetAccountEpochForTest } from '../../../lib/account-epoch';
import { backToEnglish, bypassing, showIn } from '../../../words-xx.test-support';

// The community's server's Home answer, as getHome reads it: only the Your community card is asked for. `hang`: a
// request the network never answers (it settles only when let go).
const home = vi.hoisted(() => ({ answer: null as null | Record<string, unknown>, asked: [] as unknown[], hang: false, signals: [] as (AbortSignal | undefined)[] }));
vi.mock('../../../lib/api', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../../lib/api')>();
    return {
        ...real,
        getHome: async (params: unknown, _etag?: unknown, signal?: AbortSignal) => {
            home.asked.push(params);
            home.signals.push(signal);
            if (home.hang) return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('let go'))));
            if (!home.answer) throw new Error('offline');
            return { notModified: false, answer: home.answer, etag: null };
        },
    };
});
vi.mock('../../../lib/features', () => ({ useCommunityInfo: () => null }));

const OWNER = 'garden-web-owner';
const identity = { publicKey: OWNER, privateKey: '', callsign: 'Robin', createdAt: '2026-10-01T00:00:00.000Z' };
const NOW = Date.parse('2026-10-20T09:00:00.000Z');
const answer = (place: { lat: number; lng: number } | null, area: { lat: number; lng: number } | null = null) => ({
    profile: 'local', generatedAt: '', features: {}, me: area ? { area } : null, cards: place ? { community: { place } } : {},
});

/** This browser's IndexedDB, a stand-in that can refuse a write as a full disk does (failNextCommit). */
let idb: ReturnType<typeof memoryIndexedDB>;

beforeEach(() => {
    localStorage.clear();
    idb = memoryIndexedDB();
    vi.stubGlobal('indexedDB', idb);
    resetToolStoreForTest();
    resetAccountEpochForTest();
    resetHomeCacheForTest();
    resetPlacesForTest();
    home.answer = null;
    home.asked.length = 0;
    home.hang = false;
    home.signals.length = 0;
});
afterEach(() => {
    cleanup();
    backToEnglish();
    vi.unstubAllGlobals();
});

function draw(open: ToolsPageProps['open'], over: Partial<ToolsPageProps> = {}) {
    const props: ToolsPageProps = {
        identity, open, onOpen: vi.fn(), onClose: vi.fn(), onComposer: vi.fn(), onGuide: vi.fn(), onAddHomeCard: vi.fn(),
        tools: TOOLS, apps: TOOL_APPS, now: () => NOW, ...over,
    };
    return { props, ...render(<ToolsPage {...props} />) };
}
const openGuide = async () => {
    draw({ id: 'garden', screen: 'main', key: null });
    // Nothing chosen yet, so the document is empty: the guide itself is the first open, never the template's doors.
    return screen.findByTestId('garden-zone-line');
};

describe('Your garden on the web: the guide is the first open, from every door (review of #2618)', () => {
    /** Nothing of the template's empty state sits in front of, or above, the guide. */
    const noDoors = () => {
        for (const id of ['tool-doors', 'tool-door-already', 'tool-door-starting', 'tool-examples', 'tool-home-offer']) {
            expect(screen.queryByTestId(id), id).toBeNull();
        }
    };

    it("the Tools row: with a place, the guide is the first thing drawn, and no door or examples card comes before it", async () => {
        home.answer = answer({ lat: -28.55, lng: 153.5 });
        draw({ id: 'garden', screen: 'main', key: null });
        // The first thing drawn that isn't "Loading..." is the guide's zone line: the doors are never drawn at all.
        expect((await screen.findByTestId('garden-zone-line')).textContent).toContain('Warm temperate · southern hemisphere');
        noDoors();
    });

    it("the Home card's open: the same guide whether the member had chosen a climate or not, doors never there", async () => {
        home.answer = answer({ lat: -28.55, lng: 153.5 });
        // Nothing chosen: the document is empty, as in normal use.
        draw({ id: 'garden', screen: 'main', key: null });
        await screen.findByTestId('garden-zone-line');
        noDoors();
        // The card's second line opens Change itself.
        cleanup();
        draw({ id: 'garden', screen: 'zone', key: null });
        await screen.findByTestId('garden-zone-found');
        noDoors();
        // A climate chosen (the document holds it): the guide, as before.
        fireEvent.click(await screen.findByTestId('garden-zone-mild'));
        await screen.findByTestId('garden-zone-reset');
        cleanup();
        draw({ id: 'garden', screen: 'main', key: null });
        expect((await screen.findByTestId('garden-zone-line')).textContent).toContain('Mild temperate · southern hemisphere');
        noDoors();
    });

    it("with no place at all it is still the guide (asking to choose), not the doors; and it stays the guide after 'Use my place again' empties the document", async () => {
        home.answer = null;
        draw({ id: 'garden', screen: 'main', key: null });
        expect(await screen.findByTestId('garden-no-zone')).toBeTruthy();
        expect(screen.getByTestId('garden-choose')).toBeTruthy();
        noDoors();
        cleanup();
        home.answer = answer({ lat: -28.55, lng: 153.5 });
        resetPlacesForTest();
        draw({ id: 'garden', screen: 'zone', key: null });
        fireEvent.click(await screen.findByTestId('garden-zone-mild'));
        fireEvent.click(await screen.findByTestId('garden-zone-reset'));
        await screen.findByTestId('garden-zone-found');
        cleanup();
        draw({ id: 'garden', screen: 'main', key: null });
        await screen.findByTestId('garden-zone-line');
        noDoors();
    });

    it("the Tool shed, which names no `doors`, still opens on the template's doors", async () => {
        draw({ id: 'things', screen: 'main', key: null });
        expect(await screen.findByTestId('tool-doors')).toBeTruthy();
        expect(screen.getByTestId('tool-door-already')).toBeTruthy();
    });
});

describe('Your garden on the web: the guide', () => {
    it("draws the zone line in plain words from the community's place, with Change, Sow now and the map's credit", async () => {
        home.answer = answer({ lat: -28.55, lng: 153.5 }); // Mullumbimby
        const line = await openGuide();
        expect(line.textContent).toContain('Warm temperate · southern hemisphere');
        expect(screen.getByTestId('garden-zone-source').textContent).toContain("From your community's place.");
        expect(screen.getByTestId('garden-now')).toBeTruthy();
        expect(screen.getByTestId('garden-all').textContent).toContain('Tomatoes');
        expect(document.body.textContent).toContain('Climate map: Beck et al. (2023), CC BY 4.0');
        expect(document.body.textContent).toContain('A general guide for your climate. Your neighbours know your patch better.');
        // Only the Your community card was asked for, and no place was sent with it.
        expect(home.asked).toEqual([{ cards: ['community'] }]);
    });

    it("takes the member's area when the community has no place, and asks to choose when there is neither", async () => {
        home.answer = answer(null, { lat: 51.5, lng: -0.1 }); // London
        const line = await openGuide();
        expect(line.textContent).toContain('Mild temperate · northern hemisphere');
        expect(screen.getByTestId('garden-zone-source').textContent).toContain('From your area.');
        cleanup();
        resetPlacesForTest(); // a page loaded again: it remembers no place the server told the last one
        home.answer = null; // the server can't be reached
        draw({ id: 'garden', screen: 'main', key: null });
        expect(await screen.findByTestId('garden-no-zone')).toBeTruthy();
        expect(screen.getByTestId('garden-choose')).toBeTruthy();
    });

    it("reads the Home answer this browser kept first, so nothing is asked; the server only when that holds no place", async () => {
        const keep = (a: ReturnType<typeof answer>) => writeCachedHome(homeCacheKey(OWNER), {
            answer: a as never, etag: null, layout: null, layoutUnsaved: false, savedAt: NOW,
        });
        await keep(answer({ lat: -28.55, lng: 153.5 })); // Mullumbimby, from the last Home this browser showed
        home.answer = answer(null, { lat: 51.5, lng: -0.1 }); // the server would say London
        const line = await openGuide();
        expect(line.textContent).toContain('Warm temperate · southern hemisphere');
        expect(screen.getByTestId('garden-zone-source').textContent).toContain("From your community's place.");
        expect(home.asked).toEqual([]);
        cleanup();
        await keep(answer(null)); // a kept Home with no place in it
        const again = await openGuide();
        expect(again.textContent).toContain('Mild temperate · northern hemisphere');
        expect(home.asked).toEqual([{ cards: ['community'] }]);
    });

    it("a place the server told this page serves every screen: a crop and Change open on it, ask nothing, and a dropped connection can't lose it", async () => {
        home.answer = answer({ lat: -28.55, lng: 153.5 }); // nothing kept in this browser: the server is asked
        const line = await openGuide();
        expect(line.textContent).toContain('Warm temperate · southern hemisphere');
        expect(home.asked).toEqual([{ cards: ['community'] }]);
        home.answer = null; // the connection drops: another ask would fail
        fireEvent.click(screen.getByTestId('garden-all-tomato'));
        expect((await screen.findByTestId('garden-crop-zone')).textContent).toBe('Warm temperate · southern hemisphere');
        expect(screen.getByTestId('garden-crop-sow')).toBeTruthy();
        expect(screen.queryByTestId('garden-choose')).toBeNull();
        cleanup();
        draw({ id: 'garden', screen: 'main', key: null });
        fireEvent.click(await screen.findByTestId('garden-change'));
        expect((await screen.findByTestId('garden-zone-found')).textContent).toContain('Warm temperate · southern hemisphere');
        expect(home.asked).toHaveLength(1);
    });

    it("no place is never remembered, so the next open asks again; nor is a place told before the account's copies were cleared", async () => {
        home.answer = null; // the server can't be reached
        draw({ id: 'garden', screen: 'main', key: null });
        expect(await screen.findByTestId('garden-no-zone')).toBeTruthy();
        cleanup();
        home.answer = answer(null, { lat: 51.5, lng: -0.1 }); // back, with London as the member's area
        expect((await openGuide()).textContent).toContain('Mild temperate · northern hemisphere');
        expect(home.asked).toHaveLength(2);
        cleanup();
        // Force Clear & Re-Sync (or leaving the community): what this page was told before it is not taken again.
        endAccountEpoch('cleared');
        home.answer = null;
        draw({ id: 'garden', screen: 'main', key: null });
        expect(await screen.findByTestId('garden-no-zone')).toBeTruthy();
        expect(home.asked).toHaveLength(3);
    });

    it("a server that never answers doesn't hold the guide: Choose your climate comes at the wait's end, the request let go", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            home.hang = true;
            draw({ id: 'garden', screen: 'main', key: null });
                expect(await screen.findByTestId('garden-finding')).toBeTruthy();
            await act(async () => { await vi.advanceTimersByTimeAsync(PLACE_WAIT_MS); });
            expect(await screen.findByTestId('garden-no-zone')).toBeTruthy();
            expect(screen.getByTestId('garden-choose')).toBeTruthy();
            expect(home.signals.length).toBeGreaterThan(0);
            expect(home.signals.every((sig) => sig?.aborted === true)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("Change keeps the member's own choice in this browser, which beats the place; Use my place again clears it", async () => {
        home.answer = answer({ lat: -28.55, lng: 153.5 });
        await openGuide();
        fireEvent.click(screen.getByTestId('garden-change'));
        expect((await screen.findByTestId('garden-zone-found')).textContent).toContain('Warm temperate · southern hemisphere');
        fireEvent.click(screen.getByTestId('garden-zone-mild'));
        await waitFor(() => expect(screen.getByTestId('garden-zone-line').textContent).toContain('Mild temperate · southern hemisphere'));
        expect(screen.getByTestId('garden-zone-source').textContent).toContain('You chose this.');
        const kept = await readToolRecord(OWNER, 'garden');
        expect(JSON.parse(kept!.body)).toEqual({ v: 1, settings: { zone: 'mild', hemisphere: 'south' } });
        fireEvent.click(screen.getByTestId('garden-change'));
        fireEvent.click(await screen.findByTestId('garden-zone-reset'));
        await waitFor(() => expect(screen.getByTestId('garden-zone-line').textContent).toContain('Warm temperate · southern hemisphere'));
        expect(JSON.parse((await readToolRecord(OWNER, 'garden'))!.body)).toEqual({ v: 1, settings: {} });
    });

    it('Change says "(chosen)" only of the member\'s own choice, never of the zone the place gives', async () => {
        home.answer = answer({ lat: -28.55, lng: 153.5 }); // gives Warm temperate · southern hemisphere
        await openGuide();
        fireEvent.click(screen.getByTestId('garden-change'));
        expect((await screen.findByTestId('garden-zone-found')).textContent).toContain('Warm temperate · southern hemisphere');
        expect(screen.getByTestId('garden-zone').textContent).not.toContain('(chosen)');
        expect(screen.getByTestId('garden-zone').textContent).not.toContain('✅');
        fireEvent.click(screen.getByTestId('garden-zone-mild'));
        await waitFor(() => expect(screen.getByTestId('garden-zone-line').textContent).toContain('Mild temperate · southern hemisphere'));
        fireEvent.click(screen.getByTestId('garden-change'));
        await screen.findByTestId('garden-zone-reset');
        expect(screen.getByTestId('garden-zone-mild').textContent).toContain('Mild temperate (chosen)');
        expect(screen.getByTestId('garden-zone-warm').textContent).not.toContain('(chosen)');
    });

    it('a second tap on Change before the first choice is kept goes back once, to the guide (the stack never empties)', async () => {
        home.answer = answer({ lat: -28.55, lng: 153.5 });
        const { props } = draw({ id: 'garden', screen: 'main', key: null });
        fireEvent.click(await screen.findByTestId('garden-change'));
        await screen.findByTestId('garden-zone-found');
        const mild = screen.getByTestId('garden-zone-mild');
        fireEvent.click(mild);
        fireEvent.click(mild);
        await waitFor(() => expect(screen.getByTestId('garden-zone-line').textContent).toContain('Mild temperate · southern hemisphere'));
        expect(props.onClose).not.toHaveBeenCalled();
        // And Use my place again, tapped twice the same way.
        fireEvent.click(screen.getByTestId('garden-change'));
        const reset = await screen.findByTestId('garden-zone-reset');
        fireEvent.click(reset);
        fireEvent.click(reset);
        await waitFor(() => expect(screen.getByTestId('garden-zone-line').textContent).toContain('Warm temperate · southern hemisphere'));
        expect(screen.getByTestId('garden-zone-source').textContent).toContain("From your community's place.");
        expect(props.onClose).not.toHaveBeenCalled();
    });

    it("a choice this browser couldn't keep says so, out loud, and stays on Change; the next tap is kept and goes back once", async () => {
        home.answer = answer({ lat: -28.55, lng: 153.5 });
        const { props } = draw({ id: 'garden', screen: 'main', key: null });
        fireEvent.click(await screen.findByTestId('garden-change'));
        await screen.findByTestId('garden-zone-found');
        idb.failNextCommit();
        fireEvent.click(screen.getByTestId('garden-zone-mild'));
        const said = await screen.findByTestId('garden-zone-problem');
        expect(said.textContent).toBe("Couldn't save it in this browser. Try again.");
        // In the region that was there, empty, before it: a screen reader hears it as it shows.
        const live = screen.getByTestId('garden-zone-problem-live');
        expect(live.getAttribute('aria-live')).toBe('polite');
        expect(live.contains(said)).toBe(true);
        expect(screen.getByTestId('garden-zone')).toBeTruthy();
        expect(JSON.parse((await readToolRecord(OWNER, 'garden'))?.body ?? '{"settings":{}}').settings).toEqual({});
        // The browser keeps it now: the same row, tapped again, is kept and goes back once, to the guide.
        fireEvent.click(screen.getByTestId('garden-zone-mild'));
        await waitFor(() => expect(screen.getByTestId('garden-zone-line').textContent).toContain('Mild temperate · southern hemisphere'));
        expect(props.onClose).not.toHaveBeenCalled();
        expect(JSON.parse((await readToolRecord(OWNER, 'garden'))!.body)).toEqual({ v: 1, settings: { zone: 'mild', hemisphere: 'south' } });
        // And Use my place again, refused the same way: the same sentence, the choice kept as it was, still on Change.
        fireEvent.click(screen.getByTestId('garden-change'));
        const reset = await screen.findByTestId('garden-zone-reset');
        idb.failNextCommit();
        fireEvent.click(reset);
        expect((await screen.findByTestId('garden-zone-problem')).textContent).toBe("Couldn't save it in this browser. Try again.");
        expect(screen.getByTestId('garden-zone-mild').textContent).toContain('Mild temperate (chosen)');
        expect(JSON.parse((await readToolRecord(OWNER, 'garden'))!.body)).toEqual({ v: 1, settings: { zone: 'mild', hemisphere: 'south' } });
        expect(props.onClose).not.toHaveBeenCalled();
    });

    it("leaving Change while its write is still out (the page's ←, the browser's back) keeps the choice and doesn't go back a second time (review of #2618)", async () => {
        home.answer = answer({ lat: -28.55, lng: 153.5 });
        const { props } = draw({ id: 'garden', screen: 'main', key: null });
        fireEvent.click(await screen.findByTestId('garden-change'));
        await screen.findByTestId('garden-zone-found');
        const land = idb.holdNextCommit();
        fireEvent.click(screen.getByTestId('garden-zone-mild'));
        // The write is out. The page's ← pops Change, and the guide shows the choice at once.
        fireEvent.click(screen.getByTestId('tools-back'));
        expect(screen.getByTestId('garden-zone-line').textContent).toContain('Mild temperate · southern hemisphere');
        expect(screen.queryByTestId('garden-zone')).toBeNull();
        // It lands: the choice is kept, and nothing goes back again: not out of the guide, never to an empty stack.
        await act(async () => { land(); await new Promise((r) => setTimeout(r, 25)); });
        expect(screen.getByTestId('garden-zone-line').textContent).toContain('Mild temperate · southern hemisphere');
        expect(screen.getByTestId('tools-page')).toBeTruthy();
        expect(props.onClose).not.toHaveBeenCalled();
        expect(JSON.parse((await readToolRecord(OWNER, 'garden'))!.body)).toEqual({ v: 1, settings: { zone: 'mild', hemisphere: 'south' } });
    });

    it("opens a crop's page from the guide, with its windows in words and the tropics' note", async () => {
        home.answer = answer({ lat: 6.52, lng: 3.38 }); // Lagos: wet and dry tropics
        await openGuide();
        fireEvent.click(screen.getByTestId('garden-all-cassava'));
        expect((await screen.findByTestId('garden-crop-name')).textContent).toContain('Cassava');
        expect((await screen.findByTestId('garden-crop-sow')).textContent).toBe('May – Jul');
        expect(screen.getByTestId('garden-crop-note').textContent).toBe('In the tropics the rains decide more than the month does.');
    });

    it('every guide screen in the pseudo-locale: every word through t()', async () => {
        home.answer = answer({ lat: 6.52, lng: 3.38 });
        await showIn('xx');
        await openGuide();
        expect(bypassing()).toEqual([]);
        fireEvent.click(screen.getByTestId('garden-all-cassava'));
        await screen.findByTestId('garden-crop-sow');
        expect(bypassing()).toEqual([]);
        cleanup();
        await writeToolRecord(OWNER, 'garden', { body: JSON.stringify({ v: 1, settings: {} }), updatedAt: '2026-10-20T08:00:00.000Z', syncedAt: null });
        draw({ id: 'garden', screen: 'zone', key: null });
        await screen.findByTestId('garden-zone-found');
        expect(bypassing()).toEqual([]);
    });
});

describe('Your garden on the web: both doors', () => {
    it('the Tools page lists it on its shelf (the page the Commons tab and Home open), and its row opens the guide', async () => {
        const { props } = draw({ id: null, screen: 'main', key: null });
        const row = await screen.findByTestId('tools-row-garden');
        expect(row.textContent).toContain('Your garden');
        fireEvent.click(row);
        expect(props.onOpen).toHaveBeenCalledWith({ id: 'garden', screen: 'main', key: null });
    });

    it('Home: Add a card offers it on every node (global too, where the Commons tab is hidden), and its card opens the guide', async () => {
        const card = HOME_CARD_TYPES.find((c) => c.id === toolHomeCardType('garden'));
        expect(card?.name).toBe(GARDEN.name);
        expect(card?.onNode({ profile: 'global', features: { beans: false } } as never)).toBe(true);
        const onNavigate = vi.fn();
        render(<ToolHomeCard id="c1" title="Your garden" type={toolHomeCardType('garden')} publicKey={OWNER} now={NOW} onNavigate={onNavigate} />);
        const line = await screen.findByText('What to sow this month, for your climate.');
        fireEvent.click(line);
        await waitFor(() => expect(onNavigate).toHaveBeenCalled());
        expect(JSON.stringify(onNavigate.mock.calls[0])).toContain('garden');
    });

    it('Home: shows "Nothing to sow outdoors this month." when chosen climate has no crops to sow this month', async () => {
        await writeToolRecord(OWNER, 'garden', {
            body: JSON.stringify({ v: 1, settings: { zone: 'warm', hemisphere: 'north' } }),
            updatedAt: '2026-10-20T08:00:00.000Z',
            syncedAt: null,
        });
        const onNavigate = vi.fn();
        // December in northern warm temperate: 0 crops to sow
        const dec = Date.parse('2026-12-15T10:00:00.000Z');
        render(<ToolHomeCard id="c1" title="Your garden" type={toolHomeCardType('garden')} publicKey={OWNER} now={dec} onNavigate={onNavigate} />);
        const line = await screen.findByText('Nothing to sow outdoors this month.');
        expect(line).toBeTruthy();
        expect(screen.getByText('Warm temperate · northern hemisphere')).toBeTruthy();
        fireEvent.click(line);
        await waitFor(() => expect(onNavigate).toHaveBeenCalled());
        expect(JSON.stringify(onNavigate.mock.calls[0])).toContain('garden');
    });
});
