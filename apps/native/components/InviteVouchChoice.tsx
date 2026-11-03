/**
 * "Vouch for them: None, 25, 50, 100" on the invite screen, for someone who can vouch and nobody else (core
 * offersInviteVouch; people.tsx owns the choice, and None is what it holds each time the screen opens). A small plain row,
 * not a card. Four across at 320 dp and 1.3× text, wrapping rather than cutting a word in a longer language; every choice
 * at least 44 dp tall. A screen reader hears the group's name, each choice in Beans, and which is on.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { INVITE_VOUCH_CHOICES, INVITE_VOUCH_WORDS, t, type VouchLevel } from '@beanpool/core';
import type { AppColors } from '../constants/colors';

export function InviteVouchChoice({ value, onChange, colors }: { value: VouchLevel | null; onChange: (level: VouchLevel | null) => void; colors: AppColors }) {
    const label = t(INVITE_VOUCH_WORDS.label);
    return (
        <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.group} testID="invite-vouch">
            <Text style={[styles.label, { color: colors.text.heading }]}>{label}</Text>
            <View style={styles.row}>
                {INVITE_VOUCH_CHOICES.map(({ level, amount }) => {
                    const on = level === value;
                    const shown = amount === null ? t(INVITE_VOUCH_WORDS.none) : String(amount);
                    return (
                        <Pressable
                            key={String(level)}
                            accessibilityRole="radio"
                            accessibilityLabel={amount === null ? shown : t(INVITE_VOUCH_WORDS.beans, { amount })}
                            accessibilityState={{ checked: on }}
                            testID={`invite-vouch-${level ?? 'none'}`}
                            onPress={() => onChange(level)}
                            style={[
                                styles.choice,
                                on
                                    ? { backgroundColor: colors.brand.fill, borderColor: colors.brand.fill }
                                    : { backgroundColor: colors.surface.card, borderColor: colors.border.strong },
                            ]}
                        >
                            <Text style={[styles.choiceText, { color: on ? colors.text.onBrand : colors.text.heading }]}>{shown}</Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    group: { marginBottom: 16 },
    label: { fontSize: 14, fontWeight: '700', marginBottom: 8 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    choice: { flexGrow: 1, minWidth: 56, minHeight: 44, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    choiceText: { fontSize: 14, fontWeight: '700' },
});
