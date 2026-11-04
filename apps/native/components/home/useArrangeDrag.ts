import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { AccessibilityInfo, LayoutAnimation, PanResponder, type GestureResponderEvent, type PanResponderInstance, type ScrollView, type View } from 'react-native';
import { useSharedValue, withTiming } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { placeLifted, type PlaceItem } from '@beanpool/core';
import { createArrangeDrag, DROP_MS, REFLOW_MS, type ArrangeDrag, type Lifted } from '../../utils/arrange-drag';
import { HOME_GUTTER_DP } from './HomeParts';

/**
 * The phone's drag in Arrange, wired to Home (DESIGN-home-arrange-in-place-fable.md §2.2, §2.3, slice A4). The state machine
 * is utils/arrange-drag.ts; this gives it the screen: where the list and the cards are, the scroll, the carried band's two
 * shared values, a PanResponder for each card's wrapper and the ways a drag is put back.
 *
 * Coordinates: "screen" is Home's own view, whose top-left is the list's (the ScrollView fills it from the top). A touch's
 * pageX/pageY are taken from it by `measure` on that view (the same root-view space a touch reports in).
 */
export interface ArrangeDragHome {
    /** Home's own view, measured for where a touch is on it. */
    rootRef: RefObject<View | null>;
    scrollRef: RefObject<ScrollView | null>;
    /** The list's scroll offset, as onScroll last said (and as this moves it). */
    scrollY: MutableRefObject<number>;
    /** The card list's top inside the scrolled content. */
    listY: MutableRefObject<number>;
    /** Each card wrapper's top inside the card list. */
    cardY: MutableRefObject<Map<string, number>>;
    /** The cards in the member's order, the lifted one among them, each with its wrapper's height and whether it moves. */
    items: () => PlaceItem[];
    /** The list's width: its one column is this less the two gutters. */
    width: number;
    /** The drop: saved through the same write as an arrow. */
    save: (id: string, to: number) => void;
    /** False under reduced motion: no reflow animation, and the band goes at once on a drop. */
    motion: MutableRefObject<boolean>;
}

export interface ArrangeDragView {
    /** The card lifted and where it would land, for Home to lay the list out by; null when none. */
    lifted: Lifted | null;
    /** The band in the finger (stays for the drop's 120 ms), or null. */
    ghost: string | null;
    /** The carried band's top-left on Home's view. */
    ghostX: ReturnType<typeof useSharedValue<number>>;
    ghostY: ReturnType<typeof useSharedValue<number>>;
    scrollEnabled: boolean;
    /** The hold fired on card `id`, which stands at place `from` among the cards that move. Refused while TalkBack is on. */
    lift: (id: string, from: number, e: GestureResponderEvent) => boolean;
    /** What each card's wrapper carries: takes the touch from the hold's Pressable once its card is lifted. */
    handlers: (id: string) => PanResponderInstance['panHandlers'] & { onTouchEnd: () => void; onTouchCancel: () => void };
    cancel: () => void;
    drag: ArrangeDrag;
    /** Home's view laid out: where it is, for the touches. */
    onRootLayout: () => void;
    /** The list's content height (onContentSizeChange), for how far the edge may scroll. */
    setContentHeight: (h: number) => void;
}

