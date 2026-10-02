import React, { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { AppColors } from '../../constants/colors';

/**
 * The pieces every Home card is made of (design §9 card anatomy, §10 accessibility): a caption that is a heading, an
 * optional "…" for the card's menu, lines that are each one full-width target at least 48dp tall with their whole text
 * in the screen reader's label, and a trailing link. A card grows in height only; nothing scrolls sideways.
 */

/** Captions keep to the app's own text cap at most (§9: 11 pt caps, `maxFontSizeMultiplier` 1.2, as the tab labels). */
export const CAPTION_MAX_SCALE = 1.2;
/** The shortest a line or button may be (§8 "48 dp minimum"). */
export const HOME_TARGET_DP = 48;
/** A listing's or a Pulse item's thumbnail (§9). */
export const HOME_THUMB_DP = 48;
/** The screen's side gutter and a card's own padding, for the layout checks at 320dp. */
export const HOME_GUTTER_DP = 16;
export const HOME_CARD_PADDING_DP = 14;

// ── The floating button's band (utils/fab-band.ts) ─────────────────────────────────────────────────────────────────

/** Where Home's cards report their actions (window coordinates, dp), so "+ ADD POST" steps aside while it would cover one. */
export interface FabBand {
    report: (key: string, at: { top: number; bottom: number } | null) => void;
    /** Changes when the list's content moved under the actions (a card came or went): every action measures again. */
    version: number;
}
export const FabBandContext = createContext<FabBand | null>(null);

/**
 * A card's buttons, chips or trailing link: measured on screen as it lays out (and again shortly after, as the list
 * settles, and whenever the list's content changed), and reported to Home's floating button. Not flattened away
 * (Android), so it can be measured.
 */
export function FabAware({ id, children, style }: { id: string; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
    const band = useContext(FabBandContext);
    const ref = useRef<View>(null);
    const bandRef = useRef(band);
    bandRef.current = band;
    const measure = useCallback(() => {
        ref.current?.measureInWindow?.((_x, y, _w, h) => {
            if (h > 0) bandRef.current?.report(id, { top: y, bottom: y + h });
        });
    }, [id]);
    const version = band?.version ?? 0;
    useEffect(() => {
        measure();
        const t = setTimeout(measure, 300);
        return () => clearTimeout(t);
    }, [version, measure]);
    useEffect(() => () => { bandRef.current?.report(id, null); }, [id]);
    return <View ref={ref} collapsable={false} onLayout={measure} style={style}>{children}</View>;
}

// ── The card ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function HomeCard({ caption, colors, onMenu, menuRef, right, children, testID, accent }: {
    caption: string;
    colors: AppColors;
    /** The card's "…" (Hide, Move up, Move down); absent on the cards that can't be hidden or moved. */
    onMenu?: () => void;
    /** The "…" itself, so focus returns to it when the menu closes (§10). */
    menuRef?: React.RefObject<View | null>;
    /** Drawn before the "…" on the caption's line (the Market card's "Tune"). */
    right?: React.ReactNode;
    children: React.ReactNode;
    testID?: string;
    /** The Needs you card: a warm edge (never red), with the words saying the same (§6.3). */
    accent?: boolean;
}) {
    const s = homeStyles(colors);
    return (
        <View style={[s.card, accent && s.cardAccent]} testID={testID}>
            <View style={s.captionRow}>
                <Text style={s.caption} accessibilityRole="header" maxFontSizeMultiplier={CAPTION_MAX_SCALE} numberOfLines={2}>
                    {caption}
                </Text>
                {right}
                {onMenu && (
                    <Pressable
                        ref={menuRef}
                        onPress={onMenu}
                        style={({ pressed }) => [s.menuButton, pressed && s.pressed]}
                        accessibilityRole="button"
                        accessibilityLabel={`Card options for ${caption}`}
                        testID={testID ? `${testID}-menu` : undefined}
                    >
                        <MaterialCommunityIcons name="dots-horizontal" size={22} color={colors.text.secondary} />
                    </Pressable>
                )}
            </View>
            {children}
        </View>
    );
}

/** One line of a card: one target, the whole width, its whole text for the screen reader (§10 "One target per line"). */
export function HomeRow({ text, sub, a11y, onPress, left, right, colors, lines = 2, strong, testID }: {
    text: string;
    sub?: string | null;
    a11y: string;
    onPress?: () => void;
    left?: React.ReactNode;
    right?: React.ReactNode;
    colors: AppColors;
    lines?: number;
    strong?: boolean;
    testID?: string;
}) {
    const s = homeStyles(colors);
    const body = (
        <>
            {left}
            <View style={s.rowText}>
                <Text style={[s.rowLine, strong && s.rowStrong]} numberOfLines={lines}>{text}</Text>
                {!!sub && <Text style={s.rowSub} numberOfLines={2}>{sub}</Text>}
            </View>
            {right}
        </>
    );
    if (!onPress) {
        return <View style={s.row} accessible accessibilityLabel={a11y} testID={testID}>{body}</View>;
    }
    return (
        <Pressable
            onPress={onPress}
            style={({ pressed }) => [s.row, pressed && s.pressed]}
            accessibilityRole="button"
            accessibilityLabel={a11y}
            testID={testID}
        >
            {body}
        </Pressable>
    );
}

