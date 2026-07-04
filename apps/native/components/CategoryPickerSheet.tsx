import React from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet, Dimensions } from 'react-native';
import { palette } from '../constants/colors';
import { useTheme, useStyles } from '../app/ThemeContext';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const CATEGORIES = [
    { id: 'all', emoji: '🏷️', label: 'All' },
    { id: 'food', emoji: '🥕', label: 'Food' },
    { id: 'services', emoji: '🤝', label: 'Services' },
    { id: 'labour', emoji: '👷', label: 'Labour' },
    { id: 'tools', emoji: '🛠️', label: 'Tools' },
    { id: 'goods', emoji: '📦', label: 'Goods' },
    { id: 'garden', emoji: '🌻', label: 'Garden' },
    { id: 'housing', emoji: '🏠', label: 'Housing' },
    { id: 'transport', emoji: '🚗', label: 'Transport' },
    { id: 'education', emoji: '📚', label: 'Education' },
    { id: 'arts', emoji: '🎨', label: 'Arts' },
    { id: 'health', emoji: '🌿', label: 'Health' },
    { id: 'care', emoji: '❤️', label: 'Care' },
    { id: 'animals', emoji: '🐾', label: 'Animals' },
    { id: 'tech', emoji: '💻', label: 'Tech' },
    { id: 'energy', emoji: '☀️', label: 'Energy' },
    { id: 'general', emoji: '🌱', label: 'General' },
];

// Grid: 4 columns
const ITEM_SIZE = (SCREEN_WIDTH - 48 - 36) / 4; // padding + gaps

interface CategoryPickerSheetProps {
    visible: boolean;
    selected: string;
    onSelect: (categoryId: string) => void;
    onClose: () => void;
}

export function CategoryPickerSheet({ visible, selected, onSelect, onClose }: CategoryPickerSheetProps) {
    const styles = useStyles(({ colors, theme }) => StyleSheet.create({
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
    }));

    return (
        <Modal visible={visible} transparent animationType="slide">
            <Pressable style={styles.overlay} accessibilityRole="button" accessibilityLabel="Close" onPress={onClose}>
                <Pressable style={styles.sheet} accessibilityRole="button" onPress={e => e.stopPropagation()}>
                    {/* Handle bar */}
                    <View style={styles.handleBar} />

                    <Text style={styles.title}>Category</Text>

                    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.grid}>
                        {CATEGORIES.map(cat => {
                            const isActive = selected === cat.id;
                            return (
                                <Pressable
                                    key={cat.id}
                                    style={[styles.item, isActive && styles.itemActive]}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: isActive }}
                                    onPress={() => { onSelect(cat.id); onClose(); }}
                                >
                                    <Text style={styles.itemEmoji}>{cat.emoji}</Text>
                                    <Text style={[styles.itemLabel, isActive && styles.itemLabelActive]} numberOfLines={1}>
                                        {cat.label}
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
