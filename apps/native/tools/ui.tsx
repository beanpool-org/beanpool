/**
 * The layout primitives every tool's screens are drawn with (scratch/tools/DESIGN-tool-template-fable.md §1.5, slice
 * T0.2): a tool imports these and React Native's nothing else (the eslint fence), so every tool keeps the app's rules
 * without restating them: one column, each target at least 48 dp, every state line one line (`numberOfLines`), chips
 * that wrap and never shrink, nothing that scrolls sideways, colours from the central tokens only (light and dark), text
 * at the app's cap (MAX_FONT_SCALE 1.2, tested at 1.3) and 320 dp the floor. Built on Home's card parts (HomeParts).
 *
 * Words: every prop a member reads is a string the tool made with t() (or the member's own text, shown as written).
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../app/ThemeContext';
import { HOME_TARGET_DP, homeStyles } from '../components/home/HomeParts';
import type { AppColors } from '../constants/colors';

/** The colours a tool's screen may use: the app's tokens, as the theme has them now. */
export function useToolColors(): AppColors {
    return useTheme().colors;
}

/** A tool's screen body: one column that scrolls down, never sideways. */
export function ToolScreen({ children, testID }: { children: React.ReactNode; testID?: string }) {
    return (
        <ScrollView contentContainerStyle={ui.screen} keyboardShouldPersistTaps="handled" testID={testID}>
            {children}
        </ScrollView>
    );
}

/** A heading and the rows under it, in a card. */
export function ToolSection({ title, children, testID }: { title?: string; children: React.ReactNode; testID?: string }) {
    const colors = useToolColors();
    const s = homeStyles(colors);
    return (
        <View style={[s.card, ui.section]} testID={testID}>
            {title ? (
                <View style={s.captionRow}>
                    <Text style={s.caption} accessibilityRole="header" accessibilityLabel={title} numberOfLines={2}>{title}</Text>
                </View>
            ) : null}
            {children}
        </View>
    );
}

/**
 * One row: an optional emoji, a one-line title, a one-line state under it, and a chevron when it opens something. The
 * whole row is one target with its whole text for the screen reader.
 */
export function ToolRow({ icon, title, state, onPress, a11y, testID }: {
    icon?: string;
    title: string;
    state?: string | null;
    onPress?: () => void;
    a11y?: string;
    testID?: string;
}) {
    const colors = useToolColors();
    const s = homeStyles(colors);
    const label = a11y ?? (state ? `${title}, ${state}` : title);
    const body = (
        <>
            {icon ? <Text style={ui.rowIcon} accessibilityElementsHidden importantForAccessibility="no">{icon}</Text> : null}
            <View style={s.rowText}>
                <Text style={[s.rowLine, s.rowStrong]} numberOfLines={1}>{title}</Text>
                {state ? <Text style={s.rowSub} numberOfLines={1}>{state}</Text> : null}
            </View>
            {onPress ? <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.secondary} /> : null}
        </>
    );
    return onPress ? (
        <Pressable onPress={onPress} style={({ pressed }) => [s.row, pressed && s.pressed]} accessibilityRole="button" accessibilityLabel={label} testID={testID}>
            {body}
        </Pressable>
    ) : (
        <View style={s.row} accessible accessibilityLabel={label} testID={testID}>{body}</View>
    );
}

/** A label over its value, one column (never side by side, which breaks at 320 dp in a longer language). */
export function ToolField({ label, value, testID }: { label: string; value: string; testID?: string }) {
    const colors = useToolColors();
    return (
        <View style={ui.field} testID={testID}>
            <Text style={[ui.fieldLabel, { color: colors.text.secondary }]}>{label}</Text>
            <Text style={[ui.fieldValue, { color: colors.text.body }]}>{value}</Text>
        </View>
    );
}

/** Chips that wrap to the next line and never shrink their words; the chosen one is filled and heard as selected. */
export function ToolChips<T extends string>({ options, value, onPick, label, testID }: {
    options: ReadonlyArray<{ value: T; label: string }>;
    value: T | null;
    onPick: (v: T) => void;
    label: string;
    testID?: string;
}) {
    const colors = useToolColors();
    const s = homeStyles(colors);
    return (
        <View style={s.chips} accessibilityRole="radiogroup" accessibilityLabel={label} testID={testID}>
            {options.map((o) => {
                const on = o.value === value;
                return (
                    <Pressable key={o.value} onPress={() => onPick(o.value)} style={[s.chip, on && s.chipOn]}
                        accessibilityRole="radio" accessibilityState={{ selected: on, checked: on }} accessibilityLabel={o.label}
                        testID={testID ? `${testID}-${o.value}` : undefined}>
                        <Text style={[s.chipText, on && s.chipTextOn]}>{o.label}</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

/** A button: at least 48 dp, its words never shrunk (it wraps to a row of its own instead). */
export function ToolButton({ text, onPress, primary, disabled, a11y, testID }: {
    text: string;
    onPress: () => void;
    primary?: boolean;
    disabled?: boolean;
    a11y?: string;
    testID?: string;
}) {
    const colors = useToolColors();
    const s = homeStyles(colors);
    return (
        <Pressable
            onPress={disabled ? undefined : onPress}
            disabled={disabled}
            style={({ pressed }) => [s.button, primary && !disabled && s.buttonPrimary, disabled && ui.disabled, pressed && s.pressed]}
            accessibilityRole="button"
            accessibilityLabel={a11y ?? text}
            accessibilityState={{ disabled: !!disabled }}
            testID={testID}
        >
            <Text style={[s.buttonText, primary && !disabled && s.buttonTextPrimary]}>{text}</Text>
        </Pressable>
    );
}

/** A row of buttons that wraps. */
export function ToolButtons({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
    const colors = useToolColors();
    return <View style={[homeStyles(colors).buttonRow, style]}>{children}</View>;
}

/** What a list shows with nothing in it: an emoji, one sentence, and the action that fills it. */
export function ToolEmpty({ icon, text, action, testID }: { icon?: string; text: string; action?: React.ReactNode; testID?: string }) {
    const colors = useToolColors();
    return (
        <View style={ui.empty} testID={testID}>
            {icon ? <Text style={ui.emptyIcon} accessibilityElementsHidden importantForAccessibility="no">{icon}</Text> : null}
            <Text style={[ui.emptyText, { color: colors.text.secondary }]}>{text}</Text>
            {action}
        </View>
    );
}

/** A quiet sentence: a note under a section, a hint. Wraps; never cut. */
export function ToolNote({ text, testID }: { text: string; testID?: string }) {
    const colors = useToolColors();
    return <Text style={homeStyles(colors).note} testID={testID}>{text}</Text>;
}

export const TOOL_TARGET_DP = HOME_TARGET_DP;

const ui = StyleSheet.create({
    screen: { paddingTop: 8, paddingBottom: 32 },
    section: { paddingBottom: 10 },
    rowIcon: { fontSize: 22, width: 32, textAlign: 'center', flexShrink: 0 },
    field: { paddingVertical: 6 },
    fieldLabel: { fontSize: 13, fontWeight: '700', marginBottom: 2 },
    fieldValue: { fontSize: 15, lineHeight: 20 },
    empty: { alignItems: 'center', paddingVertical: 20, paddingHorizontal: 8, gap: 10 },
    emptyIcon: { fontSize: 36 },
    emptyText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
    disabled: { opacity: 0.5 },
});
