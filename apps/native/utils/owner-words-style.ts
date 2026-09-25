/**
 * Styles for "Check your 12 words" (components/OwnerWordsPrompt.tsx, app/owner-words-check.tsx), as plain objects
 * so utils/__tests__/owner-words.test.ts can hold them to the small-screen rules without a device: every touch
 * target at least 48dp tall, no fixed width or height anywhere (text wraps and boxes grow at 320dp and 1.3× text),
 * buttons that wrap onto their own line rather than squeeze, and readable text in light and dark.
 * The components pass this through StyleSheet.create inside useStyles, so the theme switch restyles them.
 */
import { palette, type AppColors } from '../constants/colors';

/** The app's brand green is 3.8:1 under white text; one step darker is 5.5:1, in both themes. */
const BUTTON_GREEN = palette.emerald700;

/** Which entries are things you press. Each has minHeight ≥ 48. */
export const OWNER_WORDS_TOUCH_TARGETS = ['primaryBtn', 'secondaryBtn', 'backButton', 'checkBtn'] as const;

/** Text entries and the background each sits on, for the contrast check. */
export const OWNER_WORDS_TEXT_ON = {
    promptTitle: 'promptCard',
    promptBody: 'promptCard',
    primaryBtnText: 'primaryBtn',
    secondaryBtnText: 'secondaryBtn',
    headerTitle: 'header',
    body: 'screen',
    label: 'screen',
    hint: 'screen',
    input: 'input',
    checkBtnText: 'checkBtn',
    matchText: 'matchBox',
    mismatchText: 'mismatchBox',
    saveText: 'saveBox',
} as const;

export function ownerWordsStyleSpec(colors: AppColors) {
    return {
        // ── The home prompt ──
        promptCard: {
            marginHorizontal: 16, marginTop: 12, marginBottom: 4, padding: 16, borderRadius: 14,
            backgroundColor: colors.feedback.warning.bg, borderWidth: 1, borderColor: colors.feedback.warning.border,
        },
        promptTitle: { fontSize: 16, fontWeight: '700' as const, color: colors.feedback.warning.fg, marginBottom: 6 },
        promptBody: { fontSize: 14, lineHeight: 20, color: colors.text.body },
        // Wraps: at 320dp and 1.3× text the two buttons stack instead of squeezing their labels.
        buttonRow: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 10, marginTop: 14 },
        primaryBtn: {
            flexGrow: 1, flexBasis: 120, minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12,
            alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: BUTTON_GREEN,
        },
        primaryBtnText: { fontSize: 15, fontWeight: '700' as const, color: colors.text.inverse, textAlign: 'center' as const },
        secondaryBtn: {
            flexGrow: 1, flexBasis: 120, minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12,
            alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: colors.surface.card,
            borderWidth: 1, borderColor: colors.border.strong,
        },
        secondaryBtnText: { fontSize: 15, fontWeight: '600' as const, color: colors.text.body, textAlign: 'center' as const },

        // ── The check screen ──
        screen: { flex: 1, backgroundColor: colors.surface.app },
        header: {
            flexDirection: 'row' as const, alignItems: 'center' as const, paddingHorizontal: 8, paddingVertical: 6,
            borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: colors.surface.card,
        },
        backButton: { minWidth: 48, minHeight: 48, alignItems: 'center' as const, justifyContent: 'center' as const },
        headerTitle: { flex: 1, fontSize: 17, fontWeight: '700' as const, color: colors.text.heading, paddingRight: 48, textAlign: 'center' as const },
        scroll: { padding: 20, gap: 14 },
        body: { fontSize: 15, lineHeight: 22, color: colors.text.body },
        label: { fontSize: 12, fontWeight: '700' as const, letterSpacing: 1, color: colors.text.secondary },
        input: {
            minHeight: 120, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong,
            backgroundColor: colors.surface.card, color: colors.text.body, fontSize: 17, lineHeight: 24,
            textAlignVertical: 'top' as const,
        },
        hint: { fontSize: 13, lineHeight: 18, color: colors.text.secondary },
        checkBtn: {
            minHeight: 52, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 14,
            alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: BUTTON_GREEN,
        },
        checkBtnDisabled: { opacity: 0.5 },
        checkBtnText: { fontSize: 16, fontWeight: '700' as const, color: colors.text.inverse, textAlign: 'center' as const },
        matchBox: {
            padding: 14, borderRadius: 12, borderWidth: 1,
            backgroundColor: colors.feedback.success.bg, borderColor: colors.feedback.success.border,
        },
        matchText: { fontSize: 15, lineHeight: 21, fontWeight: '600' as const, color: colors.feedback.success.fg },
        mismatchBox: {
            padding: 14, borderRadius: 12, borderWidth: 1,
            backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.border,
        },
        mismatchText: { fontSize: 15, lineHeight: 21, fontWeight: '600' as const, color: colors.feedback.danger.fg },
        // "Save them on this phone", after a match on a phone with no copy of the words. Its button is a checkBtn.
        saveBox: {
            padding: 14, borderRadius: 12, borderWidth: 1, gap: 12,
            backgroundColor: colors.surface.card, borderColor: colors.border.strong,
        },
        saveText: { fontSize: 15, lineHeight: 21, color: colors.text.body },
        footer: { paddingHorizontal: 20, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border.default, backgroundColor: colors.surface.app },
    };
}

export type OwnerWordsStyleSpec = ReturnType<typeof ownerWordsStyleSpec>;
