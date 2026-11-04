// @vitest-environment jsdom
/**
 * The Market's event card on the style box (DESIGN-market-event-cards-fable.md §2, slice P2; DESIGN-card-style-box-fable.md
 * §1): the same list card as an Offer, one press that opens the event, and no Going / Interested buttons on it (Marty, 4 Nov:
 * they live on the event's page; the card shows the member's own answer as a mark). Counts show only once someone has
 * answered; the host reads that they are hosting; the 📌 PINNED chip is in the chip row, never in the date's line.
 *
 * The real EventCard and the real style box (components/market-card-shell.ts), each host's style kept so the colours and the
 * chip's numbers can be read back, in both themes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MARKET_CARD_SHELL, MARKET_CHIP } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, style, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        attrs['data-style'] = JSON.stringify(Object.assign({}, ...[style].flat(6).filter((x: unknown) => x && typeof x === 'object')));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('div'), ScrollView: el('div'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert: vi.fn() },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: vi.fn() },
    };
});
// The picture as a phone draws it: mounted, with its URL; the tile holds the slot until it has drawn.
vi.mock('expo-image', () => ({ Image: ({ source }: { source?: { uri?: string } }) => createElement('img', { 'data-src': source?.uri }) }));
const go = vi.hoisted(() => ({ pushes: [] as unknown[] }));
vi.mock('expo-router', () => ({ router: { push: (to: unknown) => { go.pushes.push(to); }, back: vi.fn(), replace: vi.fn() } }));
const scheme = vi.hoisted(() => ({ now: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const pick = () => ({ theme: scheme.now, colors: scheme.now === 'dark' ? m.darkColors : m.lightColors });
    return { useTheme: () => pick(), useStyles: (f: any) => f(pick()) };
});
vi.mock('../db', () => ({ rsvpEvent: vi.fn(), refreshPostForPhoto: vi.fn() }));
vi.mock('../photo-refresh', () => ({ refreshListingAfterPhotoError: () => false }));

import { EventCard } from '../../components/EventCard';
import { distanceKm, eventWhen, formatDistance, formatEventWhenFor } from '../events';
import { gridTextBlock } from '../../components/market-card-shell';
import { darkColors, lightColors } from '../../constants/colors';
import * as db from '../db';

const ME = 'me'.repeat(32);
const HOST = 'host'.repeat(16);
const DAY = 86_400_000;
/** Byron's Thursday market, from Marty's shot: a place, a photo, nobody's answer yet. */
const MARKET: any = {
    id: 'ev-farmers', type: 'event', status: 'active', title: 'Byron Bay Farmers Market — Weekly Thursday',
    author_pubkey: HOST, authorCallsign: 'Byron Markets',
    eventStartAt: new Date(Date.now() + DAY).toISOString(), eventEndAt: new Date(Date.now() + DAY + 4 * 3_600_000).toISOString(),
    eventPlaceName: 'Butler Street Reserve', photos: ['https://byron.example/api/marketplace/posts/ev-farmers/photos/0?v=1'],
    goingCount: 0, interestedCount: 0, myRsvp: null,
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    scheme.now = 'light';
    go.pushes.length = 0;
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

async function show(post: any, viewer: string | null = ME) {
    await act(async () => {
        root.render(createElement(EventCard, { post, currentPubkey: viewer }) as unknown as Parameters<Root['render']>[0]);
        await new Promise((r) => setTimeout(r, 0));
    });
}
const card = () => host.querySelector('[data-testid="event-card-ev-farmers"]') as HTMLElement;
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('the event card is one press that opens the event, with no button inside it', () => {
    it('one button, the card; a press anywhere opens the event', async () => {
        await show(MARKET);
        const buttons = Array.from(host.querySelectorAll('[role=button]'));
        expect(buttons).toEqual([card()]);
        expect(host.textContent).not.toContain('Interested');
        await act(async () => { (host.querySelector('[data-testid="event-when"]') as HTMLElement).click(); });
        expect(go.pushes).toEqual(['/post/ev-farmers']);
    });

    it('a member who has answered: the card never answers for them, it shows their mark', async () => {
        await show({ ...MARKET, myRsvp: 'going', goingCount: 3, interestedCount: 1 });
        expect(Array.from(host.querySelectorAll('[role=button]'))).toEqual([card()]);
        await act(async () => { card().click(); });
        expect(db.rsvpEvent).not.toHaveBeenCalled();
    });
});

describe('the status line: the mark, the counts above zero, the host', () => {
    it('"Going ✓" from myRsvp, in the event ink, and in the card\'s label', async () => {
        await show({ ...MARKET, myRsvp: 'going', goingCount: 3, interestedCount: 1 });
        const mark = byTestId('event-mark');
        expect(mark?.textContent).toBe('Going ✓');
        expect(styleOf(mark).color).toBe(lightColors.tile.event.ink);
        expect(styleOf(mark)).toMatchObject({ fontSize: 13, fontWeight: '700' });
        // The mark is the line: no counts beside it.
        expect(byTestId('event-counts')).toBeNull();
        const when = formatEventWhenFor(MARKET);
        expect(card().getAttribute('aria-label')).toBe(`Event: ${MARKET.title}, ${when}, Going ✓`);
    });

    it('"Interested ✓" from myRsvp', async () => {
        await show({ ...MARKET, myRsvp: 'interested', goingCount: 0, interestedCount: 1 });
        expect(byTestId('event-mark')?.textContent).toBe('Interested ✓');
    });

    it('nobody\'s answer and someone has answered: "3 going · 1 interested"', async () => {
        await show({ ...MARKET, goingCount: 3, interestedCount: 1 });
        expect(byTestId('event-mark')).toBeNull();
        expect(byTestId('event-counts')?.textContent).toContain('3 going · 1 interested');
        expect(card().getAttribute('aria-label')).toBe(`Event: ${MARKET.title}, ${formatEventWhenFor(MARKET)}`);
    });

    it('nobody has answered (0 / 0): no counts line, no mark, nothing at all', async () => {
        await show(MARKET);
        expect(byTestId('event-counts')).toBeNull();
        expect(byTestId('event-mark')).toBeNull();
        expect(host.textContent).not.toContain('0 going');
    });

    it('a row that carries no counts ("Your events"): nothing', async () => {
        const { goingCount: _g, interestedCount: _i, ...noCounts } = MARKET;
        await show(noCounts);
        expect(host.textContent).not.toContain('going');
    });

    it('the host reads that they are hosting, in the mark\'s place, and never a button', async () => {
        await show({ ...MARKET, goingCount: 5, interestedCount: 2 }, HOST);
        expect(byTestId('event-mark')?.textContent).toBe("You're hosting this event");
        expect(Array.from(host.querySelectorAll('[role=button]'))).toEqual([card()]);
    });
});

describe('the chip row, and the when kept whole', () => {
    const pinned = { ...MARKET, pinnedUntil: new Date(Date.now() + 2 * DAY).toISOString(), pinnedAt: new Date(Date.now() - 60_000).toISOString() };

    it('EVENT first, then 📌 PINNED, both in the chip row; the when is its own line with nothing else in it', async () => {
        await show(pinned);
        const type = byTestId('event-type-chip')!;
        const pin = byTestId('pinned-chip')!;
        expect(type.textContent).toBe('EVENT');
        expect(pin.textContent).toBe('📌 PINNED');
        expect(type.parentElement).toBe(pin.parentElement);
        expect(Array.from(type.parentElement!.children).indexOf(type)).toBe(0);
        const when = byTestId('event-when')!;
        expect(when.textContent).toBe(formatEventWhenFor(pinned));
        expect(when.children).toHaveLength(0);
        expect(when.contains(pin)).toBe(false);
        expect(when.getAttribute('data-lines')).toBe('2');
        // The loud line: 16/900, in the event's ink.
        expect(styleOf(when)).toMatchObject({ fontSize: 16, fontWeight: '900', color: lightColors.tile.event.ink });
    });

    it.each(['light', 'dark'] as const)('%s: every chip is the one chip (10/800, 6 x 2, corners 6) in its role\'s colours', async (which) => {
        scheme.now = which;
        const colors = which === 'dark' ? darkColors : lightColors;
        const check = (id: string, tone: { bg: string; fg: string }) => {
            const chip = byTestId(id)!;
            expect(chip, id).not.toBeNull();
            expect(styleOf(chip), id).toMatchObject({
                backgroundColor: tone.bg, borderRadius: MARKET_CHIP.radius,
                paddingHorizontal: MARKET_CHIP.paddingHorizontal, paddingVertical: MARKET_CHIP.paddingVertical, flexShrink: 0,
            });
            const words = chip.firstElementChild!;
            expect(styleOf(words), id).toMatchObject({ fontSize: 10, fontWeight: '800', color: tone.fg });
            expect(words.getAttribute('data-lines'), id).toBe('1');
        };
        await show(pinned);
        check('event-type-chip', { bg: colors.tile.event.tint, fg: colors.tile.event.ink });
        check('pinned-chip', { bg: colors.accent.tint, fg: colors.accent.primary });
        // A cancelled event is no longer pinned (utils/pins): its state chip is the danger chip.
        await show({ ...MARKET, eventState: 'cancelled' });
        check('event-state-chip', { bg: colors.feedback.danger.bg, fg: colors.feedback.danger.fg });
        expect(byTestId('event-state-chip')?.textContent).toBe('CANCELLED');
    });

    it('a group-only event says who can see it in a quiet chip that wraps, never cut; with no group name, "Group", as a listing does', async () => {
        await show({ ...MARKET, audienceScope: 'group', targetGroupId: 'g-1', targetGroupName: 'Byron Bay Community Gardeners' });
        const chip = byTestId('event-group-chip');
        expect(chip?.textContent).toBe('🔒 Only Byron Bay Community Gardeners can see this');
        expect(styleOf(chip).backgroundColor).toBe(lightColors.chip.quiet.bg);
        expect(chip?.firstElementChild?.getAttribute('data-lines')).toBeNull();
        await show({ ...MARKET, targetGroupId: 'g-1' });
        expect(byTestId('event-group-chip')?.textContent).toBe('🔒 Only Group can see this');
        await show(MARKET);
        expect(byTestId('event-group-chip')).toBeNull();
    });

    it('UPDATED is the event chip', async () => {
        await show({ ...MARKET, eventState: 'updated' });
        const chip = byTestId('event-state-chip');
        expect(chip?.textContent).toBe('UPDATED');
        expect(styleOf(chip).backgroundColor).toBe(lightColors.tile.event.tint);
        expect(styleOf(chip?.firstElementChild ?? null).color).toBe(lightColors.tile.event.ink);
    });
});

describe('the shell is the Offer card\'s, from the style box', () => {
    it.each(['light', 'dark'] as const)('%s: corners 14, a 1 dp border in border.default, the card ground, no purple band', async (which) => {
        scheme.now = which;
        const colors = which === 'dark' ? darkColors : lightColors;
        await show(MARKET);
        const s = styleOf(card());
        expect(s).toMatchObject({
            borderRadius: MARKET_CARD_SHELL.radius, borderWidth: MARKET_CARD_SHELL.borderWidth, borderColor: colors.border.default,
            backgroundColor: colors.surface.card, overflow: 'hidden', marginBottom: MARKET_CARD_SHELL.gap.list, flexDirection: 'row', padding: 0,
        });
        expect(s.borderLeftWidth).toBeUndefined();
        expect(s.borderLeftColor).toBeUndefined();
    });

    it('the picture is the list slot (80 wide, stretched, under the left corners); the event tile holds it until the photo draws', async () => {
        await show(MARKET);
        const slot = card().firstElementChild!;
        expect(styleOf(slot)).toMatchObject({ width: 80, minHeight: 80, alignSelf: 'stretch', borderTopLeftRadius: 14, borderBottomLeftRadius: 14, overflow: 'hidden' });
        expect(slot.querySelector('[data-testid="category-tile"]')).not.toBeNull();
        expect(slot.textContent).toContain('📅');
        const img = card().querySelector('img');
        expect(img?.getAttribute('data-src')).toContain('/api/marketplace/posts/ev-farmers/photos/0');
        // The text column: 12 all round.
        expect(styleOf(card().lastElementChild)).toMatchObject({ flex: 1, padding: 12 });
    });

    it('the card writes no colour, radius or band of its own (the source)', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'EventCard.tsx'), 'utf8');
        // EVENT_ACCENT stays exported for the map pin and the page; nothing else on the card is a hex.
        expect(src.replace("export const EVENT_ACCENT = '#7c3aed';", '')).not.toMatch(/['"`]#[0-9a-fA-F]{3,8}['"`]/);
        expect(src).not.toMatch(/borderRadius:\s*\d/);
        expect(src).not.toMatch(/borderLeftWidth/);
        expect(src).not.toMatch(/rsvpEvent|Alert\.alert|ActivityIndicator/);
    });
});

