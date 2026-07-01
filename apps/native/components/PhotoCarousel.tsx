/**
 * PhotoCarousel — full-width, swipeable photo gallery for posts (up to 5 photos).
 * Paging + page dots + a "1 / N" counter overlay. Falls back to nothing when
 * there are no valid photos, and disables paging gracefully for a single photo.
 */
import React, { useState } from 'react';
import {
    View,
    Image,
    ScrollView,
    Text,
    StyleSheet,
    NativeSyntheticEvent,
    NativeScrollEvent,
    LayoutChangeEvent,
} from 'react-native';
import { colors } from '../constants/colors';

interface Props {
    photos: string[];
    height?: number;
    borderRadius?: number;
}

function isValid(p: any): p is string {
    return typeof p === 'string' && p.trim() !== '' && p !== 'null' && p !== 'undefined';
}

export function PhotoCarousel({ photos, height = 280, borderRadius = 16 }: Props) {
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
                    valid.map((uri, i) => (
                        <Image key={i} source={{ uri }} style={{ width, height }} resizeMode="cover" />
                    ))}
            </ScrollView>

            {!single && (
                <>
                    <View style={styles.counter}>
                        <Text style={styles.counterText}>
                            {index + 1} / {valid.length}
                        </Text>
                    </View>
                    <View style={styles.dots} pointerEvents="none">
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
