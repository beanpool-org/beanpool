/**
 * The one set of chat styles, lifted out of app/chat/[id].tsx so a group chat, an enterprise thread and an
 * event chat draw the same bubbles, the same action buttons, the same quote block and the same day pill as
 * a DM. Nothing here is new: the values are the DM screen's, which is what "parity" had to mean.
 *
 * Holds at 320dp with 1.3× text: bubbles cap at 85% of the row, the composer keeps a send button that never
 * shrinks, and every tappable circle is at least 32dp inside a 44dp row.
 */

import { StyleSheet } from 'react-native';
import type { ThemeContextType } from '../../app/ThemeContext';
import { palette } from '../../constants/colors';

export const CHAT_INPUT_MIN_HEIGHT = 40;
export const CHAT_INPUT_MAX_HEIGHT = 100;
/** paddingTop + paddingBottom inside the composer: onContentSizeChange reports the text height only. */
export const CHAT_INPUT_V_PADDING = 16;

export const makeChatStyles = ({ theme, colors }: ThemeContextType) => StyleSheet.create({
    // Inverted list: the container's TOP edge renders at the visual bottom, so paddingTop is the gap above
    // the input bar and paddingBottom the gap under the header.
    listContent: { padding: 16, paddingTop: 8, gap: 4 },

    daySeparatorRow: { alignItems: 'center', marginVertical: 4 },
    daySeparatorPill: { backgroundColor: colors.chat.daySeparatorBg, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 },
    daySeparatorText: { fontSize: 11, fontWeight: '600', color: colors.text.secondary },

    messageRowContainer: { width: '100%', marginVertical: 2, position: 'relative' },
    messageRowMe: { alignItems: 'flex-end' },
    messageRowOther: { alignItems: 'flex-start' },
    messageBubble: { maxWidth: '80%', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12 },
    messageMe: { backgroundColor: colors.chat.messageMeBg, alignSelf: 'flex-end', borderBottomRightRadius: 4 },
    messageOther: { backgroundColor: colors.chat.messageOtherBg, alignSelf: 'flex-start', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: colors.border.default },
    messageText: { fontSize: 16, lineHeight: 22 },
    messageTextMe: { color: colors.chat.messageTextMe },
    messageTextOther: { color: colors.chat.messageTextOther },
    /** A deleted or removed message: italic, quieter, and nothing to tap. */
    messageRemoved: { fontStyle: 'italic', opacity: 0.75 },
    messageAuthor: { fontSize: 12, fontWeight: '800', color: colors.brand.primary, marginBottom: 2 },
    linkMe: { color: colors.chat.messageTextMe, textDecorationLine: 'underline', fontWeight: '600' },
    linkOther: { color: colors.text.link, textDecorationLine: 'underline' },
    messageTime: { fontSize: 10, marginTop: 4, alignSelf: 'flex-end' },
    messageTimeMe: { color: colors.chat.messageTimeMe },
    messageTimeOther: { color: colors.text.muted },

    systemMessageContainer: { width: '100%', alignItems: 'center', marginVertical: 8 },
    systemMessageBubble: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16 },
    systemMessageText: { fontSize: 13, color: theme === 'dark' ? colors.text.body : palette.gray600, fontWeight: '600' },
    systemTimestamp: { fontSize: 10, color: colors.text.muted, marginTop: 4 },
    systemActionBtn: { flexDirection: 'row', alignItems: 'center', marginTop: 8, backgroundColor: colors.surface.card, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: colors.brand.primary },
    systemActionText: { color: colors.brand.primary, fontWeight: '700', fontSize: 12 },

    actionButtonsContainer: { flexDirection: 'row', gap: 6, alignItems: 'center' },
    actionButtonsMe: { marginRight: 8 },
    actionButtonsOther: { marginLeft: 8 },
    circleActionButton: {
        width: 32, height: 32, borderRadius: 16,
        backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.gray600,
        justifyContent: 'center', alignItems: 'center',
        shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.2, shadowRadius: 1, elevation: 2,
    },
    circleActionButtonActive: { backgroundColor: colors.accent.primary },
    circleActionButtonDanger: { backgroundColor: colors.feedback.danger.solid },

    reactionPickerContainer: {
        position: 'absolute', top: -45, backgroundColor: colors.text.body, borderRadius: 24,
        paddingHorizontal: 12, paddingVertical: 6, flexDirection: 'row', alignItems: 'center',
        shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 4,
        elevation: 8, zIndex: 100, gap: 10,
    },
    reactionPickerMe: { right: 10 },
    reactionPickerOther: { left: 10 },
    reactionEmojiButton: { padding: 2 },
    reactionEmojiText: { fontSize: 22 },
    reactionBadgeContainer: {
        position: 'absolute', bottom: -5, height: 28, minWidth: 28,
        backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.text.inverse, borderRadius: 14,
        paddingHorizontal: 8,
        shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 1.5,
        elevation: 3, zIndex: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    },
    reactionBadgeMe: { right: 12 },
    reactionBadgeOther: { left: 12 },
    reactionBadgeText: {
        fontSize: 15, fontWeight: '600', color: theme === 'dark' ? colors.text.body : palette.gray700,
        textAlign: 'center', textAlignVertical: 'center', includeFontPadding: false,
    },

    replyPreviewContainer: {
        backgroundColor: colors.surface.app, borderTopWidth: 1, borderTopColor: colors.border.default,
        paddingHorizontal: 16, paddingVertical: 10,
    },
    replyPreviewBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    replyPreviewAuthor: { fontSize: 12, fontWeight: '700', color: colors.accent.primary, marginBottom: 2 },
    replyPreviewText: { fontSize: 14, color: colors.text.secondary },
    replyPreviewClose: { padding: 4, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },

    quoteContainer: { padding: 8, borderRadius: 8, marginBottom: 6, borderLeftWidth: 3, maxWidth: '100%' },
    quoteMe: { backgroundColor: colors.chat.quoteMeBg, borderLeftColor: colors.chat.messageTextMe },
    quoteOther: { backgroundColor: colors.chat.quoteOtherBg, borderLeftColor: colors.accent.primary },
    quoteAuthor: { fontSize: 11, fontWeight: '700', marginBottom: 2 },
    quoteAuthorMe: { color: colors.chat.messageTextMe, opacity: 0.9 },
    quoteAuthorOther: { color: colors.accent.primary },
    quoteText: { fontSize: 13 },
    quoteTextMe: { color: colors.chat.quoteTextMe },
    quoteTextOther: { color: colors.text.secondary },

    inputContainer: {
        flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8,
        borderTopWidth: 1, borderTopColor: colors.surface.subtle, backgroundColor: colors.surface.card,
    },
    attachBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
    input: {
        flex: 1, minWidth: 0, backgroundColor: colors.surface.subtle, borderWidth: 1,
        borderColor: theme === 'dark' ? colors.border.default : palette.slate300, borderRadius: 20,
        paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, fontSize: 16,
        maxHeight: CHAT_INPUT_MAX_HEIGHT, minHeight: CHAT_INPUT_MIN_HEIGHT, color: colors.text.body,
    },
    sendBtn: { flexShrink: 0, width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginLeft: 8 },
    sendBtnActive: { backgroundColor: colors.accent.primary },
    sendBtnInactive: { backgroundColor: colors.surface.subtle },
    composerNotice: { fontSize: 11, color: colors.text.muted, paddingHorizontal: 12, paddingTop: 6 },

    empty: { fontSize: 14, color: colors.text.secondary, paddingVertical: 24, textAlign: 'center' },
    errorText: { margin: 16, fontSize: 15, color: colors.text.body, lineHeight: 21 },
    retryBtn: { minHeight: 48, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 16 },
    retryText: { fontSize: 15, fontWeight: '800', color: colors.brand.primary },
    skeletonRow: { flexDirection: 'row', marginVertical: 6 },
    skeletonRowMine: { justifyContent: 'flex-end' },
    skeletonBubble: { height: 40, borderRadius: 16, backgroundColor: colors.surface.subtle },

    menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
    menuSheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 8 },
    menuTitle: { fontSize: 13, fontWeight: '800', color: colors.text.secondary, paddingHorizontal: 20, paddingVertical: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
    menuRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingHorizontal: 20 },
    menuLabel: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.text.body },
    menuHint: { fontSize: 13, color: colors.text.muted, paddingHorizontal: 20, paddingVertical: 10 },
});

export type ChatStyles = ReturnType<typeof makeChatStyles>;
