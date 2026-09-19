import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AccessibilityInfo, Animated, Easing, Pressable, Text, View, StyleSheet,
    type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle,
} from 'react-native';
import { useTheme } from '../app/ThemeContext';
import {
    ACTIVE_FILTER_CHIP, INITIAL_QUICK_RETURN, quickReturnControlsHidden, quickReturnListInset, quickReturnStep,
    type QuickReturnState,
} from '../utils/quick-return';

/** A system accessibility setting, kept current by its change event. */
function useA11ySetting(read: () => Promise<boolean>, event: 'screenReaderChanged' | 'reduceMotionChanged'): boolean {
    const [on, setOn] = useState(false);
    useEffect(() => {
        let live = true;
        read().then(v => { if (live) setOn(v); }).catch(() => {});
        const sub = AccessibilityInfo.addEventListener(event, (v: boolean) => setOn(v));
        return () => { live = false; sub.remove(); };
    }, [read, event]);
    return on;
}

const REVEAL_MS = 180;
const readScreenReader = () => AccessibilityInfo.isScreenReaderEnabled();
const readReduceMotion = () => AccessibilityInfo.isReduceMotionEnabled();

export interface QuickReturn {
    /** Spread onto the list (an Animated.FlatList / Animated.ScrollView). */
    listProps: {
        onScroll: (...args: any[]) => void;
        scrollEventThrottle: number;
        onLayout: (e: LayoutChangeEvent) => void;
        onContentSizeChange: (w: number, h: number) => void;
    };
    /** The block's measured height (title + controls). */
    blockHeight: number;
    /** Room the list leaves at its top for the block: add to its paddingTop (and the refresh spinner's offset). 0 when docked. */
    listInset: number;
    /** Screen reader on: the block sits above the list in the layout instead of over it, so no row is ever under it. */
    docked: boolean;
    titleHeight: number;
    translateY: Animated.AnimatedInterpolation<number> | Animated.AnimatedAddition<number> | Animated.Value;
    onTitleLayout: (e: LayoutChangeEvent) => void;
    onControlsLayout: (e: LayoutChangeEvent) => void;
    /** The controls are fully off screen (a page may show its active-filter chip). */
    hidden: boolean;
    /** Screen reader on, or the page pinned them: the controls never hide. */
    fixed: boolean;
    /** Bring the controls back now (the chip, tap-tab-to-top). */
    show: () => void;
}

/**
 * Quick return (utils/quick-return.ts): the title and a list's search/filter controls sit over the top of
 * the list, ride away with the page as you scroll down, and slide back in on any upward scroll.
 *
 * Everything that moves runs on the native driver — the list's offset feeds an interpolation, and the
 * only JS-side decision (pinned or riding with the page) flips a 0..1 value with a native timing — so
 * nothing re-lays-out while scrolling and a slow phone does not drop frames on it.
 *
 * - A screen reader keeps the controls fixed: they never hide, and the block docks above the list rather
 *   than over it, so focus can never land on a row hidden under the controls.
 * - Reduce motion: they appear and disappear without the slide.
 * - `pinned`: the page is using them (a panel open, the search field focused), so they stay.
 * - `resetKey`: change it whenever the list is remounted (a different layout, a loader in between), so a
 *   fresh list at the top does not inherit the old one's scrolled-away block.
 */
