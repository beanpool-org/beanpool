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

    const valid = (photos || []).filter(isValid).filter((uri) => !failed.has(uri));
    const count = valid.length;
    // The list can get shorter while the carousel stays drawn (a Learn page's Edit taking a photo off, #3355 review; or a photo
    // failing to load): the place swiped to must come back inside it, the counter and dots at once ("3 / 2" with no dot lit
    // otherwise) and the scroll itself (Android's horizontal scroll view keeps its offset when its content shrinks, leaving an
    // empty frame).
    const shown = count > 0 ? Math.min(index, count - 1) : 0;
    useEffect(() => {
        if (count === 0 || index <= count - 1) return;
        setIndex(count - 1);
        if (width > 0) scroller.current?.scrollTo({ x: (count - 1) * width, animated: false });
    }, [count, index, width]);
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
                    valid.map((uri, i) => {
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
                        return onOpen ? (
                            <Pressable key={i} accessibilityRole="button" accessibilityLabel={label} style={{ width, height }} onPress={() => onOpen(i, uri)}>
                                {picture}
                            </Pressable>
                        ) : (
                            <React.Fragment key={i}>{picture}</React.Fragment>
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
                        {valid.map((_, i) => (
                            <View key={i} style={[styles.dot, i === shown && styles.dotActive]} />
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
