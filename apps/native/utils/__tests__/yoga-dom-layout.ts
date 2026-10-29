/**
 * Lays out a React Native screen rendered into jsdom with Yoga, the engine a phone runs.
 *
 * A screen test mocks React Native's host components as plain tags (market-banner-fallback-render.test.ts), which have no
 * size: a style that makes a card fill the screen draws the same in jsdom as one that does not. Here the mocks write each
 * host's flattened style into `data-style`, and this reads that tree back into Yoga (yoga-layout, the wasm build of the
 * engine in react-native; on the Market's list scenario it gives the same heights as the Yoga compiled from
 * node_modules/react-native/ReactCommon/yoga) and lays it out in a viewport.
 *
 * What it models, and what it does not:
 *  - Every element is a node with its `data-style` (View, Pressable, FlatList's content, a cell). A top-level <span> is
 *    Text: a leaf, measured by a plain character-count rule (a little over half a font size a character, a line a font size and a
 *    quarter, both times the font scale), wrapped to the width Yoga offers and cut at `data-lines` (numberOfLines). An
 *    <img> is a picture with no size of its own (expo-image has none), and an <i> an icon. This is not Android's text:
 *    fonts differ, so a text-heavy height is an estimate. Use it for what a style does to a box, not for pixels of words.
 *  - Yoga is given what React Native gives it: no web defaults and every erratum on (Fabric's YGErrataAll).
 */
import Yoga, { type Node } from 'yoga-layout';

type Style = Record<string, unknown>;

export interface Box { left: number; top: number; width: number; height: number }

export interface Layout {
    /** The element's box, in its parent's coordinates. */
    box(el: Element): Box;
    height(el: Element): number;
    width(el: Element): number;
}

const FLEX_DIRECTION: Record<string, number> = {
    row: Yoga.FLEX_DIRECTION_ROW, column: Yoga.FLEX_DIRECTION_COLUMN,
    'row-reverse': Yoga.FLEX_DIRECTION_ROW_REVERSE, 'column-reverse': Yoga.FLEX_DIRECTION_COLUMN_REVERSE,
};
const JUSTIFY: Record<string, number> = {
    'flex-start': Yoga.JUSTIFY_FLEX_START, center: Yoga.JUSTIFY_CENTER, 'flex-end': Yoga.JUSTIFY_FLEX_END,
    'space-between': Yoga.JUSTIFY_SPACE_BETWEEN, 'space-around': Yoga.JUSTIFY_SPACE_AROUND, 'space-evenly': Yoga.JUSTIFY_SPACE_EVENLY,
};
const ALIGN: Record<string, number> = {
    auto: Yoga.ALIGN_AUTO, 'flex-start': Yoga.ALIGN_FLEX_START, center: Yoga.ALIGN_CENTER, 'flex-end': Yoga.ALIGN_FLEX_END,
    stretch: Yoga.ALIGN_STRETCH, baseline: Yoga.ALIGN_BASELINE, 'space-between': Yoga.ALIGN_SPACE_BETWEEN, 'space-around': Yoga.ALIGN_SPACE_AROUND,
};
const WRAP: Record<string, number> = { nowrap: Yoga.WRAP_NO_WRAP, wrap: Yoga.WRAP_WRAP, 'wrap-reverse': Yoga.WRAP_WRAP_REVERSE };
const POSITION: Record<string, number> = { relative: Yoga.POSITION_TYPE_RELATIVE, absolute: Yoga.POSITION_TYPE_ABSOLUTE, static: Yoga.POSITION_TYPE_STATIC };
const OVERFLOW: Record<string, number> = { visible: Yoga.OVERFLOW_VISIBLE, hidden: Yoga.OVERFLOW_HIDDEN, scroll: Yoga.OVERFLOW_SCROLL };

const isPercent = (v: unknown): v is string => typeof v === 'string' && v.endsWith('%');
const percent = (v: string): number => parseFloat(v);

function styleOf(el: Element): Style {
    try { return JSON.parse(el.getAttribute('data-style') ?? '{}') as Style; } catch { return {}; }
}

