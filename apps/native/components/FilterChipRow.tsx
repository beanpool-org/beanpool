import React, { useRef, useState } from 'react';
import { View, ScrollView, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useStyles, useTheme } from '../app/ThemeContext';
import { FilterChipButton } from './FilterChipPicker';
import type { FilterChip } from '../utils/filter-chips';

interface FilterChipBarProps {
    children: React.ReactNode;
    /** Placement and width cap from the screen (e.g. `{ marginTop: 6, maxWidth: '92%' }`). */
    style?: StyleProp<ViewStyle>;
    /** Stretch the chips to fill the bar's width when they fit, instead of packing them at the start. */
    fill?: boolean;
    /**
     * Wrap onto more lines instead of scrolling sideways, so every chip is always on screen. For a short
     * row whose every option must be seen (the Market feed's type pills); a line of chips costs 52dp.
     */
    wrap?: boolean;
    /**
     * While chips sit past the right edge, fade that edge and show a ›, so a chip that ends flush with the
     * edge does not hide the ones after it.
     */
    moreHint?: boolean;
    accessibilityLabel?: string;
    scrollRef?: React.RefObject<ScrollView | null>;
}

/**
 * The rounded backing that a row of flat filter chips (FilterChipButton variant="flat") sits in. Unless told
 * to wrap, it never does: at 320dp with 1.3x text the row scrolls sideways instead of clipping a label, and
 * every chip keeps its 48dp touch height.
 */
export function FilterChipBar({ children, style, fill, wrap, moreHint, accessibilityLabel, scrollRef }: FilterChipBarProps) {
    const [barW, setBarW] = useState(0);
    const [contentW, setContentW] = useState(0);
    const [scrollX, setScrollX] = useState(0);
    const { theme, colors } = useTheme();
    const backing = theme === 'dark' ? 'rgba(26,26,26,0.95)' : 'rgba(255,255,255,0.95)';
    const styles = useStyles(({ theme }) => StyleSheet.create({
        // The backing sits on the scroll view, not the content, so it stays a rounded pill while the chips
        // scroll inside it instead of ending in a square edge at the screen side.
        row: {
            flexGrow: 0, borderRadius: 26, overflow: 'hidden',
            backgroundColor: theme === 'dark' ? 'rgba(26,26,26,0.95)' : 'rgba(255,255,255,0.95)',
        },
        content: { alignItems: 'center', padding: 2, gap: 2 },
        contentFill: { flexGrow: 1 },
        wrapped: { flexDirection: 'row', flexWrap: 'wrap' },
        more: { position: 'absolute', top: 0, bottom: 0, right: 0, width: 40, borderTopRightRadius: 26, borderBottomRightRadius: 26, alignItems: 'flex-end', justifyContent: 'center', paddingRight: 8 },
        moreText: { fontSize: 20, fontWeight: '800' },
    }));
    if (wrap) {
        return (
            <View style={[styles.row, styles.content, styles.wrapped, style]} accessibilityLabel={accessibilityLabel}>
                {children}
            </View>
        );
    }
    const scroller = (
        <ScrollView
            ref={scrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.row, !moreHint && style]}
            contentContainerStyle={[styles.content, fill && styles.contentFill]}
            accessibilityLabel={accessibilityLabel}
            onLayout={moreHint ? e => setBarW(e.nativeEvent.layout.width) : undefined}
            onContentSizeChange={moreHint ? w => setContentW(w) : undefined}
            onScroll={moreHint ? e => setScrollX(e.nativeEvent.contentOffset.x) : undefined}
            scrollEventThrottle={moreHint ? 32 : undefined}
        >
            {children}
        </ScrollView>
    );
    if (!moreHint) return scroller;
    const more = barW > 0 && contentW - scrollX - barW > 4;
    return (
        <View style={style}>
            {scroller}
            {more && (
                <LinearGradient
                    colors={[backing.replace('0.95', '0'), backing]}
                    start={{ x: 0, y: 0.5 }}
                    end={{ x: 0.6, y: 0.5 }}
                    style={styles.more}
                    pointerEvents="none"
                >
                    <Text style={[styles.moreText, { color: colors.text.secondary }]} allowFontScaling={false}>›</Text>
                </LinearGradient>
            )}
        </View>
    );
}

interface FilterChipRowProps<Id extends string> {
    chips: ReadonlyArray<FilterChip<Id>>;
    selected: Id;
    onSelect: (id: Id) => void;
    /** Fill for the selected chip. Its text turns white, so pick a colour that carries white text. */
    activeColor: string;
    /** Placement and width cap from the screen (e.g. `{ marginTop: 6, maxWidth: '92%' }`). */
    style?: StyleProp<ViewStyle>;
    /** Stretch the chips to fill the row when they fit (the Market feed's type row). */
    fill?: boolean;
    /** Wrap onto more lines instead of scrolling (FilterChipBar). */
    wrap?: boolean;
    /** Fade the right edge while chips sit past it (FilterChipBar). */
    moreHint?: boolean;
    /** Extra style for every chip, e.g. narrower side padding so a row of short labels fits one line. */
    chipStyle?: StyleProp<ViewStyle>;
    accessibilityLabel?: string;
}

/**
 * One row of single-select filter chips — emoji + label, the selected one filled. Scrolls sideways, or wraps.
 * The map's second row uses it for the event date windows; the Market feed uses it for its type pills and
 * for the same date windows.
 *
 * When it scrolls, on mount it brings the selected chip into view, so a choice remembered across a switch
 * (say Next 7 days, far to the right) is on screen when the row comes back.
 */
export function FilterChipRow<Id extends string>({ chips, selected, onSelect, activeColor, style, fill, wrap, moreHint, chipStyle, accessibilityLabel }: FilterChipRowProps<Id>) {
    const scrollRef = useRef<ScrollView>(null);
    const scrolledOnce = useRef(false);

    return (
        <FilterChipBar scrollRef={scrollRef} style={style} fill={fill} wrap={wrap} moreHint={moreHint} accessibilityLabel={accessibilityLabel}>
            {chips.map(c => {
                const on = c.id === selected;
                return (
                    <FilterChipButton
                        key={c.id}
                        variant="flat"
                        label={c.emoji ? `${c.emoji} ${c.label}` : c.label}
                        accessibilityLabel={c.label}
                        active={on}
                        selected={on}
                        activeColor={activeColor}
                        style={[fill && { flexGrow: 1 }, chipStyle]}
                        onPress={() => onSelect(c.id)}
                        onLayout={on && !wrap ? (e) => {
                            if (scrolledOnce.current) return;
                            scrolledOnce.current = true;
                            const x = e.nativeEvent.layout.x;
                            if (x > 0) scrollRef.current?.scrollTo({ x: Math.max(0, x - 24), animated: false });
                        } : undefined}
                    />
                );
            })}
        </FilterChipBar>
    );
}
