import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, TextInput, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HOME_SEARCH_KMS, HOME_SEARCH_MAX_CHARS, readSearchSettings, readSkySettings, type HomeSearchKind, type SkySettings } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { SEARCH_KIND_CHIPS, SKY_PLACE_CHIPS, cardName } from '../../utils/home-cards';
import { POST_CATEGORIES } from '../../constants/categories';
import { HOME_TARGET_DP, homeStyles } from './HomeParts';
import { editHomeStyles } from './EditHomeSheet';
import { useModalKeyboardLift } from '../useModalKeyboardLift';

/**
 * A card's settings sheet (CARD-FRAME §1.2, §1.3): the picker opens it on Add for a type with settings (its last button
 * is Add to Home), and the card's "…" → Settings… opens it again with Save, keeping the card where it is. Sun and moon
 * asks one thing: whose place, the community's or the member's own. The saved search (CARD-FRAME §4) asks its words,
 * then Offers or Needs or both, a category, and a distance. The
 * distance chips show only where the node has a point to measure from (the member's area, or the phone's place on the
 * global community); without one the node ignores the distance, so the sheet doesn't offer it, and a kept one stays.
 *
 * Keyboard: lifted by useModalKeyboardLift from the root provider's state, as Create a Group and Invite people are (the
 * Modal's window doesn't shrink for the keyboard, which at 320 dp covered this whole sheet: review of #1699, finding 3).
 * Never a nested KeyboardProvider inside the Modal.
 */
export function CardSettingsSheet({ visible, type, settings, mode, hasPoint = false, colors, onDone, onClose }: {
    visible: boolean;
    type: string | null;
    /** The card's settings now (Settings…), or none (a new card). */
    settings?: Record<string, unknown>;
    /** `add`: from the picker, the button says Add to Home. `save`: from the card's "…". */
    mode: 'add' | 'save';
    /** The node has a point to measure a distance from: the distance chips show. */
    hasPoint?: boolean;
    colors: AppColors;
    onDone: (settings: Record<string, unknown>) => void;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const lift = useModalKeyboardLift(insets.top + 8);
    const [q, setQ] = useState('');
    const [kind, setKind] = useState<HomeSearchKind>('any');
    const [category, setCategory] = useState<string | null>(null);
    const [km, setKm] = useState<number | null>(null);
    const [place, setPlace] = useState<SkySettings['place']>('community');
    useEffect(() => {
        if (!visible) return;
        setPlace(readSkySettings(settings).place);
        const start = readSearchSettings(settings);
        setQ(start.q);
        setKind(start.kind);
        setCategory(start.category ?? null);
        setKm(start.km ?? null);
    }, [visible, settings]);
    if (!type) return null;
    const name = cardName(type);
    const sky = type === 'sky';
    const words = q.trim();
    const ready = sky || !!words;
    const done = () => onDone(sky ? { place } : { q: words, kind, ...(category ? { category } : {}), ...(km ? { km } : {}) });

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
            <View style={editHomeStyles.backdrop}>
                <View style={[editHomeStyles.sheet, { backgroundColor: colors.surface.card, paddingBottom: 12 + insets.bottom, marginTop: insets.top + 24, maxHeight: lift.maxHeight, marginBottom: lift.lift }]} testID="card-settings-sheet">
                    <View style={editHomeStyles.head}>
                        <Text style={[editHomeStyles.title, { color: colors.text.heading }]} accessibilityRole="header">{name}</Text>
                        <Pressable onPress={onClose} style={editHomeStyles.done} accessibilityRole="button" accessibilityLabel="Cancel" testID="card-settings-cancel">
                            <Text style={[editHomeStyles.doneText, { color: colors.text.link }]}>Cancel</Text>
                        </Pressable>
                    </View>
                    <ScrollView style={editHomeStyles.list} keyboardShouldPersistTaps="handled" testID="card-settings-scroll">
                        {sky ? (
                            <SettingChips label="Whose place" id="place" colors={colors} value={place} onPick={setPlace}
                                options={SKY_PLACE_CHIPS.map(p => ({ value: p.place, label: p.label }))} />
                        ) : (<>
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
                            <SettingChips label="Show" id="kind" colors={colors} value={kind} onPick={setKind}
                                options={SEARCH_KIND_CHIPS.map(k => ({ value: k.kind, label: k.label }))} />
                            <SettingChips label="Category" id="category" colors={colors} value={category} onPick={setCategory}
                                options={[{ value: null, label: 'Any category' }, ...POST_CATEGORIES.map(c => ({ value: c.id as string | null, label: `${c.emoji} ${c.label}` }))]} />
                            {hasPoint && (
                                <SettingChips label="Distance" id="km" colors={colors} value={km} onPick={setKm}
                                    options={[{ value: null, label: 'Any distance' }, ...HOME_SEARCH_KMS.map(k => ({ value: k as number | null, label: `${k} km` }))]} />
                            )}
                        </>)}
                        <Pressable
                            disabled={!ready}
                            onPress={done}
                            style={[settingsStyles.button, { backgroundColor: ready ? colors.brand.primary : colors.surface.subtle }]}
                            accessibilityRole="button"
                            accessibilityLabel={mode === 'add' ? `Add ${name} to Home` : `Save ${name}`}
                            accessibilityState={{ disabled: !ready }}
                            testID="card-settings-done"
                        >
                            <Text style={[settingsStyles.buttonText, { color: ready ? colors.text.inverse : colors.text.secondary }]}>{mode === 'add' ? 'Add to Home' : 'Save'}</Text>
                        </Pressable>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

/** One row of chips under its label; the chosen one is filled, and a screen reader hears it as selected. */
function SettingChips<T>({ label, id, colors, options, value, onPick }: {
    label: string; id: string; colors: AppColors; options: ReadonlyArray<{ value: T; label: string }>; value: T; onPick: (v: T) => void;
}) {
    const s = homeStyles(colors);
    return (
        <View accessibilityRole="radiogroup" accessibilityLabel={label} testID={`card-settings-${id}`}>
            <Text style={[settingsStyles.label, { color: colors.text.body, marginTop: 14 }]}>{label}</Text>
            <View style={s.chips}>
                {options.map(o => {
                    const on = o.value === value;
                    return (
                        <Pressable key={String(o.value)} onPress={() => onPick(o.value)} style={[s.chip, on && s.chipOn]}
                            accessibilityRole="radio" accessibilityState={{ selected: on, checked: on }} accessibilityLabel={o.label}
                            testID={`card-settings-${id}-${String(o.value)}`}>
                            <Text style={[s.chipText, on && s.chipTextOn]}>{o.label}</Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

const settingsStyles = StyleSheet.create({
    label: { fontSize: 14, fontWeight: '700', marginTop: 4, marginBottom: 6 },
    input: { minHeight: HOME_TARGET_DP, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 16 },
    button: { marginTop: 16, minHeight: HOME_TARGET_DP, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    buttonText: { fontSize: 15, fontWeight: '700' },
});
