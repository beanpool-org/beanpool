/**
 * What the key, sign-in and recovery screens' pseudo-locale render tests share (words S3, sweep B10): React Native's host
 * components as plain tags carrying what a member reads (text, screen-reader labels and hints, placeholders, alerts) and
 * the layout props the 320 dp checks read, and the checks themselves. Used by key-screens-words-render.test.ts,
 * key-components-words-render.test.ts and key-admin-words-render.test.ts. Not a test file itself.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any of those with letters outside a
 * bracket bypassed t(). What members, communities and servers wrote, codes and addresses, are named by each test and
 * taken out first.
 */
import { createElement, useEffect } from 'react';

/** What the screen said in alerts: titles, bodies and buttons, in order. */
export interface Said { said: string[] }

const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', checkbox: 'checkbox', alert: 'alert', progressbar: 'progressbar' };
const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(8).filter((x) => x && typeof x === 'object'));

/** react-native, as plain tags. `said` collects every Alert's words; `camera` the scanner's callback (expo-camera's mock sets it). */
export function nativeMock(said: Said) {
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, onValueChange, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, onLayout, value, onChangeText, disabled } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onValueChange && !disabled) attrs.onClick = () => onValueChange(!value);
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        const s = flat(props.style);
        if (s.flexDirection === 'row') attrs['data-row'] = 'true';
        if (s.flexWrap === 'wrap') attrs['data-wrap'] = 'true';
        if (s.flex !== undefined) attrs['data-flex'] = String(s.flex);
        if (typeof s.flexShrink === 'number' && s.flexShrink > 0) attrs['data-flex-shrink'] = String(s.flexShrink);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        if (typeof s.width === 'number') attrs['data-width'] = String(s.width);
        if (s.textTransform) attrs['data-transform'] = s.textTransform;
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), TouchableOpacity: el('button'), ScrollView: el('div'), TextInput: el('input'),
        SafeAreaView: el('div'), Switch: el('button'), Image: el('img'),
        ActivityIndicator: (props: { accessibilityLabel?: string }) => createElement('span', { 'data-spinner': 'true', ...(props.accessibilityLabel ? { 'aria-label': props.accessibilityLabel } : {}) }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string }>) => {
                if (title) said.said.push(title);
                if (body) said.said.push(body);
                for (const b of buttons ?? []) if (b.text) said.said.push(b.text);
            },
        },
        Share: { share: async (content: { message?: string }) => { if (content.message) said.said.push(content.message); return {}; } },
        Linking: { openSettings: async () => {}, openURL: async () => {} },
        Keyboard: { addListener: listener, dismiss() {} },
        AppState: { addEventListener: listener, currentState: 'active' },
        BackHandler: { addEventListener: listener },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
}

/** Letters left once every bracket, and the words given (names, addresses, codes), are taken out. */
export function outsideBrackets(text: string | null | undefined, written: readonly string[] = []): string {
    if (!text) return '';
    let rest = text;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const w of [...written].sort((a, b) => b.length - a.length)) rest = rest.split(w).join('');
    return rest.replace(/[^\p{L}]+/gu, ' ').trim();
}

/** Everything a member reads in `host` (and in the alerts said) that has letters outside a bracket. */
export function bypassing(host: Element, written: readonly string[] = [], said: readonly string[] = []): string[] {
    const out = new Set<string>();
    const doc = host.ownerDocument;
    const walker = doc.createTreeWalker(host, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const whole = n.parentElement?.textContent ?? n.nodeValue;
        if (outsideBrackets(whole, written)) out.add(`text: ${JSON.stringify(whole)}`);
    }
    for (const [attr, kind] of [['aria-label', 'label'], ['data-hint', 'hint'], ['placeholder', 'placeholder']] as const) {
        for (const e of Array.from(host.querySelectorAll(`[${attr}]`))) {
            const v = e.getAttribute(attr);
            if (outsideBrackets(v, written)) out.add(`${kind}: ${JSON.stringify(v)}`);
        }
    }
    for (const line of said) if (outsideBrackets(line, written)) out.add(`alert: ${JSON.stringify(line)}`);
    return [...out];
}

// ── 320 dp with text at 1.3× ────────────────────────────────────────────────────────────────────────────────────────

export const SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\uFE0F\u200B\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
export const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);
export const widestWord = (text: string) => text.split(/[\s\u200B~]+/).reduce((a, b) => (widthOf(b, 1) > widthOf(a, 1) ? b : a), '');
const fontOf = (el: Element): number => { for (let e: Element | null = el; e; e = e.parentElement) { const f = e.getAttribute('data-font'); if (f) return Number(f); } return 14; };

/**
 * What doesn't fit `column` dp at 1.3×: a word wider than the column, and a text beside something in a row that neither
 * wraps, takes the room left (flex) nor gives way (flexShrink).
 */
export function unfit(host: Element, column: number): string[] {
    const out: string[] = [];
    for (const span of Array.from(host.querySelectorAll('span')).filter((s) => s.children.length === 0 && /\p{L}/u.test(s.textContent ?? ''))) {
        const word = widestWord(span.textContent ?? '');
        const px = fontOf(span) * SCALE;
        if (widthOf(word, px) > column) out.push(`${word} (${Math.round(widthOf(word, px))} > ${column})`);
        const row = span.parentElement;
        if (/^\[/.test(span.textContent ?? '') && row?.getAttribute('data-row') === 'true' && row.getAttribute('data-wrap') !== 'true'
            && row.children.length > 1 && !span.getAttribute('data-flex') && !span.getAttribute('data-flex-shrink')) out.push(`stuck in a row: ${span.textContent}`);
    }
    return out;
}
