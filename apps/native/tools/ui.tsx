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
import { View, Text, Pressable, ScrollView, TextInput, Image, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
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
 * One row: an optional emoji (or a photo the host keeps, as a small square in its place), a one-line title, a one-line
 * state under it, and a chevron when it opens something. The whole row is one target with its whole text for the screen
 * reader.
 */
export function ToolRow({ icon, image, title, wrap, state, onPress, a11y, testID }: {
    icon?: string;
    /** A photo's uri from the host (host.photos.uri): drawn instead of the emoji. */
    image?: string | null;
    title: string;
    /** The whole title, on as many lines as it takes (a record's own screen), rather than one line. */
    wrap?: boolean;
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
            {image ? (
                <Image source={{ uri: image }} style={[ui.thumb, { backgroundColor: colors.surface.subtle }]} accessibilityElementsHidden importantForAccessibility="no" />
            ) : icon ? <Text style={ui.rowIcon} accessibilityElementsHidden importantForAccessibility="no">{icon}</Text> : null}
            <View style={s.rowText}>
                <Text style={[s.rowLine, s.rowStrong]} numberOfLines={wrap ? undefined : 1}>{title}</Text>
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

/**
 * Chips that wrap to the next line and never shrink their words; the chosen one is filled and heard as selected. `label`
 * is what the group chooses, for the screen reader; `heading` shows it over the chips too, as a field's label.
 */
export function ToolChips<T extends string>({ options, value, onPick, label, heading, testID }: {
    options: ReadonlyArray<{ value: T; label: string }>;
    value: T | null;
    onPick: (v: T) => void;
    label: string;
    heading?: boolean;
    testID?: string;
}) {
    const colors = useToolColors();
    const s = homeStyles(colors);
    const chips = (
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
    if (!heading) return chips;
    return (
        <View style={ui.field}>
            <Text style={[ui.fieldLabel, { color: colors.text.body }]} accessibilityElementsHidden importantForAccessibility="no">{label}</Text>
            {chips}
        </View>
    );
}

/**
 * A button: at least 48 dp, its words never shrunk (it wraps to a row of its own instead). `primary` the screen's one main
 * action; `danger` what takes something away, once the member has been asked.
 */
export function ToolButton({ text, onPress, primary, danger, disabled, a11y, testID }: {
    text: string;
    onPress: () => void;
    primary?: boolean;
    danger?: boolean;
    disabled?: boolean;
    a11y?: string;
    testID?: string;
}) {
    const colors = useToolColors();
    const s = homeStyles(colors);
    const strong = !disabled && (primary || danger);
    return (
        <Pressable
            onPress={disabled ? undefined : onPress}
            disabled={disabled}
            style={({ pressed }) => [
                s.button, primary && strong && s.buttonPrimary, danger && strong && { backgroundColor: colors.feedback.danger.solid, borderColor: colors.feedback.danger.solid },
                disabled && ui.disabled, pressed && s.pressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={a11y ?? text}
            accessibilityState={{ disabled: !!disabled }}
            testID={testID}
        >
            <Text style={[s.buttonText, primary && strong && s.buttonTextPrimary, danger && strong && { color: colors.text.onDanger }]}>{text}</Text>
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

/**
 * A quiet sentence: a note under a section, a hint. Wraps; never cut. `warning` for what needs the member's eye before
 * they go on, `danger` for what stopped (said, and heard as soon as it shows).
 */
export function ToolNote({ text, tone, testID }: { text: string; tone?: 'warning' | 'danger'; testID?: string }) {
    const colors = useToolColors();
    const color = tone === 'danger' ? colors.feedback.danger.fg : tone === 'warning' ? colors.feedback.warning.fg : undefined;
    return (
        <Text style={[homeStyles(colors).note, color ? { color } : null]} accessibilityLiveRegion={tone ? 'polite' : undefined} testID={testID}>{text}</Text>
    );
}

/**
 * A text box with its label over it, one column: one line, or several (`lines`) for longer words; a number pad for
 * `numeric`. At most `max` characters (the document holds each field to its bound in code points, so this is never
 * looser). A hint under it, or what is wrong with it in its place.
 */
export function ToolInput({ label, value, onChange, max, lines, numeric, placeholder, hint, error, testID }: {
    label: string;
    value: string;
    onChange: (next: string) => void;
    max: number;
    lines?: number;
    numeric?: boolean;
    placeholder?: string;
    hint?: string;
    error?: string | null;
    testID?: string;
}) {
    const colors = useToolColors();
    const multiline = !!lines && lines > 1;
    return (
        <View style={ui.field} testID={testID ? `${testID}-field` : undefined}>
            <Text style={[ui.fieldLabel, { color: colors.text.body }]}>{label}</Text>
            <TextInput
                value={value}
                onChangeText={onChange}
                maxLength={max}
                multiline={multiline}
                numberOfLines={multiline ? lines : undefined}
                keyboardType={numeric ? 'number-pad' : 'default'}
                placeholder={placeholder}
                placeholderTextColor={colors.text.muted}
                textAlignVertical={multiline ? 'top' : 'center'}
                style={[ui.input, multiline && { minHeight: 22 * (lines ?? 1) + 20 }, {
                    color: colors.text.body, backgroundColor: colors.surface.app,
                    borderColor: error ? colors.feedback.danger.fg : colors.border.strong,
                }]}
                accessibilityLabel={label}
                accessibilityHint={hint}
                testID={testID}
            />
            {error ? <Text style={[ui.inputNote, { color: colors.feedback.danger.fg }]} accessibilityLiveRegion="polite">{error}</Text>
                : hint ? <Text style={[ui.inputNote, { color: colors.text.secondary }]}>{hint}</Text> : null}
        </View>
    );
}

/** A photo the host keeps (host.photos.uri), as wide as the column and never taller than it is wide. */
export function ToolPhoto({ uri, label, testID }: { uri: string; label: string; testID?: string }) {
    const colors = useToolColors();
    return (
        <Image source={{ uri }} resizeMode="cover" accessible accessibilityLabel={label}
            style={[ui.photo, { backgroundColor: colors.surface.subtle }]} testID={testID} />
    );
}

export const TOOL_TARGET_DP = HOME_TARGET_DP;

const ui = StyleSheet.create({
    screen: { paddingTop: 8, paddingBottom: 32 },
    section: { paddingBottom: 10 },
    rowIcon: { fontSize: 22, width: 32, textAlign: 'center', flexShrink: 0 },
    thumb: { width: 40, height: 40, borderRadius: 8, flexShrink: 0 },
    input: { minHeight: HOME_TARGET_DP, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
    inputNote: { fontSize: 13, lineHeight: 18, marginTop: 4 },
    photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: 12, marginVertical: 8 },
    field: { paddingVertical: 6 },
    fieldLabel: { fontSize: 13, fontWeight: '700', marginBottom: 2 },
    fieldValue: { fontSize: 15, lineHeight: 20 },
    empty: { alignItems: 'center', paddingVertical: 20, paddingHorizontal: 8, gap: 10 },
    emptyIcon: { fontSize: 36 },
    emptyText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
    disabled: { opacity: 0.5 },
});
