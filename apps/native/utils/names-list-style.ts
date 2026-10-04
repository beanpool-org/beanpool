/**
 * Styles for the names list (app/names-list.tsx), as plain objects so utils/__tests__/names-list.test.ts can hold them
 * to the small-screen rules without a device: every touch target at least 48dp tall, no fixed width or height anywhere
 * (text wraps and boxes grow at 320dp and 1.3× text), rows of buttons that wrap rather than squeeze, and readable text
 * in light and dark. The screen passes this through StyleSheet.create inside useStyles, so the theme switch restyles it.
 */
import { palette, type AppColors } from '../constants/colors';

/** The app's brand green is 3.8:1 under white text; one step darker is 5.5:1, in both themes. */
const BUTTON_GREEN = palette.emerald700;

/** Which entries are things you press. Each has minHeight ≥ 48. */
export const NAMES_TOUCH_TARGETS = ['backButton', 'primaryBtn', 'secondaryBtn', 'dangerBtn', 'smallBtn', 'pickRow', 'switchRow', 'input', 'search'] as const;

/** Text entries and the background each sits on, for the contrast check. */
export const NAMES_TEXT_ON = {
    headerTitle: 'header',
    body: 'screen',
    hint: 'screen',
    label: 'screen',
    noticeText: 'notice',
    warnText: 'warn',
    errorText: 'error',
    entryName: 'entry',
    entryNote: 'entry',
    entryMeta: 'entry',
    lockedText: 'entry',
    primaryBtnText: 'primaryBtn',
    secondaryBtnText: 'secondaryBtn',
    dangerBtnText: 'dangerBtn',
    smallBtnText: 'smallBtn',
    pickName: 'pickRow',
    logLine: 'screen',
    input: 'input',
    search: 'search',
    switchLabel: 'switchRow',
    keyCardTitle: 'keyCard',
    keyCardText: 'keyCard',
    codeText: 'keyCard',
    scannerText: 'scanner',
} as const;