/** The trailing link ("See all ›", "All events ›", "Edit home ›"): the whole width is the target, the words at the end. */
export function HomeLink({ id, text, a11y, onPress, colors, testID }: {
    id: string;
    text: string;
    a11y: string;
    onPress: () => void;
    colors: AppColors;
    testID?: string;
}) {
    const s = homeStyles(colors);
    return (
        <FabAware id={id}>
            <Pressable onPress={onPress} style={({ pressed }) => [s.link, pressed && s.pressed]} accessibilityRole="link" accessibilityLabel={a11y} testID={testID}>
                <Text style={s.linkText} numberOfLines={1}>{text} ›</Text>
            </Pressable>
        </FabAware>
    );
}

/** A card's button: wraps to a second row rather than shrinking its words (§9 "buttons flexShrink: 0"). */
export function HomeButton({ text, a11y, onPress, colors, primary, testID }: {
    text: string;
    a11y?: string;
    onPress: () => void;
    colors: AppColors;
    primary?: boolean;
    testID?: string;
}) {
    const s = homeStyles(colors);
    return (
        <Pressable
            onPress={onPress}
            style={({ pressed }) => [s.button, primary && s.buttonPrimary, pressed && s.pressed]}
            accessibilityRole="button"
            accessibilityLabel={a11y ?? text}
            testID={testID}
        >
            <Text style={[s.buttonText, primary && s.buttonTextPrimary]}>{text}</Text>
        </Pressable>
    );
}

const cache = new WeakMap<AppColors, ReturnType<typeof make>>();
export function homeStyles(colors: AppColors) {
    let s = cache.get(colors);
    if (!s) {
        s = make(colors);
        cache.set(colors, s);
    }
    return s;
}

function make(colors: AppColors) {
    return StyleSheet.create({
        card: {
            marginHorizontal: HOME_GUTTER_DP, marginBottom: 10, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default,
            backgroundColor: colors.surface.card, paddingHorizontal: HOME_CARD_PADDING_DP, paddingTop: 4, paddingBottom: 6,
        },
        cardAccent: { borderColor: colors.feedback.warning.border, backgroundColor: colors.feedback.warning.bg },
        captionRow: { flexDirection: 'row', alignItems: 'center', minHeight: HOME_TARGET_DP },
        caption: {
            flex: 1, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', color: colors.text.secondary,
        },
        menuButton: { width: HOME_TARGET_DP, height: HOME_TARGET_DP, marginRight: -12, alignItems: 'center', justifyContent: 'center', borderRadius: HOME_TARGET_DP / 2, flexShrink: 0 },
        pressed: { backgroundColor: colors.surface.subtle },
        row: { flexDirection: 'row', alignItems: 'center', minHeight: HOME_TARGET_DP, paddingVertical: 6, gap: 10 },
        rowText: { flex: 1, minWidth: 0 },
        rowLine: { fontSize: 15, lineHeight: 20, color: colors.text.body },
        rowStrong: { fontWeight: '700', color: colors.text.heading },
        rowSub: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginTop: 1 },
        link: { minHeight: HOME_TARGET_DP, alignItems: 'flex-end', justifyContent: 'center' },
        linkText: { fontSize: 14, fontWeight: '700', color: colors.text.link },
        buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6, marginBottom: 4 },
        button: {
            minHeight: HOME_TARGET_DP, flexShrink: 0, maxWidth: '100%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12,
            borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center',
        },
        buttonPrimary: { backgroundColor: colors.brand.primary, borderColor: colors.brand.primary },
        buttonText: { fontSize: 14, fontWeight: '700', color: colors.text.body, textAlign: 'center' },
        buttonTextPrimary: { color: colors.text.inverse },
        thumb: { width: HOME_THUMB_DP, height: HOME_THUMB_DP, borderRadius: 10, backgroundColor: colors.surface.subtle, flexShrink: 0 },
        thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
        badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, flexShrink: 0, alignSelf: 'flex-start' },
        badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
        trailing: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, flexShrink: 0 },
        chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2, marginBottom: 8 },
        chip: {
            minHeight: HOME_TARGET_DP, flexShrink: 0, maxWidth: '100%', paddingHorizontal: 12, borderRadius: 24, borderWidth: 1,
            borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center',
        },
        chipOn: { backgroundColor: colors.accent.primary, borderColor: colors.accent.primary },
        chipText: { fontSize: 14, fontWeight: '700', color: colors.text.body },
        chipTextOn: { color: colors.text.inverse },
        note: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginBottom: 6 },
        faces: { flexDirection: 'row', marginRight: 2, flexShrink: 0 },
    });
}
