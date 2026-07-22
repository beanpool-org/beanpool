import React, { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, FlatList, ScrollView, Alert, Image, ActivityIndicator, Platform, Linking, Modal } from 'react-native';
import { KeyboardAvoidingView, KeyboardController, AndroidSoftInputModes, useKeyboardHandler, useKeyboardState } from 'react-native-keyboard-controller';
import { scheduleOnRN } from 'react-native-worklets';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, useFocusEffect, Stack } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useIdentity } from '../IdentityContext';
import { getMessages, getConversation, insertMessage, editMessage, sendImageMessage, getDecryptedAttachment, syncMessages, syncSingleConversation, markConversationRead, completeMarketplaceTransaction, cancelMarketplaceTransaction, getDealsBetween, getDb, toggleMessageReactionApi, deleteLocalMessage } from '../../utils/db';
import { hapticSuccess, hapticWarning } from '../../utils/haptics';
import { ReviewModal } from '../../components/ReviewModal';
import { MemberAvatar } from '../../components/MemberAvatar';
import { palette } from '../../constants/colors';
import { useTheme, useStyles } from '../ThemeContext';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';

// Splits message text into plain runs and tappable URLs. The capturing group keeps the
// matched URLs in the split output so they can be rendered as <Text> links inline.
const URL_SPLIT_REGEX = /((?:https?:\/\/|www\.)[^\s]+)/gi;
const URL_TEST_REGEX = /^(?:https?:\/\/|www\.)[^\s]+$/i;

// Authors may edit a text message for this long after sending (mirrors the server's window).
const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;

// History window (WhatsApp-style): open with the newest page, grow by a page each
// time the user scrolls up to the oldest loaded message. Keeps open-a-chat cost
// (SQLite read + per-message decrypt) flat no matter how long the thread is.
const MESSAGE_PAGE_SIZE = 50;

// Composer height bounds (dp). JS owns the input height — see the inputHeight
// note in the component — so these live here for both the style and the clamp.
const CHAT_INPUT_MIN_HEIGHT = 40;
const CHAT_INPUT_MAX_HEIGHT = 100;
// Vertical padding inside the composer (paddingTop + paddingBottom in styles.input);
// onContentSizeChange reports the text height only, so the clamp adds this back.
const CHAT_INPUT_V_PADDING = 16;

// Bound an await so a hung step can never latch sendingRef forever — a hung
// insertMessage left the send button silently dead until an app restart
// (field report 2026-07-18). The underlying work isn't cancelled; the caller's
// catch/finally run and the UI stays usable.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} is taking too long — please try again.`)), ms)),
    ]);
}

function renderTextWithLinks(text: string, linkStyle: any, onPressUrl: (url: string) => void) {
    if (!text) return text;
    const parts = text.split(URL_SPLIT_REGEX);
    return parts.map((part, i) =>
        URL_TEST_REGEX.test(part)
            ? (
                <Text key={i} style={linkStyle} onPress={() => onPressUrl(part)}>
                    {part}
                </Text>
            )
            : part
    );
}

/** WhatsApp-style day label: Today / Yesterday / "Mon, 12 May". */
function formatDayLabel(d: Date): string {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Image bubble that lazily fetches + decrypts an encrypted attachment for display.
 *  Tapping calls onOpen(uri) so the parent can show it full-screen. */
function ChatImage({ conversationId, messageId, onOpen }: { conversationId: string; messageId: string; onOpen?: (uri: string) => void }) {
    const { colors } = useTheme();
    const [uri, setUri] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let active = true;
        getDecryptedAttachment(conversationId, messageId)
            .then(u => { if (active) { if (u) { setUri(u); } else { setFailed(true); } } })
            .catch(() => { if (active) setFailed(true); });
        return () => { active = false; };
    }, [conversationId, messageId]);
    if (failed) return <Text style={{ color: colors.text.muted, fontStyle: 'italic', padding: 8 }}>🔒 Image unavailable</Text>;
    if (!uri) return <View style={{ width: 220, height: 220, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.text.muted} /></View>;
    return (
        <Pressable accessibilityRole="button" accessibilityLabel="View photo full screen" onPress={() => onOpen?.(uri)}>
            <Image accessibilityLabel="Photo message" source={{ uri }} style={{ width: 220, height: 220, borderRadius: 12 }} resizeMode="cover" />
        </Pressable>
    );
}

