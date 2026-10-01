/**
 * Styles for the line a tap on an untrusted notification shows (components/PushNoticeWarning.tsx), as plain objects so
 * utils/__tests__/push-notice-check.test.ts can hold them to the small-screen rules without a device: its button at
 * least 48dp, no fixed width or height anywhere (the line wraps and the card grows at 320dp and 1.3× text), nothing
 * cut to a number of lines, and readable text in every theme.
 */
import type { AppColors } from '../constants/colors';

/** The space the card keeps from each side of the screen, and below the status bar. */
export const PUSH_NOTICE_WARNING_INSET = 16;

/** The button's label. */
export const PUSH_NOTICE_WARNING_OK = 'OK';

/** Which entries are things you press. Each has minHeight ≥ 48. */
export const PUSH_NOTICE_WARNING_TOUCH_TARGETS = ['okBtn'] as const;

/** Text entries and the background each sits on, for the contrast check. */
export const PUSH_NOTICE_WARNING_TEXT_ON = { line: 'card', okBtnText: 'okBtn' } as const;

export function pushNoticeWarningStyleSpec(colors: AppColors) {
    return {
        // Over the screen, under the status bar (the component adds the safe area to `top`); as wide as the screen
        // allows, never wider, and as tall as the line needs.
        card: {
            position: 'absolute' as const, top: PUSH_NOTICE_WARNING_INSET, left: PUSH_NOTICE_WARNING_INSET, right: PUSH_NOTICE_WARNING_INSET,
            zIndex: 1000, elevation: 6, padding: 16, borderRadius: 14, borderWidth: 1,
            backgroundColor: colors.surface.card, borderColor: colors.border.strong,
            shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 10,
        },
        line: { fontSize: 15, lineHeight: 21, color: colors.text.body },
        buttonRow: { flexDirection: 'row' as const, justifyContent: 'flex-end' as const, marginTop: 12 },
        okBtn: {
            minHeight: 48, minWidth: 64, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12, borderWidth: 1,
            alignItems: 'center' as const, justifyContent: 'center' as const,
            backgroundColor: colors.surface.subtle, borderColor: colors.border.strong,
        },
        okBtnText: { fontSize: 15, fontWeight: '700' as const, color: colors.text.body, textAlign: 'center' as const },
    };
}

export type PushNoticeWarningStyleSpec = ReturnType<typeof pushNoticeWarningStyleSpec>;
