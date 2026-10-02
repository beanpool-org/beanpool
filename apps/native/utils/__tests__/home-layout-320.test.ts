/**
 * Home holds at the floor: 320dp wide with the phone's text at 1.3x (memory product-audience-small-screens; design §9).
 * Every line wraps or is cut to its lines, never clipped sideways; buttons and chips wrap to another row rather than
 * shrinking their words; every target is at least 48dp; the tab strip still holds six labelled tabs.
 *
 * Nothing here draws a frame (vitest.config.ts): the styles are read from the components themselves and the widths are a
 * model of flexbox, as sso-button-layout.test.ts does: a generous glyph width (0.62em for a bold Latin face, 0.72em for
 * capitals, 1.25em for an emoji) at 1.3x even where the app caps text at 1.2x. The emulator check at the floor is separate.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
    View: 'View', Text: 'Text', Pressable: 'Pressable', Modal: 'Modal', ScrollView: 'ScrollView', Switch: 'Switch',
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: 'Icon' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import { lightColors } from '../../constants/colors';
import { POST_CATEGORIES } from '../../constants/categories';
import { MAX_FONT_SCALE } from '../../constants/responsive';
import { CAPTION_MAX_SCALE, HOME_TARGET_DP, HOME_THUMB_DP, homeStyles } from '../../components/home/HomeParts';
import { editHomeStyles } from '../../components/home/EditHomeSheet';
import { HOME_CARD_NAMES } from '../home-cards';
import { FAB_BAND_DP } from '../fab-band';

const SCREEN = 320;
const FONT_SCALE = 1.3;
const s = homeStyles(lightColors) as unknown as Record<string, Record<string, unknown>>;
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');

function textWidth(text: string, fontSize: number, opts: { scale?: number; caps?: boolean; letterSpacing?: number } = {}): number {
    const px = fontSize * (opts.scale ?? FONT_SCALE);
    return [...text].reduce((w, ch) => {
        if (/\p{Extended_Pictographic}/u.test(ch)) return w + 1.25 * px;
        return w + (opts.caps ? 0.72 : 0.62) * px + (opts.letterSpacing ?? 0);
    }, 0);
}
const longestWord = (text: string, fontSize: number, opts?: Parameters<typeof textWidth>[2]) =>
    Math.max(...text.split(/\s+/).filter(Boolean).map(w => textWidth(w, fontSize, opts)));

/** A card's inside at 320dp: the screen's gutters, the card's padding and its border. */
const CARD_INNER = SCREEN - 2 * num(s.card.marginHorizontal) - 2 * num(s.card.paddingHorizontal) - 2 * num(s.card.borderWidth);

