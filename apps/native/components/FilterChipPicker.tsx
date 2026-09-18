import React, { useState } from 'react';
import { View, ScrollView, Pressable, Text, StyleSheet, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { useStyles } from '../app/ThemeContext';
import { tilePanelColumns, TILE_GAP, type FilterChip } from '../utils/filter-chips';

interface FilterChipPickerProps<Id extends string> {
    chips: ReadonlyArray<FilterChip<Id>>;
    selected: Id;
    /** Text of the collapsed chip, e.g. "🏷️ All Categories ▾". */
    chipLabel: string;
    open: boolean;
    /** The collapsed chip was tapped: open the panel, or close it if open. */
    onToggle: () => void;
    /** A tile was picked. The screen applies it and closes the panel. */
    onSelect: (id: Id) => void;
    /** Fill for the chosen tile and, once something other than the first chip is chosen, the collapsed chip. */
    activeColor: string;
    /** Placement and width cap from the screen (e.g. `{ marginTop: 6, maxWidth: '92%' }`). */
    style?: StyleProp<ViewStyle>;
    /** Tallest the open panel may be. Past it the tiles scroll vertically, never sideways. */
    panelMaxHeight?: number;
    accessibilityLabel?: string;
}

/**
 * A single-select filter with many options: collapsed, ONE chip naming the current choice; tapped open, a
 * panel of every option as tiles, wrapping onto as many rows as it takes so all of them are visible at
 * once. The map uses it for its 18 categories; the Market feed's filter row can adopt it the same way.
 *
 * Controlled: the screen owns `open` so it can also close the panel on its own events (a tap on the map).
 * Tiles are emoji above label, at least 48dp tall. Four per row at normal width, fewer when four would
 * squeeze a label at a large text size (`tilePanelColumns`).
 */
export function FilterChipPicker<Id extends string>({
    chips, selected, chipLabel, open, onToggle, onSelect, activeColor, style, panelMaxHeight, accessibilityLabel,
}: FilterChipPickerProps<Id>) {
    const { fontScale } = useWindowDimensions();
    const [innerWidth, setInnerWidth] = useState(0);
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        wrap: { alignItems: 'center' },
        chip: {
            minHeight: 48, paddingHorizontal: 16, borderRadius: 24, justifyContent: 'center', alignItems: 'center',
            backgroundColor: theme === 'dark' ? 'rgba(26,26,26,0.95)' : 'rgba(255,255,255,0.95)',
            shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 6, elevation: 6,
        },
        chipText: { fontSize: 13, fontWeight: '700', color: colors.text.secondary },
        chipTextActive: { color: '#ffffff', fontWeight: '800' },
        panel: {
            marginTop: 6, alignSelf: 'stretch', borderRadius: 20, overflow: 'hidden',
            backgroundColor: theme === 'dark' ? 'rgba(26,26,26,0.97)' : 'rgba(255,255,255,0.97)',
            shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 8,
        },
        grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 6, gap: TILE_GAP },
        tile: {
            minHeight: 48, paddingVertical: 6, paddingHorizontal: 2, borderRadius: 14,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
        },
        tileEmoji: { fontSize: 20, lineHeight: 26 },
        tileText: { fontSize: 12, fontWeight: '600', color: colors.text.secondary, textAlign: 'center' },
        tileTextActive: { color: '#ffffff', fontWeight: '800' },
    }));

    const cols = innerWidth ? tilePanelColumns(innerWidth, fontScale) : 4;
    const tileWidth = innerWidth ? Math.floor((innerWidth - TILE_GAP * (cols - 1)) / cols) : 0;
    const chosen = selected !== chips[0]?.id;

    return (
        <View style={[styles.wrap, style]} pointerEvents="box-none">
            <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                accessibilityLabel={accessibilityLabel}
                style={[styles.chip, chosen && { backgroundColor: activeColor }]}
                onPress={onToggle}
            >
                <Text style={[styles.chipText, chosen && styles.chipTextActive]} numberOfLines={1}>{chipLabel}</Text>
            </Pressable>

            {open && (
                <View style={styles.panel}>
                    <ScrollView style={panelMaxHeight ? { maxHeight: panelMaxHeight } : undefined} bounces={false}>
                        {/* Measured once, then the tiles lay out at the computed width. padding 6 either side. */}
                        <View style={styles.grid} onLayout={e => setInnerWidth(e.nativeEvent.layout.width - 12)}>
                            {tileWidth > 0 && chips.map(c => {
                                const on = c.id === selected;
                                return (
                                    <Pressable
                                        key={c.id}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected: on }}
                                        accessibilityLabel={c.label}
                                        style={[styles.tile, { width: tileWidth }, on && { backgroundColor: activeColor }]}
                                        onPress={() => onSelect(c.id)}
                                    >
                                        {c.emoji ? <Text style={styles.tileEmoji}>{c.emoji}</Text> : null}
                                        <Text style={[styles.tileText, on && styles.tileTextActive]} numberOfLines={2}>{c.label}</Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    </ScrollView>
                </View>
            )}
        </View>
    );
}
