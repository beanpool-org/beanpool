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
import { CAPTION_MAX_SCALE, HOME_TARGET_DP, HOME_THUMB_DP, communityLinksStyle, homeStyles } from '../../components/home/HomeParts';
import { EDIT_HOME_NOTE, editHomeStyles } from '../../components/home/EditHomeSheet';
import { ADD_CARD_FULL_NOTE, ADD_CARD_NOTE, addCardStyles } from '../../components/home/AddCardSheet';
import { cardRowName, FEWER_CARDS_LINE, HOME_HINT_LINE, NOT_ON_ACCOUNT_LINE, SEARCH_KIND_CHIPS, SEARCH_OFFLINE_LINE, pickerGroups, searchEmptyLine, searchFirstLine } from '../home-cards';
import { HOME_CARD_GROUPS, HOME_CARD_TYPES, HOME_SEARCH_KMS, HOME_TIPS, TIPS_ALL_SEEN, TIPS_DONT_SHOW, tipsCaption } from '@beanpool/core';
import { FAB_BAND_DP } from '../fab-band';

/** Every card's name as a member can see it: core's registry, and the worldwide community's words for the Market. */
const CARD_NAMES = HOME_CARD_TYPES.flatMap(t => (t.globalName ? [t.name, t.globalName] : [t.name]));

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
        for (const name of [...CARD_NAMES, 'The worldwide community', tipsCaption({ position: 15, total: 15 })]) {
            const w = longestWord(name.toUpperCase(), num(s.caption.fontSize), { scale: CAPTION_MAX_SCALE, caps: true, letterSpacing: num(s.caption.letterSpacing) });
            expect(w, name).toBeLessThan(room);
        }
        // Long community names wrap to a second line rather than run under the "…".
        expect(s.caption.flex).toBe(1);
    });

    it('the Tips card (TIPS-DESIGN §5): every tip\'s longest word fits; Next and Read more share a row; "Don\'t show tips again" fits a line and may wrap, never cut', () => {
        // §5 guessed under 140dp; measured, the longest is "recognition," at about 145dp of the 258: one word never runs out.
        for (const t of HOME_TIPS) expect(longestWord(t.text, 15), t.id).toBeLessThan(CARD_INNER * 0.6);
        const button = (w: string) => textWidth(w, 14) + 2 * 16;
        expect(button('Next') + 8 + button('Read more')).toBeLessThan(CARD_INNER);
        expect(textWidth(TIPS_DONT_SHOW, num(s.linkText.fontSize))).toBeLessThan(CARD_INNER);
        const body = read('components/home/HomeCardBodies.tsx');
        const tips = body.slice(body.indexOf('export function TipsBody'));
        expect(tips).not.toMatch(/numberOfLines/);
        expect(tips).toMatch(/minHeight: HOME_TARGET_DP/);
        // The floating "+ ADD POST" steps aside for both bands (HomeParts.tsx FabAware).
        expect(tips).toMatch(/<FabAware id="tips:buttons"/);
        expect(tips).toMatch(/<FabAware id="tips:dont-show"/);
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
        for (const label of ['Post an Offer', 'Invite someone', 'Open the Market', 'Open Talk', 'Try again', 'Connect']) {
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

describe('Edit home at 320dp × 1.3 (CARD-FRAME §1.3)', () => {
    const e = editHomeStyles as unknown as Record<string, Record<string, unknown>>;
    it('a card\'s name keeps its longest word beside ↑, ↓ and "…" (about 140dp of the sheet\'s 288)', () => {
        const room = SCREEN - 2 * num(e.list.paddingHorizontal) - 3 * num(e.arrow.width) - 3 * num(e.row.gap);
        expect(room).toBeGreaterThanOrEqual(130);
        for (const name of CARD_NAMES) {
            expect(longestWord(name, num(e.name.fontSize)), name).toBeLessThan(room);
        }
        for (const sub of ['Nothing to show now', TIPS_ALL_SEEN]) expect(longestWord(sub, num(e.sub.fontSize)), sub).toBeLessThan(room);
        // A saved search's row leads with its kind, so the first of its two lines shows it however long the words (#1716
        // confirmation, finding 4): "Needs · " fits a line whole.
        for (const q of ['organic free range eggs', 'firewood delivery', 'x'.repeat(40)]) {
            const name = cardRowName({ type: 'search', settings: { q, kind: 'need' } });
            expect(name.startsWith('Needs · '), name).toBe(true);
            expect(textWidth('Needs · ', num(e.name.fontSize)), name).toBeLessThan(room);
        }
        expect(e.rowText).toMatchObject({ flex: 1, minWidth: 0 });
        expect(e.arrow.flexShrink).toBe(0);
        expect(num(e.arrow.height)).toBeGreaterThanOrEqual(48);
        expect(num(e.reset.minHeight)).toBeGreaterThanOrEqual(48);
        expect(num(e.done.minHeight)).toBeGreaterThanOrEqual(48);
        expect(num(e.addRow.minHeight)).toBeGreaterThanOrEqual(48);
    });

    it('each arrow and "…" is a 48dp target both ways, not only in height (PR #1483 review 4165384018); no switch is left', () => {
        expect(num(e.arrow.width)).toBeGreaterThanOrEqual(HOME_TARGET_DP);
        expect(num(e.arrow.height)).toBeGreaterThanOrEqual(HOME_TARGET_DP);
        expect(HOME_TARGET_DP).toBeGreaterThanOrEqual(48);
        const sheet = read('components/home/EditHomeSheet.tsx');
        expect(sheet).not.toMatch(/<Switch/);
        expect(sheet).not.toMatch(/>Hidden</);
        expect(sheet).toMatch(/testID=\{`edit-home-\$\{c\.id\}-menu`\}/);
    });

    it('its fixed words fit: the note, ＋ Add a card, Reset to defaults, and the "not on your account yet" line', () => {
        const inner = SCREEN - 2 * num(e.list.paddingHorizontal);
        for (const t of [EDIT_HOME_NOTE, NOT_ON_ACCOUNT_LINE, ' Find your community stays near the top for your first 30 days.']) {
            expect(longestWord(t, num(e.note.fontSize)), t).toBeLessThan(inner);
        }
        expect(textWidth('＋ Add a card', num(e.addText.fontSize))).toBeLessThan(inner);
        expect(textWidth('Reset to defaults', num(e.resetText.fontSize))).toBeLessThan(inner);
    });
});

describe('the picker at 320dp × 1.3 (CARD-FRAME §1.2, §1.4)', () => {
    const e = editHomeStyles as unknown as Record<string, Record<string, unknown>>;
    const a = addCardStyles as unknown as Record<string, Record<string, unknown>>;
    const ADD = Math.max(num(a.add.minWidth), textWidth('Add', num(a.addText.fontSize)) + 2 * num(a.add.paddingHorizontal));
    const ON_HOME = textWidth('On Home', num(a.onHome.fontSize));
    const room = SCREEN - 2 * num(e.list.paddingHorizontal) - 2 * num(a.group.borderWidth) - 2 * num(a.group.paddingHorizontal) - num(a.row.gap) - Math.max(ADD, ON_HOME);
    const everyRow = () => {
        const local = pickerGroups({ profile: 'local', features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true } }, null, 'admin');
        const global = pickerGroups({ profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false } }, null, null);
        return [...local.groups, ...global.groups].flatMap(g => g.rows);
    };

    it('every row\'s name and line keep their longest word beside a 48dp Add (or "On Home")', () => {
        expect(num(a.add.minHeight)).toBeGreaterThanOrEqual(HOME_TARGET_DP);
        expect(num(a.add.minWidth)).toBeGreaterThanOrEqual(HOME_TARGET_DP);
        expect(a.add.flexShrink).toBe(0);
        expect(a.rowText).toMatchObject({ flex: 1, minWidth: 0 });
        const rows = everyRow();
        expect(rows.length).toBeGreaterThan(10);
        for (const r of rows) {
            expect(longestWord(r.name, num(a.name.fontSize)), r.name).toBeLessThan(room);
            expect(longestWord(r.line, num(a.line.fontSize)), r.line).toBeLessThan(room);
        }
        for (const t of ['5 of 5 on Home', '3 of 3 on Home', TIPS_ALL_SEEN]) expect(longestWord(t, num(a.line.fontSize)), t).toBeLessThan(room);
    });

    it('every type in the registry is measured, whatever node lists it; the group headings and the notes fit', () => {
        for (const t of HOME_CARD_TYPES) expect(longestWord(t.line, num(a.line.fontSize)), t.id).toBeLessThan(room);
        const inner = SCREEN - 2 * num(e.list.paddingHorizontal);
        for (const g of HOME_CARD_GROUPS) {
            expect(textWidth(g.name.toUpperCase(), num(e.section.fontSize), { caps: true, letterSpacing: num(e.section.letterSpacing) }), g.name).toBeLessThan(inner);
        }
        for (const t of [ADD_CARD_NOTE, ADD_CARD_FULL_NOTE]) expect(longestWord(t, num(e.note.fontSize)), t).toBeLessThan(inner);
    });
});

describe("a saved search's settings sheet at 320dp × 1.3 (CARD-FRAME §4, §5.2 item 20)", () => {
    it("every chip (kind, category, distance) fits the sheet's width on one line, and is a 48dp target", () => {
        const sheetInner = SCREEN - 2 * num((editHomeStyles as unknown as Record<string, Record<string, unknown>>).list.paddingHorizontal);
        const labels = [
            ...SEARCH_KIND_CHIPS.map(k => k.label),
            'Any category', ...POST_CATEGORIES.map(c => `${c.emoji} ${c.label}`),
            'Any distance', ...HOME_SEARCH_KMS.map(k => `${k} km`),
        ];
        for (const l of labels) {
            const w = textWidth(l, num(s.chipText.fontSize)) + 2 * num(s.chip.paddingHorizontal) + 2 * num(s.chip.borderWidth);
            expect(w, l).toBeLessThan(sheetInner);
        }
        expect(num(s.chip.minHeight)).toBeGreaterThanOrEqual(HOME_TARGET_DP);
        expect(HOME_TARGET_DP).toBeGreaterThanOrEqual(48);
        // The three kinds share one row at the floor, so "Both" reads as one choice of three.
        const row = SEARCH_KIND_CHIPS.reduce((w, k) => w + textWidth(k.label, num(s.chipText.fontSize)) + 2 * num(s.chip.paddingHorizontal) + 2, 0) + 2 * 8;
        expect(row).toBeLessThan(sheetInner);
        // The sheet scrolls: eighteen category chips and a keyboard don't fit 569dp at once.
        expect(read('components/home/CardSettingsSheet.tsx')).toMatch(/<ScrollView style=\{editHomeStyles\.list\}/);
    });
});

describe('the frame\'s words on Home at 320dp × 1.3', () => {
    it('"Add a card ›" and "Edit home ›" each fit a row whole, wrap rather than clip, and each is its own 48dp target the floating button steps aside for', () => {
        const add = textWidth('Add a card ›', num(s.linkText.fontSize));
        const edit = textWidth('Edit home ›', num(s.linkText.fontSize));
        expect(add).toBeLessThan(CARD_INNER);
        expect(edit).toBeLessThan(CARD_INNER);
        // Together they don't fit at the floor: the row wraps (CARD-FRAME §1.1).
        expect(add + edit + num(communityLinksStyle.columnGap)).toBeGreaterThan(CARD_INNER);
        expect(communityLinksStyle.flexWrap).toBe('wrap');
        expect(num(s.link.minHeight)).toBeGreaterThanOrEqual(HOME_TARGET_DP);
        const body = read('components/home/HomeCardBodies.tsx');
        expect(body).toMatch(/<HomeLink id="community:add"/);
        expect(body).toMatch(/<HomeLink id="community:edit"/);
    });

    it('the hint and the fewer-cards line keep their longest word beside the ✕; a saved search\'s lines fit the card', () => {
        const home = read('app/(tabs)/index.tsx');
        const hintText = Number(/hintText: \{ flex: 1, fontSize: (\d+)/.exec(home)?.[1]);
        const room = SCREEN - 2 * 16 - 12 - HOME_TARGET_DP;
        for (const t of [HOME_HINT_LINE, FEWER_CARDS_LINE]) expect(longestWord(t, hintText), t).toBeLessThan(room);
        // The offline and empty lines are notes; the first line is a strong row of at most 40 characters of words plus the
        // distance, which wraps at word breaks: its longest word (40 characters with no space is the worst case) still
        // has to be readable, so it is bounded like any row (HomeRow's two lines) and never put in the caption.
        const longest = 'x'.repeat(40);
        for (const t of [SEARCH_OFFLINE_LINE, searchEmptyLine('duck eggs', 25), searchFirstLine('duck eggs', 25)]) {
            expect(longestWord(t, num(s.note.fontSize)), t).toBeLessThan(CARD_INNER);
        }
        expect(searchFirstLine('eggs', 5)).toBe('eggs · within 5 km');
        expect(searchFirstLine('eggs', null)).toBe('eggs');
        expect(searchFirstLine(longest, 25).startsWith(longest)).toBe(true);
        expect(searchEmptyLine('eggs', 5)).toBe('No eggs within 5 km right now');
        expect(searchEmptyLine('eggs', null)).toBe('No eggs right now');
        const body = read('components/home/HomeCardBodies.tsx');
        // The first line is a HomeRow (bounded to its lines), the rows the Market card's own, and See more a HomeLink (≥ 48 dp).
        expect(body).toMatch(/<HomeRow colors=\{colors\} text=\{first\}/);
        expect(body).toMatch(/<MarketRow key=\{p\.id\} p=\{p\}[^\n]*home-search-row-/);
        expect(body).toMatch(/<HomeLink id="search:more"/);
        expect(num(s.link.minHeight)).toBeGreaterThanOrEqual(HOME_TARGET_DP);
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