export function namesListStyleSpec(colors: AppColors) {
    const button = {
        minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12,
        alignItems: 'center' as const, justifyContent: 'center' as const,
    };
    return {
        screen: { flex: 1, backgroundColor: colors.surface.app },
        header: {
            flexDirection: 'row' as const, alignItems: 'center' as const, paddingHorizontal: 8, paddingVertical: 6,
            borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: colors.surface.card,
        },
        backButton: { minWidth: 48, minHeight: 48, alignItems: 'center' as const, justifyContent: 'center' as const },
        headerTitle: { flex: 1, fontSize: 17, fontWeight: '700' as const, color: colors.text.heading, paddingRight: 48, textAlign: 'center' as const },
        scroll: { padding: 16, gap: 12, paddingBottom: 48 },
        body: { fontSize: 15, lineHeight: 22, color: colors.text.body },
        hint: { fontSize: 13, lineHeight: 18, color: colors.text.secondary },
        label: { fontSize: 12, fontWeight: '700' as const, letterSpacing: 1, color: colors.text.secondary, marginTop: 8 },

        notice: { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.feedback.info.border, backgroundColor: colors.feedback.info.bg },
        noticeText: { fontSize: 14, lineHeight: 20, color: colors.feedback.info.fg },
        warn: { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.feedback.warning.border, backgroundColor: colors.feedback.warning.bg },
        warnText: { fontSize: 14, lineHeight: 20, color: colors.feedback.warning.fg },
        error: { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.feedback.danger.border, backgroundColor: colors.feedback.danger.bg },
        errorText: { fontSize: 14, lineHeight: 20, color: colors.feedback.danger.fg },

        // Wraps: at 320dp and 1.3× text, buttons in a row stack instead of squeezing their labels.
        buttonRow: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 10 },
        primaryBtn: { ...button, flexGrow: 1, flexBasis: 120, backgroundColor: BUTTON_GREEN },
        primaryBtnText: { fontSize: 15, fontWeight: '700' as const, color: colors.text.inverse, textAlign: 'center' as const },
        secondaryBtn: { ...button, flexGrow: 1, flexBasis: 120, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong },
        secondaryBtnText: { fontSize: 15, fontWeight: '600' as const, color: colors.text.body, textAlign: 'center' as const },
        dangerBtn: { ...button, flexGrow: 1, flexBasis: 120, backgroundColor: colors.feedback.danger.bg, borderWidth: 1, borderColor: colors.feedback.danger.border },
        dangerBtnText: { fontSize: 15, fontWeight: '700' as const, color: colors.feedback.danger.fg, textAlign: 'center' as const },
        smallBtn: {
            minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, flexGrow: 1, flexBasis: 100,
            alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: colors.surface.subtle,
            borderWidth: 1, borderColor: colors.border.strong,
        },
        smallBtnText: { fontSize: 14, fontWeight: '600' as const, color: colors.text.body, textAlign: 'center' as const },
        /** More / Less under the opening paragraph: a small button as wide as its words, on a line of its own. */
        moreBtn: { alignSelf: 'flex-start' as const, flexGrow: 0, flexBasis: 'auto' as const, marginTop: 4, marginBottom: 8 },
        disabled: { opacity: 0.5 },

        entry: { padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, gap: 6 },
        entryName: { fontSize: 16, fontWeight: '700' as const, color: colors.text.heading },
        entryNote: { fontSize: 14, lineHeight: 20, color: colors.text.body },
        entryMeta: { fontSize: 13, lineHeight: 18, color: colors.text.secondary },
        lockedText: { fontSize: 14, lineHeight: 20, color: colors.feedback.warning.fg },

        input: {
            minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: 1,
            borderColor: colors.border.strong, backgroundColor: colors.surface.card, color: colors.text.body, fontSize: 16,
        },
        noteInput: { minHeight: 96, textAlignVertical: 'top' as const },
        search: {
            minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: 1,
            borderColor: colors.border.strong, backgroundColor: colors.surface.card, color: colors.text.body, fontSize: 16,
        },
        pickRow: {
            minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, borderWidth: 1,
            borderColor: colors.border.default, backgroundColor: colors.surface.card, justifyContent: 'center' as const,
        },
        pickName: { fontSize: 16, color: colors.text.body },
        switchRow: {
            minHeight: 48, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, paddingHorizontal: 14,
            paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card,
        },
        switchLabel: { flex: 1, fontSize: 15, lineHeight: 21, color: colors.text.body },
        logLine: { fontSize: 13, lineHeight: 19, color: colors.text.body },

        // This phone's key, for another admin to check in person: the QR code sits on white in both themes (a scanner
        // needs dark on light), 200dp wide with its margin, inside a card that grows with the code at 1.3× text.
        keyCard: { padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, gap: 8, alignItems: 'stretch' as const },
        keyCardTitle: { fontSize: 15, fontWeight: '700' as const, color: colors.text.heading },
        keyCardText: { fontSize: 14, lineHeight: 20, color: colors.text.body },
        qrBox: { alignSelf: 'center' as const, padding: 8, borderRadius: 8, backgroundColor: '#ffffff' },
        codeText: { fontSize: 18, lineHeight: 26, fontWeight: '700' as const, letterSpacing: 1, color: colors.text.heading, textAlign: 'center' as const },
        // The camera, while scanning another admin's code: square, as wide as the screen allows.
        camera: { aspectRatio: 1, alignSelf: 'stretch' as const, borderRadius: 12, overflow: 'hidden' as const, backgroundColor: '#000000' },
        // The scanner's own full screen (design §10 F8): dark around the camera in both themes, its words above it.
        scanner: { flex: 1, padding: 16, gap: 16, justifyContent: 'center' as const, backgroundColor: '#000000' },
        scannerText: { fontSize: 15, lineHeight: 22, color: '#ffffff' },
    };
}
