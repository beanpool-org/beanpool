/**
 * PhotoCarousel — full-width, swipeable photo gallery for posts (up to 5 photos).
 * Paging + page dots + a "1 / N" counter overlay. Falls back to nothing when
 * there are no valid photos, and disables paging gracefully for a single photo.
 * With `onOpen`, a tap on a photo asks the page to show that photo whole (DESIGN-detail-pages-fable.md §2.6, slice DP4).
 */
import React, { useEffect, useRef, useState } from 'react';
import {
    View,
    Pressable,
    ScrollView,
    Text,
    StyleSheet,
    NativeSyntheticEvent,
    NativeScrollEvent,
    LayoutChangeEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { t } from '@beanpool/core';
import { palette } from '../constants/colors';
import { useTheme } from '../app/ThemeContext';

interface Props {
    photos: string[];
    height?: number;
    borderRadius?: number;
    /**
     * Given, each photo is a button ("Photo {n} of {count}") that calls this with the photo's place among the photos drawn and its
     * own URL (the same ~800 px photo the frame crops: no bigger copy exists, memory photos-stay-800px). Absent, nothing is pressable.
     */
    onOpen?: (index: number, uri: string) => void;
}

function isValid(p: any): p is string {
    return typeof p === 'string' && p.trim() !== '' && p !== 'null' && p !== 'undefined';
}

export function PhotoCarousel({ photos, height = 280, borderRadius = 16, onOpen }: Props) {
    // The empty frame is the page's, in the colour set being drawn (walk 148: a near-white box in Dark until a photo drew). The
    // counter and the dots sit on the photo itself, and stay white in every set.
    const frame = useTheme().colors.surface.subtle;
    const [width, setWidth] = useState(0);
    const [index, setIndex] = useState(0);
    // URIs that failed to load: dropped from the carousel so a page never sits on an empty box (or opens a blank viewer on tap).
    // Keyed by URI so a fresh URL/version from a sync tries again.
    const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
    const scroller = useRef<ScrollView>(null);

    const valid = (photos || [])
        .map((uri, origIndex) => ({ uri, origIndex }))
        .filter((item): item is { uri: string; origIndex: number } => isValid(item.uri) && !failed.has(item.uri));
    const count = valid.length;
    const validKey = valid.map((item) => `${item.origIndex}:${item.uri}`).join('\0');
    const prevValidRef = useRef(valid);
    // The list can get shorter while the carousel stays drawn (a Learn page's Edit taking a photo off, #3355 review; or a photo
    // failing to load): keep the viewed slide in place when an earlier slide drops, reset index on 0 so fresh URLs start on slide 1,
    // and clamp the counter/dots and scroll offset when the end shrinks (Android's ScrollView keeps its old offset otherwise).
    const shown = count > 0 ? Math.min(index, count - 1) : 0;
    useEffect(() => {
        const prevValid = prevValidRef.current;
        prevValidRef.current = valid;
        if (count === 0) {
            if (index !== 0) setIndex(0);
            return;
        }
        const listChanged =
            prevValid.length !== valid.length ||
            prevValid.some((item, i) => item.uri !== valid[i]?.uri || item.origIndex !== valid[i]?.origIndex);
        if (listChanged && prevValid.length > 0) {
            const clampedPrev = Math.min(index, prevValid.length - 1);
            const active = prevValid[clampedPrev];
            if (active) {
                const sameIdx = valid.findIndex((item) => item.origIndex === active.origIndex && item.uri === active.uri);
                if (sameIdx !== -1 && sameIdx !== index) {
                    setIndex(sameIdx);
                    if (width > 0) scroller.current?.scrollTo({ x: sameIdx * width, animated: false });
                    return;
                }
                if (sameIdx === -1) {
                    const survivingOrig = new Set(valid.map((item) => item.origIndex));
                    const removedBefore = prevValid
                        .slice(0, clampedPrev)
                        .filter((item) => !survivingOrig.has(item.origIndex)).length;
                    const nextIndex = Math.max(0, Math.min(count - 1, clampedPrev - removedBefore));
                    if (nextIndex !== index) {
                        setIndex(nextIndex);
                        if (width > 0) scroller.current?.scrollTo({ x: nextIndex * width, animated: false });
                        return;
                    }
                }
            }
        }
        if (index <= count - 1) return;
        setIndex(count - 1);
        if (width > 0) scroller.current?.scrollTo({ x: (count - 1) * width, animated: false });
    }, [validKey, count, index, width]);
    if (count === 0) return null;

    const single = valid.length === 1;

    const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
    const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (width <= 0) return;
        const i = Math.round(e.nativeEvent.contentOffset.x / width);
        if (i !== index) setIndex(Math.max(0, Math.min(valid.length - 1, i)));
    };
    const markFailed = (uri: string) => {
        setFailed((prev) => {
            if (prev.has(uri)) return prev;
            const next = new Set(prev);
            next.add(uri);
            return next;
        });
    };

    return (
        <View style={[styles.wrap, { height, borderRadius, backgroundColor: frame }]} onLayout={onLayout}>
            <ScrollView
                ref={scroller}
                horizontal
                pagingEnabled={!single}
                scrollEnabled={!single}
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={onScrollEnd}
            >
                {width > 0 &&
                    valid.map(({ uri, origIndex }, i) => {
                        const label = t('Photo {n} of {count}', { n: i + 1, count: valid.length });
                        const picture = (
                            <Image
                                source={{ uri }}
                                style={{ width, height }}
                                contentFit="cover"
                                cachePolicy="memory-disk"
                                transition={0}
                                onError={() => markFailed(uri)}
                                accessibilityLabel={label}
                            />
                        );
                        // The page's frame crops (4:3), so a page that can show the photo whole hands us onOpen and each photo is a
                        // button for it. Without onOpen (a copy's page, anything else) it stays a picture and nothing is pressable.
                        // Key by pre-filter `origIndex` (not post-filter `i`, and without `uri`) so dropping an earlier failed slide
                        // never reuses its native expo-image view for a surviving slide, while in-place Edit `?v=` updates still reuse it.
                        return onOpen ? (
                            <Pressable key={origIndex} accessibilityRole="button" accessibilityLabel={label} style={{ width, height }} onPress={() => onOpen(i, uri)}>
                                {picture}
                            </Pressable>
                        ) : (
                            <React.Fragment key={origIndex}>{picture}</React.Fragment>
                        );
                    })}
            </ScrollView>

            {!single && (
                <>
                    <View style={styles.counter} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden={true}>
                        <Text style={styles.counterText}>
                            {shown + 1} / {valid.length}
                        </Text>
                    </View>
                    <View style={styles.dots} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden={true}>
                        {valid.map(({ origIndex }, i) => (
                            <View key={origIndex} style={[styles.dot, i === shown && styles.dotActive]} />
                        ))}
                    </View>
                </>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { overflow: 'hidden' },
    counter: {
        position: 'absolute',
        top: 10,
        right: 10,
        backgroundColor: 'rgba(0,0,0,0.55)',
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12,
    },
    counterText: { color: palette.white, fontSize: 12, fontWeight: '700' },
    dots: {
        position: 'absolute',
        bottom: 10,
        left: 0,
        right: 0,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 6,
    },
    dot: {
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: 'rgba(255,255,255,0.55)',
    },
    dotActive: { backgroundColor: palette.white, width: 18 },
});
