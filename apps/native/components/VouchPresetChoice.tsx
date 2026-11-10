/**
 * Native VouchPresetChoice component (slice V3):
 * "Vouch for them: None · 25 · 50 · 75 · 100" from core VOUCH_PRESETS,
 * with "From your budget: 550 of 1,000 left" under it;
 * presets above what is left are disabled ("Not enough budget left").
 * An owner (`noLimit`, Marty 9 Nov): 200 and 500 too, none disabled for budget, and "From your budget: No limit".
 * A raise (`raiseFrom`, slice I6): "Raise to: 200 · 500", the totals above what you vouched already (core raiseTargetsFor),
 * no None; a choice is greyed only when the difference it draws is more than the budget has left.
 *
 * Meets 44 dp min target size and wraps cleanly on 320 dp screens at 1.3x text.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { formatNumber, t, vouchPresetsFor, raiseTargetsFor, vouchPresets } from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';

export interface VouchPresetChoiceProps {
    value: number | null;
    onChange: (value: number | null) => void;
    budgetLeft: number;
    budgetTotal: number;
    /**
     * What you have vouched for this person already (the node's figure), above 0 on a raise: the choices are then the totals
     * the vouch can be raised TO, with no None, and a choice draws only the difference (so it is greyed on that, not on its total).
     */
    raiseFrom?: number;
    /**
     * The node's `noLimit` for the signer (GET /api/vouchers/me): an owner vouches with no budget limit (Marty, 9 Nov), so
     * the presets are core's six (200 and 500 too), none greyed for budget, 500 for one person, and "From your budget: No limit".
     */
    noLimit?: boolean;
}

export function VouchPresetChoice({ value, onChange, budgetLeft, budgetTotal, raiseFrom, noLimit = false }: VouchPresetChoiceProps) {
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

    const raising = raiseFrom !== undefined && raiseFrom > 0;
    const noneLeft = !noLimit && budgetLeft <= 0;
    const subtitle = noLimit
        ? t(vouchPresets.fromBudgetNoLimit)
        : noneLeft
            ? t(vouchPresets.noneLeft)
            : t(vouchPresets.fromBudget, { left: formatNumber(budgetLeft), total: formatNumber(budgetTotal) });

    const picks = raising ? raiseTargetsFor(noLimit, raiseFrom) : vouchPresetsFor(noLimit);
    const choices: { amount: number | null; label: string; ariaLabel: string; disabled: boolean; why?: string }[] = [
        ...(raising ? [] : [{ amount: null, label: t(vouchPresets.none), ariaLabel: t(vouchPresets.none), disabled: false }]),
        ...picks.map((p) => {
            // A raise draws the difference from the budget, a first vouch its whole amount.
            const notEnoughBudget = !noLimit && (raising ? p - raiseFrom : p) > budgetLeft;
            return {
                amount: p,
                label: String(p),
                ariaLabel: t(vouchPresets.beans, { amount: p }),
                disabled: notEnoughBudget,
                why: notEnoughBudget ? t(vouchPresets.notEnough) : undefined,
            };
        }),
    ];

    return (
        <View style={styles.container} testID="invite-vouch">
            <Text style={styles.label}>{raising ? t(vouchPresets.raiseTo) : t(vouchPresets.label)}</Text>
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
