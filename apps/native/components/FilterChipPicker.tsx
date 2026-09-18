import React, { useState } from 'react';
import { View, ScrollView, Pressable, Text, StyleSheet, useWindowDimensions, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { useStyles } from '../app/ThemeContext';
import { tilePanelColumns, TILE_GAP, TILE_PANEL_PADDING, type FilterChip } from '../utils/filter-chips';

/** Adds 7dp above and below a ~34dp pill, so the finger target is 48dp. */
export const CHIP_HIT_SLOP = { top: 7, bottom: 7 } as const;

interface FilterChipButtonProps {
    label: string;
    /** Filled with `activeColor` and white text while its filter is doing something. */
    active: boolean;
    activeColor: string;
    onPress: () => void;
    /**
     * Floating: its own backing and shadow, for a chip that sits on the map by itself. Flat: no backing, for a
     * chip inside a FilterChipBar (the bar is the backing).
     */
    variant?: 'floating' | 'flat';
    /** Set for a chip that opens a panel: read out as expanded or collapsed. */
    expanded?: boolean;
    /** Set for a chip in a single-select row: read out as selected. */
    selected?: boolean;
    accessibilityLabel?: string;
    style?: StyleProp<ViewStyle>;
    onLayout?: (e: LayoutChangeEvent) => void;
}

/**
 * One filter chip, its label on one line. The map's rows and the Market feed's share it. It looks as slim as the
 * pills always did (8dp above and below the label); `hitSlop` stretches the tap area to 48dp without making
 * the pill taller — a 48dp minimum height here drew every pill as a tall lozenge.
 */
export function FilterChipButton({
    label, active, activeColor, onPress, variant = 'floating', expanded, selected, accessibilityLabel, style, onLayout,
}: FilterChipButtonProps) {
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        floating: {
            paddingVertical: 8, paddingHorizontal: 16, borderRadius: 24, justifyContent: 'center', alignItems: 'center',
            backgroundColor: theme === 'dark' ? 'rgba(26,26,26,0.95)' : 'rgba(255,255,255,0.95)',
            shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 6, elevation: 6,
        },
        flat: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
        floatingText: { fontSize: 13, fontWeight: '700', color: colors.text.secondary },
        flatText: { fontSize: 13, fontWeight: '600', color: colors.text.secondary },
        textActive: { color: '#ffffff', fontWeight: '800' },
    }));
    const flat = variant === 'flat';
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={expanded !== undefined ? { expanded } : selected !== undefined ? { selected } : undefined}
            accessibilityLabel={accessibilityLabel}
            style={[flat ? styles.flat : styles.floating, active && { backgroundColor: activeColor }, style]}
            onPress={onPress}
            hitSlop={CHIP_HIT_SLOP}
            onLayout={onLayout}
        >
            <Text style={[flat ? styles.flatText : styles.floatingText, active && styles.textActive]} numberOfLines={1}>{label}</Text>
        </Pressable>
    );
}

interface FilterChipPanelProps<Id extends string> {
    chips: ReadonlyArray<FilterChip<Id>>;
    selected: Id;
    /** A tile was picked. The screen applies it and closes the panel. */
    onSelect: (id: Id) => void;
    activeColor: string;
    /** Tallest the panel may be. Past it the tiles scroll vertically, never sideways. */
    panelMaxHeight?: number;
    style?: StyleProp<ViewStyle>;
}

/**
 * Every option as tiles, wrapping onto as many rows as it takes so all of them are visible at once. Tiles
 * are emoji above label, at least 48dp tall. Four per row at normal width, fewer when four would squeeze a
 * label at a large text size (`tilePanelColumns`).
 */
export function FilterChipPanel<Id extends string>({ chips, selected, onSelect, activeColor, panelMaxHeight, style }: FilterChipPanelProps<Id>) {
    const { fontScale } = useWindowDimensions();
    const [innerWidth, setInnerWidth] = useState(0);
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        panel: {
            marginTop: 6, alignSelf: 'stretch', borderRadius: 20, overflow: 'hidden',
            // Opaque: at 0.97 the map's labels and pins still showed through behind the tiles.
            backgroundColor: theme === 'dark' ? '#1a1a1a' : '#ffffff',
            shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 8,
        },
        grid: { flexDirection: 'row', flexWrap: 'wrap', padding: TILE_PANEL_PADDING, gap: TILE_GAP },
        // Compact so all 18 categories fit on a 320dp phone at 1.3x text: five rows of four at the 48dp floor.
        tile: {
            minHeight: 48, paddingVertical: 3, paddingHorizontal: 2, borderRadius: 14,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
        },
        tileEmoji: { fontSize: 18, lineHeight: 22 },
        tileText: { fontSize: 11, fontWeight: '600', color: colors.text.secondary, textAlign: 'center' },
        tileTextActive: { color: '#ffffff', fontWeight: '800' },
    }));

    const cols = innerWidth ? tilePanelColumns(innerWidth, fontScale) : 4;
    const tileWidth = innerWidth ? Math.floor((innerWidth - TILE_GAP * (cols - 1)) / cols) : 0;

    return (
        <View style={[styles.panel, style]}>
            <ScrollView style={panelMaxHeight ? { maxHeight: panelMaxHeight } : undefined} bounces={false}>
                {/* Measured, then the tiles lay out at the computed width. */}
                <View style={styles.grid} onLayout={e => setInnerWidth(e.nativeEvent.layout.width - 2 * TILE_PANEL_PADDING)}>
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
                                {/* The emoji is a picture, not text: it keeps its size at large text so the label gets the room. */}
                                {c.emoji ? <Text style={styles.tileEmoji} allowFontScaling={false}>{c.emoji}</Text> : null}
                                <Text style={[styles.tileText, on && styles.tileTextActive]} numberOfLines={2}>{c.label}</Text>
                            </Pressable>
                        );
                    })}
                </View>
            </ScrollView>
        </View>
    );
}

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
 * panel of every option as tiles (FilterChipPanel) under it. The map uses it for its 18 categories. The
 * Market feed uses the same two pieces apart — the chip sits in its filter bar beside Distance and Trust,
 * and the panel opens full width under the bar.
 *
 * Controlled: the screen owns `open` so it can also close the panel on its own events (a tap on the map).
 */
export function FilterChipPicker<Id extends string>({
    chips, selected, chipLabel, open, onToggle, onSelect, activeColor, style, panelMaxHeight, accessibilityLabel,
}: FilterChipPickerProps<Id>) {
    return (
        <View style={[{ alignItems: 'center' }, style]} pointerEvents="box-none">
            <FilterChipButton
                label={chipLabel}
                active={selected !== chips[0]?.id}
                activeColor={activeColor}
                onPress={onToggle}
                expanded={open}
                accessibilityLabel={accessibilityLabel}
            />
            {open && (
                <FilterChipPanel chips={chips} selected={selected} onSelect={onSelect} activeColor={activeColor} panelMaxHeight={panelMaxHeight} />
            )}
        </View>
    );
}
