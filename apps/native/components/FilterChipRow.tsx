import React, { useRef } from 'react';
import { ScrollView, Pressable, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useStyles } from '../app/ThemeContext';
import type { FilterChip } from '../utils/filter-chips';

interface FilterChipRowProps<Id extends string> {
    chips: ReadonlyArray<FilterChip<Id>>;
    selected: Id;
    onSelect: (id: Id) => void;
    /** Fill for the selected chip. Its text turns white, so pick a colour that carries white text. */
    activeColor: string;
    /** Placement and width cap from the screen (e.g. `{ marginTop: 6, maxWidth: '92%' }`). */
    style?: StyleProp<ViewStyle>;
    accessibilityLabel?: string;
}

/**
 * One horizontally scrollable row of single-select filter chips — emoji + label, the selected one filled.
 * The map's second row uses it for categories and for the event date windows; the Market feed's filter
 * row can adopt it the same way. It never wraps: at 320dp with 1.3x text the row scrolls instead of
 * clipping, and every chip keeps a 48dp touch height.
 *
 * On mount it scrolls the selected chip into view, so a category remembered across a type switch (say
 * 📜 Mindset, far to the right) is on screen when the row comes back.
 */
export function FilterChipRow<Id extends string>({ chips, selected, onSelect, activeColor, style, accessibilityLabel }: FilterChipRowProps<Id>) {
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        // The backing sits on the scroll view, not the content, so it stays a rounded pill while the chips
        // scroll inside it instead of ending in a square edge at the screen side.
        row: {
            flexGrow: 0, borderRadius: 26, overflow: 'hidden',
            backgroundColor: theme === 'dark' ? 'rgba(26,26,26,0.95)' : 'rgba(255,255,255,0.95)',
        },
        content: { alignItems: 'center', padding: 2, gap: 2 },
        chip: { minHeight: 48, paddingHorizontal: 12, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
        chipText: { fontSize: 13, fontWeight: '600', color: colors.text.secondary },
        chipTextActive: { color: '#ffffff', fontWeight: '800' },
    }));

    const scrollRef = useRef<ScrollView>(null);
    const scrolledOnce = useRef(false);

    return (
        <ScrollView
            ref={scrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.row, style]}
            contentContainerStyle={styles.content}
            accessibilityLabel={accessibilityLabel}
        >
            {chips.map(c => {
                const on = c.id === selected;
                return (
                    <Pressable
                        key={c.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={c.label}
                        style={[styles.chip, on && { backgroundColor: activeColor }]}
                        onPress={() => onSelect(c.id)}
                        onLayout={on ? (e) => {
                            if (scrolledOnce.current) return;
                            scrolledOnce.current = true;
                            const x = e.nativeEvent.layout.x;
                            if (x > 0) scrollRef.current?.scrollTo({ x: Math.max(0, x - 24), animated: false });
                        } : undefined}
                    >
                        <Text style={[styles.chipText, on && styles.chipTextActive]} numberOfLines={1}>
                            {c.emoji ? `${c.emoji} ${c.label}` : c.label}
                        </Text>
                    </Pressable>
                );
            })}
        </ScrollView>
    );
}