// Slice P3' (DESIGN-market-grid-sizes-fable.md §2.2): in the grid the event is a tile like the listing beside it. The 4:3
// photo, EVENT (the one chip) at its top-left, the foot row of scrim pills (📌 PINNED, CANCELLED / UPDATED, and the member's
// own mark at the end, where a listing's price sits), then the text block market.tsx hands it, the listing tiles' own: the
// date, the time, the title and the place, one line each. The counts and the host's line are the page's in the grid.
describe("the grid tile (P3'): the listing tile's shell, the four rows, the mark on the photo", () => {
    // Tomorrow, 10:26 to 14:26 on this phone's clock: a plain same-day span whatever time the test runs at.
    const at = (h: number, m: number) => { const d = new Date(Date.now() + DAY); d.setHours(h, m, 0, 0); return d.toISOString(); };
    const SAME_DAY = { ...MARKET, eventStartAt: at(10, 26), eventEndAt: at(14, 26) };
    const pinned = { ...MARKET, pinnedUntil: new Date(Date.now() + 2 * DAY).toISOString(), pinnedAt: new Date(Date.now() - 60_000).toISOString() };
    async function showTile(post: any, viewer: string | null = ME, scale = 1.3, myLocation: { lat: number; lng: number } | null = null) {
        const block = gridTextBlock(scale);
        await act(async () => {
            root.render(createElement(EventCard, { post, currentPubkey: viewer, viewMode: 'grid', fontScale: scale, myLocation }) as unknown as Parameters<Root['render']>[0]);
            await new Promise((r) => setTimeout(r, 0));
        });
        return block;
    }
    const blockEl = () => byTestId('grid-text-block') as HTMLElement;
    const footRow = () => byTestId('grid-badge-row') as HTMLElement;

    it('one press, the tile, that opens the event; the tile fills its cell; no button inside it', async () => {
        await showTile({ ...MARKET, myRsvp: 'going', goingCount: 3, interestedCount: 1 });
        expect(Array.from(host.querySelectorAll('[role=button]'))).toEqual([card()]);
        expect(styleOf(card())).toMatchObject({ flex: 1, marginBottom: 0, borderRadius: MARKET_CARD_SHELL.radius, overflow: 'hidden' });
        await act(async () => { (byTestId('event-when') as HTMLElement).click(); });
        expect(go.pushes).toEqual(['/post/ev-farmers']);
        expect(db.rsvpEvent).not.toHaveBeenCalled();
    });

    it('the text block is the listing tiles\' own at the font scale it is given, and its rows are the date, the time, the title and the place', async () => {
        // A plain same-day span (fixed hours, so the test never depends on the time of day it runs at).
        const block = await showTile(SAME_DAY);
        expect(styleOf(blockEl())).toEqual(block.block);
        const rows = Array.from(blockEl().children);
        expect(rows).toHaveLength(4);
        // Rows 1, 3 and 4 the listing's row; row 2 the time row (call 4), the same height.
        for (const r of [rows[0], rows[2], rows[3]]) expect(styleOf(r)).toEqual(block.row);
        expect(styleOf(rows[1])).toEqual(block.timeRow);
        expect(block.timeRow.height).toBe(block.row.height);
        const parts = eventWhen(SAME_DAY)!;
        expect(parts.second).toBe('10:26–14:26');
        expect(rows.map(r => r.textContent)).toEqual([parts.first, '10:26–14:26', MARKET.title, '📍 Butler Street Reserve']);
        expect(byTestId('event-your-time')).toBeNull();
        for (const r of rows) expect(r.firstElementChild?.getAttribute('data-lines')).toBe('1');
        // The date and the time: the loud line, 14/800 on 18, in the event's ink; the title 14/700; the place 14/500.
        expect(styleOf(byTestId('event-when'))).toMatchObject({ fontSize: 14, fontWeight: '800', lineHeight: 18, color: lightColors.tile.event.ink });
        expect(styleOf(byTestId('event-time'))).toMatchObject({ fontSize: 14, fontWeight: '800', lineHeight: 18, color: lightColors.tile.event.ink });
        expect(styleOf(rows[2].firstElementChild)).toMatchObject({ fontSize: 14, fontWeight: '700', lineHeight: 18, color: lightColors.text.body });
        expect(styleOf(rows[3].firstElementChild)).toMatchObject({ fontSize: 14, fontWeight: '500', lineHeight: 18, color: lightColors.text.secondary });
    });

    // DESIGN-event-times §4 on the tile: a member never reads the place's clock as their own. A Byron event (NSW, on daylight
    // time in November) from 16:00 to 21:00, read on a Gold Coast phone (Queensland, an hour behind).
    describe('a reader whose clock is not the place\'s', () => {
        const savedTz = process.env.TZ;
        beforeEach(() => { process.env.TZ = 'Australia/Brisbane'; });
        afterEach(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });
        const BYRON: any = {
            ...MARKET, title: 'Byron Bay Twilight Market', eventPlaceName: 'Railway Park',
            eventStartAt: '2026-11-07T05:00:00.000Z', eventEndAt: '2026-11-07T10:00:00.000Z',
            eventStartLocal: '2026-11-07T16:00', eventEndLocal: '2026-11-07T21:00', eventTz: 'Australia/Sydney', eventOnline: false,
        };

        it('a Queensland reader on a NSW daylight-time event: the reader\'s own time, labelled "your time"; never the place\'s bare 16:00', async () => {
            // The list card's own note, for the same event and phone: the two must agree.
            expect(eventWhen(BYRON)!.note).toBe('Sydney time · 15:00 your time');
            await showTile(BYRON);
            const rows = Array.from(blockEl().children);
            expect(rows).toHaveLength(4);
            expect(rows.map(r => Array.from(r.children).map(c => c.textContent))).toEqual([['SAT 7 NOV'], ['15:00', '–20:00'], ['Byron Bay Twilight Market'], ['🕒 your time', '📍 Railway Park']]);
            expect(host.textContent).not.toContain('16:00');
            expect(host.textContent).not.toContain('21:00');
            // The label opens the last row as its own line, never shrunk for the place (one truncating line would put its "…"
            // inside the label at 320 dp and 1.3x); the place after it gives way, as a listing's row 4 lays out its pieces.
            const block = gridTextBlock(1.3);
            const yours = byTestId('event-your-time')!;
            expect(rows[3].firstElementChild).toBe(yours);
            expect(yours.getAttribute('data-lines')).toBe('1');
            expect(styleOf(yours)).toMatchObject({ fontSize: 14, color: lightColors.tile.event.ink, fontWeight: '700', flexShrink: 0, maxWidth: '100%' });
            expect(styleOf(rows[3])).toEqual(block.lastRow);
            expect(styleOf(rows[3].children[1])).toMatchObject({ ...block.lastRowPiece, fontSize: 14, color: lightColors.text.secondary });
            expect(rows[3].children[1].getAttribute('data-lines')).toBe('1');
            // The label speaks the reader's clock too, with "your time".
            expect(card().getAttribute('aria-label')).toBe('Event: Byron Bay Twilight Market, SAT 7 NOV · 15:00–20:00 your time');
            // The lattice is untouched: four rows of the listing's height (the last laid out as a listing's), in its block.
            expect(styleOf(blockEl())).toEqual(block.block);
            for (const r of [rows[0], rows[2]]) expect(styleOf(r)).toEqual(block.row);
            expect(styleOf(rows[1])).toEqual(block.timeRow);
            expect(styleOf(rows[1]).height).toBe(block.row.height);
            expect(styleOf(rows[3]).height).toBe(block.row.height);
        });

        it('dark: the label keeps the event\'s ink of the dark theme', async () => {
            scheme.now = 'dark';
            await showTile(BYRON);
            expect(styleOf(byTestId('event-your-time'))).toMatchObject({ color: darkColors.tile.event.ink });
        });

        it('no place to name: the last row is the label alone', async () => {
            await showTile({ ...BYRON, eventPlaceName: null });
            const last = Array.from(blockEl().children)[3];
            expect(Array.from(last.children).map(c => c.textContent)).toEqual(['🕒 your time']);
        });

        it('the reader in the place\'s own zone (Byron read in Byron): the place\'s time, nothing to label', async () => {
            process.env.TZ = 'Australia/Sydney';
            await showTile(BYRON);
            expect(Array.from(blockEl().children).map(r => r.textContent)).toEqual(['SAT 7 NOV', '16:00–21:00', 'Byron Bay Twilight Market', '📍 Railway Park']);
            expect(byTestId('event-your-time')).toBeNull();
        });

        it('an event that ends the next day: the date row, then the start time row, each whole; the end is on the page', async () => {
            await showTile({
                ...BYRON, title: 'Seed swap weekend',
                eventStartAt: '2026-11-06T00:26:00.000Z', eventEndAt: '2026-11-07T02:26:00.000Z',
                eventStartLocal: '2026-11-06T10:26', eventEndLocal: '2026-11-07T12:26', eventTz: 'Australia/Brisbane',
            });
            const rows = Array.from(blockEl().children);
            expect(rows.map(r => r.textContent)).toEqual(['FRI 6 NOV', '10:26', 'Seed swap weekend', '📍 Railway Park']);
            for (const r of rows.slice(0, 2)) expect(r.firstElementChild?.getAttribute('data-lines')).toBe('1');
            // The label keeps the whole span for a screen reader.
            expect(card().getAttribute('aria-label')).toBe('Event: Seed swap weekend, FRI 6 NOV 10:26 – SAT 7 NOV 12:26');
        });

        // DESIGN-grid-event-rows call 3: every clock on the tile is the reader's own, so an online event's row 2 is the bare
        // span; "your time" would label nothing there. The tile's label keeps it, as the list card's line does.
        it('(c) an online event: row 2 the reader\'s own span, "your time" in no row; the label in the tile\'s name; row 4 Online', async () => {
            const ONLINE = { ...BYRON, title: 'Seed library call', eventPlaceName: null, eventOnline: true, event_online: 1 };
            await showTile(ONLINE);
            const rows = Array.from(blockEl().children);
            expect(rows.map(r => Array.from(r.children).map(c => c.textContent))).toEqual([['SAT 7 NOV'], ['15:00', '–20:00'], ['Seed library call'], ['💻 Online']]);
            expect(blockEl().textContent).not.toContain('your time');
            expect(card().textContent).not.toContain('your time');
            expect(byTestId('event-your-time')).toBeNull();
            expect(card().getAttribute('aria-label')).toBe('Event: Seed library call, SAT 7 NOV · 15:00–20:00 your time');
            // Read on the host's own clock too: the bare span, no label in any row.
            process.env.TZ = 'Australia/Sydney';
            await showTile(ONLINE);
            expect(Array.from(blockEl().children).map(r => r.textContent)).toEqual(['SAT 7 NOV', '16:00–21:00', 'Seed library call', '💻 Online']);
            expect(card().textContent).not.toContain('your time');
        });

        it('an event that ends the next day, read across the zone line: the reader\'s own start, labelled', async () => {
            await showTile({
                ...BYRON, eventStartAt: '2026-11-05T23:26:00.000Z', eventEndAt: '2026-11-07T01:26:00.000Z',
                eventStartLocal: '2026-11-06T10:26', eventEndLocal: '2026-11-07T12:26',
            });
            const rows = Array.from(blockEl().children);
            expect(rows.map(r => r.textContent)).toEqual(['FRI 6 NOV', '9:26', 'Byron Bay Twilight Market', '🕒 your time📍 Railway Park']);
            expect(byTestId('event-your-time')?.textContent).toBe('🕒 your time');
        });
    });

    // DESIGN-grid-event-rows call 1: the lock is a 🔒 glyph pill on the photo's foot, after CANCELLED / UPDATED and before the
    // mark; its name is the whole sentence. Row 4 keeps the place.
    it.each(['light', 'dark'] as const)('(a) %s: a group-only event has a 🔒 pill on the foot named with the whole sentence; row 4 still the place', async (which) => {
        scheme.now = which;
        const colors = which === 'dark' ? darkColors : lightColors;
        // A group-only post is never pinned (pinLive: a pin is for everyone), so the foot reads UPDATED · 🔒 · the mark.
        const GROUP = { ...SAME_DAY, eventState: 'updated', myRsvp: 'going', audienceScope: 'group', targetGroupId: 'g-1', targetGroupName: 'Byron Bay Community Gardeners' };
        await showTile(GROUP);
        const foot = footRow();
        expect(Array.from(foot.children).map(c => c.getAttribute('data-testid'))).toEqual(['event-state-chip', 'event-group-chip', 'event-mark']);
        const pill = byTestId('event-group-chip')!;
        expect(pill.textContent).toBe('🔒');
        expect(pill.getAttribute('aria-label')).toBe('🔒 Only Byron Bay Community Gardeners can see this');
        // The quiet pill: shell.gridBadge and shell.gridPinText, as UPDATED beside it (and 📌 PINNED on a public event).
        expect(styleOf(pill)).toEqual(styleOf(byTestId('event-state-chip')));
        expect(styleOf(pill.firstElementChild)).toEqual(styleOf(byTestId('event-state-chip')!.firstElementChild));
        expect(styleOf(pill)).toMatchObject({ backgroundColor: colors.overlay.scrim, borderColor: colors.overlay.scrimEdge, borderRadius: 8 });
        expect(styleOf(pill.firstElementChild)).toMatchObject({ fontSize: 10, fontWeight: '700', color: colors.text.inverse });
        // Row 4 is the place, unchanged; the sentence is in no row.
        const rows = Array.from(blockEl().children);
        expect(rows).toHaveLength(4);
        expect(rows[3].textContent).toBe('📍 Butler Street Reserve');
        expect(blockEl().textContent).not.toContain('Only');
        // A screen reader hears it on the tile, which is the one thing it reads (a button's name is its own).
        expect(card().getAttribute('aria-label')).toBe(`Event: ${MARKET.title}, ${formatEventWhenFor(SAME_DAY)}, updated, 🔒 Only Byron Bay Community Gardeners can see this, Going ✓`);
        // No group name: "Group", as the list card and a listing read it. No lock: no pill.
        await showTile({ ...SAME_DAY, targetGroupId: 'g-1' });
        expect(byTestId('event-group-chip')?.getAttribute('aria-label')).toBe('🔒 Only Group can see this');
        await showTile(SAME_DAY);
        expect(byTestId('event-group-chip')).toBeNull();
    });

    // DESIGN-grid-event-rows call 2: a copy on global says where it is from in row 4, in the place's stead, with the distance.
    it('(b) a copy on global: row 4 is "from {community} · {distance}", no place name and no pin glyph', async () => {
        const HERE = { lat: -28.64, lng: 153.61 };
        const COPY = {
            ...SAME_DAY, eventPlaceName: 'Heritage Park', lat: -28.53, lng: 153.5,
            shownCopy: true, shownFrom: { host: 'mullum.example', postId: 'ev-1', name: 'Mullumbimby', url: 'https://mullum.example', door: 'ask' },
        };
        const km = formatDistance(distanceKm(HERE.lat, HERE.lng, COPY.lat, COPY.lng));
        expect(km).toMatch(/km$/);
        await showTile(COPY, ME, 1.3, HERE);
        const rows = Array.from(blockEl().children);
        expect(rows).toHaveLength(4);
        expect(rows[3].textContent).toBe(`from Mullumbimby · ${km}`);
        expect(card().textContent).not.toContain('Heritage Park');
        expect(rows[3].textContent).not.toContain('📍');
        // No distance known: the community alone.
        await showTile(COPY);
        expect(Array.from(blockEl().children)[3].textContent).toBe('from Mullumbimby');
        // A copy that names no community (an unreadable cached column): the place line, as before.
        await showTile({ ...SAME_DAY, eventPlaceName: 'Heritage Park', shown_from: 'not json' });
        expect(Array.from(blockEl().children)[3].textContent).toBe('📍 Heritage Park');
    });

    // DESIGN-grid-event-rows call 4: the span is two whole pieces in a row that wraps and clips (gridBlock.timeRow), so a row
    // with no room for the end drops it whole (market-card-height-layout.test.ts lays it out).
    it('(d) the time row is two Texts, the start and then the end with its dash, each whole and one line; a lone start is one', async () => {
        const block = await showTile(SAME_DAY);
        const row = byTestId('event-time-row')!;
        expect(styleOf(row)).toEqual(block.timeRow);
        expect(block.timeRow).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', alignContent: 'flex-start', overflow: 'hidden', height: block.row.height });
        const pieces = Array.from(row.children);
        expect(pieces.map(x => x.tagName)).toEqual(['SPAN', 'SPAN']);
        expect(pieces.map(x => x.textContent)).toEqual(['10:26', '–14:26']);
        expect(pieces[0].textContent).not.toMatch(/[–-]/);
        for (const x of pieces) {
            expect(x.getAttribute('data-lines')).toBe('1');
            expect(styleOf(x)).toMatchObject({ fontSize: 14, fontWeight: '800', lineHeight: 18, color: lightColors.tile.event.ink, flexShrink: 0 });
        }
        // Cancelled: both pieces struck through.
        await showTile({ ...SAME_DAY, eventState: 'cancelled' });
        for (const id of ['event-time', 'event-time-end']) expect(styleOf(byTestId(id))).toMatchObject({ textDecorationLine: 'line-through' });
        // A start with no end of its own: the phone's default end, still a span; an event that ends the next day: one piece.
        const twoDay = { ...SAME_DAY, eventEndAt: new Date(new Date(SAME_DAY.eventStartAt).getTime() + DAY).toISOString() };
        await showTile(twoDay);
        expect(Array.from(byTestId('event-time-row')!.children).map(x => x.textContent)).toEqual(['10:26']);
        expect(byTestId('event-time-end')).toBeNull();
    });

    // #2879: the map's pin card (MapPreviewCard) is this card with `popUp`, and it is always the list card. The props refuse
    // `popUp` beside `viewMode: 'grid'` (the type check below), and a pin card handed both anyway still draws the list card.
    it('a pin card (popUp) is the list card, never the grid tile, whatever it is handed', async () => {
        // @ts-expect-error the grid tile is never the map's pin card: `popUp` is the list card's alone
        const both: Parameters<typeof EventCard>[0] = { post: MARKET, viewMode: 'grid', fontScale: 1.3, popUp: { onOpen: () => {} } };
        expect(both.viewMode).toBe('grid');
        const onOpen = vi.fn();
        await act(async () => {
            root.render(createElement(EventCard, { post: MARKET, currentPubkey: ME, viewMode: 'grid', fontScale: 1.3, popUp: { onOpen } } as any) as unknown as Parameters<Root['render']>[0]);
            await new Promise((r) => setTimeout(r, 0));
        });
        const pin = byTestId('map-preview-open') as HTMLElement;
        expect(pin).not.toBeNull();
        expect(byTestId('grid-text-block')).toBeNull();
        expect(byTestId('grid-badge-row')).toBeNull();
        expect(styleOf(pin)).toMatchObject({ flexDirection: 'row', padding: 0 });
        expect(pin.getAttribute('aria-label')).toBe(`Open event: ${MARKET.title}`);
        await act(async () => { pin.click(); });
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(go.pushes).toEqual([]);
        // And the map's own card asks for no view at all: it is the list card by default.
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'MapPreviewCard.tsx'), 'utf8');
        const call = src.match(/<EventCard\b[^>]*\/>/g) ?? [];
        expect(call).toHaveLength(1);
        expect(call[0]).toContain('popUp=');
        expect(call[0]).not.toMatch(/viewMode|fontScale/);
    });

    it('an online event says so on its last row; an event with no place leaves the row blank, the block the same', async () => {
        await showTile({ ...MARKET, eventPlaceName: null, eventOnline: true, event_online: 1 });
        expect(Array.from(blockEl().children)[3].textContent).toBe('💻 Online');
        await showTile({ ...MARKET, eventPlaceName: null });
        const rows = Array.from(blockEl().children);
        expect(rows).toHaveLength(4);
        expect(rows[3].textContent).toBe('');
    });

    it.each(['light', 'dark'] as const)('%s: the picture is the 4:3 frame with EVENT, the one chip, at its top-left', async (which) => {
        scheme.now = which;
        const colors = which === 'dark' ? darkColors : lightColors;
        await showTile(MARKET);
        const frame = blockEl().previousElementSibling!;
        expect(styleOf(frame)).toEqual({ position: 'relative', width: '100%', aspectRatio: 4 / 3 });
        expect(frame.querySelector('img')?.getAttribute('data-src')).toContain('/api/marketplace/posts/ev-farmers/photos/0');
        const chip = byTestId('event-type-chip')!;
        expect(frame.contains(chip)).toBe(true);
        expect(styleOf(chip.parentElement)).toEqual({ position: 'absolute', top: 8, left: 8 });
        expect(styleOf(chip)).toMatchObject({ backgroundColor: colors.tile.event.tint, borderRadius: MARKET_CHIP.radius, paddingHorizontal: MARKET_CHIP.paddingHorizontal, paddingVertical: MARKET_CHIP.paddingVertical });
        expect(styleOf(chip.firstElementChild)).toMatchObject({ fontSize: 10, fontWeight: '800', color: colors.tile.event.ink });
        expect(chip.textContent).toBe('EVENT');
    });

    it.each(['light', 'dark'] as const)('%s: the member\'s mark is the loud pill at the foot\'s end, white on the scrim; 📌 PINNED a quiet pill before it', async (which) => {
        scheme.now = which;
        const colors = which === 'dark' ? darkColors : lightColors;
        await showTile({ ...pinned, myRsvp: 'going', goingCount: 3, interestedCount: 1 });
        const foot = footRow();
        expect(Array.from(foot.children).map(c => c.textContent)).toEqual(['📌 PINNED', 'Going ✓']);
        const mark = byTestId('event-mark')!;
        expect(styleOf(mark)).toMatchObject({ backgroundColor: colors.overlay.scrim, borderColor: colors.overlay.scrimEdge, borderRadius: 8, marginLeft: 'auto' });
        expect(styleOf(mark.firstElementChild)).toMatchObject({ fontSize: 13, fontWeight: '700', color: colors.text.inverse });
        expect(mark.firstElementChild?.getAttribute('data-lines')).toBe('1');
        const pin = byTestId('pinned-chip')!;
        expect(styleOf(pin)).toMatchObject({ backgroundColor: colors.overlay.scrim, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 });
        expect(styleOf(pin.firstElementChild)).toMatchObject({ fontSize: 10, fontWeight: '700', color: colors.text.inverse });
        // The counts are the page's in the grid; the label says what the tile shows.
        expect(byTestId('event-counts')).toBeNull();
        expect(host.textContent).not.toContain('going ·');
        expect(card().getAttribute('aria-label')).toBe(`Event: ${MARKET.title}, ${formatEventWhenFor(MARKET)}, Going ✓`);
    });

    it('"Interested ✓" for an interested member; nothing on the photo\'s foot while nobody has answered', async () => {
        await showTile({ ...MARKET, myRsvp: 'interested', interestedCount: 1 });
        expect(byTestId('event-mark')?.textContent).toBe('Interested ✓');
        await showTile({ ...MARKET, goingCount: 4, interestedCount: 2 });
        expect(footRow().children).toHaveLength(0);
        expect(card().getAttribute('aria-label')).toBe(`Event: ${MARKET.title}, ${formatEventWhenFor(MARKET)}`);
    });

    it('the host: no mark and no hosting line on the tile (the page says it), and still no button', async () => {
        await showTile({ ...MARKET, myRsvp: 'going', goingCount: 5, interestedCount: 2 }, HOST);
        expect(byTestId('event-mark')).toBeNull();
        expect(host.textContent).not.toContain("You're hosting this event");
        expect(Array.from(host.querySelectorAll('[role=button]'))).toEqual([card()]);
    });

    it('CANCELLED is a quiet pill on the photo and the date and time are struck through; UPDATED a quiet pill', async () => {
        await showTile({ ...MARKET, eventState: 'cancelled' });
        expect(byTestId('event-state-chip')?.textContent).toBe('CANCELLED');
        expect(footRow().contains(byTestId('event-state-chip'))).toBe(true);
        for (const id of ['event-when', 'event-time']) expect(styleOf(byTestId(id))).toMatchObject({ textDecorationLine: 'line-through', color: lightColors.text.secondary });
        expect(card().getAttribute('aria-label')).toBe(`Event: ${MARKET.title}, ${formatEventWhenFor(MARKET)}, cancelled`);
        await showTile({ ...MARKET, eventState: 'updated' });
        expect(byTestId('event-state-chip')?.textContent).toBe('UPDATED');
        expect(styleOf(byTestId('event-when')).textDecorationLine).toBeUndefined();
    });

    it('outside the grid the list card is unchanged: list and compact draw it (the compact row is slice C1)', async () => {
        for (const viewMode of ['list', 'compact'] as const) {
            await act(async () => {
                root.render(createElement(EventCard, { post: MARKET, currentPubkey: ME, viewMode }) as unknown as Parameters<Root['render']>[0]);
                await new Promise((r) => setTimeout(r, 0));
            });
            expect(byTestId('grid-text-block'), viewMode).toBeNull();
            expect(styleOf(card()), viewMode).toMatchObject({ flexDirection: 'row', padding: 0 });
        }
    });
});