type Sized = 'Width' | 'Height' | 'MinWidth' | 'MinHeight' | 'MaxWidth' | 'MaxHeight' | 'FlexBasis';

/** One size property, as React Native passes it to Yoga: points, a percentage of the owner, or auto. */
function setSize(node: Node, prop: Sized, v: unknown): void {
    if (v === undefined || v === null) return;
    const n = node as unknown as Record<string, (x?: unknown) => void>;
    if (v === 'auto') { n[`set${prop}Auto`]?.(); return; }
    if (isPercent(v)) { n[`set${prop}Percent`]?.(percent(v)); return; }
    if (typeof v === 'number') n[`set${prop}`]?.(v);
}

const EDGES: Array<[string, number]> = [['Left', Yoga.EDGE_LEFT], ['Right', Yoga.EDGE_RIGHT], ['Top', Yoga.EDGE_TOP], ['Bottom', Yoga.EDGE_BOTTOM]];

/** margin / padding: the all-sides, horizontal, vertical and per-side keys, in React Native's order (the narrower one wins). */
function setEdges(node: Node, kind: 'Margin' | 'Padding', s: Style): void {
    const set = (edge: number, v: unknown) => {
        if (v === undefined || v === null) return;
        if (kind === 'Margin' && v === 'auto') { node.setMarginAuto(edge); return; }
        if (isPercent(v)) { (kind === 'Margin' ? node.setMarginPercent : node.setPaddingPercent).call(node, edge, percent(v)); return; }
        if (typeof v === 'number') (kind === 'Margin' ? node.setMargin : node.setPadding).call(node, edge, v);
    };
    const key = kind.toLowerCase();
    set(Yoga.EDGE_ALL, s[key]);
    set(Yoga.EDGE_HORIZONTAL, s[`${key}Horizontal`]);
    set(Yoga.EDGE_VERTICAL, s[`${key}Vertical`]);
    for (const [name, edge] of EDGES) set(edge, s[`${key}${name}`]);
}

function applyStyle(node: Node, s: Style): void {
    for (const prop of ['Width', 'Height', 'MinWidth', 'MinHeight', 'MaxWidth', 'MaxHeight'] as const) setSize(node, prop, s[prop[0].toLowerCase() + prop.slice(1)]);
    if (typeof s.flex === 'number') node.setFlex(s.flex);
    if (typeof s.flexGrow === 'number') node.setFlexGrow(s.flexGrow);
    if (typeof s.flexShrink === 'number') node.setFlexShrink(s.flexShrink);
    setSize(node, 'FlexBasis', s.flexBasis);
    if (typeof s.flexDirection === 'string') node.setFlexDirection(FLEX_DIRECTION[s.flexDirection] ?? Yoga.FLEX_DIRECTION_COLUMN);
    if (typeof s.flexWrap === 'string') node.setFlexWrap(WRAP[s.flexWrap] ?? Yoga.WRAP_NO_WRAP);
    if (typeof s.justifyContent === 'string') node.setJustifyContent(JUSTIFY[s.justifyContent] ?? Yoga.JUSTIFY_FLEX_START);
    if (typeof s.alignItems === 'string') node.setAlignItems(ALIGN[s.alignItems] ?? Yoga.ALIGN_STRETCH);
    if (typeof s.alignSelf === 'string') node.setAlignSelf(ALIGN[s.alignSelf] ?? Yoga.ALIGN_AUTO);
    if (typeof s.alignContent === 'string') node.setAlignContent(ALIGN[s.alignContent] ?? Yoga.ALIGN_FLEX_START);
    if (typeof s.position === 'string') node.setPositionType(POSITION[s.position] ?? Yoga.POSITION_TYPE_RELATIVE);
    if (typeof s.overflow === 'string') node.setOverflow(OVERFLOW[s.overflow] ?? Yoga.OVERFLOW_VISIBLE);
    if (s.display === 'none') node.setDisplay(Yoga.DISPLAY_NONE);
    if (typeof s.aspectRatio === 'number') node.setAspectRatio(s.aspectRatio);
    for (const [name, edge] of EDGES) {
        const at = s[name.toLowerCase()];
        if (isPercent(at)) node.setPositionPercent(edge, percent(at));
        else if (typeof at === 'number') node.setPosition(edge, at);
    }
    setEdges(node, 'Margin', s);
    setEdges(node, 'Padding', s);
    if (typeof s.borderWidth === 'number') node.setBorder(Yoga.EDGE_ALL, s.borderWidth);
    for (const [name, edge] of EDGES) if (typeof s[`border${name}Width`] === 'number') node.setBorder(edge, s[`border${name}Width`] as number);
    if (typeof s.gap === 'number') node.setGap(Yoga.GUTTER_ALL, s.gap);
    if (typeof s.rowGap === 'number') node.setGap(Yoga.GUTTER_ROW, s.rowGap);
    if (typeof s.columnGap === 'number') node.setGap(Yoga.GUTTER_COLUMN, s.columnGap);
}