export function useQuickReturn({ pinned = false, resetKey }: { pinned?: boolean; resetKey?: unknown } = {}): QuickReturn {
    const screenReader = useA11ySetting(readScreenReader, 'screenReaderChanged');
    const reduceMotion = useA11ySetting(readReduceMotion, 'reduceMotionChanged');
    const fixed = screenReader || pinned;

    const scrollY = useRef(new Animated.Value(0)).current;
    const reveal = useRef(new Animated.Value(0)).current;
    const still = useRef(new Animated.Value(0)).current;
    const [titleH, setTitleH] = useState(0);
    const [controlsH, setControlsH] = useState(0);
    const [hidden, setHidden] = useState(false);

    const state = useRef<QuickReturnState>(INITIAL_QUICK_RETURN);
    const revealedNow = useRef(false);
    const live = useRef({ fixed, reduceMotion, blockH: 0 });
    live.current = { fixed, reduceMotion, blockH: titleH + controlsH };

    const apply = useCallback((next: QuickReturnState) => {
        state.current = next;
        if (next.revealed !== revealedNow.current) {
            revealedNow.current = next.revealed;
            reveal.stopAnimation();
            if (live.current.reduceMotion) reveal.setValue(next.revealed ? 1 : 0);
            else Animated.timing(reveal, { toValue: next.revealed ? 1 : 0, duration: REVEAL_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
        }
        const h = quickReturnControlsHidden(next, live.current.blockH);
        setHidden(prev => (prev === h ? prev : h));
    }, [reveal]);

    const onScroll = useRef(Animated.event(
        [{ nativeEvent: { contentOffset: { y: scrollY } } }],
        {
            useNativeDriver: true,
            listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
                const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                apply(quickReturnStep(state.current, {
                    y: contentOffset.y,
                    maxY: contentSize.height - layoutMeasurement.height,
                    fixed: live.current.fixed,
                }));
            },
        },
    )).current;

    // A list that shrinks under the offset (a search narrowing it) is moved up by the platform without a
    // scroll event, which left the block placed for the old offset. Follow the clamp here.
    const viewportH = useRef(0);
    const onLayout = useCallback((e: LayoutChangeEvent) => { viewportH.current = e.nativeEvent.layout.height; }, []);
    const onContentSizeChange = useCallback((_w: number, h: number) => {
        if (!viewportH.current) return;
        const maxY = Math.max(0, h - viewportH.current);
        if (state.current.lastY <= maxY) return;
        scrollY.setValue(maxY);
        apply(quickReturnStep(state.current, { y: maxY, fixed: live.current.fixed }));
    }, [scrollY, apply]);

    // Screen reader switched on, or the page pinned the controls: back at once, wherever the list is.
    useEffect(() => {
        apply(quickReturnStep(state.current, { y: state.current.lastY, fixed }));
    }, [fixed, apply]);

    const first = useRef(true);
    useEffect(() => {
        if (first.current) { first.current = false; return; }
        scrollY.setValue(0);
        apply(INITIAL_QUICK_RETURN);
    }, [resetKey, scrollY, apply]);

    const show = useCallback(() => {
        const s = state.current;
        apply({ ...s, revealed: true, anchorY: s.lastY, dir: 0 });
    }, [apply]);

    const translateY = useMemo(() => {
        if (screenReader) return still;
        const T = titleH;
        const H = Math.max(1, controlsH);
        // translateY = -clamp(y, 0, T + H) + clamp(y - T, 0, H) × reveal (utils/quick-return.ts)
        const follow = scrollY.interpolate({ inputRange: [0, T + H], outputRange: [0, -(T + H)], extrapolate: 'clamp' });
        const pin = scrollY.interpolate({ inputRange: [T, T + H], outputRange: [0, H], extrapolate: 'clamp' });
        return Animated.add(follow, Animated.multiply(pin, reveal));
    }, [screenReader, still, titleH, controlsH, scrollY, reveal]);

    const onTitleLayout = useCallback((e: LayoutChangeEvent) => setTitleH(Math.round(e.nativeEvent.layout.height)), []);
    const onControlsLayout = useCallback((e: LayoutChangeEvent) => setControlsH(Math.round(e.nativeEvent.layout.height)), []);

    return { listProps: { onScroll, scrollEventThrottle: 16, onLayout, onContentSizeChange }, blockHeight: titleH + controlsH, listInset: quickReturnListInset(titleH + controlsH, screenReader), docked: screenReader, titleHeight: titleH, translateY, onTitleLayout, onControlsLayout, hidden: hidden && !fixed, fixed, show };
}

/**
 * The block that rides over the top of the list. Place it inside a `{ flex: 1, overflow: 'hidden' }`
 * container together with the list (which spreads `qr.listProps` and adds `qr.listInset` to its
 * paddingTop), so what slides up goes under the tab bar rather than over it. Put it BEFORE the list in
 * that container: its zIndex draws it on top, and a screen reader then reads the controls first.
 *
 * `below` is drawn under the controls but not counted in the block's height: a panel that opens over
 * the list (Market's category tiles) instead of pushing it down.
 */
export function QuickReturnBlock({ qr, title, children, below, style }: {
    qr: QuickReturn;
    title?: React.ReactNode;
    children: React.ReactNode;
    below?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}) {
    const { colors } = useTheme();
    return (
        <Animated.View
            style={[styles.block, qr.docked && styles.blockDocked, { backgroundColor: colors.surface.app, transform: [{ translateY: qr.translateY }] }, style]}
            // Off screen it cannot be reached by touch; keep it out of the accessibility tree too. (With a
            // screen reader on it is never off screen.)
            importantForAccessibility={qr.hidden ? 'no-hide-descendants' : 'auto'}
            accessibilityElementsHidden={qr.hidden}
        >
            <View onLayout={qr.onTitleLayout}>{title}</View>
            <View onLayout={qr.onControlsLayout}>{children}</View>
            {below}
        </Animated.View>
    );
}

/**
 * What is narrowing the list, pinned at the top while the controls are scrolled away — so 100 items deep
 * you can still see why the list is short, bring the controls back (tap) or drop every filter (✕).
 */
export function ActiveFilterChip({ label, onPress, onClear }: { label: string; onPress: () => void; onClear: () => void }) {
    const { colors } = useTheme();
    const pill = [styles.pill, { backgroundColor: colors.surface.card, borderColor: colors.border.default }];
    // Each Pressable is the full 48dp target; the 36dp pill is drawn inside it. (hitSlop would not do:
    // on Android a touch outside the parent's bounds never reaches the child.)
    return (
        <View style={styles.chipWrap} pointerEvents="box-none">
            <View style={styles.chipRow} pointerEvents="box-none">
                <Pressable
                    onPress={onPress}
                    style={styles.chipMain}
                    accessibilityRole="button"
                    accessibilityLabel={`Filtered: ${label}`}
                    accessibilityHint="Shows the search and filters"
                >
                    <View style={[pill, styles.pillLabel]}>
                        <Text style={[styles.chipText, { color: colors.text.body }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{label}</Text>
                    </View>
                </Pressable>
                <Pressable
                    onPress={onClear}
                    style={styles.chipClear}
                    accessibilityRole="button"
                    accessibilityLabel="Clear search and filters"
                >
                    <View style={[pill, styles.pillClear]}>
                        <Text style={[styles.chipClearText, { color: colors.text.secondary }]} maxFontSizeMultiplier={1.3}>✕</Text>
                    </View>
                </Pressable>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    block: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 },
    blockDocked: { position: 'relative' },
    chipWrap: { position: 'absolute', top: 0, left: 16, right: 16, zIndex: 2, alignItems: 'center' },
    chipRow: { flexDirection: 'row', alignItems: 'center', maxWidth: '100%', gap: ACTIVE_FILTER_CHIP.gap },
    chipMain: { flexShrink: 1, minHeight: ACTIVE_FILTER_CHIP.target, justifyContent: 'center' },
    chipClear: { width: ACTIVE_FILTER_CHIP.clearWidth, minHeight: ACTIVE_FILTER_CHIP.target, alignItems: 'center', justifyContent: 'center' },
    pill: {
        minHeight: ACTIVE_FILTER_CHIP.pill, borderRadius: ACTIVE_FILTER_CHIP.pill / 2, borderWidth: 1, justifyContent: 'center',
        shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 6, elevation: 6,
    },
    pillLabel: { paddingHorizontal: 14 },
    pillClear: { width: ACTIVE_FILTER_CHIP.pill, alignItems: 'center' },
    chipText: { fontSize: 13, fontWeight: '700' },
    chipClearText: { fontSize: 15, fontWeight: '800' },
});
