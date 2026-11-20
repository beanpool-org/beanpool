/**
 * Settings → Chat memory (DESIGN-dm-peer-key-pin §3.4 amendment 6 §3, slice 2's row): the member's reset of one
 * community's DM pins, the only reset there is (the phone never resets on its own). The words and the look live here so
 * the card and its 320 dp test read the same ones; the reset itself is db.ts resetDmChatMemory. Since the reset takes the
 * DM guard's list too (§3.4 amendment 8 §3), the row's subtitle, the body and the confirmation are dm-guard-list.ts
 * CHAT_MEMORY_RESET_WORDS. Every sentence is a word() key, put through t() where it is shown.
 */
import { t, word } from '@beanpool/core';
import type { AppColors } from '../constants/colors';
import { CHAT_MEMORY_RESET_WORDS } from './dm-guard-list';

export const CHAT_MEMORY_COPY = {
    row: word('Chat memory'),
    rowSub: CHAT_MEMORY_RESET_WORDS.rowSub,
    title: word('Chat memory'),
    body: CHAT_MEMORY_RESET_WORDS.body,
    reset: word('Reset'),
    cancel: word('Cancel'),
    /** Amendment 8 §3's confirmation, word for word (case 14's reword): the reset's two stated residuals. */
    confirm: CHAT_MEMORY_RESET_WORDS.confirm,
    none: word('No communities on this phone yet.'),
    failed: word("This phone couldn't reset it. Try again."),
} as const;

export const chatMemoryConfirmTitle = (community: string) => t('Reset chat memory for {community}?', { community });
export const chatMemoryDoneLine = (community: string) => t('Reset. Every chat in {community} is checked again from the start.', { community });
export const chatMemoryResetLabel = (community: string) => t('Reset chat memory for {community}', { community });
export const CHAT_MEMORY_FAILED_LINE = CHAT_MEMORY_COPY.failed;

/** The card's look, from the colour library's roles only (constants/colors.ts), light and dark alike. */
export function chatMemoryStyleSpec(colors: AppColors) {
    const danger = colors.feedback.danger;
    return {
        body: { color: colors.text.secondary, fontSize: 14, lineHeight: 20, marginBottom: 12 },
        row: { borderColor: colors.border.default, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 10, gap: 8 },
        name: { color: colors.text.heading, fontSize: 15, fontWeight: '700' as const },
        // Full width, stacked: two buttons never share a row at 320 dp with 1.3× text.
        resetBtn: { backgroundColor: colors.surface.subtle, borderColor: colors.border.strong, borderWidth: 1, borderRadius: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' as const, justifyContent: 'center' as const },
        resetText: { color: colors.text.heading, fontSize: 15, fontWeight: '600' as const, textAlign: 'center' as const },
        confirmBox: { backgroundColor: danger.bg, borderColor: danger.border, borderWidth: 1, borderRadius: 10, padding: 12, gap: 8 },
        confirmTitle: { color: colors.text.heading, fontSize: 15, fontWeight: '700' as const },
        confirmText: { color: colors.text.heading, fontSize: 14, lineHeight: 20 },
        // The reset itself: the danger role's text and border on the card, readable in both themes (not white on red500).
        confirmBtn: { backgroundColor: colors.surface.card, borderColor: danger.fg, borderWidth: 2, borderRadius: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' as const, justifyContent: 'center' as const },
        confirmBtnText: { color: danger.fg, fontSize: 15, fontWeight: '700' as const, textAlign: 'center' as const },
        cancelBtn: { backgroundColor: colors.surface.card, borderColor: colors.border.strong, borderWidth: 1, borderRadius: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' as const, justifyContent: 'center' as const },
        cancelText: { color: colors.text.heading, fontSize: 15, fontWeight: '600' as const, textAlign: 'center' as const },
        doneLine: { color: colors.text.secondary, fontSize: 14, lineHeight: 20 },
        failedLine: { color: danger.fg, fontSize: 14, lineHeight: 20 },
    };
}
