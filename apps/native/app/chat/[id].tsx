import React, { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, ScrollView, Alert, Image, ActivityIndicator, Platform, Linking, Modal, DeviceEventEmitter, AppState, type AppStateStatus } from 'react-native';
import { KeyboardAvoidingView, KeyboardController, AndroidSoftInputModes, useKeyboardState } from 'react-native-keyboard-controller';
import { withJitter } from '../../utils/jitter';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, useFocusEffect, Stack, ErrorBoundary } from 'expo-router';

export { ErrorBoundary };
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useIdentity } from '../IdentityContext';
import { getMessages, getConversation, insertMessage, editMessage, sendImageMessage, getDecryptedAttachment, syncMessages, syncSingleConversation, markConversationRead, completeMarketplaceTransaction, cancelMarketplaceTransaction, getDealsBetween, getDb, toggleMessageReactionApi, deleteLocalMessage, deleteMessageApi, muteChatApi, getKnownChatMute, getConversationKind } from '../../utils/db';
import { EventChatView } from '../../components/EventChatView';
import { GroupChatView } from '../../components/GroupChatView';
import { isUserBlocked, BLOCKLIST_UPDATED_EVENT } from '../../utils/blocklist';
import { hapticSuccess, hapticWarning } from '../../utils/haptics';
import { ReviewModal } from '../../components/ReviewModal';
import { MemberAvatar } from '../../components/MemberAvatar';
import { palette } from '../../constants/colors';
import { useTheme, useStyles } from '../ThemeContext';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';
import { makeChatStyles } from '../../components/chat/styles';
import { ChatMessageList, scrollChatToBottom } from '../../components/chat/ChatMessageList';
import { ChatMessageRow } from '../../components/chat/ChatMessageRow';
import { ChatEditBanner, ChatMenuSheet, ChatReplyBanner, type ChatMenuItem } from '../../components/chat/ChatBanners';
import { ChatComposer, type ChatComposerHandle } from '../../components/chat/ChatComposer';
import {
    buildChatListItems, chatActionErrorMessage, hasAnyAction, isTombstone, messageActions, tombstoneText,
    shouldFollowNewMessages, type ChatViewer,
} from '../../utils/chat-actions';
import { normaliseTappedUrl } from '../../utils/chat-links';
import { isMuted, muteMenuLabel, type YourChatMute } from '../../utils/your-groups';

// The edit window, the emoji row, the day labels, the link splitting, the bubble, the action buttons and
// the composer all moved to utils/chat-actions, utils/chat-links and components/chat/* (chat parity,
// 2026-09-23), so a group chat behaves the same way rather than nearly the same way.

// History window (WhatsApp-style): open with the newest page, grow by a page each
// time the user scrolls up to the oldest loaded message. Keeps open-a-chat cost
// (SQLite read + per-message decrypt) flat no matter how long the thread is.
const MESSAGE_PAGE_SIZE = 50;

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

/**
 * `/chat/:id` serves two kinds of conversation. A DM or group is the screen below. An event chat is its
 * own screen (docs/events-on-the-map.md §2.2): node-readable `plaintext-v1`, members that follow the
 * RSVPs, a host who can remove a message, read-only once the event ends — none of which the DM pipeline
 * below (E2E, edits, reactions, deals) knows about, and all of which it would quietly get wrong.
 *
 * Both callers that can open one — the Inbox row and the event detail — say so with `event=1`, so a DM
 * never waits on a database read to decide. The lookup is the fallback for an older link or a push.
 */