export default function ChatScreen() {
    const { theme, colors } = useTheme();
    const { id, triggerReview, txId: txIdParam, focusTx } = useLocalSearchParams();
    const { identity } = useIdentity();
    const [messages, setMessages] = useState<any[]>([]);
    const [activeMessageActionsId, setActiveMessageActionsId] = useState<string | null>(null);
    const [activeEmojiPickerId, setActiveEmojiPickerId] = useState<string | null>(null);
    const [pickerPosition, setPickerPosition] = useState<'top' | 'bottom'>('top');
    const [draft, setDraft] = useState('');
    const [peerName, setPeerName] = useState('Loading...');
    const [peerPubkey, setPeerPubkey] = useState<string | null>(null);
    const [peerAvatar, setPeerAvatar] = useState<string | null>(null);
    // True when this thread is a 2-party DM (the only threads we E2E-encrypt).
    const [isEncrypted, setIsEncrypted] = useState(false);
    const [postContext, setPostContext] = useState<any>(null);
    const [pendingTx, setPendingTx] = useState<{ id: string; amount: number; isPayer: boolean } | null>(null);
    const [isDynamicContext, setIsDynamicContext] = useState(false);
    const [actionLoading, setActionLoading] = useState(false);
    const [promptReviewForTx, setPromptReviewForTx] = useState<{ txId: string; targetPubkey: string; targetCallsign: string } | null>(null);
    const [ratedPostIds, setRatedPostIds] = useState<Set<string>>(new Set());
    const [replyToMessage, setReplyToMessage] = useState<any | null>(null);
    const [editingMessage, setEditingMessage] = useState<any | null>(null);
    const [deals, setDeals] = useState<any[]>([]);
    const [viewerUri, setViewerUri] = useState<string | null>(null);
    const flatListRef = useRef<FlatList>(null);
    const inputRef = useRef<TextInput>(null);
    const insets = useSafeAreaInsets();
    const sendingRef = useRef(false);
    // Mirror of the native input's text for SEND LOGIC. `draft` state is only for
    // styling the send button: handleSend receives state through a render closure,
    // and renders commit late whenever the JS thread is busy — reading state at
    // press time sent a stale prefix of the box ("Go test your core business" went
    // out as "Go test your"; observed on two devices, 2026-07-18). The ref is
    // written synchronously inside every change event, and input events precede
    // the press in the event queue, so it holds the full text when the press runs.
    const draftRef = useRef('');
    // Counts draft writes so the clear sweep can tell a dropped-clear echo
    // (one write carrying the full sent text) from the user re-typing the same
    // text (one write per keystroke) — see scheduleClearSweep.
    const draftWritesRef = useRef(0);
    const updateDraft = (text: string) => {
        draftWritesRef.current += 1;
        draftRef.current = text;
        setDraft(text);
    };
    // Android's multiline TextInput auto-GROWS on keystrokes but never shrinks
    // after a programmatic clear until the next real keystroke (field report
    // 2026-07-18: box stays tall after send). So JS owns the height: measured
    // via onContentSizeChange, clamped, and reset by resetInputBox below.
    const [inputHeight, setInputHeight] = useState(CHAT_INPUT_MIN_HEIGHT);
    // Empty the box and both mirrors, and collapse the height — the one true
    // "reset the composer" path (send, edit-cancel, and the clear sweep).
    const resetInputBox = () => {
        updateDraft('');
        inputRef.current?.clear();
        setInputHeight(CHAT_INPUT_MIN_HEIGHT);
    };
    // inputRef.clear() can be silently DROPPED: the native command carries the
    // count of text events JS has processed, and Android's ReactEditText skips
    // stale-counted updates (protection against clobbering typing JS hasn't seen).
    // Under JS-thread lag the IME emits one more event (autocorrect finalizing on
    // the send tap) just before clear() dispatches -> the box keeps the sent text
    // while draftRef says '' -> grey dead send button over a full box.
    //
    // Field history (2026-07-18, keep for context — three designs failed before this):
    //  v1.1.79  no sweep: stuck box + dead button.
    //  v1.1.80  sweep gated on OBSERVING the pending event drain back within 600ms:
    //           never fired — the drain can take seconds under JS-thread blocks.
    //  v1.1.81  added unconditional rungs (clear + height reset whenever draftRef
    //           was still ''): rescued the stuck box but acted BLINDLY while the
    //           user typed the next message before their keystrokes drained —
    //           squishing the growing box and racing real typing ("glitching").
    //
    // Current design: act only on POSITIVE EVIDENCE, never blindly. A dropped
    // clear always leaves its rejected-count event in flight, and in-flight
    // events always drain eventually — so wait for the drain: when the residue
    // equals the just-sent text and it arrived as EXACTLY ONE write (the echo
    // signature; human re-typing is one write per keystroke), re-clear — that
    // retry now carries a current event count and sticks. Rungs spread to 6s to
    // outlast multi-second JS blocks (2.4s observed). No action on any other
    // state: an undrained box is untouchable (a stale-counted retry would be
    // rejected anyway) and new typing is sacred. Only a single-write identical
    // reproduction (re-pasting the exact sent text mid-ladder) is
    // indistinguishable from the echo — accepted residual.
    const clearSweepTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const scheduleClearSweep = (sentText: string) => {
        if (!sentText) return;
        const writesBaseline = draftWritesRef.current;
        clearSweepTimersRef.current.forEach(clearTimeout);
        clearSweepTimersRef.current = [400, 1200, 3000, 6000].map(ms => setTimeout(() => {
            if (draftWritesRef.current - writesBaseline === 1 && draftRef.current.trim() === sentText) {
                console.log(`[Chat] clear sweep: re-clearing dropped-clear residue at ${ms}ms`);
                resetInputBox();
            }
        }, ms));
    };
    useEffect(() => () => clearSweepTimersRef.current.forEach(clearTimeout), []);
    // History-window paging. Refs (not state) because loadMessages is called from
    // long-lived closures (poll interval, ws listener) that must see current values.
    const msgLimitRef = useRef(MESSAGE_PAGE_SIZE);
    const messagesLenRef = useRef(0);
    const loadingOlderRef = useRef(false);
    // While the keyboard is up, KeyboardAvoidingView already lifts the input bar to sit
    // on the keyboard — adding the nav-bar inset on top of that shows as a dead gap.
    const keyboardVisible = useKeyboardState(s => s.isVisible);
    // Modals get their own native window, and keyboard-controller only hears keyboard
    // events on the main window. If a modal opens while the keyboard is up, the hide
    // happens under the modal's window and the chat stays padded by a phantom keyboard
    // (screen squeezed into the top half). So: fully dismiss the keyboard BEFORE any
    // modal is allowed to mount.
    const [reviewModalReady, setReviewModalReady] = useState(false);
    useEffect(() => {
        if (promptReviewForTx) {
            KeyboardController.dismiss().then(() => setReviewModalReady(true));
        } else {
            setReviewModalReady(false);
        }
    }, [promptReviewForTx]);
    const openImageViewer = useCallback((uri: string) => {
        KeyboardController.dismiss().then(() => setViewerUri(uri));
    }, []);

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.card },
        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.surface.subtle },
        backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'flex-start' },
        headerProfileContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', marginLeft: 8, gap: 10 },
        headerTextContainer: { flex: 1, justifyContent: 'center' },
        headerTitle: { fontSize: 16, fontWeight: '800', color: colors.text.body, letterSpacing: 0.5 },
        headerSubtitle: { fontSize: 11, color: colors.brand.primary, fontWeight: '600', marginTop: 2 },
        moreButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'flex-end' },
        stickyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.emerald50, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme === 'dark' ? colors.border.default : palette.emerald100 },
        stickyHeaderLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, paddingRight: 16 },
        stickyPostTitle: { fontSize: 15, fontWeight: '700', color: theme === 'dark' ? colors.text.body : palette.emerald800 },
        stickyPostCredits: { fontSize: 13, color: colors.brand.dark, fontWeight: '600', marginTop: 2 },
        statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
        statusBadgeText: { fontSize: 11, fontWeight: '800' },
        keyboardView: { flex: 1 },
        // Inverted list: the container's TOP edge renders at the visual bottom,
        // so paddingTop is the gap above the input bar and paddingBottom the gap
        // under the header.
        listContent: { padding: 16, paddingTop: 8, gap: 4 },
        systemMessageContainer: { width: '100%', alignItems: 'center', marginVertical: 8 },
        systemMessageBubble: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16 },
        systemMessageText: { fontSize: 13, color: theme === 'dark' ? colors.text.body : palette.gray600, fontWeight: '600' },
        systemActionBtn: { flexDirection: 'row', alignItems: 'center', marginTop: 8, backgroundColor: colors.surface.card, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: colors.brand.primary },
        systemActionText: { color: colors.brand.primary, fontWeight: '700', fontSize: 12 },
        messageBubble: { maxWidth: '80%', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12 },
        messageMe: { backgroundColor: colors.chat.messageMeBg, alignSelf: 'flex-end', borderBottomRightRadius: 4 },
        messageOther: { backgroundColor: colors.chat.messageOtherBg, alignSelf: 'flex-start', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: colors.border.default },
        messageText: { fontSize: 16, lineHeight: 22 },
        messageTextMe: { color: colors.chat.messageTextMe },
        messageTextOther: { color: colors.chat.messageTextOther },
        linkMe: { color: colors.chat.messageTextMe, textDecorationLine: 'underline', fontWeight: '600' },
        linkOther: { color: colors.text.link, textDecorationLine: 'underline' },
        // Pinned active-deals strip
        dealStrip: { backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.green50, borderBottomWidth: 1, borderBottomColor: theme === 'dark' ? colors.border.default : palette.green200 },
        dealCard: { backgroundColor: colors.surface.card, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.emerald100, width: 200 },
        dealCardTitle: { fontSize: 14, fontWeight: '800', color: colors.text.body },
        dealCardMeta: { fontSize: 12, color: colors.text.secondary, marginTop: 2, marginBottom: 8 },
        dealCardActions: { flexDirection: 'row', gap: 6, alignItems: 'center' },
        dealBtn: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
        dealBtnRelease: { backgroundColor: colors.brand.dark, flex: 1 },
        dealBtnReleaseText: { color: colors.text.inverse, fontWeight: '800', fontSize: 13 },
        dealBtnCancel: { backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.red50, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.red200 },
        dealBtnCancelText: { color: colors.feedback.danger.solid, fontWeight: '700', fontSize: 13 },
        dealBtnReview: { backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.amber50, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.amber200, flex: 1 },
        dealBtnReviewText: { color: theme === 'dark' ? colors.text.body : palette.amber600, fontWeight: '800', fontSize: 13 },
        dealAwaiting: { color: colors.text.secondary, fontSize: 12, fontWeight: '600', fontStyle: 'italic' },
        // Full-screen image viewer
        imageViewerOverlay: { flex: 1, backgroundColor: colors.overlay.imageViewerBg, alignItems: 'center', justifyContent: 'center' },
        imageViewerImage: { width: '100%', height: '100%' },
        imageViewerClose: { position: 'absolute', top: 50, right: 20, width: 44, height: 44, borderRadius: 22, backgroundColor: colors.overlay.imageViewerCloseBg, alignItems: 'center', justifyContent: 'center' },
        messageTime: { fontSize: 10, marginTop: 4, alignSelf: 'flex-end' },
        messageTimeMe: { color: colors.chat.messageTimeMe },
        messageTimeOther: { color: colors.text.muted },
        inputContainer: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.surface.subtle, backgroundColor: colors.surface.card },
        attachBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
        input: { flex: 1, backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.slate300, borderRadius: 20, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, fontSize: 16, maxHeight: CHAT_INPUT_MAX_HEIGHT, minHeight: CHAT_INPUT_MIN_HEIGHT, color: colors.text.body },
        sendBtn: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginLeft: 8 },
        sendBtnActive: { backgroundColor: colors.accent.primary },
        sendBtnInactive: { backgroundColor: colors.surface.subtle },
        systemTimestamp: { fontSize: 10, color: colors.text.muted, marginTop: 4 },
        daySeparatorRow: { alignItems: 'center', marginVertical: 4 },
        daySeparatorPill: { backgroundColor: colors.chat.daySeparatorBg, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 },
        daySeparatorText: { fontSize: 11, fontWeight: '600', color: colors.text.secondary },
        // Inline Action Bar
        inlineActionBar: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, gap: 8, backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.yellow50, borderBottomWidth: 1, borderBottomColor: theme === 'dark' ? colors.border.default : palette.yellow200 },
        inlineActionBtn: { flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingVertical: 10, borderRadius: 10 },
        inlineActionRelease: { backgroundColor: colors.brand.dark },
        inlineActionReleaseText: { color: colors.text.inverse, fontWeight: '800', fontSize: 14 },
        inlineActionCancel: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.red300 },
        inlineActionCancelText: { color: colors.feedback.danger.solid, fontWeight: '700', fontSize: 14 },
        // Reactions and Custom Message Rows
        messageRowContainer: {
            width: '100%',
            marginVertical: 2,
            position: 'relative',
        },
        messageRowMe: {
            alignItems: 'flex-end',
        },
        messageRowOther: {
            alignItems: 'flex-start',
        },
        actionButtonsContainer: {
            flexDirection: 'row',
            gap: 6,
            alignItems: 'center',
        },
        actionButtonsMe: {
            marginRight: 8,
        },
        actionButtonsOther: {
            marginLeft: 8,
        },
        circleActionButton: {
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.gray600,
            justifyContent: 'center',
            alignItems: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.2,
            shadowRadius: 1,
            elevation: 2,
        },
        circleActionButtonActive: {
            backgroundColor: colors.accent.primary,
        },
        reactionPickerContainer: {
            position: 'absolute',
            top: -45,
            backgroundColor: colors.text.body,
            borderRadius: 24,
            paddingHorizontal: 12,
            paddingVertical: 6,
            flexDirection: 'row',
            alignItems: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.3,
            shadowRadius: 4,
            elevation: 8,
            zIndex: 100,
            gap: 10,
        },
        reactionPickerMe: {
            right: 10,
        },
        reactionPickerOther: {
            left: 10,
        },
        reactionEmojiButton: {
            padding: 2,
        },
        reactionEmojiText: {
            fontSize: 22,
        },
        reactionBadgeContainer: {
            position: 'absolute',
            bottom: -5,
            height: 28,
            minWidth: 28,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.text.inverse,
            borderRadius: 14,
            paddingHorizontal: 8,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.15,
            shadowRadius: 1.5,
            elevation: 3,
            zIndex: 10,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
        },
        reactionBadgeMe: {
            right: 12,
        },
        reactionBadgeOther: {
            left: 12,
        },
        reactionBadgeText: {
            fontSize: 15,
            fontWeight: '600',
            color: theme === 'dark' ? colors.text.body : palette.gray700,
            textAlign: 'center',
            textAlignVertical: 'center',
            includeFontPadding: false,
        },
        // Reply & Quotes styling
        replyPreviewContainer: {
            backgroundColor: colors.surface.app,
            borderTopWidth: 1,
            borderTopColor: colors.border.default,
            paddingHorizontal: 16,
            paddingVertical: 10,
        },
        replyPreviewBar: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
        },
        replyPreviewAuthor: {
            fontSize: 12,
            fontWeight: '700',
            color: colors.accent.primary,
            marginBottom: 2,
        },
        replyPreviewText: {
            fontSize: 14,
            color: colors.text.secondary,
        },
        replyPreviewClose: {
            padding: 4,
        },
        quoteContainer: {
            padding: 8,
            borderRadius: 8,
            marginBottom: 6,
            borderLeftWidth: 3,
            maxWidth: '100%',
        },
        quoteMe: {
            backgroundColor: colors.chat.quoteMeBg,
            borderLeftColor: colors.chat.messageTextMe,
        },
        quoteOther: {
            backgroundColor: colors.chat.quoteOtherBg,
            borderLeftColor: colors.accent.primary,
        },
        quoteAuthor: {
            fontSize: 11,
            fontWeight: '700',
            marginBottom: 2,
        },
        quoteAuthorMe: {
            color: colors.chat.messageTextMe,
            opacity: 0.9,
        },
        quoteAuthorOther: {
            color: colors.accent.primary,
        },
        quoteText: {
            fontSize: 13,
        },
        quoteTextMe: {
            color: colors.chat.quoteTextMe,
        },
        quoteTextOther: {
            color: colors.text.secondary,
        },
    }));
    const promptedRef = useRef(false);
    // Set briefly when a URL link inside a bubble is tapped, so the bubble's own onPress
    // (which opens the reaction/actions menu) doesn't also fire on the same tap.
    const linkPressedRef = useRef(false);

    const openUrl = useCallback((raw: string) => {
        linkPressedRef.current = true;
        setTimeout(() => { linkPressedRef.current = false; }, 350);
        let url = raw.replace(/[.,;:!?)\]}'"]+$/, ''); // drop trailing punctuation
        if (/^www\./i.test(url)) url = 'https://' + url;
        if (!/^https?:\/\//i.test(url)) return;
        Linking.openURL(url).catch(() => Alert.alert('Cannot open link', url));
    }, []);

    // The list is inverted (newest message = index 0), so "bottom" is offset 0.
    const scrollToBottom = useCallback((animated: boolean) => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated });
    }, []);

    // On Android, tell the OS not to resize/pan the window when the keyboard
    // opens. This makes react-native-keyboard-controller's KeyboardAvoidingView
    // the sole owner of keyboard compensation — eliminating the intermittent
    // race where Android's OS-level resize and the library's padding would
    // double-compensate or mis-time, hiding the input bar.
    useEffect(() => {
        if (Platform.OS === 'android') {
            KeyboardController.setInputMode(AndroidSoftInputModes.SOFT_INPUT_ADJUST_NOTHING);
        }
        return () => {
            if (Platform.OS === 'android') {
                KeyboardController.setDefaultMode();
            }
        };
    }, []);

    // Keep the latest messages pinned to the bottom as the keyboard slides in,
    // following it frame-by-frame (WhatsApp-style) instead of a single delayed
    // jump that lands before the avoid-view padding has settled.
    useKeyboardHandler({
        onMove: () => {
            'worklet';
            scheduleOnRN(scrollToBottom, false);
        },
        onEnd: () => {
            'worklet';
            scheduleOnRN(scrollToBottom, false);
        },
    }, [scrollToBottom]);

    const loadRatedTransactions = useCallback(async () => {
        if (!identity?.publicKey) return;
        try {
            const db = await getDb();
            const ratedRows = await db.getAllAsync<any>(
                "SELECT mt.post_id FROM ratings r JOIN marketplace_transactions mt ON r.transaction_id = mt.id WHERE r.rater_pubkey = ?",
                [identity.publicKey]
            );
            const ids = new Set<string>(ratedRows.map(r => r.post_id).filter(Boolean));
            setRatedPostIds(ids);
        } catch (e) {
            console.error("[Chat] Failed to load rated transaction list:", e);
        }
    }, [identity?.publicKey]);

    const loadConversationData = useCallback(async () => {
        if (id && identity?.publicKey) {
            const res = await getConversation(id as string, identity.publicKey);
            if (res) {
                setPeerName(res.name || res.otherCallsign || String(id).slice(0, 8));
                if (res.otherPubkey) setPeerPubkey(res.otherPubkey);
                setIsEncrypted(res.type === 'dm' && !!res.otherPubkey);
                setPeerAvatar(res.otherAvatar || null);
                if (res.postId) {
                    setPostContext({
                        id: res.postId,
                        title: res.postTitle,
                        status: res.postStatus,
                        priceType: res.price_type,
                        credits: res.credits
                    });
                    setIsDynamicContext(false);

                    if (triggerReview === 'true' && !promptedRef.current) {
                        promptedRef.current = true;
                        try {
                            const db = await getDb();
                            const txRow = await db.getFirstAsync<any>(
                                "SELECT id, buyer_pubkey, seller_pubkey FROM marketplace_transactions WHERE post_id=? AND status='completed' LIMIT 1",
                                [res.postId]
                            );
                            if (txRow) {
                                const targetPubkey = txRow.buyer_pubkey === identity.publicKey ? txRow.seller_pubkey : txRow.buyer_pubkey;
                                setPromptReviewForTx({
                                    txId: txRow.id,
                                    targetPubkey,
                                    targetCallsign: res.name || res.otherCallsign || String(id).slice(0, 8)
                                });
                            }
                        } catch (e) {
                            console.error('[Rating] Auto-trigger review load failed:', e);
                        }
                    }
                } else {
                    setIsDynamicContext(true);
                }
                // Track pending transaction for inline action bar
                if (res.pendingTxId && identity.publicKey) {
                    setPendingTx({
                        id: res.pendingTxId,
                        amount: res.pendingAmount,
                        isPayer: res.txBuyerPubkey === identity.publicKey
                    });
                } else if (res.postId) {
                    setPendingTx(null);
                }

                // Consolidated-thread review deep-link: the inbox passes the specific deal's txId
                // (per-pair threads have no postId, so the post-based trigger above won't fire).
                if (triggerReview === 'true' && txIdParam && !promptedRef.current && res.otherPubkey) {
                    promptedRef.current = true;
                    setPromptReviewForTx({
                        txId: String(txIdParam),
                        targetPubkey: res.otherPubkey,
                        targetCallsign: res.name || res.otherCallsign || String(id).slice(0, 8)
                    });
                }
            } else {
                setPeerName(String(id).slice(0, 8));
            }
        }
    }, [id, identity, triggerReview]);

    // All deals with this peer, from local SQLite. Re-queried on focus, on the poll,
    // and on sync events below so a deal written moments after navigation
    // (e.g. accept-offer → chat) still surfaces without a remount.
    const loadDeals = useCallback(async () => {
        if (!identity?.publicKey || !peerPubkey) return;
        try {
            const next = await getDealsBetween(identity.publicKey, peerPubkey);
            // Polled every few seconds — keep the previous reference when nothing
            // changed so unchanged ticks don't re-render the thread.
            setDeals(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
        } catch (e) {
            console.warn('[Deals] load failed', e);
        }
    }, [identity?.publicKey, peerPubkey]);

    React.useEffect(() => { loadDeals(); }, [loadDeals]);

    useFocusEffect(
        useCallback(() => {
            setReplyToMessage(null);
            setEditingMessage(null);
            // Fresh window on each (re)open — a long thread starts at one page again.
            msgLimitRef.current = MESSAGE_PAGE_SIZE;
            let interval: ReturnType<typeof setInterval>;
            promptedRef.current = false;

            let sub: any = null;
            let wsSub: any = null;
            if (id && identity?.publicKey) {
                // Initial Load
                loadConversationData();
                loadRatedTransactions();
                loadDeals();
                loadMessages().then(() => {
                    syncMessages(identity!.publicKey).then(() => {
                        loadConversationData();
                        loadMessages(true);
                        loadRatedTransactions();
                        loadDeals();
                    });
                });

                // Background Poll
                interval = setInterval(() => {
                    syncSingleConversation(id as string).then(() => {
                        loadConversationData();
                        loadMessages(true);
                        loadDeals();
                    });
                }, 3000);

                const { DeviceEventEmitter } = require('react-native');
                sub = DeviceEventEmitter.addListener('sync_data_updated', () => {
                    loadConversationData();
                    loadMessages(true);
                    loadRatedTransactions();
                    loadDeals();
                });

                // Fast path: the WebSocket doorbell nudges us to refresh THIS
                // conversation immediately with a single targeted fetch, rather
                // than waiting for the heavier full reconciliation (requestSync)
                // to finish and emit 'sync_data_updated'.
                wsSub = DeviceEventEmitter.addListener('ws_activity', () => {
                    syncSingleConversation(id as string).then(() => {
                        loadConversationData();
                        loadMessages(true);
                        loadDeals();
                    });
                });
            }
            return () => {
                if (interval) clearInterval(interval);
                if (sub) sub.remove();
                if (wsSub) wsSub.remove();
            };
        }, [id, identity, loadConversationData, loadDeals])
    );

    // Change signature for the poll-tick compare in loadMessages: every field that
    // can alter how a bubble renders, EXCEPT the message text — text is pinned by
    // (id, editedAt), and stringifying the full decrypted thread twice every 3s is
    // what made ticks expensive once the history window grew. Metadata stays in
    // (it's tiny and carries reactions/reply refs/send state).
    const messagesSignature = (rows: any[]) => rows.map(m =>
        [m.id, m.rawTimestamp, m.editedAt ?? '', m.readByPeer ? 1 : 0, m.sendState ?? '', m.text?.length ?? 0, m.metadata ? JSON.stringify(m.metadata) : ''].join('\u0001')
    ).join('\u0002');

    const loadMessages = async (isBackgroundPoll = false) => {
        const data = await getMessages(id as string, { limit: msgLimitRef.current });
        messagesLenRef.current = data.length;
        if (identity?.publicKey) {
            await markConversationRead(id as string, identity.publicKey).catch(() => {});
        }
        
        setMessages(prev => {
            // Unchanged thread → keep the previous reference so 3s poll ticks don't
            // re-render every bubble ("VirtualizedList slow to update" churn).
            if (prev.length === data.length && messagesSignature(prev) === messagesSignature(data)) return prev;
            // Inverted list: offset 0 IS the newest message, so the view is already
            // pinned to the bottom on open and stays there as new rows arrive. Only
            // a foreground action (own send, image, resend) snaps back explicitly —
            // background polls must not yank someone who scrolled up to read history.
            if (!isBackgroundPoll && data.length > prev.length) {
                setTimeout(() => scrollToBottom(true), 100);
            }
            return data;
        });
    };

    const handleSend = async () => {
        // Guard and payload both come from draftRef, never `draft` state — see the
        // draftRef note. Guarding on state made the button silently swallow presses
        // whenever state lagged the box (the "chat locked up" report, 2026-07-18).
        const currentDraft = draftRef.current.trim();
        if (!currentDraft || !identity?.publicKey) return;
        if (sendingRef.current) return;

        sendingRef.current = true;
        const wasEditing = editingMessage;
        try {
            resetInputBox(); // uncontrolled input: state alone doesn't clear the box
            scheduleClearSweep(currentDraft); // clear() may be dropped under load — see note at definition
            if (wasEditing) {
                await withTimeout(editMessage(id as string, wasEditing.id, currentDraft), 15_000, 'Editing');
                setEditingMessage(null);
                loadMessages(true);
            } else {
                let metadata: string | undefined = undefined;
                if (replyToMessage) {
                    metadata = JSON.stringify({ replyToId: replyToMessage.id });
                }
                await withTimeout(insertMessage(id as string, identity.publicKey, currentDraft, metadata), 15_000, 'Sending');
                setReplyToMessage(null);
                loadMessages();
            }
        } catch (err: any) {
            Alert.alert(wasEditing ? "Edit Failed" : "Message Failed", err.message || "Could not execute send.");
            if (wasEditing) setEditingMessage(null); // drop back to normal compose on failure (e.g. window expired)
        } finally {
            sendingRef.current = false;
        }
    };

    // A failed optimistic send renders a red "!" — tapping the bubble lands here.
    const handleFailedMessagePress = async (item: any) => {
        await KeyboardController.dismiss(); // Alert = separate window; see phantom-keyboard note above
        Alert.alert('Message not delivered', 'This message could not be sent.', [
            { text: 'Discard', style: 'destructive', onPress: async () => {
                await deleteLocalMessage(item.id).catch(() => {});
                loadMessages(true);
            }},
            { text: 'Resend', onPress: async () => {
                if (!identity?.publicKey) return;
                const meta = { ...(item.metadata || {}) };
                delete meta.__sendState;
                const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : undefined;
                await deleteLocalMessage(item.id).catch(() => {});
                try {
                    // Reuse the failed row's id: if the original POST actually landed
                    // (timeout after server commit), the retry is idempotent instead
                    // of a duplicate the peer sees twice.
                    await insertMessage(id as string, identity.publicKey, item.text, metaStr, item.id);
                } catch (e: any) {
                    Alert.alert('Message Failed', e.message || 'Could not resend.');
                }
                loadMessages(true);
            }},
            { text: 'Cancel', style: 'cancel' },
        ]);
    };

    const pickAndSendImage = async () => {
        if (!identity?.publicKey || sendingRef.current) return;
        // Same phantom-keyboard hazard as the review modal: the source-picker Alert and
        // the image-picker Activity are separate windows — hide the keyboard first.
        await KeyboardController.dismiss();
        const sendUri = async (uri: string) => {
            sendingRef.current = true;
            try {
                const manip = await withTimeout(ImageManipulator.manipulateAsync(
                    uri,
                    [{ resize: { width: 1000 } }],
                    { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
                ), 30_000, 'Processing the image');
                if (!manip.base64) throw new Error('Could not process image.');
                let metadata: string | undefined = undefined;
                if (replyToMessage) {
                    metadata = JSON.stringify({ replyToId: replyToMessage.id });
                }
                // Image sends still await the server round-trip (not optimistic) —
                // the timeout keeps a dead network from latching sendingRef forever.
                await withTimeout(sendImageMessage(id as string, `data:image/jpeg;base64,${manip.base64}`, '', metadata), 60_000, 'Sending the image');
                setReplyToMessage(null);
                hapticSuccess();
                loadMessages();
            } catch (err: any) {
                hapticWarning();
                Alert.alert('Image Failed', err.message || 'Could not send image.');
            } finally {
                sendingRef.current = false;
            }
        };
        Alert.alert('Send Photo', 'Choose a source', [
            { text: 'Camera', onPress: async () => {
                const perm = await ImagePicker.requestCameraPermissionsAsync();
                if (!perm.granted) { Alert.alert('Permission needed', 'Camera access is required.'); return; }
                const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
                if (!r.canceled && r.assets[0]?.uri) sendUri(r.assets[0].uri);
            }},
            { text: 'Gallery', onPress: async () => {
                const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
                if (!r.canceled && r.assets[0]?.uri) sendUri(r.assets[0].uri);
            }},
            { text: 'Cancel', style: 'cancel' },
        ]);
    };

    const handleReleaseCredits = async () => {
        if (!pendingTx || !identity?.publicKey) return;
        await KeyboardController.dismiss(); // Alert = separate window; see review-modal note
        Alert.alert(
            'Release Credits',
            `Release ${pendingTx.amount} Beans to the provider? This action cannot be undone.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Release',
                    style: 'destructive',
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            await completeMarketplaceTransaction(pendingTx.id, identity.publicKey);
                            hapticSuccess();
                            Alert.alert('Success', 'Credits have been released!');
                            
                            // Immediately prompt for review
                            const targetPubkey = peerPubkey;
                            if (targetPubkey) {
                                setPromptReviewForTx({
                                    txId: pendingTx.id,
                                    targetPubkey,
                                    targetCallsign: peerName
                                });
                            }
                            
                            // Refresh conversation state
                            syncSingleConversation(id as string).then(() => {
                                loadConversationData();
                                loadDeals();
                                loadMessages(true);
                            });
                        } catch (e: any) {
                            hapticWarning();
                            Alert.alert('Failed', e.message || 'Could not release credits.');
                        } finally {
                            setActionLoading(false);
                        }
                    }
                }
            ]
        );
    };

    const handleCancelEscrow = async () => {
        if (!pendingTx || !identity?.publicKey) return;
        await KeyboardController.dismiss();
        Alert.alert(
            'Cancel Escrow',
            'Are you sure you want to cancel this escrow? The credits will be refunded.',
            [
                { text: 'Keep', style: 'cancel' },
                {
                    text: 'Cancel Escrow',
                    style: 'destructive',
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            await cancelMarketplaceTransaction(pendingTx.id, identity.publicKey);
                            hapticWarning();
                            Alert.alert('Cancelled', 'Escrow has been cancelled and credits refunded.');
                            syncSingleConversation(id as string).then(() => {
                                loadConversationData();
                                loadDeals();
                                loadMessages(true);
                            });
                        } catch (e: any) {
                            hapticWarning();
                            Alert.alert('Failed', e.message || 'Could not cancel escrow.');
                        } finally {
                            setActionLoading(false);
                        }
                    }
                }
            ]
        );
    };

    // ---- Consolidated thread: per-deal action handlers (loadDeals lives above the focus effect) ----

    // Pinned-strip deals: live escrow, or a completed deal still awaiting my review.
    const activeDeals = React.useMemo(
        () => deals.filter(d => d.status === 'pending' || (d.status === 'completed' && !d.iRated)),
        [deals]
    );

    // Filter out the deal from the top strip if it is currently displayed in the richer bottom Inline Action Bar
    const visibleDeals = React.useMemo(() => {
        return activeDeals.filter(d => {
            const isShownInInlineBar = pendingTx && pendingTx.isPayer && postContext?.status === 'pending' && d.txId === pendingTx.id;
            return !isShownInInlineBar;
        });
    }, [activeDeals, pendingTx, postContext]);

    // Reactive dynamic context: if there is no hardcoded postContext (consolidated thread),
    // derive postContext and pendingTx automatically from active deals where the user is the buyer.
    React.useEffect(() => {
        if (!isDynamicContext) return;

        let selectedDeal = null;
        if (focusTx) {
            selectedDeal = deals.find(d => d.txId === focusTx && d.status === 'pending');
        }
        if (!selectedDeal) {
            selectedDeal = deals.find(d => d.status === 'pending' && d.iAmBuyer);
        }

        if (selectedDeal) {
            setPendingTx({
                id: selectedDeal.txId,
                amount: selectedDeal.credits,
                isPayer: selectedDeal.iAmBuyer
            });
            setPostContext({
                id: selectedDeal.postId || '',
                title: selectedDeal.postTitle || 'Deal',
                status: selectedDeal.status || 'pending',
                priceType: 'fixed',
                credits: selectedDeal.credits
            });
        } else {
            setPendingTx(null);
            setPostContext(null);
        }
    }, [deals, isDynamicContext, focusTx]);

    // postId -> item title, so escrow events can be labelled by deal in the merged timeline.
    const dealTitleByPostId = React.useMemo(() => {
        const map: Record<string, string> = {};
        for (const d of deals) if (d.postId && d.postTitle) map[d.postId] = d.postTitle;
        return map;
    }, [deals]);

    const handleReleaseDeal = async (txId: string, amount: number) => {
        if (!identity?.publicKey) return;
        await KeyboardController.dismiss();
        Alert.alert('Release Credits', `Release ${amount} Beans to the provider? This action is final.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Release', style: 'destructive', onPress: async () => {
                setActionLoading(true);
                try {
                    await completeMarketplaceTransaction(txId, identity.publicKey);
                    hapticSuccess();
                    if (peerPubkey) setPromptReviewForTx({ txId, targetPubkey: peerPubkey, targetCallsign: peerName });
                    await syncSingleConversation(id as string);
                    await loadDeals();
                    loadMessages(true);
                } catch (e: any) {
                    hapticWarning();
                    Alert.alert('Failed', e.message || 'Could not release credits.');
                } finally { setActionLoading(false); }
            }}
        ]);
    };

    const handleCancelDeal = async (txId: string) => {
        if (!identity?.publicKey) return;
        await KeyboardController.dismiss();
        Alert.alert('Cancel Deal', 'Cancel this deal? The escrow will be refunded.', [
            { text: 'Keep', style: 'cancel' },
            { text: 'Cancel Deal', style: 'destructive', onPress: async () => {
                setActionLoading(true);
                try {
                    await cancelMarketplaceTransaction(txId, identity.publicKey);
                    hapticWarning();
                    await syncSingleConversation(id as string);
                    await loadDeals();
                    loadMessages(true);
                } catch (e: any) {
                    hapticWarning();
                    Alert.alert('Failed', e.message || 'Could not cancel.');
                } finally { setActionLoading(false); }
            }}
        ]);
    };

    const handleReviewDeal = (deal: any) => {
        if (peerPubkey) setPromptReviewForTx({ txId: deal.txId, targetPubkey: peerPubkey, targetCallsign: peerName });
    };

    // Interleave day-separator pills between messages from different calendar days
    const listItems = React.useMemo(() => {
        const items: any[] = [];
        let lastDay: string | null = null;
        for (const m of messages) {
            const d = m.rawTimestamp ? new Date(m.rawTimestamp) : null;
            if (d && !isNaN(d.getTime())) {
                const dayKey = d.toDateString();
                if (dayKey !== lastDay) {
                    items.push({ id: `day-${dayKey}`, type: 'day-separator', label: formatDayLabel(d) });
                    lastDay = dayKey;
                }
            }
            items.push(m);
        }
        // Reversed for the inverted FlatList: index 0 renders at the visual bottom,
        // so the reversed-chronological array reads correctly top-to-bottom on screen.
        return items.reverse();
    }, [messages]);

    // List cells are siblings, and a later-mounted cell paints over an earlier one —
    // so the reaction picker / action buttons (positioned at top/bottom: -45, overflowing into
    // adjacent rows) rendered BEHIND sibling bubbles. zIndex inside the row can't win
    // across cells; the whole cell has to be lifted while its picker or action bar is open.
    const renderCell = useCallback(({ children, item, style, ...props }: any) => {
        const isActive = item?.id && (item.id === activeEmojiPickerId || item.id === activeMessageActionsId);
        return (
            <View
                {...props}
                style={[
                    style,
                    isActive ? { zIndex: 9999, elevation: 9999, overflow: 'visible' } : { zIndex: 1 }
                ]}
            >
                {children}
            </View>
        );
    }, [activeEmojiPickerId, activeMessageActionsId]);

    const renderMessage = ({ item }: { item: any }) => {
        if (item.type === 'day-separator') {
            return (
                <View style={styles.daySeparatorRow}>
                    <View style={styles.daySeparatorPill}>
                        <Text style={styles.daySeparatorText}>{item.label}</Text>
                    </View>
                </View>
            );
        }

        const isSystem = item.type === 'system' || item.senderId === 'SYSTEM';
        
        if (isSystem) {
            let iconName: any = 'information-outline';
            let iconColor: string = colors.text.secondary;
            let bgColor: string = colors.chatSystem.defaultBg;
            let borderColor: string = colors.chatSystem.defaultBorder;

            if (item.systemType === 'ESCROW_FUNDED') {
                iconName = 'lock-check';
                iconColor = colors.brand.primary;
                bgColor = colors.chatSystem.fundedBg;
                borderColor = colors.brand.primary;
            }
            if (item.systemType === 'ESCROW_RELEASED') {
                iconName = 'check-decagram';
                iconColor = colors.brand.dark;
                bgColor = colors.chatSystem.releasedBg;
                borderColor = colors.brand.dark;
            }
            if (item.systemType === 'ESCROW_CANCELLED') {
                iconName = 'cash-refund';
                iconColor = colors.feedback.danger.solid;
                bgColor = colors.chatSystem.cancelledBg;
                borderColor = colors.feedback.danger.solid;
            }

            return (
                <View style={[styles.systemMessageContainer, { marginTop: 16, marginBottom: 16 }]}>
                    <View style={[styles.systemMessageBubble, { backgroundColor: bgColor, borderColor: borderColor, borderWidth: 1 }]}>
                        <MaterialCommunityIcons name={iconName} size={16} color={iconColor} style={{ marginRight: 6 }} />
                        <Text style={[styles.systemMessageText, { color: theme === 'dark' ? colors.text.secondary : palette.gray700, fontSize: 13, fontWeight: '500' }]}>
                            {item.metadata?.postId && dealTitleByPostId[item.metadata.postId] ? `${dealTitleByPostId[item.metadata.postId]}: ` : ''}{item.text}
                        </Text>
                    </View>
                    <Text style={styles.systemTimestamp}>{item.timestamp}</Text>
                    
                    {/* Inline post link — only when it points somewhere the sticky header doesn't already cover */}
                    {item.metadata?.postId && item.metadata.postId !== postContext?.id && (
                        <Pressable
                            accessibilityRole="button"
                            style={styles.systemActionBtn}
                            onPress={() => router.push(`/post/${item.metadata.postId}`)}
                        >
                            <MaterialCommunityIcons name="tag-outline" size={14} color={colors.brand.primary} style={{ marginRight: 4 }} />
                            <Text style={styles.systemActionText}>View Post</Text>
                        </Pressable>
                    )}
                    
                    {item.systemType === 'ESCROW_RELEASED' && item.metadata?.postId && (() => {
                        const hasRated = ratedPostIds.has(item.metadata.postId);
                        return (
                            <Pressable
                                accessibilityRole="button"
                                style={[styles.systemActionBtn, { borderColor: hasRated ? colors.brand.primary : colors.feedback.warning.solid }]}
                                onPress={async () => {
                                    try {
                                        const db = await getDb();
                                        const txRow = await db.getFirstAsync<any>(
                                            "SELECT id, buyer_pubkey, seller_pubkey FROM marketplace_transactions WHERE post_id=? AND status='completed' LIMIT 1",
                                            [item.metadata.postId]
                                        );
                                        if (txRow && identity?.publicKey) {
                                            const targetPubkey = txRow.buyer_pubkey === identity.publicKey ? txRow.seller_pubkey : txRow.buyer_pubkey;
                                            setPromptReviewForTx({
                                                txId: txRow.id,
                                                targetPubkey,
                                                targetCallsign: peerName
                                            });
                                        } else {
                                            Alert.alert("Notice", "Transaction details not found locally. Please try viewing the post.");
                                        }
                                    } catch (e) {
                                        console.error(e);
                                        Alert.alert("Error", "Could not load transaction details for rating.");
                                    }
                                }}
                            >
                                <MaterialCommunityIcons 
                                    name={hasRated ? "star" : "star-outline"} 
                                    size={14} 
                                    color={hasRated ? colors.brand.primary : colors.feedback.warning.solid}
                                    style={{ marginRight: 4 }}
                                />
                                <Text style={[styles.systemActionText, { color: hasRated ? colors.brand.primary : colors.feedback.warning.solid }]}>
                                    {hasRated ? '✓ Rating submitted (Tap to edit)' : 'Rate your partner'}
                                </Text>
                            </Pressable>
                        );
                    })()}
                </View>
            );
        }

        const isMe = identity?.publicKey ? item.senderId === identity.publicKey : false;
        const showActions = activeMessageActionsId === item.id;
        const showEmojiPicker = activeEmojiPickerId === item.id;

        // Parse reactions
        const reactions: { emoji: string; author: string }[] = item.metadata?.reactions || [];
        const reactionCounts = reactions.reduce((acc: { [key: string]: number }, r: any) => {
            acc[r.emoji] = (acc[r.emoji] || 0) + 1;
            return acc;
        }, {});
        const uniqueEmojis = Object.keys(reactionCounts);
        const totalReactionsCount = reactions.length;

        const handleEmojiSelect = async (emoji: string) => {
            if (!identity?.publicKey) return;
            try {
                await toggleMessageReactionApi(item.id, identity.publicKey, emoji);
                hapticSuccess();
                setActiveEmojiPickerId(null);
                setActiveMessageActionsId(null);
                loadMessages(true);
            } catch (e) {
                console.error('Failed to react to message:', e);
                Alert.alert('Error', 'Could not react to message');
            }
        };

        const toggleActions = (event: any) => {
            // A link tap also bubbles to here — swallow it so we don't open the actions menu.
            if (linkPressedRef.current) { linkPressedRef.current = false; return; }
            // Failed sends get the resend/discard prompt instead of the actions menu.
            if (item.sendState === 'failed') { handleFailedMessagePress(item); return; }
            const pageY = event?.nativeEvent?.pageY;
            // If the touch is within the top 230px of the viewport, position the picker below the bubble
            const isNearTop = pageY && pageY < 230;
            setPickerPosition(isNearTop ? 'bottom' : 'top');

            if (activeMessageActionsId === item.id) {
                setActiveMessageActionsId(null);
                setActiveEmojiPickerId(null);
            } else {
                setActiveMessageActionsId(item.id);
                setActiveEmojiPickerId(null);
            }
        };

        const handleSmileyPress = () => {
            if (activeEmojiPickerId === item.id) {
                setActiveEmojiPickerId(null);
            } else {
                setActiveEmojiPickerId(item.id);
            }
        };

        const handleReplyPress = () => {
            setReplyToMessage(item);
            setEditingMessage(null);
            setActiveMessageActionsId(null);
        };

        const handleEditPress = () => {
            setEditingMessage(item);
            setReplyToMessage(null);
            updateDraft(item.text || '');
            // Uncontrolled input: push the text into the native field explicitly.
            inputRef.current?.setNativeProps({ text: item.text || '' });
            setActiveMessageActionsId(null);
            setActiveEmojiPickerId(null);
        };

        // Only the author can edit, only text (not images/system), only within the window,
        // and never a message still in flight (its id is a local temp id the server doesn't know).
        const canEdit = isMe && item.type !== 'image' && !item.systemType && !item.sendState && !!item.rawTimestamp &&
            (Date.now() - new Date(item.rawTimestamp).getTime() <= MESSAGE_EDIT_WINDOW_MS);

        const renderActionButtons = () => {
            return (
                <View style={[styles.actionButtonsContainer, isMe ? styles.actionButtonsMe : styles.actionButtonsOther]}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Reply"
                        style={styles.circleActionButton}
                        onPress={handleReplyPress}
                    >
                        <MaterialCommunityIcons name="reply" size={16} color={colors.text.inverse} />
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="React"
                        style={[styles.circleActionButton, showEmojiPicker ? styles.circleActionButtonActive : {}]}
                        onPress={handleSmileyPress}
                    >
                        <MaterialCommunityIcons name="emoticon-happy-outline" size={16} color={colors.text.inverse} />
                    </Pressable>
                    {canEdit && (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Edit message"
                            style={styles.circleActionButton}
                            onPress={handleEditPress}
                        >
                            <MaterialCommunityIcons name="pencil" size={15} color={colors.text.inverse} />
                        </Pressable>
                    )}
                </View>
            );
        };

        return (
            <View style={[
                styles.messageRowContainer,
                isMe ? styles.messageRowMe : styles.messageRowOther
            ]}>
                {showEmojiPicker && (
                    <View style={[
                        styles.reactionPickerContainer, 
                        isMe ? styles.reactionPickerMe : styles.reactionPickerOther,
                        pickerPosition === 'bottom' ? { top: undefined, bottom: -45 } : { bottom: undefined, top: -45 }
                    ]}>
                        {['👍', '❤️', '😂', '😮', '😢', '🙏', '😁'].map((emoji) => (
                            <Pressable
                                key={emoji}
                                accessibilityRole="button"
                                accessibilityLabel={`React with ${emoji}`}
                                style={styles.reactionEmojiButton}
                                onPress={() => handleEmojiSelect(emoji)}
                            >
                                <Text style={styles.reactionEmojiText}>{emoji}</Text>
                            </Pressable>
                        ))}
                    </View>
                )}

                <View style={{ flexDirection: 'row', alignItems: 'center', maxWidth: '85%' }}>
                    {isMe && showActions && renderActionButtons()}
                    
                    <Pressable
                        accessibilityRole="button"
                        onPress={toggleActions}
                        style={[
                            styles.messageBubble,
                            isMe ? styles.messageMe : styles.messageOther,
                            { position: 'relative', zIndex: 1 },
                            totalReactionsCount > 0 ? { paddingBottom: 24 } : null
                        ]}
                    >
                        {item.metadata?.replyToId && (() => {
                            const parentMsg = messages.find(m => m.id === item.metadata.replyToId);
                            const parentText = parentMsg ? (parentMsg.type === 'image' ? '🔒 Photo' : parentMsg.text) : 'Message not found';
                            const parentAuthor = parentMsg ? (parentMsg.senderId === identity?.publicKey ? 'You' : (peerName || 'Someone')) : 'Someone';
                            return (
                                <Pressable
                                    accessibilityRole="button"
                                    onPress={() => {
                                        const index = listItems.findIndex(m => m.id === item.metadata.replyToId);
                                        if (index > -1) {
                                            try {
                                                flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
                                            } catch (e) {
                                                console.warn(e);
                                            }
                                        }
                                    }}
                                    style={[
                                        styles.quoteContainer,
                                        isMe ? styles.quoteMe : styles.quoteOther
                                    ]}
                                >
                                    <Text style={[styles.quoteAuthor, isMe ? styles.quoteAuthorMe : styles.quoteAuthorOther]}>
                                        {parentAuthor}
                                    </Text>
                                    <Text style={[styles.quoteText, isMe ? styles.quoteTextMe : styles.quoteTextOther]} numberOfLines={1}>
                                        {parentText}
                                    </Text>
                                </Pressable>
                            );
                        })()}
                        {item.type === 'image' ? (
                            <>
                                <ChatImage conversationId={id as string} messageId={item.id} onOpen={openImageViewer} />
                                {!!item.text && (
                                    <Text style={[styles.messageText, isMe ? styles.messageTextMe : styles.messageTextOther, { marginTop: 6 }]}>
                                        {renderTextWithLinks(item.text, isMe ? styles.linkMe : styles.linkOther, openUrl)}
                                        {"  "}
                                        <Text style={[styles.messageTime, isMe ? styles.messageTimeMe : styles.messageTimeOther, { fontSize: 10 }]}>
                                            {item.timestamp}
                                        </Text>
                                        {isMe && item.outgoing && (
                                            <Text style={{ fontSize: 10, color: item.readByPeer ? palette.cyan200 : colors.chat.tickUnread }}>
                                                {item.readByPeer ? ' ✓✓' : ' ✓'}
                                            </Text>
                                        )}
                                    </Text>
                                )}
                            </>
                        ) : (
                            <Text style={[styles.messageText, isMe ? styles.messageTextMe : styles.messageTextOther]}>
                                {renderTextWithLinks(item.text, isMe ? styles.linkMe : styles.linkOther, openUrl)}
                                {"  "}
                                <Text style={[styles.messageTime, isMe ? styles.messageTimeMe : styles.messageTimeOther, { fontSize: 10 }]}>
                                    {item.edited ? 'edited · ' : ''}{item.timestamp}
                                </Text>
                                {isMe && item.outgoing && (
                                    item.sendState === 'sending' ? (
                                        <Text style={{ fontSize: 10, color: colors.chat.tickUnread }}> ◷</Text>
                                    ) : item.sendState === 'failed' ? (
                                        <Text style={{ fontSize: 10, color: colors.feedback.danger.solid, fontWeight: '800' }}> ! not delivered</Text>
                                    ) : (
                                        <Text style={{ fontSize: 10, color: item.readByPeer ? palette.cyan200 : colors.chat.tickUnread }}>
                                            {item.readByPeer ? ' ✓✓' : ' ✓'}
                                        </Text>
                                    )
                                )}
                            </Text>
                        )}
                        {item.type === 'image' && !item.text && (
                            <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: isMe ? 'flex-end' : 'flex-start', marginTop: 4 }}>
                                <Text style={[styles.messageTime, isMe ? styles.messageTimeMe : styles.messageTimeOther]}>
                                    {item.timestamp}
                                </Text>
                                {isMe && item.outgoing && (
                                    <MaterialCommunityIcons
                                        name={item.readByPeer ? 'check-all' : 'check'}
                                        size={14}
                                        color={item.readByPeer ? palette.cyan200 : colors.chat.tickUnread}
                                        style={{ marginLeft: 3 }}
                                    />
                                )}
                            </View>
                        )}

                        {totalReactionsCount > 0 && (
                            <View style={[
                                styles.reactionBadgeContainer, 
                                isMe ? styles.reactionBadgeMe : styles.reactionBadgeOther,
                                totalReactionsCount === 1 ? { width: 28, paddingHorizontal: 0, justifyContent: 'center' } : {}
                            ]}>
                                <Text style={[
                                    styles.reactionBadgeText,
                                    totalReactionsCount === 1 
                                        ? { fontSize: 14, lineHeight: 14, marginTop: 1.5, marginLeft: 3.5 } 
                                        : { marginTop: -1 }
                                ]}>
                                    {uniqueEmojis.join(' ')} {totalReactionsCount > 1 ? totalReactionsCount : ''}
                                </Text>
                            </View>
                        )}
                    </Pressable>

                    {!isMe && showActions && renderActionButtons()}
                </View>
            </View>
        );
    };

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            <StatusBar style="dark" />
            
            {/* Header */}
            <View style={styles.header}>
                <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.backButton}>
                    <MaterialCommunityIcons name="arrow-left" size={28} color={colors.text.body} />
                </Pressable>

                <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                        if (peerPubkey) {
                            router.push({
                                pathname: '/public-profile',
                                params: { publicKey: peerPubkey, callsign: peerName }
                            });
                        }
                    }}
                    style={styles.headerProfileContainer}
                >
                    <MemberAvatar 
                        avatarUrl={peerAvatar} 
                        pubkey={peerPubkey || ''} 
                        callsign={peerName} 
                        size={38} 
                    />
                    <View style={styles.headerTextContainer}>
                        <Text style={styles.headerTitle} numberOfLines={1}>{peerName}</Text>
                        <Text style={styles.headerSubtitle} numberOfLines={1}>
                            {isEncrypted ? '🔒 End-to-end encrypted' : 'Connected via Mullum Node'}
                        </Text>
                    </View>
                </Pressable>

                <Pressable accessibilityRole="button" accessibilityLabel="More options" style={styles.moreButton}>
                    <MaterialCommunityIcons name="dots-horizontal" size={28} color={colors.text.secondary} />
                </Pressable>
            </View>

            {/* Pinned active-deals strip — per-deal actions live here (one card per live deal),
                always visible so a Release/Review is never buried in the conversation scroll. */}
            {visibleDeals.length > 0 && (
                <View style={styles.dealStrip}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingVertical: 10 }}>
                        {visibleDeals.map(d => (
                            <Pressable
                                key={d.txId}
                                accessibilityRole="button"
                                style={styles.dealCard}
                                onPress={() => d.postId && router.push(`/post/${d.postId}`)}
                            >
                                <Text style={styles.dealCardTitle} numberOfLines={1}>{d.postTitle || 'Deal'}</Text>
                                <Text style={styles.dealCardMeta} numberOfLines={1}>
                                    <CurrencyDisplay amount={d.credits} style={styles.dealCardMeta} /> · {d.status === 'completed' ? 'completed' : 'in escrow'}
                                </Text>
                                <View style={styles.dealCardActions}>
                                    {d.status === 'pending' && d.iAmBuyer && (
                                        <>
                                            <Pressable accessibilityRole="button" accessibilityLabel={`Release credits for ${d.postTitle || 'deal'}`} style={[styles.dealBtn, styles.dealBtnRelease]} disabled={actionLoading} onPress={() => handleReleaseDeal(d.txId, d.credits)}>
                                                <Text style={styles.dealBtnReleaseText}>{actionLoading ? '…' : 'Release'}</Text>
                                            </Pressable>
                                            <Pressable accessibilityRole="button" accessibilityLabel="Cancel deal" style={[styles.dealBtn, styles.dealBtnCancel]} disabled={actionLoading} onPress={() => handleCancelDeal(d.txId)}>
                                                <Text style={styles.dealBtnCancelText}>Cancel</Text>
                                            </Pressable>
                                        </>
                                    )}
                                    {d.status === 'pending' && !d.iAmBuyer && (
                                        <Text style={styles.dealAwaiting}>⏳ Awaiting release</Text>
                                    )}
                                    {d.status === 'completed' && !d.iRated && (
                                        <Pressable accessibilityRole="button" accessibilityLabel={`Leave a review for ${d.postTitle || 'deal'}`} style={[styles.dealBtn, styles.dealBtnReview]} onPress={() => handleReviewDeal(d)}>
                                            <Text style={styles.dealBtnReviewText}>⭐ Review</Text>
                                        </Pressable>
                                    )}
                                </View>
                            </Pressable>
                        ))}
                    </ScrollView>
                </View>
            )}

            {/* Sticky Marketplace Header */}
            {postContext && (
                <Pressable accessibilityRole="button" onPress={() => router.push(`/post/${postContext.id}`)} style={styles.stickyHeader}>
                    <View style={styles.stickyHeaderLeft}>
                        <MaterialCommunityIcons name="shopping-outline" size={24} color={colors.brand.dark} />
                        <View style={{ marginLeft: 12 }}>
                            <Text style={styles.stickyPostTitle} numberOfLines={1}>{postContext.title}</Text>
                            <Text style={styles.stickyPostCredits}>{postContext.credits} Beans{postContext.priceType === 'hourly' ? ' / hr' : ''}</Text>
                        </View>
                    </View>
                    <View style={[styles.statusBadge,
                        postContext.status === 'active' ? { backgroundColor: theme === 'dark' ? colors.feedback.success.bg : palette.emerald100 } :
                        postContext.status === 'pending' ? { backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : palette.amber100 } :
                        { backgroundColor: colors.border.default }
                    ]}>
                        <Text style={[styles.statusBadgeText,
                            postContext.status === 'active' ? { color: theme === 'dark' ? colors.feedback.success.fg : colors.brand.dark } :
                            postContext.status === 'pending' ? { color: theme === 'dark' ? colors.feedback.warning.fg : palette.amber600 } :
                            { color: theme === 'dark' ? colors.text.secondary : palette.gray600 }
                        ]}>{postContext.status?.toUpperCase() || 'UNKNOWN'}</Text>
                    </View>
                </Pressable>
            )}

            {/* Inline Action Bar — Release/Cancel when escrow is pending and user is the payer */}
            {pendingTx && pendingTx.isPayer && postContext?.status === 'pending' && (
                <View style={[styles.inlineActionBar, { flexDirection: 'column' }]}>
                    <View style={{ width: '100%', marginBottom: 10 }}>
                        <Text style={{ color: theme === 'dark' ? colors.feedback.warning.fg : palette.amber600, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 4 }}>
                            ⚠️ Action Required: Release Credits
                        </Text>
                        <Text style={{ color: theme === 'dark' ? colors.text.body : palette.amber900, fontSize: 11, textAlign: 'center', paddingHorizontal: 16 }}>
                            Only release credits ONCE the provider has fulfilled the terms of the agreement. This action is final.
                        </Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Pressable
                            accessibilityRole="button"
                            style={[styles.inlineActionBtn, styles.inlineActionRelease]}
                            onPress={handleReleaseCredits}
                            disabled={actionLoading}
                        >
                            <MaterialCommunityIcons name="check-circle-outline" size={18} color={colors.text.inverse} style={{ marginRight: 6 }} />
                            <Text style={styles.inlineActionReleaseText}>
                                {actionLoading ? 'Processing...' : (
                                    <>
                                        Release <CurrencyDisplay amount={pendingTx.amount} style={styles.inlineActionReleaseText} />
                                    </>
                                )}
                            </Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            style={[styles.inlineActionBtn, styles.inlineActionCancel]}
                            onPress={handleCancelEscrow}
                            disabled={actionLoading}
                        >
                            <MaterialCommunityIcons name="close-circle-outline" size={18} color={colors.feedback.danger.solid} style={{ marginRight: 6 }} />
                            <Text style={styles.inlineActionCancelText}>Cancel</Text>
                        </Pressable>
                    </View>
                </View>
            )}

            <KeyboardAvoidingView
                style={styles.keyboardView}
                behavior="padding"
            >
                {/* Messages List */}
                <FlatList
                    ref={flatListRef}
                    data={listItems}
                    keyExtractor={item => item.id}
                    renderItem={renderMessage}
                    CellRendererComponent={renderCell}
                    contentContainerStyle={styles.listContent}
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                    // Inverted = newest message (index 0) is on-screen from the first
                    // frame. The old non-inverted list rendered the thread top-down in
                    // batches while animating scrollToEnd after EVERY batch — the
                    // jerky ride-to-the-bottom on opening a conversation.
                    inverted
                    initialNumToRender={15}
                    windowSize={9}
                    // Inverted list: "end" = the oldest loaded message (visual top).
                    // Reaching it grows the history window by one page, WhatsApp-style.
                    // If the last load came back short of the window, there is no
                    // older history to fetch and the grow is skipped.
                    onEndReachedThreshold={0.8}
                    onEndReached={() => {
                        if (loadingOlderRef.current) return;
                        if (messagesLenRef.current < msgLimitRef.current) return;
                        loadingOlderRef.current = true;
                        msgLimitRef.current += MESSAGE_PAGE_SIZE;
                        loadMessages(true).finally(() => { loadingOlderRef.current = false; });
                    }}
                    onScrollBeginDrag={() => {
                        setActiveMessageActionsId(null);
                        setActiveEmojiPickerId(null);
                    }}
                />

                {/* Edit Banner */}
                {editingMessage && (
                    <View style={styles.replyPreviewContainer}>
                        <View style={styles.replyPreviewBar}>
                            <View style={{ flex: 1, borderLeftWidth: 3, borderLeftColor: colors.brand.primary, paddingLeft: 8 }}>
                                <Text style={[styles.replyPreviewAuthor, { color: colors.brand.primary }]}>Editing message</Text>
                                <Text style={styles.replyPreviewText} numberOfLines={1}>{editingMessage.text}</Text>
                            </View>
                            <Pressable accessibilityRole="button" accessibilityLabel="Cancel edit" onPress={() => { const prior = draftRef.current.trim(); setEditingMessage(null); resetInputBox(); scheduleClearSweep(prior); }} style={styles.replyPreviewClose}>
                                <MaterialCommunityIcons name="close" size={20} color={colors.text.secondary} />
                            </Pressable>
                        </View>
                    </View>
                )}

                {/* Reply Preview */}
                {replyToMessage && !editingMessage && (
                    <View style={styles.replyPreviewContainer}>
                        <View style={styles.replyPreviewBar}>
                            <View style={{ flex: 1, borderLeftWidth: 3, borderLeftColor: colors.accent.primary, paddingLeft: 8 }}>
                                <Text style={styles.replyPreviewAuthor}>
                                    Replying to {replyToMessage.senderId === identity?.publicKey ? 'You' : (peerName || 'Someone')}
                                </Text>
                                <Text style={styles.replyPreviewText} numberOfLines={1}>
                                    {replyToMessage.type === 'image' ? '🔒 Photo' : replyToMessage.text}
                                </Text>
                            </View>
                            <Pressable accessibilityRole="button" accessibilityLabel="Cancel reply" onPress={() => setReplyToMessage(null)} style={styles.replyPreviewClose}>
                                <MaterialCommunityIcons name="close" size={20} color={colors.text.secondary} />
                            </Pressable>
                        </View>
                    </View>
                )}

                {/* Input Area */}
                <View style={[
                    styles.inputContainer,
                    { paddingBottom: keyboardVisible ? 8 : Math.max(insets.bottom, 12) }
                ]}>
                    <Pressable accessibilityRole="button" accessibilityLabel="Attach image" style={styles.attachBtn} onPress={pickAndSendImage}>
                        <MaterialCommunityIcons name="plus-circle-outline" size={26} color={colors.text.muted} />
                    </Pressable>
                    <TextInput
                        ref={inputRef}
                        accessibilityLabel="Message"
                        style={[styles.input, { height: inputHeight }]}
                        // JS-owned height: Android's native autosize only ever grows —
                        // after a programmatic clear the box stays multi-line until the
                        // next keystroke. Measure, clamp, and let resetInputBox collapse it.
                        onContentSizeChange={e => setInputHeight(Math.min(CHAT_INPUT_MAX_HEIGHT,
                            Math.max(CHAT_INPUT_MIN_HEIGHT, Math.ceil(e.nativeEvent.contentSize.height) + CHAT_INPUT_V_PADDING)))}
                        placeholder="Message..."
                        placeholderTextColor={colors.text.muted}
                        // UNCONTROLLED on purpose — no `value` prop. A controlled input
                        // round-trips every keystroke through the JS thread; when JS is
                        // busy (sync payload parsing), React writes a STALE value back
                        // into the native field and typed characters are lost — messages
                        // arrived at the server with letters missing on slower devices.
                        // The native field is the source of truth. updateDraft mirrors it
                        // into draftRef (synchronously — handleSend's guard and payload)
                        // and into `draft` state (async — send-button styling only; state
                        // reaches handlers via render closures that lag under load, which
                        // truncated sends to a stale prefix before draftRef existed).
                        onChangeText={updateDraft}
                        multiline
                        submitBehavior="newline"
                    />
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Send message"
                        style={[styles.sendBtn, draft.trim().length > 0 ? styles.sendBtnActive : styles.sendBtnInactive]}
                        onPress={handleSend}
                    >
                        <MaterialCommunityIcons name="send" size={20} color={draft.trim().length > 0 ? colors.text.inverse : colors.text.muted} />
                    </Pressable>
                </View>
            </KeyboardAvoidingView>

            {promptReviewForTx && reviewModalReady && (
                <ReviewModal
                    visible={!!promptReviewForTx}
                    txId={promptReviewForTx.txId}
                    targetPubkey={promptReviewForTx.targetPubkey}
                    targetCallsign={promptReviewForTx.targetCallsign}
                    onClose={() => {
                        setPromptReviewForTx(null);
                        if (triggerReview === 'true') {
                            router.navigate('/(tabs)/chats');
                        }
                    }}
                    onSuccess={() => {
                        Alert.alert("Success", "Your rating has been submitted!");
                        setPromptReviewForTx(null);
                        loadRatedTransactions();
                        loadDeals(); // reviewed deal drops off the pinned strip
                        if (triggerReview === 'true') {
                            router.navigate('/(tabs)/chats');
                        }
                    }}
                />
            )}

            {/* Full-screen image viewer — opened from a tapped chat image (full 1000px, from the
                local cache so it's instant/offline after first view). */}
            {viewerUri && (
                <Modal visible transparent animationType="fade" onRequestClose={() => setViewerUri(null)}>
                    <Pressable style={styles.imageViewerOverlay} onPress={() => setViewerUri(null)}>
                        <Image source={{ uri: viewerUri }} style={styles.imageViewerImage} resizeMode="contain" accessibilityLabel="Full-size photo" />
                        <Pressable accessibilityRole="button" accessibilityLabel="Close photo" style={styles.imageViewerClose} onPress={() => setViewerUri(null)}>
                            <MaterialCommunityIcons name="close" size={28} color={colors.text.inverse} />
                        </Pressable>
                    </Pressable>
                </Modal>
            )}
        </SafeAreaView>
    );
}
