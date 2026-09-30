/**
 * The social sign-in buttons keep their text and logos inside their borders on a 320dp phone with enlarged text
 * (memory: product-audience-small-screens), on the Restore screen and on the social sign-in screen after it.
 *
 * What went wrong: each button lays its label out in a row beside logos, and the label could not shrink. Flexbox sizes
 * a label that cannot shrink at the row's full width, the logos are added on top, and a centred row that is too wide
 * spills past BOTH edges: on the Restore screen the globe and the start of "Recover with Social" sat outside the left
 * border; on the sign-in screen the Facebook button's label sat outside the button.
 *
 * Nothing here draws a frame (see vitest.config.ts): the buttons are rendered as element trees with React Native stood
 * in for, and the screen's styles are read from its source. The widths below are a model of flexbox, not a phone:
 * each row's fixed parts are subtracted from the button's inner width, and what is left must hold the label's longest
 * word, so the label wraps between words inside the border. The emulator check is separate.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReactElement, ReactNode } from 'react';

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    StyleSheet: { create: <T,>(s: T) => s },
    Text: 'Text',
    View: 'View',
    TouchableOpacity: 'TouchableOpacity',
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }));

import { AppleButton, FacebookButton, GoogleButton } from '../../components/SsoButton';
import { MAX_FONT_SCALE } from '../../constants/responsive';

type Style = Record<string, unknown>;
const flatten = (s: unknown): Style =>
    Array.isArray(s) ? Object.assign({}, ...s.map(flatten)) : s && typeof s === 'object' ? { ...(s as Style) } : {};
const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/** components/SsoButton.tsx: every provider's logo at 20, in a 24 box (kept private there: sign-in-choices.test.ts pins its exports). */
const SSO_LOGO_SIZE = 20;
const SSO_ICON_BOX = 24;

/** The smallest phone we hold to, and the enlarged text we hold it at (the app caps OS scaling at MAX_FONT_SCALE). */
const SCREEN = 320;
const FONT_SCALE = 1.3;
/** welcome.tsx: styles.scroll padding 24, styles.card padding 24 + a 1px border. */
const CARD_INNER = SCREEN - 2 * 24 - 2 * 24 - 2 * 1;

/** A generous glyph width for a bold Latin face (Roboto / SF average is nearer 0.55em); an emoji is wider. */
function wordWidth(word: string, fontSize: number): number {
    const px = fontSize * FONT_SCALE;
    return [...word].reduce((w, ch) => w + (/\p{Extended_Pictographic}/u.test(ch) ? 1.25 : 0.62) * px, 0);
}
const longestWordWidth = (text: string, fontSize: number) => Math.max(...text.split(/\s+/).map((w) => wordWidth(w, fontSize)));

function innerWidth(outer: number, s: Style): number {
    const pad = num(s.paddingHorizontal ?? s.padding) * 2 || num(s.paddingLeft) + num(s.paddingRight);
    const border = num(s.borderWidth) * 2;
    return outer - pad - border;
}

function noNegativeMargins(s: Style) {
    for (const k of ['margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical', 'marginStart', 'marginEnd']) {
        if (k in s) expect(num(s[k]), `${k} must not pull the content outside`).toBeGreaterThanOrEqual(0);
    }
    expect(s.position, 'nothing is lifted out of the row').not.toBe('absolute');
}

/** The host elements a button renders, with function components (the logos) left as they are. */
function children(el: ReactElement): ReactElement[] {
    const kids = (el.props as { children?: ReactNode }).children;
    return (Array.isArray(kids) ? kids : [kids]).filter((k): k is ReactElement => !!k && typeof k === 'object');
}

const BUTTONS = [
    { name: 'Google', render: GoogleButton, title: 'Recover with Google' },
    { name: 'Facebook', render: FacebookButton, title: 'Recover with Facebook' },
    { name: 'Apple', render: AppleButton, title: 'Recover with Apple' },
] as const;