export default function ChatRoute() {
    const { id, event, group, enterprise, created, name } = useLocalSearchParams<{
        id?: string; event?: string; group?: string; enterprise?: string; created?: string; name?: string;
    }>();
    const [isEventChat, setIsEventChat] = useState(event === '1');
    // A group's chat and an enterprise's public discussion thread are node-readable threads like the event chat, on
    // their own screen with the one owner header (groups decision 9). "Your groups" says which on the way in.
    const [threadKind, setThreadKind] = useState<'group' | 'enterprise' | null>(
        group === '1' ? 'group' : enterprise === '1' ? 'enterprise' : null,
    );

    useEffect(() => {
        if (isEventChat || threadKind || !id) return;
        let alive = true;
        getConversationKind(String(id)).then(kind => {
            if (!alive) return;
            if (kind === 'event_thread') setIsEventChat(true);
            else if (kind === 'group_thread') setThreadKind('group');
            else if (kind === 'enterprise_thread') setThreadKind('enterprise');
        });
        return () => { alive = false; };
    }, [id, isEventChat, threadKind]);

    if (isEventChat && id) return <EventChatView eventId={String(id)} />;
    if (threadKind && id) return <GroupChatView kind={threadKind} id={String(id)} justCreated={created === '1'} initialName={name} />;
    return <ChatScreen />;
}

