/**
 * The forum's styles on the phone (slice F3), from the look's tokens only: 48 dp targets, nothing fixed-width, words that wrap
 * at 320 dp and 1.3x text. A plain object, as the names list's (utils/names-list-style.ts), passed through StyleSheet.create
 * inside useStyles, so a switch of look restyles every forum screen. Each part that draws calls useForumStyles itself (never a
 * table handed down as a prop), so the contrast check (utils/button-contrast.ts, which follows this module) reads every pair.
 */
import { StyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native';
import { useStyles } from '../../app/ThemeContext';
import type { AppColors } from '../../constants/colors';

export function forumStyleSpec(colors: AppColors) {
    return {
        page: { flex: 1, backgroundColor: colors.surface.page },
        pad: { paddingHorizontal: 12, paddingBottom: 24, gap: 10 },
        head: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4, minHeight: 48, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        iconBtn: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
        headWords: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600', color: colors.text.secondary },
        heading: { fontSize: 18, fontWeight: '800', color: colors.text.heading, flexShrink: 1 },
        title: { fontSize: 18, fontWeight: '800', lineHeight: 24, color: colors.text.heading },
        body: { fontSize: 15, lineHeight: 21, color: colors.text.body },
        small: { fontSize: 13, lineHeight: 18, color: colors.text.secondary },
        muted: { fontSize: 13, lineHeight: 18, color: colors.text.muted },
        italic: { fontSize: 14, lineHeight: 20, fontStyle: 'italic', color: colors.text.muted },
        link: { color: colors.text.link, textDecorationLine: 'underline' },
        danger: { fontSize: 14, lineHeight: 20, color: colors.feedback.danger.fg },
        row: { borderTopWidth: 1, borderTopColor: colors.border.default, paddingVertical: 10, minHeight: 56, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
        rowWords: { flex: 1, minWidth: 0, gap: 2 },
        rowTitle: { fontSize: 15, fontWeight: '700', lineHeight: 21, color: colors.text.heading },
        dot: { width: 12, height: 12, borderRadius: 6, marginTop: 6, backgroundColor: colors.accent.fill },
        commit: { minHeight: 48, borderRadius: 10, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brand.fill },
        commitText: { fontSize: 15, fontWeight: '800', color: colors.text.onBrand, textAlign: 'center' },
        quiet: { minHeight: 48, borderRadius: 10, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.strong },
        quietText: { fontSize: 15, fontWeight: '700', color: colors.text.body, textAlign: 'center' },
        warnRow: { minHeight: 48, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center', backgroundColor: colors.feedback.warning.bg, borderWidth: 1, borderColor: colors.feedback.warning.border },
        warnText: { fontSize: 15, fontWeight: '800', color: colors.feedback.warning.fg },
        infoBox: { borderRadius: 10, padding: 12, gap: 8, backgroundColor: colors.feedback.info.bg, borderWidth: 1, borderColor: colors.feedback.info.border },
        infoText: { fontSize: 14, lineHeight: 20, color: colors.text.body },
        chip: { minHeight: 40, borderRadius: 20, paddingHorizontal: 14, justifyContent: 'center', borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card },
        chipOn: { backgroundColor: colors.accent.fill, borderColor: colors.accent.fill },
        chipText: { fontSize: 14, fontWeight: '600', color: colors.text.body },
        chipTextOn: { fontSize: 14, fontWeight: '700', color: colors.text.onAccent },
        card: { borderRadius: 12, padding: 12, gap: 8, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
        field: { minHeight: 48, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text.body, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong },
        label: { fontSize: 14, fontWeight: '700', color: colors.text.secondary },
        mine: { backgroundColor: colors.surface.subtle },
        quote: { borderLeftWidth: 3, borderLeftColor: colors.accent.fill, paddingLeft: 8 },
        photo: { width: 96, height: 96, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default },
        backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay.scrim, padding: 12 },
        sheet: { borderRadius: 16, padding: 8, backgroundColor: colors.surface.card },
        menuItem: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, justifyContent: 'center', borderRadius: 10 },
        menuText: { fontSize: 16, fontWeight: '600', color: colors.text.body },
        menuDanger: { fontSize: 16, fontWeight: '600', color: colors.feedback.danger.fg },
        placeholder: { color: colors.text.muted },
    } satisfies Record<string, ViewStyle | TextStyle | ImageStyle>;
}

/** The forum's styles in the look on screen. */
export function useForumStyles() {
    return useStyles(({ colors }) => StyleSheet.create(forumStyleSpec(colors)));
}
export type ForumStyles = ReturnType<typeof useForumStyles>;