export function useArrangeDrag(home: ArrangeDragHome): ArrangeDragView {
    const homeRef = useRef(home);
    homeRef.current = home;
    const [lifted, setLiftedState] = useState<Lifted | null>(null);
    const [ghost, setGhost] = useState<string | null>(null);
    const [scrollEnabled, setScrollEnabled] = useState(true);
    const ghostX = useSharedValue(0);
    const ghostY = useSharedValue(0);
    const root = useRef({ x: 0, y: 0 });
    const viewH = useRef(0);
    const contentH = useRef(0);
    const screenReader = useRef(false);
    const dropTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const setContentHeight = useCallback((h: number) => { contentH.current = h; }, []);
    const measureRoot = useCallback(() => {
        homeRef.current.rootRef.current?.measure?.((_x, _y, _w, h, pageX, pageY) => {
            if (Number.isFinite(pageY)) root.current = { x: pageX, y: pageY };
            if (h > 0) viewH.current = h;
        });
    }, []);

    const drag = useMemo(() => createArrangeDrag({
        setScrollEnabled,
        setLifted: next => {
            setLiftedState(prev => {
                // The other cards make room with a short slide; none with reduced motion (the card is just in its new place).
                if (prev && next && prev.to !== next.to && homeRef.current.motion.current) {
                    LayoutAnimation.configureNext(LayoutAnimation.create(REFLOW_MS, 'easeInEaseOut', 'opacity'));
                }
                return next;
            });
        },
        moveGhost: (x, y) => { ghostX.value = x; ghostY.value = y; },
        place: (id, point, current) => placeLifted(homeRef.current.items(), id, point, 1, colWidth(homeRef.current.width), 0, current),
        toList: p => ({ x: colWidth(homeRef.current.width) / 2, y: p.y + homeRef.current.scrollY.current - homeRef.current.listY.current }),
        viewport: () => ({ top: 0, bottom: viewH.current }),
        scrollBy: dy => {
            const h = homeRef.current;
            const was = h.scrollY.current;
            const max = Math.max(0, contentH.current - viewH.current);
            const next = Math.min(max, Math.max(0, was + dy));
            if (next === was) return 0;
            h.scrollY.current = next;
            h.scrollRef.current?.scrollTo({ y: next, animated: false });
            return next - was;
        },
        haptic: () => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); },
        save: (id, to) => homeRef.current.save(id, to),
        ended: (id, released) => {
            const h = homeRef.current;
            if (dropTimer.current) clearTimeout(dropTimer.current);
            const top = h.cardY.current.get(id);
            // Put back (Back, blur, the system took the touch) or reduced motion: the band just goes.
            if (!released || !h.motion.current || top === undefined) { setGhost(null); return; }
            // The band goes back into the card's own band, where the card now stands, then goes.
            ghostX.value = withTiming(HOME_GUTTER_DP, { duration: DROP_MS });
            ghostY.value = withTiming(h.listY.current + top - h.scrollY.current, { duration: DROP_MS });
            dropTimer.current = setTimeout(() => { dropTimer.current = null; setGhost(null); }, DROP_MS);
        },
        frame: cb => {
            const handle = requestAnimationFrame(cb);
            return () => cancelAnimationFrame(handle);
        },
    }), [ghostX, ghostY]);

    const lift = useCallback((id: string, from: number, e: GestureResponderEvent) => {
        // TalkBack's way is the arrows: a hold that reaches a card through explore-by-touch never lifts it.
        if (screenReader.current) return false;
        const h = homeRef.current;
        const finger = { x: e.nativeEvent.pageX - root.current.x, y: e.nativeEvent.pageY - root.current.y };
        const top = h.listY.current + (h.cardY.current.get(id) ?? 0) - h.scrollY.current;
        if (dropTimer.current) { clearTimeout(dropTimer.current); dropTimer.current = null; }
        const ok = drag.lift(id, from, finger, { x: finger.x - HOME_GUTTER_DP, y: finger.y - top });
        if (ok) setGhost(id);
        // Measured again for the next touch (the view can move with a banner above Home).
        measureRoot();
        return ok;
    }, [drag, measureRoot]);

    const responders = useRef(new Map<string, ReturnType<ArrangeDragView['handlers']>>());
    const handlers = useCallback((id: string) => {
        let r = responders.current.get(id);
        if (!r) {
            const pan = PanResponder.create({
                // Taps, the arrows and a scroll are never this wrapper's: only a card already lifted by its hold.
                onStartShouldSetPanResponder: () => false,
                onMoveShouldSetPanResponderCapture: () => drag.wants(id),
                onMoveShouldSetPanResponder: () => drag.wants(id),
                onPanResponderGrant: () => drag.grant(),
                onPanResponderMove: (_e, g) => drag.move({ x: g.moveX - root.current.x, y: g.moveY - root.current.y }),
                onPanResponderRelease: () => drag.release(),
                onPanResponderTerminate: () => drag.cancel(),
                // Once lifted, nothing else takes the finger until it leaves the screen.
                onPanResponderTerminationRequest: () => !drag.wants(id),
                onShouldBlockNativeResponder: () => true,
            });
            r = {
                ...pan.panHandlers,
                // A hold let go without moving: the wrapper never took the touch. Nothing moved, so nothing is saved.
                onTouchEnd: () => { if (drag.phase === 'lifted' && drag.wants(id)) drag.release(); },
                onTouchCancel: () => { if (drag.phase === 'lifted' && drag.wants(id)) drag.cancel(); },
            };
            responders.current.set(id, r);
        }
        return r;
    }, [drag]);

    // TalkBack coming on, the screen going away: put back, nothing saved. (The app going to the background is Home's own
    // AppState listener's to say: it calls `cancel`.)
    useEffect(() => {
        void AccessibilityInfo.isScreenReaderEnabled?.().then(on => { screenReader.current = !!on; }).catch(() => {});
        const reader = AccessibilityInfo.addEventListener?.('screenReaderChanged', (on: boolean) => {
            screenReader.current = on;
            if (on) drag.cancel();
        });
        return () => {
            reader?.remove();
            drag.cancel();
            if (dropTimer.current) clearTimeout(dropTimer.current);
        };
    }, [drag]);

    return {
        lifted,
        ghost,
        ghostX,
        ghostY,
        scrollEnabled,
        lift,
        handlers,
        cancel: drag.cancel,
        drag,
        onRootLayout: measureRoot,
        setContentHeight,
    };
}

/** The one column's width: the list's, less a gutter each side. */
const colWidth = (width: number) => Math.max(0, width - 2 * HOME_GUTTER_DP);