function ChatScreen() {
    const { theme, colors } = useTheme();
    const { id, triggerReview, txId: txIdParam, focusTx, prefill } = useLocalSearchParams<{ id?: string; triggerReview?: string; txId?: string; focusTx?: string; prefill?: string }>();
    const { identity } = useIdentity();
    const [messages, setMessages] = useState<any[]>([]);
    const [activeMessageActionsId, setActiveMessageActionsId] = useState<string | null>(null);
    const [activeEmojiPickerId, setActiveEmojiPickerId] = useState<string | null>(null);
    const [pickerPosition, setPickerPosition] = useState<'top' | 'bottom'>('top');
    const [peerName, setPeerName] = useState('Loading...');
    const [peerPubkey, setPeerPubkey] = useState<string | null>(null);
    const [isPeerBlocked, setIsPeerBlocked] = useState(false);
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
    // The first local read has come back (a cold database open is not instant), and what went wrong if it did not.
    const [firstLoadDone, setFirstLoadDone] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [muteOpen, setMuteOpen] = useState(false);
    const [mute, setMute] = useState<YourChatMute | null>(() => getKnownChatMute(String(id ?? '')));
    const flatListRef = useRef<FlatList>(null);
    const composerRef = useRef<ChatComposerHandle>(null);
    // Whether the newest message is on screen. A message arriving while it is must follow the thread down;
    // one arriving while someone reads history must not yank them (utils/chat-actions.shouldFollowNewMessages).
    const atBottomRef = useRef(true);
    const insets = useSafeAreaInsets();
    const sendingRef = useRef(false);
    // The message box — its draft mirror, its height and its dropped-clear sweep — is components/chat/
    // ChatComposer now. Every hard-won Android lesson in it is unchanged; it is simply shared.

    useEffect(() => {
        if (prefill && typeof prefill === 'string') {
            composerRef.current?.setText(prefill);
        }
    }, [prefill]);
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

    // The chat's own pieces — bubbles, actions, the emoji picker, quotes, day pills, the banners and the
    // composer — are the shared set every chat draws (components/chat/styles). Below are only the things
    // this screen has that a group chat does not: the peer header, the deals strip, the escrow action bar
    // and the full-screen photo viewer.
    const chat = useStyles(makeChatStyles);
    const styles = useStyles(({ theme, colors, patternEnabled }) => StyleSheet.create({
        // The wallpaper shows behind the thread; with it off, the chat keeps its plain card white.
        container: { flex: 1, backgroundColor: patternEnabled ? colors.surface.page : colors.surface.card },
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
        // Inline Action Bar
        inlineActionBar: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, gap: 8, backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.yellow50, borderBottomWidth: 1, borderBottomColor: theme === 'dark' ? colors.border.default : palette.yellow200 },
        inlineActionBtn: { flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingVertical: 10, borderRadius: 10 },
        inlineActionRelease: { backgroundColor: colors.brand.dark },
        inlineActionReleaseText: { color: colors.text.inverse, fontWeight: '800', fontSize: 14 },
        inlineActionCancel: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.red300 },
        inlineActionCancelText: { color: colors.feedback.danger.solid, fontWeight: '700', fontSize: 14 },
        blockedNotice: { padding: 14, alignItems: 'center', marginHorizontal: 12, borderRadius: 12, backgroundColor: colors.feedback.danger.bg, borderWidth: 1, borderColor: colors.feedback.danger.border },
        blockedNoticeText: { color: colors.feedback.danger.solid, fontSize: 13, fontWeight: '700' },
    }));

    const promptedRef = useRef(false);
    // Set briefly when a URL link inside a bubble is tapped, so the bubble's own onPress
    // (which opens the reaction/actions menu) doesn't also fire on the same tap.
    const linkPressedRef = useRef(false);

    const openUrl = useCallback((raw: string) => {
        linkPressedRef.current = true;
        setTimeout(() => { linkPressedRef.current = false; }, 350);
        const url = normaliseTappedUrl(raw);
        if (!url) return;
        Linking.openURL(url).catch(() => Alert.alert('Cannot open link', url));
    }, []);

    // The list is inverted (newest message = index 0), so "bottom" is offset 0.
    const scrollToBottom = useCallback((animated: boolean) => {
        scrollChatToBottom(flatListRef, animated);
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

    useEffect(() => {
        if (!peerPubkey) return;
        let isMounted = true;
        isUserBlocked(peerPubkey).then(blocked => {
            if (isMounted) setIsPeerBlocked(blocked);
        });
        const sub = DeviceEventEmitter.addListener(BLOCKLIST_UPDATED_EVENT, async () => {
            const blocked = await isUserBlocked(peerPubkey);
            if (isMounted) setIsPeerBlocked(blocked);
        });
        return () => {
            isMounted = false;
            sub.remove();
        };
    }, [peerPubkey]);

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
            let interval: ReturnType<typeof setInterval> | null = null;
            let appStateSub: any = null;
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
                const pollSingle = () => {
                    syncSingleConversation(id as string).then(() => {
                        loadConversationData();
                        loadMessages(true);
                        loadDeals();
                    });
                };

                const startPolling = () => {
                    if (!interval) {
                        pollSingle();
                        interval = setInterval(pollSingle, withJitter(3000));
                    }
                };

                const stopPolling = () => {
                    if (interval) {
                        clearInterval(interval);
                        interval = null;
                    }
                };

                const handleAppStateChange = (nextState: AppStateStatus) => {
                    if (nextState === 'active') {
                        startPolling();
                    } else {
                        stopPolling();
                    }
                };

                if (AppState.currentState === 'active') {
                    startPolling();
                }

                appStateSub = AppState.addEventListener('change', handleAppStateChange);

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
                    if (AppState.currentState === 'active') {
                        syncSingleConversation(id as string).then(() => {
                            loadConversationData();
                            loadMessages(true);
                            loadDeals();
                        });
                    }
                });
            }
            return () => {
                if (interval) clearInterval(interval);
                if (appStateSub) appStateSub.remove();
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
        [m.id, m.rawTimestamp, m.editedAt ?? '', m.readByPeer ? 1 : 0, m.sendState ?? '', m.type ?? '', m.text?.length ?? 0, m.metadata ? JSON.stringify(m.metadata) : ''].join('\u0001')
    ).join('\u0002');

    const loadMessages = async (isBackgroundPoll = false) => {
        let data: any[];
        try {
            data = await getMessages(id as string, { limit: msgLimitRef.current });
            setLoadError(null);
        } catch (e: any) {
            console.warn('[Chat] Could not read this conversation:', e?.message || e);
            setLoadError(e?.message || 'Could not open this chat.');
            return;
        } finally {
            setFirstLoadDone(true);
        }
        messagesLenRef.current = data.length;
        if (identity?.publicKey) {
            await markConversationRead(id as string, identity.publicKey).catch(() => {});
        }

        setMessages(prev => {
            // Unchanged thread → keep the previous reference so 3s poll ticks don't
            // re-render every bubble ("VirtualizedList slow to update" churn).
            if (prev.length === data.length && messagesSignature(prev) === messagesSignature(data)) return prev;
            // Inverted list: offset 0 IS the newest message. A foreground action (own send, image, resend)
            // always snaps back; a message that arrives on the poll follows the thread down only while the
            // newest message is already in view, so nobody reading history is yanked
            // (utils/chat-actions.shouldFollowNewMessages).
            if (shouldFollowNewMessages({ grew: data.length > prev.length, isBackgroundPoll, atBottom: atBottomRef.current })) {
                setTimeout(() => scrollToBottom(true), 100);
            }
            return data;
        });
    };

    // Asked before the composer empties the box, so a refused send keeps what was typed.
    const canSendNow = () => !!identity?.publicKey && !isPeerBlocked && !sendingRef.current;

    // The composer owns the box and hands over the text it has already cleared and put under its sweep.
    const handleSend = async (currentDraft: string) => {
        if (!currentDraft || !canSendNow() || !identity?.publicKey) return;

        sendingRef.current = true;
        const wasEditing = editingMessage;
        try {
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

    /**
     * Delete for everyone. One question, no window, and the node turns the message into a tombstone both
     * phones pick up. A node that has not been updated yet answers 404, which reads as
     * "Not available on this community yet" rather than as a raw error.
     */
    const handleDeletePress = async (item: any) => {
        setActiveMessageActionsId(null);
        setActiveEmojiPickerId(null);
        await KeyboardController.dismiss(); // Alert = separate window; see the phantom-keyboard note above
        Alert.alert('Delete for everyone?', 'It will read "This message was deleted" for both of you.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: async () => {
                try {
                    await deleteMessageApi(item.id);
                    hapticSuccess();
                    loadMessages(true);
                } catch (e: any) {
                    hapticWarning();
                    Alert.alert('Not deleted', chatActionErrorMessage(e));
                }
            } },
        ]);
    };

    const setMuteTo = async (duration: '8h' | '1w' | 'always' | 'off') => {
        setMuteOpen(false);
        setMenuOpen(false);
        try {
            const res = await muteChatApi(id as string, duration);
            setMute(duration === 'off' ? null : (res?.mute ?? { conversationId: String(id), mutedUntil: null, always: duration === 'always' }));
        } catch (e: any) {
            Alert.alert('Not changed', chatActionErrorMessage(e));
        }
    };

    const openMenu = async () => {
        await Promise.race([KeyboardController.dismiss(), new Promise(r => setTimeout(r, 400))]);
        setMute(getKnownChatMute(String(id)));
        setMenuOpen(true);
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

    // ⚡ Bolt: O(1) Map lookup for parent messages in reply threads instead of repeated O(M) .find() scans
    const messagesById = React.useMemo(() => new Map(messages.map(m => [m.id, m])), [messages]);

    // Day pills interleaved, then reversed for the inverted list. Shared with every chat so a group's
    // Today / Yesterday / "Mon, 12 May" reads exactly like a DM's (utils/chat-actions).
    const listItems = React.useMemo(() => buildChatListItems(messages), [messages]);

    // Who this member is in this chat. The one place the action rules are asked, so a DM and a group chat
    // can never disagree about what tapping a bubble offers.
    const viewer: ChatViewer = React.useMemo(() => ({
        kind: 'dm' as const,
        myPubkey: identity?.publicKey ?? null,
        canPost: !isPeerBlocked,
        isModerator: false,
    }), [identity?.publicKey, isPeerBlocked]);

    /** Escrow events, join notices and the like: a centred grey line with the deal actions under it. */
    const renderSystemMessage = (item: any) => {
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
            <View style={[chat.systemMessageContainer, { marginTop: 16, marginBottom: 16 }]}>
                <View style={[chat.systemMessageBubble, { backgroundColor: bgColor, borderColor: borderColor, borderWidth: 1 }]}>
                    <MaterialCommunityIcons name={iconName} size={16} color={iconColor} style={{ marginRight: 6 }} />
                    <Text style={[chat.systemMessageText, { color: theme === 'dark' ? colors.text.secondary : palette.gray700, fontSize: 13, fontWeight: '500' }]}>
                        {item.metadata?.postId && dealTitleByPostId[item.metadata.postId] ? `${dealTitleByPostId[item.metadata.postId]}: ` : ''}{item.text}
                    </Text>
                </View>
                <Text style={chat.systemTimestamp}>{item.timestamp}</Text>

                {/* Inline post link — only when it points somewhere the sticky header doesn't already cover */}
                {item.metadata?.postId && item.metadata.postId !== postContext?.id && (
                    <Pressable
                        accessibilityRole="button"
                        style={chat.systemActionBtn}
                        onPress={() => router.push(`/post/${item.metadata.postId}`)}
                    >
                        <MaterialCommunityIcons name="tag-outline" size={14} color={colors.brand.primary} style={{ marginRight: 4 }} />
                        <Text style={chat.systemActionText}>View Post</Text>
                    </Pressable>
                )}

                {item.systemType === 'ESCROW_RELEASED' && item.metadata?.postId && (() => {
                    const hasRated = ratedPostIds.has(item.metadata.postId);
                    return (
                        <Pressable
                            accessibilityRole="button"
                            style={[chat.systemActionBtn, { borderColor: hasRated ? colors.brand.primary : colors.feedback.warning.solid }]}
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
                            <Text style={[chat.systemActionText, { color: hasRated ? colors.brand.primary : colors.feedback.warning.solid }]}>
                                {hasRated ? '✓ Rating submitted (Tap to edit)' : 'Rate your partner'}
                            </Text>
                        </Pressable>
                    );
                })()}
            </View>
        );
    };

    const renderMessage = (item: any) => {
        if (item.type === 'system' || item.senderId === 'SYSTEM') return renderSystemMessage(item);

        const isMe = identity?.publicKey ? item.senderId === identity.publicKey : false;
        const showActions = activeMessageActionsId === item.id;
        const showEmojiPicker = activeEmojiPickerId === item.id;
        const actions = messageActions(item, viewer);

        const handleEmojiSelect = async (emoji: string) => {
            if (!identity?.publicKey) return;
            try {
                await toggleMessageReactionApi(item.id, identity.publicKey, emoji);
                hapticSuccess();
                setActiveEmojiPickerId(null);
                setActiveMessageActionsId(null);
                loadMessages(true);
            } catch (e: any) {
                console.error('Failed to react to message:', e);
                Alert.alert('Not reacted', chatActionErrorMessage(e));
            }
        };

        const toggleActions = (event: any) => {
            // A link tap also bubbles to here — swallow it so we don't open the actions menu.
            if (linkPressedRef.current) { linkPressedRef.current = false; return; }
            // Failed sends get the resend/discard prompt instead of the actions menu.
            if (item.sendState === 'failed') { handleFailedMessagePress(item); return; }
            // Nothing on offer (a tombstone, a blocked peer): no empty bar.
            if (!hasAnyAction(actions)) return;
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

        const handleReplyPress = () => {
            setReplyToMessage(item);
            setEditingMessage(null);
            setActiveMessageActionsId(null);
        };

        const handleEditPress = () => {
            setEditingMessage(item);
            setReplyToMessage(null);
            composerRef.current?.setText(item.text || '');
            setActiveMessageActionsId(null);
            setActiveEmojiPickerId(null);
        };

        const quote = item.metadata?.replyToId ? (() => {
            const parentMsg = messagesById.get(item.metadata.replyToId);
            const parentText = !parentMsg
                ? 'Message not found'
                : isTombstone(parentMsg)
                    ? tombstoneText(parentMsg, 'dm')
                    : parentMsg.type === 'image' ? '🔒 Photo' : parentMsg.text;
            const parentAuthor = parentMsg ? (parentMsg.senderId === identity?.publicKey ? 'You' : (peerName || 'Someone')) : 'Someone';
            return {
                author: parentAuthor,
                text: parentText,
                onPress: () => {
                    const index = listItems.findIndex((m: any) => m.id === item.metadata.replyToId);
                    if (index > -1) {
                        try {
                            flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
                        } catch (e) {
                            console.warn(e);
                        }
                    }
                },
            };
        })() : null;

        const status = isMe && item.outgoing ? (
            item.sendState === 'sending' ? (
                <Text style={{ fontSize: 10, color: colors.chat.tickUnread }}> ◷</Text>
            ) : item.sendState === 'failed' ? (
                <Text style={{ fontSize: 10, color: colors.feedback.danger.solid, fontWeight: '800' }}> ! not delivered</Text>
            ) : (
                <Text style={{ fontSize: 10, color: item.readByPeer ? palette.cyan200 : colors.chat.tickUnread }}>
                    {item.readByPeer ? ' ✓✓' : ' ✓'}
                </Text>
            )
        ) : null;

        return (
            <ChatMessageRow
                item={item}
                kind="dm"
                isMe={isMe}
                styles={chat}
                actions={actions}
                showActions={showActions}
                showEmojiPicker={showEmojiPicker}
                pickerPosition={pickerPosition}
                onPressBubble={toggleActions}
                onReply={handleReplyPress}
                onToggleEmojiPicker={() => setActiveEmojiPickerId(activeEmojiPickerId === item.id ? null : item.id)}
                onEdit={handleEditPress}
                onDelete={() => handleDeletePress(item)}
                onRemove={() => { /* a DM has no convenor: nobody removes anybody else's message here */ }}
                onPickEmoji={handleEmojiSelect}
                onPressUrl={openUrl}
                quote={quote}
                attachment={item.type === 'image' ? (
                    <ChatImage conversationId={id as string} messageId={item.id} onOpen={openImageViewer} />
                ) : null}
                status={status}
                footer={item.type === 'image' && !item.text ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: isMe ? 'flex-end' : 'flex-start', marginTop: 4 }}>
                        <Text style={[chat.messageTime, isMe ? chat.messageTimeMe : chat.messageTimeOther]}>
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
                ) : null}
            />
        );
    };

    const menuItems: ChatMenuItem[] = [
        {
            icon: isMuted(mute) ? 'bell-ring-outline' : 'bell-off-outline',
            label: muteMenuLabel(mute),
            onPress: () => { setMenuOpen(false); if (isMuted(mute)) setMuteTo('off'); else setMuteOpen(true); },
        },
        {
            icon: 'account-outline',
            label: 'View profile',
            hidden: !peerPubkey,
            onPress: () => {
                setMenuOpen(false);
                if (peerPubkey) router.push({ pathname: '/public-profile', params: { publicKey: peerPubkey, callsign: peerName } });
            },
        },
    ];

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            
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

                <Pressable accessibilityRole="button" accessibilityLabel="More options" style={styles.moreButton} onPress={openMenu}>
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
                {/* The thread. Inverted, day-separated and keyboard-following — the shared list every chat uses. */}
                {loadError && !firstLoadDone ? (
                    <View style={{ flex: 1 }}>
                        <Text style={chat.errorText} accessibilityRole="alert">{loadError}</Text>
                        <Pressable style={chat.retryBtn} accessibilityRole="button" onPress={() => { setLoadError(null); loadMessages(); }}>
                            <Text style={chat.retryText}>Try again</Text>
                        </Pressable>
                    </View>
                ) : !firstLoadDone ? (
                    // The thread's outline while the first read comes back: the header already names who it is with.
                    <View style={[chat.listContent, { flex: 1 }]} accessibilityRole="progressbar" accessibilityLabel="Loading the chat">
                        {[{ w: '62%', mine: false }, { w: '48%', mine: true }, { w: '70%', mine: false }].map((b, k) => (
                            <View key={k} style={[chat.skeletonRow, b.mine && chat.skeletonRowMine]}>
                                <View style={[chat.skeletonBubble, { width: b.w as any }]} />
                            </View>
                        ))}
                    </View>
                ) : (
                    <ChatMessageList
                        listRef={flatListRef}
                        items={listItems}
                        styles={chat}
                        renderMessage={renderMessage}
                        activeId={activeEmojiPickerId || activeMessageActionsId}
                        onAtBottomChange={atBottom => { atBottomRef.current = atBottom; }}
                        onScrollBeginDrag={() => {
                            setActiveMessageActionsId(null);
                            setActiveEmojiPickerId(null);
                        }}
                        // Inverted list: "end" = the oldest loaded message (visual top). Reaching it grows the
                        // history window by one page, WhatsApp-style. If the last load came back short of the
                        // window, there is no older history to fetch and the grow is skipped.
                        onEndReached={() => {
                            if (loadingOlderRef.current) return;
                            if (messagesLenRef.current < msgLimitRef.current) return;
                            loadingOlderRef.current = true;
                            msgLimitRef.current += MESSAGE_PAGE_SIZE;
                            loadMessages(true).finally(() => { loadingOlderRef.current = false; });
                        }}
                    />
                )}

                {editingMessage && (
                    <ChatEditBanner
                        styles={chat}
                        text={editingMessage.text}
                        onCancel={() => { setEditingMessage(null); composerRef.current?.reset(); }}
                    />
                )}

                {replyToMessage && !editingMessage && (
                    <ChatReplyBanner
                        styles={chat}
                        author={replyToMessage.senderId === identity?.publicKey ? 'You' : (peerName || 'Someone')}
                        text={replyToMessage.type === 'image' ? '🔒 Photo' : replyToMessage.text}
                        onCancel={() => setReplyToMessage(null)}
                    />
                )}

                {isPeerBlocked ? (
                    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.blockedNotice, { marginBottom: Math.max(insets.bottom, 12) }]}>
                        <Text style={styles.blockedNoticeText}>
                            <Text aria-hidden={true} importantForAccessibility="no">🚫 </Text>You have blocked this user. Messaging is disabled.
                        </Text>
                    </View>
                ) : (
                    <ChatComposer
                        ref={composerRef}
                        styles={chat}
                        onSend={handleSend}
                        canSend={canSendNow}
                        placeholder="Message..."
                        accessibilityLabel="Message"
                        bottomPadding={keyboardVisible ? 8 : Math.max(insets.bottom, 12)}
                        leading={
                            <Pressable accessibilityRole="button" accessibilityLabel="Attach image" style={chat.attachBtn} onPress={pickAndSendImage}>
                                <MaterialCommunityIcons name="plus-circle-outline" size={26} color={colors.text.muted} />
                            </Pressable>
                        }
                    />
                )}
            </KeyboardAvoidingView>

            {/* The ⋮ menu: the same sheet, the same mute wording, as every group chat (groups decision 12). */}
            <ChatMenuSheet
                styles={chat}
                menuOpen={menuOpen}
                muteOpen={muteOpen}
                title={peerName}
                items={menuItems}
                onClose={() => { setMenuOpen(false); setMuteOpen(false); }}
                onPickMute={setMuteTo}
                bottomInset={insets.bottom}
            />

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
                local cache so it's instant/offline after first view).
                The Modal is its own full-screen window, outside this screen's SafeAreaView, so the close
                button takes the status-bar inset itself: a fixed 50 is less than the 59pt inset on Dynamic Island iPhones. */}
            {viewerUri && (
                <Modal visible transparent animationType="fade" onRequestClose={() => setViewerUri(null)}>
                    <Pressable accessibilityRole="button" accessibilityLabel="Dismiss full-size photo" style={styles.imageViewerOverlay} onPress={() => setViewerUri(null)}>
                        <Image source={{ uri: viewerUri }} style={styles.imageViewerImage} resizeMode="contain" accessibilityLabel="Full-size photo" />
                        <Pressable accessibilityRole="button" accessibilityLabel="Close photo" style={[styles.imageViewerClose, { top: Math.max(50, insets.top + 8) }]} onPress={() => setViewerUri(null)}>
                            <MaterialCommunityIcons name="close" size={28} color={colors.text.inverse} />
                        </Pressable>
                    </Pressable>
                </Modal>
            )}
        </SafeAreaView>
    );
}
