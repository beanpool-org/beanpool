/**
 * React Native's host components as plain DOM, WITH the styles (credit-render.test.ts; slice C4). The other render tests map
 * a View to a bare <div> because they check words and presses; the credit screens are also judged by how they look at
 * 320 dp with 130% text, so this keeps what a screenshot needs: flex defaults, padding/margin shorthands, px line heights,
 * and text scaled by the font scale (capped as `maxFontSizeMultiplier` caps it). It is a stand-in for the device, not the
 * device: layout here is a browser's, so the shots show structure, wrapping and colour, and the device run is the director's.
 */
import { createContext, createElement, useContext, type ReactNode } from 'react';

type Style = Record<string, unknown>;
export const FONT_SCALE = { value: 1.3 };
/** The window the device reports: 320 dp wide; the height is raised for a screenshot of a whole sheet. */
export const WINDOW = { width: 320, height: 569 };

const flatten = (s: unknown): Style => (Array.isArray(s) ? Object.assign({}, ...s.map(flatten)) : s && typeof s === 'object' ? (s as Style) : {});
const px = (v: unknown) => (typeof v === 'number' ? `${v}px` : (v as string));
const UNITLESS = new Set(['flex', 'flexGrow', 'flexShrink', 'opacity', 'fontWeight', 'zIndex']);
const InText = createContext(false);

export function cssOf(style: unknown, opts: { text?: boolean; cap?: number } = {}): Record<string, string | number> {
    const s = flatten(style);
    const out: Record<string, string | number> = {};
    if (!opts.text) Object.assign(out, { display: 'flex', flexDirection: 'column', boxSizing: 'border-box', position: 'relative', minWidth: 0, flexShrink: 0, alignItems: 'stretch', alignContent: 'flex-start' });
    else Object.assign(out, { boxSizing: 'border-box', margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
    const sides = (name: 'padding' | 'margin') => {
        const v = s[`${name}Vertical`], h = s[`${name}Horizontal`], a = s[name];
        for (const [k, side] of [['Top', v], ['Bottom', v], ['Left', h], ['Right', h]] as const) {
            const own = s[`${name}${k}`] ?? side ?? a;
            if (own !== undefined) out[`${name}${k}`] = px(own);
        }
    };
    sides('padding'); sides('margin');
    for (const [k, v] of Object.entries(s)) {
        if (v === undefined || v === null) continue;
        if (/^(padding|margin)(Vertical|Horizontal|Top|Bottom|Left|Right)?$/.test(k)) continue;
        if (k === 'fontSize') { out.fontSize = px(Math.round((v as number) * Math.min(FONT_SCALE.value, opts.cap ?? FONT_SCALE.value) * 100) / 100); continue; }
        if (k === 'lineHeight') { out.lineHeight = px(Math.round((v as number) * Math.min(FONT_SCALE.value, opts.cap ?? FONT_SCALE.value) * 100) / 100); continue; }
        if (k === 'flex') { out.flex = `${v} 1 ${v === 0 ? 'auto' : '0%'}`; continue; }
        if (k === 'borderWidth' || k === 'borderTopWidth' || k === 'borderBottomWidth' || k === 'borderLeftWidth' || k === 'borderRightWidth') {
            out[k] = px(v); out[k.replace('Width', 'Style')] = 'solid'; continue;
        }
        if (k === 'elevation' || k === 'shadowOffset' || k === 'shadowOpacity' || k === 'shadowRadius' || k === 'shadowColor') continue;
        if (k === 'gap') { out.gap = px(v); continue; }
        out[k] = UNITLESS.has(k) ? (v as number) : px(v);
    }
    if (out.borderTopStyle === undefined && out.borderWidth === undefined && out.borderBottomWidth === undefined) { /* none */ }
    return out;
}

const el = (tag: string, kind: 'view' | 'text' | 'press') => (props: Record<string, any>) => {
    const { children, style, onPress, testID, accessibilityLabel, accessibilityRole, accessibilityHint, disabled, maxFontSizeMultiplier, pointerEvents } = props;
    const inText = useContext(InText);
    const isText = kind === 'text';
    const attrs: Record<string, unknown> = {
        style: { ...cssOf(style, { text: isText, cap: maxFontSizeMultiplier }), ...(isText && inText ? { display: 'inline' } : {}), ...(kind === 'press' ? { cursor: 'pointer' } : {}), ...(pointerEvents === 'none' ? { pointerEvents: 'none' } : {}) },
    };
    if (testID) attrs['data-testid'] = testID;
    if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
    if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
    if (accessibilityRole) attrs['data-role'] = accessibilityRole;
    if (props.accessibilityState?.selected) attrs['data-selected'] = 'true';
    if (disabled) attrs['aria-disabled'] = 'true';
    if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
    const kids = typeof children === 'function' ? children({ pressed: false }) : children;
    return createElement(tag, attrs, isText ? createElement(InText.Provider, { value: true }, kids) : kids);
};

export function reactNativeDom() {
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Dimensions: { get: () => ({ ...WINDOW, scale: 1.5, fontScale: FONT_SCALE.value }) },
        useWindowDimensions: () => ({ ...WINDOW, scale: 1.5, fontScale: FONT_SCALE.value }),
        View: el('div', 'view'),
        Text: el('div', 'text'),
        Pressable: el('div', 'press'),
        ScrollView: (props: Record<string, any>) => createElement('div', { style: { ...cssOf(props.style), overflow: 'hidden' } }, createElement('div', { style: cssOf(props.contentContainerStyle) }, props.children)),
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent, onEndReached }: Record<string, any>) => createElement('div', { style: cssOf({}), 'data-end': onEndReached ? 'y' : 'n' },
            ListHeaderComponent,
            (data ?? []).length
                ? data.map((item: any, index: number) => createElement('div', { key: keyExtractor ? keyExtractor(item, index) : index, style: cssOf({}) }, renderItem({ item, index })))
                : ListEmptyComponent,
            ListFooterComponent),
        Modal: ({ visible, children }: { visible?: boolean; children?: ReactNode }) => (visible === false ? null : createElement('div', { 'data-modal': 'true', style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', zIndex: 10 } }, children)),
        Switch: ({ value, onValueChange, accessibilityLabel, testID, trackColor }: Record<string, any>) => createElement('div', {
            role: 'switch', 'aria-checked': String(!!value), 'aria-label': accessibilityLabel, 'data-testid': testID, onClick: () => onValueChange?.(!value),
            style: { width: 52, height: 32, borderRadius: 16, flexShrink: 0, background: value ? trackColor?.true : trackColor?.false, position: 'relative', cursor: 'pointer' },
        }, createElement('div', { style: { position: 'absolute', top: 3, left: value ? 23 : 3, width: 26, height: 26, borderRadius: 13, background: '#fff' } })),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        TextInput: (props: Record<string, any>) => createElement('input', { style: cssOf(props.style, { text: true }), value: props.value ?? '', placeholder: props.placeholder, readOnly: true }),
        Image: (props: Record<string, any>) => createElement('div', { style: cssOf(props.style) }),
        Alert: { alert() {} },
        Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} },
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit() {} },
    };
}
