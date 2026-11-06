/**
 * Native VouchPresetChoice component (slice V3):
 * "Vouch for them: None · 25 · 50 · 75 · 100" from core VOUCH_PRESETS,
 * with "From your budget: 550 of 1,000 left" under it;
 * presets above what is left are disabled ("Not enough budget left").
 *
 * Meets 44 dp min target size and wraps cleanly on 320 dp screens at 1.3x text.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { formatNumber, t, VOUCH_PRESETS, VOUCH_MAX, vouchPresets } from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';

export interface VouchPresetChoiceProps {
    value: number | null;
    onChange: (value: number | null) => void;
    budgetLeft: number;
    budgetTotal: number;
    /** What you have vouched for this person already (the node's figure): a preset past VOUCH_MAX with it is greyed. */
    priorVouch?: number;
    /** Their callsign, for the sentence a greyed-by-the-cap preset says. */
    personName?: string;
}

export function VouchPresetChoice({ value, onChange, budgetLeft, budgetTotal, priorVouch, personName }: VouchPresetChoiceProps) {
    const { colors } = useTheme();

    const styles = useStyles(({ colors }) => StyleSheet.create({
        container: {
            marginBottom: 16,
        },
        label: {
            fontSize: 14,
            fontWeight: '700',
            color: colors.text.heading,
            marginBottom: 4,
        },
        subtitle: {
            fontSize: 12,
            color: colors.text.muted,
            marginBottom: 8,
        },
        row: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
        },
        chip: {
            minHeight: 44,
            minWidth: 54,
            paddingHorizontal: 12,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border.default,
            backgroundColor: colors.surface.card,
            alignItems: 'center',
            justifyContent: 'center',
        },
        chipSelected: {
            backgroundColor: colors.brand.fill,
            borderColor: 'transparent',
        },
        chipDisabled: {
            backgroundColor: colors.chip.quiet.bg,
            borderColor: colors.border.default,
        },
        chipText: {
            fontSize: 14,
            fontWeight: '700',
            color: colors.text.heading,
        },
        chipTextSelected: {
            color: colors.text.inverse,
            fontWeight: '800',
        },
        chipTextDisabled: {
            color: colors.chip.quiet.fg,
        },
    }));

    const noneLeft = budgetLeft <= 0;
    const subtitle = noneLeft
        ? t(vouchPresets.noneLeft)
        : t(vouchPresets.fromBudget, { left: formatNumber(budgetLeft), total: formatNumber(budgetTotal) });

    const choices: { amount: number | null; label: string; ariaLabel: string; disabled: boolean; why?: string }[] = [
        { amount: null, label: t(vouchPresets.none), ariaLabel: t(vouchPresets.none), disabled: false },
        ...VOUCH_PRESETS.map((p) => {
            const wouldExceedMax = priorVouch !== undefined && priorVouch > 0 && priorVouch + p > VOUCH_MAX;
            const notEnoughBudget = p > budgetLeft;
            return {
                amount: p,
                label: String(p),
                ariaLabel: t(vouchPresets.beans, { amount: p }),
                disabled: notEnoughBudget || wouldExceedMax,
                // The cap first: more budget would not make this preset possible.
                why: wouldExceedMax
                    ? t(vouchPresets.pastMax, { name: personName ?? '', max: formatNumber(VOUCH_MAX) })
                    : notEnoughBudget ? t(vouchPresets.notEnough) : undefined,
            };
        }),
    ];

    return (
        <View style={styles.container} testID="invite-vouch">
            <Text style={styles.label}>{t(vouchPresets.label)}</Text>
            <Text style={styles.subtitle}>{subtitle}</Text>
            <View style={styles.row}>
                {choices.map(({ amount, label, ariaLabel, disabled, why }) => {
                    const isSelected = value === amount;
                    return (
                        <Pressable
                            key={String(amount)}
                            disabled={disabled}
                            onPress={() => { if (!disabled) onChange(amount); }}
                            accessibilityRole="radio"
                            accessibilityState={{ selected: isSelected, disabled }}
                            accessibilityLabel={ariaLabel}
                            accessibilityHint={disabled ? why : undefined}
                            testID={`invite-vouch-${amount ?? 'none'}`}
                            style={[
                                styles.chip,
                                isSelected && styles.chipSelected,
                                disabled && styles.chipDisabled,
                            ]}
                        >
                            <Text
                                style={[
                                    styles.chipText,
                                    isSelected && styles.chipTextSelected,
                                    disabled && styles.chipTextDisabled,
                                ]}
                            >
                                {label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}
