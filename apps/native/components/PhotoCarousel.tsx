/**
 * PhotoCarousel — full-width, swipeable photo gallery for posts (up to 5 photos).
 * Paging + page dots + a "1 / N" counter overlay. Falls back to nothing when
 * there are no valid photos, and disables paging gracefully for a single photo.
 * With `onOpen`, a tap on a photo asks the page to show that photo whole (DESIGN-detail-pages-fable.md §2.6, slice DP4).
 */
import React, { useState } from 'react';
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
import { colors } from '../constants/colors';

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
    const [width, setWidth] = useState(0);
    const [index, setIndex] = useState(0);

    const valid = (photos || []).filter(isValid);
    if (valid.length === 0) return null;

    const single = valid.length === 1;

    const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
    const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (width <= 0) return;
        const i = Math.round(e.nativeEvent.contentOffset.x / width);
        if (i !== index) setIndex(Math.max(0, Math.min(valid.length - 1, i)));
    };

    return (
        <View style={[styles.wrap, { height, borderRadius }]} onLayout={onLayout}>
            <ScrollView
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
                                transition={150}
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
                            {index + 1} / {valid.length}
                        </Text>
                    </View>
                    <View style={styles.dots} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden={true}>
                        {valid.map((_, i) => (
                            <View key={i} style={[styles.dot, i === index && styles.dotActive]} />
                        ))}
                    </View>
                </>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { backgroundColor: colors.surface.subtle, overflow: 'hidden' },
    counter: {
        position: 'absolute',
        top: 10,
        right: 10,
        backgroundColor: 'rgba(0,0,0,0.55)',
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12,
    },
    counterText: { color: colors.text.inverse, fontSize: 12, fontWeight: '700' },
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
    dotActive: { backgroundColor: colors.surface.card, width: 18 },
});
