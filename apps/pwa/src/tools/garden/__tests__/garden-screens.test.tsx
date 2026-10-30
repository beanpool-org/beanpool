/**
 * Your garden G0 on the web (grow-food slice G0: the planting guide), drawn through the Tools page with the tool as the
 * registry ships it: the zone line in plain words from a place the community's server already tells the member (its
 * Home answer's community place, else the member's area; the browser's position is never asked), Change, the crop
 * page, every word through t() in the pseudo-locale, and both doors: the Tools page's row (the Commons tab's Tools and
 * Home's Your shop and tools open that page) and Home's card, which Add a card offers on every node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GARDEN, HOME_CARD_TYPES, TOOLS, toolHomeCardType } from '@beanpool/core';
import { ToolsPage, type ToolsPageProps } from '../../../pages/ToolsPage';
import { TOOL_APPS } from '../../index';
import { ToolHomeCard } from '../../home-card';
import { readToolRecord, resetToolStoreForTest, writeToolRecord } from '../../store';
import { memoryIndexedDB } from '../../../lib/memory-indexeddb';
import { resetAccountEpochForTest } from '../../../lib/account-epoch';
import { backToEnglish, bypassing, showIn } from '../../../words-xx.test-support';

// The community's server's Home answer, as getHome reads it: only the Your community card is asked for.
const home = vi.hoisted(() => ({ answer: null as null | Record<string, unknown>, asked: [] as unknown[] }));
vi.mock('../../../lib/api', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../../lib/api')>();
    return {
        ...real,
        getHome: async (params: unknown) => {
            home.asked.push(params);
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

beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetToolStoreForTest();
    resetAccountEpochForTest();
    home.answer = null;
    home.asked.length = 0;
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
    // Nothing chosen yet: the template's two doors; the guide is behind either, never a gate.
    fireEvent.click(await screen.findByTestId('tool-door-already'));
    return screen.findByTestId('garden-zone-line');
};

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
        home.answer = null; // the server can't be reached
        draw({ id: 'garden', screen: 'main', key: null });
        fireEvent.click(await screen.findByTestId('tool-door-already'));
        expect(await screen.findByTestId('garden-no-zone')).toBeTruthy();
        expect(screen.getByTestId('garden-choose')).toBeTruthy();
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

    it('a second tap on Change before the first choice is kept goes back once, to the guide (the stack never empties)', async () => {
        home.answer = answer({ lat: -28.55, lng: 153.5 });
        const { props } = draw({ id: 'garden', screen: 'main', key: null });
        fireEvent.click(await screen.findByTestId('tool-door-already'));
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

    it("opens a crop's page from the guide, with its windows in words and the tropics' note", async () => {
        home.answer = answer({ lat: 6.52, lng: 3.38 }); // Lagos: wet and dry tropics
        await openGuide();
        fireEvent.click(screen.getByTestId('garden-all-cassava'));
        expect((await screen.findByTestId('garden-crop-name')).textContent).toContain('Cassava');
        expect(screen.getByTestId('garden-crop-sow').textContent).toBe('May – Jul');
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
});