/** A <span> that is not inside another one: React Native's Text, a leaf Yoga measures. */
function isText(el: Element): boolean {
    return el.tagName === 'SPAN' && !el.parentElement?.closest('span');
}

function textMeasure(el: Element, fontScale: number) {
    const s = styleOf(el);
    const fontSize = (typeof s.fontSize === 'number' ? s.fontSize : 14) * fontScale;
    const lineHeight = (typeof s.lineHeight === 'number' ? s.lineHeight * fontScale : fontSize * 1.25);
    const chars = (el.textContent ?? '').length;
    const maxLines = Number(el.getAttribute('data-lines')) || Infinity;
    const natural = chars * fontSize * 0.56;
    return (width: number, widthMode: number) => {
        if (chars === 0) return { width: 0, height: 0 };
        const room = widthMode === Yoga.MEASURE_MODE_UNDEFINED ? Infinity : width;
        const lines = Math.min(maxLines, Math.max(1, Math.ceil(natural / Math.max(room, 1))));
        const w = widthMode === Yoga.MEASURE_MODE_EXACTLY ? width : Math.min(natural, room);
        return { width: w, height: lines * lineHeight };
    };
}

/**
 * Lays `root` out in a viewport of the given size, as the only child of a column that size (the screen around a list).
 * `fontScale` multiplies every font size and line height, as a phone's font setting does.
 */
export function layOut(root: Element, viewport: { width: number; height: number }, options: { fontScale?: number } = {}): Layout {
    const fontScale = options.fontScale ?? 1;
    const config = Yoga.Config.create();
    config.setErrata(Yoga.ERRATA_ALL);
    config.setPointScaleFactor(0);
    const nodes = new Map<Element, Node>();

    const build = (el: Element): Node => {
        const node = Yoga.Node.create(config);
        nodes.set(el, node);
        applyStyle(node, styleOf(el));
        if (isText(el)) {
            node.setMeasureFunc(textMeasure(el, fontScale));
        } else if (el.tagName === 'I' && styleOf(el).width === undefined) {
            node.setWidth(20);
            node.setHeight(20);
        } else if (el.tagName !== 'IMG') {
            Array.from(el.children).forEach((child) => node.insertChild(build(child), node.getChildCount()));
        }
        return node;
    };

    const screen = Yoga.Node.create(config);
    screen.setWidth(viewport.width);
    screen.setHeight(viewport.height);
    screen.insertChild(build(root), 0);
    screen.calculateLayout(viewport.width, viewport.height, Yoga.DIRECTION_LTR);

    const boxes = new Map<Element, Box>();
    for (const [el, node] of nodes) {
        const { left, top, width, height } = node.getComputedLayout();
        boxes.set(el, { left, top, width, height });
    }
    screen.freeRecursive();

    const box = (el: Element): Box => {
        const b = boxes.get(el);
        if (!b) throw new Error('that element is not in the laid-out tree');
        return b;
    };
    return { box, height: (el) => box(el).height, width: (el) => box(el).width };
}
