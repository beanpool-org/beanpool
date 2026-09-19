import React from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet, Dimensions } from 'react-native';
import { TIER_LEVELS } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Tier emojis come from @beanpool/core so the filter matches the badges on the cards.
const [NEWCOMER, RESIDENT, STEWARD, ELDER] = TIER_LEVELS;
export const TRUST_FILTERS = [
    { id: 'all', emoji: '👥', label: 'All Users' },
    { id: 'founding', emoji: '🔑', label: 'Founding' },
    { id: 'new', emoji: NEWCOMER.emoji, label: 'Newcomers' },
    { id: 'resident', emoji: RESIDENT.emoji, label: 'Residents' },
    { id: 'steward', emoji: STEWARD.emoji, label: 'Stewards' },
    { id: 'elder', emoji: ELDER.emoji, label: 'Elders' },
] as const;

// Grid: 3 columns for trust levels
const ITEM_SIZE = (SCREEN_WIDTH - 48 - 24) / 3;

interface TrustPickerSheetProps {
    visible: boolean;
    selected: string;
    onSelect: (filterId: string) => void;
    onClose: () => void;
}

export function TrustPickerSheet({ visible, selected, onSelect, onClose }: TrustPickerSheetProps) {
    const styles = useStyles(makeStyles);
    return (
        <Modal visible={visible} transparent animationType="slide">
            <Pressable style={styles.overlay} accessibilityRole="button" accessibilityLabel="Close" onPress={onClose}>
                <Pressable style={styles.sheet} accessibilityRole="button" onPress={e => e.stopPropagation()}>
                    {/* Handle bar */}
                    <View style={styles.handleBar} />

                    <Text style={styles.title}>Filter by Trust Level</Text>

                    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.grid}>
                        {TRUST_FILTERS.map(f => {
                            const isActive = selected === f.id;
                            return (
                                <Pressable
                                    key={f.id}
                                    style={[styles.item, isActive && styles.itemActive]}
                                    accessibilityRole="button"
                                    accessibilityLabel={f.label}
                                    accessibilityState={{ selected: isActive }}
                                    onPress={() => { onSelect(f.id); onClose(); }}
                                >
                                    <Text style={styles.itemEmoji}>{f.emoji}</Text>
                                    <Text style={[styles.itemLabel, isActive && styles.itemLabelActive]} numberOfLines={1}>
                                        {f.label}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </ScrollView>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

// Themed, so the sheet follows dark mode (it used the static light colours).
const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: colors.surface.card,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        padding: 24,
        paddingBottom: 40,
        maxHeight: '60%',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.1,
        shadowRadius: 12,
        elevation: 10,
    },
    handleBar: {
        width: 40,
        height: 4,
        borderRadius: 2,
        backgroundColor: colors.border.strong,
        alignSelf: 'center',
        marginBottom: 16,
    },
    title: {
        fontSize: 18,
        fontWeight: '900',
        color: colors.text.body,
        marginBottom: 20,
        textAlign: 'center',
    },
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
        justifyContent: 'center',
    },
    item: {
        width: ITEM_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: colors.border.default,
        backgroundColor: colors.surface.app,
    },
    itemActive: {
        backgroundColor: colors.accent.tint,
        borderColor: colors.accent.primary,
    },
    itemEmoji: {
        fontSize: 24,
        marginBottom: 4,
    },
    itemLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: colors.text.secondary,
    },
    itemLabelActive: {
        color: colors.accent.primary,
        fontWeight: '800',
    },
});
