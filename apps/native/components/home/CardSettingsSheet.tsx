import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, TextInput, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HOME_SEARCH_MAX_CHARS, readSearchSettings } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { cardName } from '../../utils/home-cards';
import { HOME_TARGET_DP } from './HomeParts';
import { editHomeStyles } from './EditHomeSheet';

/**
 * A card's settings sheet (CARD-FRAME §1.2, §1.3): the picker opens it on Add for a type with settings (its last button
 * is Add to Home), and the card's "…" → Settings… opens it again with Save, keeping the card where it is. Today only the
 * saved search has settings, and only its words are asked here: the kind, category and distance chips are slice F4's.
 */
export function CardSettingsSheet({ visible, type, settings, mode, colors, onDone, onClose }: {
    visible: boolean;
    type: string | null;
    /** The card's settings now (Settings…), or none (a new card). */
    settings?: Record<string, unknown>;
    /** `add`: from the picker, the button says Add to Home. `save`: from the card's "…". */
    mode: 'add' | 'save';
    colors: AppColors;
    onDone: (settings: Record<string, unknown>) => void;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const [q, setQ] = useState('');
    useEffect(() => {
        if (visible) setQ(readSearchSettings(settings).q);
    }, [visible, settings]);
    if (!type) return null;
    const name = cardName(type);
    const words = q.trim();
    const done = () => onDone({ ...readSearchSettings(settings), q: words });

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
            <View style={editHomeStyles.backdrop}>
                <View style={[editHomeStyles.sheet, { backgroundColor: colors.surface.card, paddingBottom: 12 + insets.bottom, marginTop: insets.top + 24 }]} testID="card-settings-sheet">
                    <View style={editHomeStyles.head}>
                        <Text style={[editHomeStyles.title, { color: colors.text.heading }]} accessibilityRole="header">{name}</Text>
                        <Pressable onPress={onClose} style={editHomeStyles.done} accessibilityRole="button" accessibilityLabel="Cancel" testID="card-settings-cancel">
                            <Text style={[editHomeStyles.doneText, { color: colors.text.link }]}>Cancel</Text>
                        </Pressable>
                    </View>
                    <View style={editHomeStyles.list}>
                        <Text style={[settingsStyles.label, { color: colors.text.body }]} nativeID="card-settings-words-label">Words to look for</Text>
                        <TextInput
                            value={q}
                            onChangeText={setQ}
                            maxLength={HOME_SEARCH_MAX_CHARS}
                            placeholder="eggs"
                            placeholderTextColor={colors.text.muted}
                            style={[settingsStyles.input, { color: colors.text.body, borderColor: colors.border.strong, backgroundColor: colors.surface.page }]}
                            accessibilityLabel="Words to look for"
                            accessibilityLabelledBy="card-settings-words-label"
                            returnKeyType="done"
                            onSubmitEditing={() => { if (words) done(); }}
                            testID="card-settings-words"
                        />
                        <Pressable
                            disabled={!words}
                            onPress={done}
                            style={[settingsStyles.button, { backgroundColor: words ? colors.brand.primary : colors.surface.subtle }]}
                            accessibilityRole="button"
                            accessibilityLabel={mode === 'add' ? `Add ${name} to Home` : `Save ${name}`}
                            accessibilityState={{ disabled: !words }}
                            testID="card-settings-done"
                        >
                            <Text style={[settingsStyles.buttonText, { color: words ? colors.text.inverse : colors.text.secondary }]}>{mode === 'add' ? 'Add to Home' : 'Save'}</Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const settingsStyles = StyleSheet.create({
    label: { fontSize: 14, fontWeight: '700', marginTop: 4, marginBottom: 6 },
    input: { minHeight: HOME_TARGET_DP, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 16 },
    button: { marginTop: 16, minHeight: HOME_TARGET_DP, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    buttonText: { fontSize: 15, fontWeight: '700' },
});