describe('a card at 320dp × 1.3', () => {
    it('the inside of a card is what the design assumes (16dp gutters, 14dp padding)', () => {
        expect(CARD_INNER).toBe(258);
    });

    it('a caption\'s longest word fits beside the "…" and "Tune", at its own cap (§9: 11 pt caps, at most 1.2x)', () => {
        expect(CAPTION_MAX_SCALE).toBeLessThanOrEqual(MAX_FONT_SCALE);
        const menu = num(s.menuButton.width) + num(s.menuButton.marginRight);
        const tune = HOME_TARGET_DP;
        const room = CARD_INNER - menu - tune;
        for (const name of [...Object.values(HOME_CARD_NAMES), 'Near you', 'The worldwide community']) {
            const w = longestWord(name.toUpperCase(), num(s.caption.fontSize), { scale: CAPTION_MAX_SCALE, caps: true, letterSpacing: num(s.caption.letterSpacing) });
            expect(w, name).toBeLessThan(room);
        }
        // Long community names wrap to a second line rather than run under the "…".
        expect(s.caption.flex).toBe(1);
    });

    it('a listing row: the title beside the thumbnail keeps a long word; the OFFER/NEED badge rides on the second line', () => {
        const room = CARD_INNER - HOME_THUMB_DP - num(s.row.gap);
        expect(room).toBeGreaterThan(longestWord('Neighbourhood', num(s.rowLine.fontSize)));
        // The second line: the badge, then the price or category, which gives way first.
        const badge = textWidth('OFFER', num(s.badgeText.fontSize), { scale: 1.2, caps: true, letterSpacing: num(s.badgeText.letterSpacing) }) + 2 * num(s.badge.paddingHorizontal);
        expect(room - badge - num(s.subRow.gap)).toBeGreaterThan(longestWord('Education', num(s.rowSub.fontSize)));
        expect(s.subBeside.flexShrink).toBe(1);
        // The text takes what is left and may shrink rather than push anything out; it is cut to its lines.
        expect(s.rowText).toMatchObject({ flex: 1, minWidth: 0 });
        expect(s.badge.flexShrink).toBe(0);
        expect(s.thumb.flexShrink).toBe(0);
        const bodies = read('components/home/HomeCardBodies.tsx');
        expect(bodies).toMatch(/subBadge=\{<View style=\{\[s\.badge/);
    });

    it('every interest chip fits a card\'s width whole, so the grid wraps and no chip is cut (§9; Transport and Education too)', () => {
        const pad = 2 * num(s.chip.paddingHorizontal) + 2 * num(s.chip.borderWidth);
        for (const c of POST_CATEGORIES) {
            const w = textWidth(`${c.emoji} ${c.label} ★`, num(s.chipText.fontSize)) + pad;
            expect(w, c.label).toBeLessThanOrEqual(CARD_INNER);
        }
        expect(s.chips.flexWrap).toBe('wrap');
        expect(s.chip.flexShrink).toBe(0);
        expect(s.chip.maxWidth).toBe('100%');
    });

    it('buttons keep their words and wrap to another row (§9 "flexShrink: 0"), each fitting the card', () => {
        expect(s.buttonRow.flexWrap).toBe('wrap');
        expect(s.button.flexShrink).toBe(0);
        expect(s.button.maxWidth).toBe('100%');
        const pad = 2 * num(s.button.paddingHorizontal) + 2 * num(s.button.borderWidth);
        for (const label of ['Post an Offer', 'Invite someone', 'Open the Market', 'Try again', 'Connect']) {
            expect(textWidth(label, num(s.buttonText.fontSize)) + pad, label).toBeLessThanOrEqual(CARD_INNER);
        }
    });

    it('Find your community\'s actions on Home (H4) keep their words: whole on a row, or (the long one) wrapping inside its button, never cut', () => {
        const pad = 2 * num(s.button.paddingHorizontal) + 2 * num(s.button.borderWidth);
        for (const label of ['Communities near you', 'Start a community']) {
            expect(textWidth(label, num(s.buttonText.fontSize)) + pad, label).toBeLessThanOrEqual(CARD_INNER);
        }
        // Wider than a card at 1.3x: it takes two lines inside its button (the button's text has no line limit, and the
        // button is never wider than the card), each word whole. The on-device check at the floor is in the PR.
        const tell = 'Tell me when one starts here';
        expect(textWidth(tell, num(s.buttonText.fontSize)) + pad).toBeGreaterThan(CARD_INNER);
        expect(longestWord(tell, num(s.buttonText.fontSize)) + pad).toBeLessThanOrEqual(CARD_INNER);
        expect(read('components/home/HomeParts.tsx')).toMatch(/<Text style=\{\[s\.buttonText, primary && s\.buttonTextPrimary\]\}>\{text\}<\/Text>/);
        const body = read('components/home/FindCommunityBody.tsx');
        expect(body).toMatch(/<FabAware id="find:actions" style=\{s\.buttonRow\}>/);
        expect(body.match(/<HomeButton /g)).toHaveLength(3);
        // No touchable of its own below Home's floor: every action is a HomeButton (48dp).
        expect(body).not.toMatch(/<Pressable|minHeight: 44/);
    });

    it('First steps\' global lines (H4) fit their two lines beside the box; the limits sentence wraps with no limit', () => {
        const box = textWidth('☐', 18);
        const room = CARD_INNER - box - num(s.row.gap);
        for (const line of ['Post something free or for swap', 'Ask a community to let you in']) {
            expect(textWidth(line, num(s.rowLine.fontSize)), line).toBeLessThanOrEqual(2 * room);
        }
        expect(read('components/home/HomeCardBodies.tsx')).toMatch(/\{!!note && <Text style=\{\[s\.note, \{ marginTop: 4 \}\]\} testID="home-steps-limits">\{note\}<\/Text>\}/);
    });

    it('every target is at least 48dp (§8)', () => {
        expect(HOME_TARGET_DP).toBe(48);
        expect(num(s.row.minHeight)).toBeGreaterThanOrEqual(48);
        expect(num(s.link.minHeight)).toBeGreaterThanOrEqual(48);
        expect(num(s.button.minHeight)).toBeGreaterThanOrEqual(48);
        expect(num(s.chip.minHeight)).toBeGreaterThanOrEqual(48);
        expect(num(s.menuButton.width)).toBeGreaterThanOrEqual(48);
        expect(num(s.menuButton.height)).toBeGreaterThanOrEqual(48);
        expect(num(s.captionRow.minHeight)).toBeGreaterThanOrEqual(48);
    });

    it('the last card can scroll clear of "+ ADD POST": Home leaves at least the button\'s band under it', () => {
        const home = read('app/(tabs)/index.tsx');
        const pad = Number(/content: \{ paddingBottom: (\d+) \}/.exec(home)?.[1]);
        expect(pad).toBeGreaterThanOrEqual(FAB_BAND_DP);
    });
});

describe('Edit home at 320dp × 1.3', () => {
    const e = editHomeStyles as unknown as Record<string, Record<string, unknown>>;
    it('a card\'s name keeps its longest word beside the two arrows and the switch', () => {
        const SWITCH = 52;
        const room = SCREEN - 2 * num(e.list.paddingHorizontal) - 2 * num(e.arrow.width) - SWITCH - 3 * num(e.row.gap);
        for (const name of [...Object.values(HOME_CARD_NAMES), 'Near you']) {
            expect(longestWord(name, num(e.name.fontSize)), name).toBeLessThan(room);
        }
        expect(e.rowText).toMatchObject({ flex: 1, minWidth: 0 });
        expect(e.arrow.flexShrink).toBe(0);
        expect(num(e.arrow.height)).toBeGreaterThanOrEqual(48);
        expect(num(e.reset.minHeight)).toBeGreaterThanOrEqual(48);
        expect(num(e.done.minHeight)).toBeGreaterThanOrEqual(48);
    });

    it('each up and down arrow is a 48dp target both ways, not only in height (PR #1483 review 4165384018)', () => {
        expect(num(e.arrow.width)).toBeGreaterThanOrEqual(HOME_TARGET_DP);
        expect(num(e.arrow.height)).toBeGreaterThanOrEqual(HOME_TARGET_DP);
        expect(HOME_TARGET_DP).toBeGreaterThanOrEqual(48);
    });
});

describe('the tab strip: Home · Market · Map · Talk · Commons · Ledger', () => {
    const layout = read('app/(tabs)/_layout.tsx');
    const screens = [...layout.matchAll(/<Tabs\.Screen\s+name="([^"]+)"([\s\S]*?)\/>\s*(?=<Tabs\.Screen|\{\/\*|<\/Tabs>)/g)].map(m => ({ name: m[1], body: m[2] }));
    const onStrip = screens.filter(x => !/href: null/.test(x.body) || /hiddenTabs\.includes/.test(x.body));

    it('six labelled tabs in the design\'s order; Pulse, People and Settings are routes off the strip', () => {
        expect(onStrip.map(x => x.name)).toEqual(['index', 'market', 'map', 'chats', 'projects', 'ledger']);
        expect(screens.find(x => x.name === 'pulse')!.body).toMatch(/href: null/);
        expect(screens.find(x => x.name === 'people')!.body).toMatch(/href: null/);
        expect(screens.find(x => x.name === 'settings')!.body).toMatch(/href: null/);
        expect(screens.find(x => x.name === 'index')!.body).toMatch(/<TabItem label="Home"/);
        expect(screens.find(x => x.name === 'index')!.body).toMatch(/tabBarButtonTestID: 'tab-home'/);
    });

    it('the Market\'s tab still carries the deals count, and still answers to tab-market', () => {
        const market = screens.find(x => x.name === 'market')!.body;
        expect(market).toMatch(/<TabItem label="Market" icon="🤝" focused=\{focused\} color=\{color\} count=\{dealsCount\} \/>/);
        expect(market).toMatch(/tabBarButtonTestID: 'tab-market'/);
        // The count is the same rule as the Market's own pill (MyDealsSheet usePendingDealsCount), set from the database.
        expect(layout).toMatch(/setDealsCount\(active\)/);
    });

    it('"Home" is no wider than "Commons", the label measured to fit at 320dp under the strip\'s 1.1x cap', () => {
        expect(layout).toMatch(/const LABEL_MAX_SCALE = 1\.1;/);
        const labels = onStrip.map(x => /<TabItem label="([^"]+)"/.exec(x.body)?.[1]);
        expect(labels).toEqual(['Home', 'Market', 'Map', 'Talk', 'Commons', 'Ledger']);
        for (const l of labels) expect(textWidth(l!, 10, { scale: 1.1 })).toBeLessThanOrEqual(textWidth('Commons', 10, { scale: 1.1 }));
    });
});