describe('the social sign-in screen: Apple, Google and Facebook buttons', () => {
    for (const { name, render, title } of BUTTONS) {
        const tree = render({ title, onPress: () => {}, style: { marginBottom: 10, width: '100%' } }) as ReactElement;
        const button = flatten((tree.props as { style: unknown }).style);
        const [icon, label] = children(tree);
        const iconStyle = flatten((icon.props as { style: unknown }).style);
        const labelStyle = flatten((label.props as { style: unknown }).style);
        const logo = children(icon)[0];

        it(`${name}: the logo sits in a fixed box that never gives way`, () => {
            expect(button.flexDirection).toBe('row');
            expect(iconStyle.flexShrink).toBe(0);
            expect(iconStyle.width).toBe(SSO_ICON_BOX);
            expect(iconStyle.height).toBe(SSO_ICON_BOX);
            const size = (logo.props as { size: number }).size;
            expect(size).toBeLessThanOrEqual(SSO_ICON_BOX);
            if (name !== 'Apple') expect(size, `${name}'s logo is the same size as the others`).toBe(SSO_LOGO_SIZE);
            noNegativeMargins(iconStyle);
        });

        it(`${name}: the label shrinks and wraps inside the button at ${SCREEN}dp and ${FONT_SCALE}x text`, () => {
            expect(num(labelStyle.flexShrink) >= 1 || num(labelStyle.flex) >= 1, 'the label can shrink').toBe(true);
            expect(labelStyle.textAlign).toBe('center');
            noNegativeMargins(labelStyle);
            expect(label.props).not.toHaveProperty('numberOfLines');

            expect(button.width).toBe('100%');
            const room = innerWidth(CARD_INNER, button) - SSO_ICON_BOX - num(iconStyle.marginRight);
            expect(room).toBeGreaterThan(longestWordWidth(title, num(labelStyle.fontSize)));
        });
    }

    it('Facebook and Google logos are drawn the same size', () => {
        const logoSize = (render: typeof GoogleButton) => {
            const tree = render({ onPress: () => {} }) as ReactElement;
            return (children(children(tree)[0])[0].props as { size: number }).size;
        };
        expect(logoSize(FacebookButton)).toBe(logoSize(GoogleButton));
        expect(logoSize(FacebookButton)).toBeGreaterThanOrEqual(20);
    });

    it('the app never lets text grow past the 1.3x this is checked at', () => {
        expect(MAX_FONT_SCALE).toBeLessThanOrEqual(FONT_SCALE);
    });
});

describe('Restore your account: the Recover with Social button', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf-8');
    /** A one-line entry in welcome.tsx's StyleSheet, literals only. */
    function style(name: string): Style {
        const m = src.match(new RegExp(`^ {4}${name}: (\\{[^\\n]*\\}),$`, 'm'));
        expect(m, `styles.${name}`).not.toBeNull();
        return new Function(`return (${m![1]});`)() as Style;
    }
    const member = (() => {
        const from = src.indexOf("if (mode === 'member') {");
        const to = src.indexOf('Recover with 12 Words', from);
        expect(from).toBeGreaterThan(-1);
        expect(to).toBeGreaterThan(from);
        return src.slice(from, to);
    })();

    it('the label and logos sit in the named row styles, not inline ones', () => {
        expect(member).toContain('<Pressable\n                            style={styles.ssoRecoverBtn}');
        expect(member).toContain('<View style={styles.ssoRecoverRow}>');
        expect(member).toContain('<Text style={styles.ssoRecoverBtnText}>🌐 Recover with Social</Text>');
        expect(member).toContain('<View style={styles.ssoRecoverLogos}>');
    });

    it(`the label shrinks and wraps, the logos keep their size, all inside the border at ${SCREEN}dp and ${FONT_SCALE}x text`, () => {
        const btn = style('ssoRecoverBtn');
        const row = style('ssoRecoverRow');
        const text = style('ssoRecoverBtnText');
        const logos = style('ssoRecoverLogos');

        expect(text.flexShrink).toBe(1);
        expect(text.textAlign).toBe('center');
        expect(logos.flexShrink).toBe(0);
        expect(row.flexDirection).toBe('row');
        expect(row.maxWidth).toBe('100%');
        for (const s of [btn, row, text, logos]) noNegativeMargins(s);

        // Three 16dp logos on an iPhone (Apple, Google, Facebook), two on Android.
        const logoSizes = [...member.matchAll(/<(?:Apple|Google|Facebook)Logo size=\{(\d+)\}/g)].map((m) => Number(m[1]));
        expect(logoSizes).toHaveLength(3);
        const logosWidth = logoSizes.reduce((a, b) => a + b, 0) + num(logos.gap) * (logoSizes.length - 1);
        const room = innerWidth(CARD_INNER, btn) - logosWidth - num(row.gap);
        expect(room).toBeGreaterThan(longestWordWidth('🌐 Recover with Social', num(text.fontSize)));
    });
});
