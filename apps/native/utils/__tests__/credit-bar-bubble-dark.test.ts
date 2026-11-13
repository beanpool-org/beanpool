// @vitest-environment jsdom
/**
 * The phone's credit card (DESIGN-credit-bar-amend-fable.md, slice R1), in every look. The label on the dot reads in each:
 * dark with white words (the picture's own, as the web's), red with white words at nine tenths used, gold with dark words
 * above 200, each 4.5:1 or more. The dot keeps its dark ring in dark looks too (F15: the ring took the heading colour,
 * white, so the dot was all white). The card's words equal core's, the same fixture the web's test reads, and the source
 * holds no hex and no size under 12.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CREDIT_RAINBOW, contrastRatio, creditStandingCard, type BrandSet, type CreditStandingAnswer } from '@beanpool/core';
import { darkColors, lightColors } from '../../constants/colors';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => createElement(tag, {
        'data-testid': props.testID,
        'data-style': JSON.stringify(Object.assign({}, ...[props.style].flat(3).filter(s => s && typeof s === 'object'))),
        'aria-hidden': props.accessibilityElementsHidden ? 'true' : undefined,
    }, props.children);
    return { View: el('div'), Text: el('span'), StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} } };
});
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));

import { CreditBar } from '../../components/CreditBar';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const hex6 = (c: string) => (/^#[0-9a-f]{3}$/i.test(c) ? `#${[...c.slice(1)].map(x => x + x).join('')}` : c).toLowerCase();
/** Marty on 14 Nov: owes 50 of a 500 line, all of it Damo's vouch, one live Offer (the web's test reads the same). */
const MARTY: CreditStandingAnswer = {
    balance_c: -5000, floor_c: -50000, usableFloor_c: -50000, knownGrant_c: 0, roomHeld_c: 50000, earnedCredit_c: 0, liveOffers: 1,
    vouchedBy: [{ callsign: 'Damo', amount_c: 50000 }],
};
const LOOKS: Array<[BrandSet, unknown]> = [['light', lightColors], ['dark', darkColors], ['night', darkColors]];

function draw(answer: CreditStandingAnswer, colors: unknown = lightColors, set: BrandSet = 'light') {
    act(() => root.render(createElement(CreditBar, { answer, colors, set }) as any));
    const style = (id: string) => JSON.parse(host.querySelector(`[data-testid="${id}"]`)!.getAttribute('data-style')!);
    const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
    return { style, text };
}

describe('the phone credit card: core\'s words', () => {
    it('the headline, the sentence, the label and the parts line equal core\'s', () => {
        const d = draw(MARTY);
        const card = creditStandingCard(MARTY);
        expect(d.text('credit-headline')).toBe(card.headline);
        expect(d.text('credit-sentence')).toBe(card.sentence);
        expect(d.text('credit-bar-label')).toBe('−50 Beans');
        expect(d.text('credit-parts')).toBe('Credit line 500: ■ Earned by trading 0 so far · □ @Damo vouched 500');
        expect(host.querySelector('[data-testid="credit-drawing"]')!.getAttribute('aria-hidden')).toBe('true');
    });

    it('a confirmed member with a vouch reads the whole line (F7)', () => {
        const d = draw({ balance_c: 0, floor_c: -110000, usableFloor_c: -110000, knownGrant_c: 100000, roomHeld_c: 10000, liveOffers: 1, vouchedBy: [{ callsign: 'Olive', amount_c: 10000 }] });
        expect(d.text('credit-parts')).toBe('Credit line 1,100: ■ Earned by trading 0 so far · □ Confirmed member 1,000 · □ @Olive vouched 100');
    });

    it('one live Offer opens a vouched line whole: no stripes, one outlined block', () => {
        draw(MARTY);
        expect(host.querySelector('[data-testid="credit-stripes"]')).toBeNull();
        expect(host.querySelectorAll('[data-testid^="credit-block-"]').length).toBe(1);
        expect(host.querySelector('[data-testid="credit-block-vouch"]')).not.toBeNull();
    });
});

describe('the label on the dot, in every look', () => {
    for (const [set, colors] of LOOKS) {
        it(`${set}: calm, near and fee labels read 4.5:1 or more; the dot keeps its dark ring`, () => {
            const calm = draw({ ...MARTY, balance_c: 8500 }, colors, set);
            const c = { bg: hex6(calm.style('credit-bar-bubble').backgroundColor), fg: hex6(calm.style('credit-bar-label').color) };
            expect(c).toEqual({ bg: CREDIT_RAINBOW.tag, fg: CREDIT_RAINBOW.tagOn });
            expect(contrastRatio(c.fg, c.bg)).toBeGreaterThanOrEqual(4.5);
            const near = draw({ ...MARTY, balance_c: -47000 }, colors, set);
            expect(contrastRatio(near.style('credit-bar-label').color, near.style('credit-bar-bubble').backgroundColor)).toBeGreaterThanOrEqual(4.5);
            const fee = draw({ ...MARTY, balance_c: 45000 }, colors, set);
            expect(contrastRatio(fee.style('credit-bar-label').color, fee.style('credit-bar-bubble').backgroundColor)).toBeGreaterThanOrEqual(4.5);
            const dot = Array.from(host.querySelectorAll('div')).map((e) => JSON.parse(e.getAttribute('data-style') ?? '{}')).find((st) => st.width === 18 && st.borderWidth === 4);
            expect(dot.borderColor).toBe(CREDIT_RAINBOW.ring);
            expect(dot.backgroundColor).toBe(CREDIT_RAINBOW.dot);
        });
    }
});

describe('the source', () => {
    const src = readFileSync(path.join(__dirname, '../../components/CreditBar.tsx'), 'utf8');
    it('holds no hex colour', () => {
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
    it('holds no size under 12', () => {
        const sizes = [...src.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
        expect(sizes.length).toBeGreaterThan(0);
        expect(sizes.filter((n) => n < 12)).toEqual([]);
    });
    it('has no rung labels, no fee ladder and none of the old words', () => {
        expect(src).not.toMatch(/sweet spot|fee-free|carry credit|hold credit|fee\/mo|🎣|rungLabel/);
    });
});
