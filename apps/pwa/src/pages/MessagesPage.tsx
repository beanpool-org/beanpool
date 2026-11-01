/**
 * MessagesPage — Conversations list + chat view
 *
 * Two modes:
 *  - List: shows all conversations with last message preview
 *  - Chat: shows messages in a conversation with send input
 */

import { useState, useEffect, useLayoutEffect, useRef, useMemo, type CSSProperties } from 'react';
import {
    getConversations, getConversationMessages, createConversationApi, decideMessageRequest,
    sendMessageApi, editMessageApi, toggleMessageReactionApi, getMessageAttachmentApi,
    markConversationReadApi, getMyMarketplaceTransactions, completeMarketplaceTransaction, cancelMarketplaceTransaction,
    getEventChat, getGroupChat, getGroupMembers, groupKeysNet, getFriends,
    deleteMessageApi, removeGroupChatMessage, muteChatApi, type YourChatMute,
    type Conversation, type ApiMessage, type Member, type MarketplaceTransaction, type GroupChatAnswer, type FriendEntry, type DmRequestEntry,
} from '../lib/api';
import { requestModeOf, requestAfterRead, requestAfterOwnLine, requestTakesPhoto, requestPendingRefusal, REQUEST_CARDS_SHOWN } from '../lib/dm-requests';
import { MessageRequestsList, RequestActions, closedPhotoWords, useRequestPreviews } from '../components/MessageRequests';
import { ChatPhotoViewer } from '../components/ChatPhotoViewer';
import { iRated, tradeOfReleaseLine, unratedTradeWith } from '../lib/trade-review';
import {
    decodePlaintext, checkDmThread, openDmLine, dmAfterReference, dmLineMarkText, dmLineShownText, dmLineIsUnattributed, dmReplyToOf,
    dmThreadInShownOrder, dmQuoteFrom, dmQuoteLabel, newDmMessageId, isEncryptedNonce, DM_LINE_DELETED_TEXT, DM_LINE_NOT_VERIFIED_TEXT, type DMKeyContext,
} from '../lib/e2e-crypto';
import { chatAuthorWords, chatLineWords } from '../lib/chat-line-words';
import { dmKeyContext, lockForDm, payloadForChat, isDmNotLocked, dmNotLockedLine, isNodeReadableChat, type DmLineSeal } from '../lib/dm-lock';
import { holdConversation, lockedGroupsOrNull, sendRouteOf, groupIdKey, startedDm, GROUP_HOLD_STARTED_DM_TEXT, GROUP_HOLD_UNREAD_TEXT, GROUP_HOLD_UNREAD_OPEN_TEXT, GROUP_CHAT_IS_DM_TEXT } from '../lib/group-hold';
import { encodePlaintext } from '../lib/e2e-crypto';
import { groupKeyring, GroupChatKeyError, GroupKeysRequestError, GROUP_KEY_WAITING_TEXT } from '../lib/group-chat-keys';
import { indexedDbGroupLockStore } from '../lib/group-chat-lock-store';
import {
    chatIsLocked, groupChatNotice, groupChatSendPlan, heldGroupRefusal, sendSealedGroupLine, editSealedGroupLine, openGroupThread,
    groupLineShown, groupRemovedRuns, getDecryptedGroupAttachment, reportSealedGroupLine, GROUP_CHAT_OLD_NODE_NOTICE, type GroupLineShown,
    type OpenedGroupThread,
} from '../lib/group-chat-lines';
import { resizePhotoFile } from '../lib/photo-resize';
import { searchShownLines, GROUP_LINE_UNVERIFIED_NAME, type DisplayRosterRow } from '../lib/group-line-display';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';
import { onSyncActivity, socketIsAlive } from '../lib/sync';
import { registerLivePostTie, conversationTie } from '../lib/live-posts';
import { consumeChatPrefill } from '../lib/archetypes';
import { isUserBlocked, blockUser, unblockUser, getBlockedUsers, onBlocklistUpdated } from '../lib/blocklist';
import { withJitter } from '../lib/jitter';
import { imageFromTransfer, dragCarriesFile, chatImageRefusal, NODE_READABLE_NO_PHOTOS_TEXT } from '../lib/chat-image-transfer';
import { nodeRefusal } from '../lib/node-refusal';
import { useMembersOnDemand, useMemberSearch, memberKeysBatches, membersByKeys, getMembersWhole, MEMBERS_SEARCH_MIN_CHARS } from '../lib/members-on-demand';
import { ReportModal } from '../components/ReportModal';
import { ChatConfirmDialog } from '../components/ChatConfirmDialog';
import { ChatDealStrip } from '../components/ChatDealStrip';
import { ChatMenuModal } from '../components/ChatMenuModal';
import { isMuted, groupHeaderDetail, chatMuteFromAnswer } from '../lib/chat-mute';
import { EventChat } from '../components/EventChat';
import { notifyConversationRead } from '../lib/conversation-read';
import { FoldedChatText } from '../components/FoldedChatText';
import { CreateGroupModal } from '../components/CreateGroupModal';
import { inConversationTab, groupsUnreadCount, isGroupLikeChat, type ConversationTab } from '../lib/conversation-tabs';
import { bundledGroupEmblem, dealStep, dealsNeedingMe, formatDate, listPhotoUrl, messageBackstopDue, MESSAGE_BACKSTOP_TICK_MS, removedRunText, t, tn, word, type WordKey } from '@beanpool/core';
import { systemLineColours } from '../lib/systemLineColours';
import { readsOwn, useCommunityInfo } from '../lib/features';

const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '😁'];
const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * A group chat as this page holds it (lib/group-chat-lines.ts): the node's chat answer, whether it is locked (by the node's
 * word, or by this browser having seen it locked: the sticky lock), its sealed lines opened and named, and the roster
 * the screen shows. Nothing of it is kept beyond the page but the lock store's two facts.
 */
interface GroupChatView {
    id: string;
    answer: GroupChatAnswer | null;
    error: unknown;
    nodeSaysLocked: boolean;
    seenLocked: boolean;
    thread: OpenedGroupThread | null;
    roster: DisplayRosterRow[];
}

/** Words for a group chat this member can read but not write in (the node's own, GROUP_CHAT_OBSERVER): shown through t(). */
const GROUP_CHAT_WORDS = {
    readOnly: word('Observers can read this chat but not post in it'),
    closed: word('This group was closed by its members: its chat stays to read and takes no new messages.'),
};

/**
 * A listing's or its deal's status on a conversation row's pill, as the phone's (utils/listing-status-words.ts): word()
 * keys written in capitals, shown through t(); a status this build doesn't know is shown as the node wrote it.
 */
const POST_STATUS_WORDS: Readonly<Record<string, WordKey>> = {
    active: word('ACTIVE', 'listing status'),
    pending: word('HELD IN TRUST'),
    completed: word('COMPLETED', 'deal status'),
    cancelled: word('CANCELLED', 'deal status'),
    requested: word('REQUESTED', 'deal status'),
    rejected: word('REJECTED', 'deal status'),
    paused: word('PAUSED', 'listing status'),
};

function postStatusWords(status: string): string {
    return Object.prototype.hasOwnProperty.call(POST_STATUS_WORDS, status) ? t(POST_STATUS_WORDS[status]) : status.toUpperCase();
}

/** The one time under a bubble: core's time of day in the member's language ("9:05", as the phone's), empty for an unreadable stamp. */
function messageTime(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : formatDate(d, 'time');
}

/** When a conversation row began, from core's date tables ("14 Oct 2026"), empty for an unreadable stamp. */
function conversationDate(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : formatDate(d, 'day-month-year');
}

/**
 * A trade line's amount for tn(): a number, written the language's way; anything else the node sent, exactly as given
 * (`{ n }` in the values wins over the count).
 */
function tradeAmount(amount: unknown): { n: number; values?: { n: string } } {
    return typeof amount === 'number' ? { n: amount } : { n: Number(amount), values: { n: String(amount) } };
}

interface Props {
    identity: BeanPoolIdentity;
    openConversationId?: string | null;
    onConversationOpened?: () => void;
    /** `txId`: the deal a listing opens at (the chat's deal strip, as the phone's opens the listing for a deal). */
    onNavigate?: (tab: string, contextId?: string, txId?: string) => void;
    /** A person's profile: a request's sender, from their card or the chat's header in request mode. */
    onOpenProfile?: (pubkey: string) => void;
    /** Called when an open conversation's unread lines have been marked read on the server. */
    onConversationRead?: (conversationId: string) => void;
}

// ⚡ Bolt: O(1) Map lookup helper for transaction seller resolution in system messages
function formatSystemMessage(msg: any, myPubkey: string, userTransactions: any[] | Map<string, MarketplaceTransaction>) {
    let metaObj: any = null;
    try {
        if (msg.metadata) metaObj = JSON.parse(msg.metadata);
    } catch {}

    const amount = metaObj?.amount ?? '';
    const sum = tradeAmount(amount);

    const getSellerPublicKey = (postId?: string) => {
        if (!postId) return undefined;
        if (userTransactions instanceof Map) {
            return userTransactions.get(postId)?.sellerPublicKey;
        }
        return (userTransactions as any[]).find(t => t.postId === postId)?.sellerPublicKey;
    };

    if (msg.systemType === 'ESCROW_FUNDED') {
        return amount ? tn(sum.n, '{n} Beans held in trust.', '{n} Beans held in trust.', sum.values) : t('Beans held in trust.');
    }

    if (msg.systemType === 'ESCROW_RELEASED') {
        // Find transaction to see who is the seller (provider)
        const sellerPubkey = metaObj?.sellerPubkey || getSellerPublicKey(metaObj?.postId);
        
        const isSeller = sellerPubkey === myPubkey;
        if (isSeller) {
            return amount ? tn(sum.n, 'Payment of {n} Beans released to you.', 'Payment of {n} Beans released to you.', sum.values) : t('Payment of Beans released to you.');
        } else {
            return amount ? tn(sum.n, 'Payment of {n} Beans released to the provider.', 'Payment of {n} Beans released to the provider.', sum.values) : t('Payment of Beans released to the provider.');
        }
    }

    if (msg.systemType === 'ESCROW_CANCELLED') {
        return t('Trust hold cancelled and funds refunded.');
    }

    // Fallback: clean up Ʀ or R in the ciphertext
    let txt = msg.ciphertext || '';
    if (txt.includes('Ʀ')) {
        txt = txt.replace(/Ʀ(\d+)/g, '$1 Beans').replace(/Ʀ/g, 'Beans');
    }
    if (txt.includes('Payment of R')) {
        txt = txt.replace(/Payment of R(\d+) released to the provider\./g, (_: string, amt: string) => {
            const sellerPubkey = metaObj?.sellerPubkey || getSellerPublicKey(metaObj?.postId);
            const isSeller = sellerPubkey === myPubkey;
            return isSeller
                ? tn(Number(amt), 'Payment of {n} Beans released to you.', 'Payment of {n} Beans released to you.', { n: amt })
                : tn(Number(amt), 'Payment of {n} Beans released to the provider.', 'Payment of {n} Beans released to the provider.', { n: amt });
        });
        txt = txt.replace(/R(\d+) has been placed in escrow\./g, (_: string, amt: string) => tn(Number(amt), '{n} Beans held in trust.', '{n} Beans held in trust.', { n: amt }));
    }
    return txt;
}

/**
 * Lazily fetch + decrypt an encrypted image attachment, then render it. The photo opens only as part of its message:
 * bound to the author and id the node shows the message under, and in the format its words opened in
 * (`bodyFormat`, from the thread check), so no other line's photo, and no old-format picture, can stand in for it.
 * Words that didn't open (`bodyFormat` null) leave the photo locked too.
 */
function ChatImageBubble({ messageId, conversationId, authorPubkey, metadata, bodyFormat, peerPubHex, myPrivHex, onOpen }:
    { messageId: string; conversationId: string; authorPubkey: string; metadata?: string | null; bodyFormat: 2 | 3 | null; peerPubHex: string; myPrivHex: string; onOpen?: (uri: string) => void }) {
    const [uri, setUri] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let active = true;
        (async () => {
            try {
                if (!bodyFormat) throw new Error('not verified');
                const att = await getMessageAttachmentApi(messageId);
                const dataUri = openDmLine({ ciphertext: att.data, nonce: att.nonce }, { myEdPrivHex: myPrivHex, peerEdPubHex: peerPubHex },
                    { conversationId, senderPubHex: authorPubkey, messageId, part: 'attachment', metadata }, [bodyFormat]).text;
                if (active) setUri(dataUri);
            } catch { if (active) setFailed(true); }
        })();
        return () => { active = false; };
    }, [messageId, conversationId, authorPubkey, metadata, bodyFormat, peerPubHex, myPrivHex]);
    return <ChatPhotoShown uri={uri} failed={failed} onOpen={onOpen} />;
}

/**
 * A locked group chat's photo (DESIGN-group-chat-photos-fable.md §2.3), opened once per line, signer and epoch by `open`
 * (lib/group-chat-lines.ts getDecryptedGroupAttachment): only after its words opened, under the key and signer that opened
 * them, so no other line's, chat's or sender's picture can stand in for it. Drawn as a DM's photo is.
 */
function GroupChatImageBubble({ photoKey, open, onOpen }: { photoKey: string; open: () => Promise<string | null>; onOpen?: (uri: string) => void }) {
    const [uri, setUri] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const openRef = useRef(open);
    openRef.current = open;
    useEffect(() => {
        let active = true;
        setUri(null);
        setFailed(false);
        openRef.current()
            .then((u) => { if (active) { if (u) setUri(u); else setFailed(true); } })
            .catch(() => { if (active) setFailed(true); });
        return () => { active = false; };
    }, [photoKey]);
    return <ChatPhotoShown uri={uri} failed={failed} onOpen={onOpen} />;
}

/** A chat photo in its bubble: the picture once opened, "Loading image…" until then, or "🔒 Image unavailable". */
function ChatPhotoShown({ uri, failed, onOpen }: { uri: string | null; failed: boolean; onOpen?: (uri: string) => void }) {
    if (failed) return <span style={{ fontStyle: 'italic', opacity: 0.7 }}>{t('🔒 Image unavailable')}</span>;
    if (!uri) return <span style={{ opacity: 0.6 }}>{t('Loading image…')}</span>;
    return (
        <button
            type="button"
            aria-label={t('View photo full screen')}
            onClick={(e) => {
                e.currentTarget.focus();
                onOpen?.(uri);
            }}
            className="p-0 m-0 border-0 bg-transparent text-left cursor-pointer rounded-xl block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            style={{ maxWidth: '220px', lineHeight: 0 }}
        >
            <img src={uri} alt={t('Photo message')} style={{ maxWidth: '220px', borderRadius: '12px', display: 'block' }} />
        </button>
    );
}

export function MessagesPage({ identity, openConversationId, onConversationOpened, onNavigate, onOpenProfile, onConversationRead }: Props) {
    const [conversations, setConversations] = useState<Conversation[]>([]);
    // The message requests waiting for this member (lib/dm-requests.ts), as the node lists them apart from their chats;
    // null where the community has requests off (its list has no `requests`).
    const [requests, setRequests] = useState<{ count: number; conversations: DmRequestEntry[] } | null>(null);
    // Their cards' lines as read, kept here so a chat opened from a card and Back reads none of them again.
    const requestPreviews = useRequestPreviews();
    // A listing the viewer has a conversation about is not applied from the live feed: this list shows its title
    // and status, and only the refresh re-reads them, so the change rings the doorbell (lib/live-posts).
    // Set in the commit, not in a later effect, so a push landing in between is tested against this list.
    const conversationsRef = useRef<Conversation[]>([]);
    useLayoutEffect(() => { conversationsRef.current = conversations; }, [conversations]);
    useEffect(() => registerLivePostTie(conversationTie(() => conversationsRef.current)), []);
    const [userTransactions, setUserTransactions] = useState<MarketplaceTransaction[]>([]);
    const [activeTab, setActiveTab] = useState<ConversationTab>('all');
    // Requests turned off while the member is on them: the pill goes, so the list goes back to All, never to no chip.
    useEffect(() => { if (!requests && activeTab === 'requests') setActiveTab('all'); }, [requests, activeTab]);
    // Groups' "New group": the form Commons uses, opened here (the phone's Talk → Groups).
    const [showCreateGroup, setShowCreateGroup] = useState(false);
    // An enterprise holds Beans and its form asks for a goal in Beans: no bridge to Start something on a community with
    // Beans off (the phone's CreateGroupModal, and Commons' own Create form). Unknown counts as on, as everywhere.
    const beansOn = useCommunityInfo()?.features?.beans !== false;
    const [activeConv, setActiveConv] = useState<Conversation | null>(null);
    const [messages, setMessages] = useState<ApiMessage[]>([]);
    // The DM whose lines have arrived: the pinned Rate your partner waits for them, so it never flashes over its own line.
    const [loadedDmId, setLoadedDmId] = useState<string | null>(null);
    const [groupChat, setGroupChat] = useState<GroupChatView | null>(null);
    // In-thread search (design §10): over the loaded thread only, in this browser.
    const [chatSearch, setChatSearch] = useState<string | null>(null);
    // Full-screen photo viewer (parity gap 4): the photo tapped in the thread.
    const [viewerUri, setViewerUri] = useState<string | null>(null);
    useEffect(() => { setViewerUri(null); }, [activeConv?.id]);
    const activeConvRef = useRef<Conversation | null>(null);
    useLayoutEffect(() => { activeConvRef.current = activeConv; }, [activeConv]);
    // Whether the open DM still waits on the other person reading the member's newest line. No doorbell rings for a read
    // (POST /api/messages/mark-read broadcasts nothing), so while a "✓" can still turn "✓✓" the backstop below reads every
    // 30 s, as it did before slice L0, socket or not (review of #2558).
    const awaitingPeerReadRef = useRef(false);
    useLayoutEffect(() => {
        const me = identity?.publicKey;
        if (!me || activeConv?.type !== 'dm') { awaitingPeerReadRef.current = false; return; }
        const ownNewest = messages.reduce((at, m) => m.authorPubkey === me ? Math.max(at, new Date(m.timestamp).getTime()) : at, -Infinity);
        const peerRead = activeConv.peerLastReadAt ? new Date(activeConv.peerLastReadAt).getTime() : -Infinity;
        awaitingPeerReadRef.current = ownNewest > peerRead;
    }, [messages, activeConv?.type, activeConv?.peerLastReadAt, identity?.publicKey]);
    const markingReadRef = useRef<Set<string>>(new Set());
    const markReadIfNeeded = async (convId: string, initialUnread?: number) => {
        if (!identity?.publicKey) return;
        const row = conversationsRef.current.find(c => c.id === convId);
        const unread = Math.max(
            initialUnread ?? 0,
            row?.unreadCount ?? 0,
            (activeConvRef.current?.id === convId ? activeConvRef.current.unreadCount : 0) ?? 0,
        );
        if (unread <= 0) return;
        if (markingReadRef.current.has(convId)) return;
        markingReadRef.current.add(convId);
        try {
            await markConversationReadApi(identity.publicKey, convId);
            setConversations(prev => prev.map(c => c.id === convId ? { ...c, unreadCount: 0 } : c));
            setActiveConv(prev => (prev && prev.id === convId ? { ...prev, unreadCount: 0 } : prev));
            onConversationRead?.(convId);
            notifyConversationRead(convId);
        } catch {
            // offline: the next poll tries again
        } finally {
            markingReadRef.current.delete(convId);
        }
    };
    // Keys handed to members who lack them, once per group per page (GroupKeyring.serveMissing).
    const servedMissingRef = useRef<Set<string>>(new Set());
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [showNewDm, setShowNewDm] = useState(false);
    // Who this page can name: the member directory, or on a community where people are asked for, not read whole
    // (lib/members-on-demand, the worldwide one), the cards asked for by key, as the page needs them (below).
    const [members, setMembers] = useState<Array<Pick<Member, 'publicKey' | 'callsign' | 'avatarUrl'> & { joinedAt?: string }>>([]);
    const membersOnDemand = useMembersOnDemand();
    const membersOnDemandRef = useRef<boolean | null>(null);
    membersOnDemandRef.current = membersOnDemand;
    // The keys asked for on this visit (the node's answer, or a request still out): never asked twice. A failed request
    // takes its keys out again, so the next change asks for them.
    const askedKeysRef = useRef<Set<string>>(new Set());
    const [pickerQuery, setPickerQuery] = useState('');
    const pickerSearch = useMemberSearch(pickerQuery, membersOnDemand === true && showNewDm);
    // The New DM picker's friends with members on demand (design §2.3, review of #1861 N5): the member's own friends
    // list, which carries each friend's name and face, so a friend is offered without being in any card held here.
    // null while it hasn't answered; 'failed' when it couldn't be read.
    const [pickerFriends, setPickerFriends] = useState<FriendEntry[] | null | 'failed'>(null);
    useEffect(() => {
        if (!showNewDm || membersOnDemand !== true) return;
        let cancelled = false;
        setPickerFriends(null);
        // Asked inside the promise, so a read that throws before it starts is "couldn't read" too.
        Promise.resolve()
            .then(() => getFriends(identity.publicKey))
            .then(list => { if (!cancelled) setPickerFriends(Array.isArray(list) ? list : []); })
            .catch(() => { if (!cancelled) setPickerFriends('failed'); });
        return () => { cancelled = true; };
    }, [showNewDm, membersOnDemand, identity.publicKey]);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const pollRef = useRef<number | null>(null);
    const [replyToMessage, setReplyToMessage] = useState<ApiMessage | null>(null);
    const [editingMessage, setEditingMessage] = useState<ApiMessage | null>(null);
    const [activeEmojiPickerId, setActiveEmojiPickerId] = useState<string | null>(null);
    const [activeEditNoticeId, setActiveEditNoticeId] = useState<string | null>(null);
    // Set by the expired Edit button, read once by the notice: focus moves to it on that press only, never on a later render
    const focusEditNoticeRef = useRef(false);
    const [reportTarget, setReportTarget] = useState<{ pubkey: string; name: string } | null>(null);
    // One line of a locked group chat being reported with its key (group chat photos S6): its report card is open while set.
    const [reportingLine, setReportingLine] = useState<ApiMessage | null>(null);
    const [chatMute, setChatMute] = useState<YourChatMute | null>(null);
    const [chatMenuOpen, setChatMenuOpen] = useState(false);
    const [muteDialogOpen, setMuteDialogOpen] = useState(false);
    const [confirmDeleteMsg, setConfirmDeleteMsg] = useState<ApiMessage | null>(null);
    const [confirmRemoveMsg, setConfirmRemoveMsg] = useState<ApiMessage | null>(null);
    const [cancellingRequest, setCancellingRequest] = useState(false);
    const [blocklistVersion, setBlocklistVersion] = useState(0);
    const draftRef = useRef<HTMLTextAreaElement>(null);
    const activeConvIdRef = useRef<string | null>(null);
    const messageRequestIdRef = useRef<number>(0);
    // A picture that arrived by paste or drop, waiting for Send or Cancel. 📎 has no
    // preview: picking a file from a dialog is already a deliberate act. It keeps the id a
    // group's photo line goes under, so a Send again after a lost answer is stored once.
    const [pendingImage, setPendingImage] = useState<{ file: File; previewUrl: string | null; clientId: string } | null>(null);
    // Why the last paste or drop went nowhere — shown inline above the composer.
    const [imageNotice, setImageNotice] = useState<string | null>(null);
    // The node's own words when it refused a message or a new conversation: a new account's limit (429
    // probation_limit), a moderation pause (403 moderation_muted) or an account's pause, which opens no new
    // conversation (403 paused). Shown in place, the draft kept.
    const [chatRefusal, setChatRefusal] = useState<string | null>(null);
    /** A failed send or opening: the node's refusal in place, anything else as before. */
    function showChatError(err: any, fallback: string) {
        const refusal = nodeRefusal(err);
        const waiting = requestPendingRefusal(err);
        if (refusal) setChatRefusal(refusal.message);
        else if (waiting) {
            // The opener's request still waits (lib/dm-requests.ts): the node's words, and the chat read again, so the
            // composer shows it waiting.
            setChatRefusal(waiting);
            const id = activeConvIdRef.current;
            if (id) void loadMessages(id);
        }
        else alert(err?.message || fallback);
    }

    async function handleSetMute(duration: '8h' | '1w' | 'always' | 'off') {
        if (!activeConv) return;
        const targetId = activeConv.id;
        const convId = activeConv.type === 'group_thread' ? groupIdKey(activeConv.id) : activeConv.id;
        setChatMenuOpen(false);
        setMuteDialogOpen(false);
        try {
            const res = await muteChatApi(convId, duration);
            if (res?.success) {
                if (activeConvIdRef.current !== targetId) return;
                const next = res.mute ?? null;
                setChatMute(next);
                setConversations(prev => prev.map(c => c.id === targetId ? { ...c, mute: next } : c));
                setActiveConv(prev => prev && prev.id === targetId ? { ...prev, mute: next } : prev);
            }
        } catch (e: any) {
            alert(e?.message || t('Could not reach the node.'));
        }
    }

    async function handleConfirmDelete() {
        if (!confirmDeleteMsg) return;
        const msgToDelete = confirmDeleteMsg;
        setConfirmDeleteMsg(null);
        try {
            await deleteMessageApi(msgToDelete.id);
            if (activeConv) await loadMessages(activeConv.id);
        } catch (e: any) {
            alert(e?.message || t('Could not reach the node.'));
        }
    }

    async function handleConfirmRemove() {
        if (!confirmRemoveMsg || !activeConv) return;
        const msgToRemove = confirmRemoveMsg;
        setConfirmRemoveMsg(null);
        try {
            await removeGroupChatMessage(groupIdKey(activeConv.id), msgToRemove.id);
            if (activeConv) await loadMessages(activeConv.id);
        } catch (e: any) {
            alert(e?.message || t('Could not reach the node.'));
        }
    }
    const [dragActive, setDragActive] = useState(false);
    // `dragleave` fires for every child the pointer crosses, so count enters and
    // leaves instead of trusting a single leave to mean the drag has gone.
    const dragDepthRef = useRef(0);

    // ⚡ Bolt: O(1) Map lookups for member details and completed transactions in conversation list and chat views
    const membersByPublicKey = useMemo(() => new Map(members.map(m => [m.publicKey, m])), [members]);
    const membersByPublicKeyRef = useRef(membersByPublicKey);
    membersByPublicKeyRef.current = membersByPublicKey;
    // The open DM in the order it is shown and judged: by the node's timestamps, as the phone shows it, never by the
    // node's row order alone (after a standby takes over, its delta copy has written rows in last-changed order).
    const isDmThread = !!activeConv && !isNodeReadableChat(activeConv);
    const isGroupChat = activeConv?.type === 'group_thread';
    // This group's chat as opened here, once its answer has come (never the last conversation's).
    const openGroup = isGroupChat && groupChat?.id === activeConv?.id ? groupChat : null;
    const groupLocked = !!openGroup && (openGroup.nodeSaysLocked || openGroup.seenLocked);
    // Why this group chat takes no photo, once its answer is in: it isn't locked here (a node from before locked chats, or
    // an answer that didn't come; DESIGN-group-chat-photos-fable.md §2.6), and a group's photo is only ever sent sealed.
    const groupPhotoRefusal = openGroup && !groupLocked
        ? groupChatNotice({ nodeSaysLocked: false, seenLocked: false, chatError: openGroup.answer ? null : openGroup.error })
        : null;
    const shownMessages = useMemo(() => {
        if (isDmThread) return dmThreadInShownOrder(messages);
        // A group chat draws nothing until its own answer is in: never another chat's lines under its name.
        if (isGroupChat && !openGroup) return [];
        return messages;
    }, [messages, isDmThread, isGroupChat, openGroup]);
    // The open chat's message request mode (lib/dm-requests.ts): read from the node's `request` and, for the opener, the
    // loaded lines of this chat only (never the last chat's, still in `messages` until this one's arrive): until they do,
    // the opener's is not known, rather than taken for one with no line in it yet.
    const requestMode = requestModeOf(activeConv, identity.publicKey, activeConv && loadedDmId === activeConv.id ? shownMessages : null);
    // Each line of a locked group chat as drawn (lib/group-chat-lines.ts groupLineShown): a sealed line under the name of
    // the key that signed it, a node line in the app's words, anything else nobody's. Null for every other chat.
    const groupShown = useMemo(() => {
        if (!openGroup || !groupLocked) return null;
        const m = new Map<string, GroupLineShown>();
        for (const msg of shownMessages) {
            const v = groupLineShown({ ...msg, type: msg.type ?? 'text' } as never, { locked: true, thread: openGroup.thread, me: identity.publicKey });
            if (v) m.set(msg.id, v);
        }
        return m;
    }, [shownMessages, openGroup, groupLocked, identity.publicKey]);
    // What the search box finds: the loaded thread's lines by their shown words (design §10).
    const searchedMessages = useMemo(() => {
        const q = chatSearch?.trim();
        if (!q) return shownMessages;
        const texts = shownMessages
            .filter((m) => !(groupShown?.get(m.id)?.hidden))
            .map((m) => ({ m, text: groupShown?.get(m.id)?.text ?? (groupLocked ? '' : decryptMessage(m)) }));
        return searchShownLines(texts, q).map((x) => x.m);
    }, [shownMessages, chatSearch, groupShown, groupLocked]);
    // Two or more removed lines in a row, of one kind, drawn as one line (Marty, 15 Oct): display only, every id kept.
    // Not while searching: hits in a row there need not be in a row in the chat, and each hit is drawn as itself.
    const removedRuns = useMemo(
        () => groupRemovedRuns(chatSearch?.trim() ? [] : shownMessages, groupShown),
        [shownMessages, chatSearch, groupShown],
    );
    // Every line of the open DM judged in that order (e2e-crypto checkDmThread): an encrypted line opened bound to the
    // author and id the node shows it under, and one that doesn't open never shown as anyone's words; a row in a member's
    // name that isn't an encrypted line never either; one the node moved or reordered, and every old-format line, marked;
    // the admin page's message shown as the community admins'. Only the node's own notices are left out.
    const lineViews = useMemo(() => {
        if (!activeConv || !isDmThread) return null;
        const ctx = dmKeyContext(activeConv, identity);
        return checkDmThread(shownMessages.map(m => ({
            id: m.id, authorPubkey: m.authorPubkey, ciphertext: m.ciphertext, nonce: m.nonce, type: m.type, metadata: m.metadata, timestamp: m.timestamp,
        })), ctx ? { myEdPrivHex: ctx.myEdPrivHex, peerEdPubHex: ctx.peerEdPubHex } : null, ctx?.conversationId ?? activeConv.id);
    }, [shownMessages, activeConv, identity, isDmThread]);
    const userTransactionsByPostId = useMemo(() => {
        const map = new Map<string, MarketplaceTransaction>();
        for (const tx of userTransactions) {
            if (tx.postId && !map.has(tx.postId)) {
                map.set(tx.postId, tx);
            }
        }
        return map;
    }, [userTransactions]);
    const activePeerPubkey = useMemo(() => {
        if (!activeConv) return '';
        return activeConv.participants?.find(p => p !== identity.publicKey) || '';
    }, [activeConv, identity.publicKey]);
    // ⚡ Bolt: memoized pending transaction for active conversation to avoid O(T) array scan on render
    const activePendingTransaction = useMemo(() => {
        if (!activeConv) return null;
        return userTransactions.find(t =>
            t.status === 'pending' &&
            ((t.buyerPublicKey === identity.publicKey && (t.sellerPublicKey === activePeerPubkey || !activePeerPubkey)) ||
             (t.postId && t.postId === activeConv.postId && t.buyerPublicKey === identity.publicKey))
        ) || null;
    }, [activeConv, userTransactions, identity.publicKey, activePeerPubkey]);
    // The deals with the open DM's other person that ask something of the chat, newest first: Beans held (either side's), a
    // finished trade I haven't rated, or a request on my listing waiting for my answer (the list's Action Required counts it,
    // so the chat it opens must show it: DESIGN-deals-fable §2.2, every surface opens the deal). The phone's pinned strip
    // (chat/[id].tsx `activeDeals`) is the same rule less the request. The deal the buyer's Trust Hold banner above already
    // carries is left out of it, as the phone leaves out the one its action bar shows.
    const stripDeals = useMemo(() => {
        if (activeConv?.type !== 'dm' || !activePeerPubkey) return [];
        const me = identity.publicKey;
        return userTransactions
            .filter(tx => ((tx.buyerPublicKey === me && tx.sellerPublicKey === activePeerPubkey) || (tx.sellerPublicKey === me && tx.buyerPublicKey === activePeerPubkey))
                && (tx.status === 'pending' || (tx.status === 'completed' && !iRated(tx, me)) || (tx.status === 'requested' && dealStep(tx, me).state === 'to-answer'))
                && tx.id !== activePendingTransaction?.id)
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    }, [activeConv?.type, userTransactions, identity.publicKey, activePeerPubkey, activePendingTransaction?.id]);
    // The deals whose next step is mine (core's one rule, dealsNeedingMe), by the other person: the list's Action Required
    // chip, counted per deal as the phone's Talk counts its own (a thread is per person and may hold several).
    const dealsNeedingMeByPeer = useMemo(() => {
        const me = identity.publicKey;
        const byPeer = new Map<string, MarketplaceTransaction[]>();
        for (const tx of dealsNeedingMe(userTransactions, me)) {
            const peer = tx.buyerPublicKey === me ? tx.sellerPublicKey : tx.buyerPublicKey;
            const rows = byPeer.get(peer);
            if (rows) rows.push(tx); else byPeer.set(peer, [tx]);
        }
        return byPeer;
    }, [userTransactions, identity.publicKey]);

    // Auto-grow the composer with the draft (up to ~4 lines), collapsing back
    // to one line when the draft is cleared on send.
    useEffect(() => {
        const el = draftRef.current;
        if (!el) return;
        el.style.height = 'auto';
        // +2 accounts for the 1px top/bottom border under border-box sizing,
        // otherwise the content sits 2px short and shows a scrollbar.
        el.style.height = Math.min(el.scrollHeight + 2, 100) + 'px';
    }, [draft]);

    useEffect(() => {
        const handleGlobalClick = () => {
            setActiveEmojiPickerId(null);
            setActiveEditNoticeId(null);
        };
        window.addEventListener('click', handleGlobalClick);
        return () => window.removeEventListener('click', handleGlobalClick);
    }, []);

    useEffect(() => {
        loadConversations();
        const unsubscribe = onSyncActivity(() => loadConversations());
        const unsubBlocklist = onBlocklistUpdated(() => {
            setBlocklistVersion(v => v + 1);
            loadConversations();
            loadMembers();
        });
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
            unsubscribe();
            unsubBlocklist();
        };
    }, []);

    useEffect(() => {
        activeConvIdRef.current = activeConv?.id ?? null;
        setChatMute(null);
        setChatMenuOpen(false);
        setMuteDialogOpen(false);
        setConfirmDeleteMsg(null);
        setConfirmRemoveMsg(null);
        if (activeConv) {
            messageRequestIdRef.current++;
            setGroupChat(null);
            setChatSearch(null);
            setReplyToMessage(null);
            setEditingMessage(null);
            setActiveEmojiPickerId(null);
            setDraft('');
            // The initial load happens in startPolling() below; calling it here as well fired two
            // concurrent loads (and two decrypt passes) for the same conversation on open, which
            // could land out of order and overwrite the newer result with the older one.
            // Mark conversation as read when opened (only if it showed unread) and refresh App's count
            void markReadIfNeeded(activeConv.id, activeConv.unreadCount);
            // Check for prefilled draft from sessionStorage (e.g. Archetype synergy chat nudge)
            const prefill = consumeChatPrefill(activeConv.id, activeConv.participants);
            if (prefill) {
                setDraft(prefill);
                setTimeout(() => draftRef.current?.focus(), 100);
            }
            // An event chat loads itself through the event's own chat route (EventChat), which re-checks
            // the RSVP and carries the private note. The DM loader must not also pull it: that payload has
            // no note, and merging its conversation row back in would overwrite the type this screen
            // branches on (docs/events-on-the-map.md §2.2).
            if (activeConv.type === 'event_thread') {
                return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
            }

            // Poll for new messages as a backstop, paused when tab is hidden: every 120 s while the member's socket is
            // alive (its doorbell below brings each new line, edit and reaction at once), every 30 s while it is not
            // (@beanpool/core messageBackstopDue, slice L0). The doorbell never brings the other person's read, so while
            // the member's newest line waits for it (awaitingPeerReadRef), every 30 s too. Only a read that worked counts:
            // after one that failed with the socket up (a 503 while the node is full, a dropped request) the next tick
            // reads, as before slice L0 (review of #2558). When the last read that worked started, and the last that failed:
            let lastReadAt = 0;
            let lastFailedAt = 0;
            const read = () => {
                const startedAt = Date.now();
                return loadMessages(activeConv.id).then((worked) => {
                    if (worked) lastReadAt = Math.max(lastReadAt, startedAt);
                    else lastFailedAt = Math.max(lastFailedAt, startedAt);
                });
            };
            const startPolling = () => {
                if (!pollRef.current) {
                    read();
                    pollRef.current = window.setInterval(() => {
                        const failedSince = lastFailedAt >= lastReadAt; // started together: read again
                        if (!messageBackstopDue(lastReadAt, Date.now(), socketIsAlive() && !awaitingPeerReadRef.current && !failedSince)) return;
                        read();
                    }, withJitter(MESSAGE_BACKSTOP_TICK_MS));
                }
            };

            const stopPolling = () => {
                if (pollRef.current) {
                    clearInterval(pollRef.current);
                    pollRef.current = null;
                }
            };

            const handleVisibilityChange = () => {
                if (document.hidden) {
                    stopPolling();
                } else {
                    startPolling();
                }
            };

            if (!document.hidden) {
                startPolling();
            }

            document.addEventListener('visibilitychange', handleVisibilityChange);

            // Fast path: the WebSocket doorbell refreshes this conversation
            // immediately, instead of waiting for the next poll tick.
            const unsubscribe = onSyncActivity(() => {
                if (document.hidden) return;
                return read();
            });
            return () => {
                stopPolling();
                document.removeEventListener('visibilitychange', handleVisibilityChange);
                unsubscribe();
            };
        }
        return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
    }, [activeConv?.id]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    const [actionLoading, setActionLoading] = useState(false);

    async function handleReleaseCredits(txId: string, amount: number) {
        if (!confirm(tn(amount, 'Release {n} Beans to the provider? This action is final.', 'Release {n} Beans to the provider? This action is final.'))) return;
        setActionLoading(true);
        try {
            await completeMarketplaceTransaction(txId, identity.publicKey);
            alert(t('Payment released successfully!'));
            await loadConversations();
            if (activeConv) await loadMessages(activeConv.id);
        } catch (e: any) {
            alert(e?.message || t('Failed to release credits.'));
        } finally {
            setActionLoading(false);
        }
    }

    async function handleCancelCredits(txId: string) {
        if (!confirm(t('Cancel this hold and refund the credits?'))) return;
        setActionLoading(true);
        try {
            await cancelMarketplaceTransaction(txId, identity.publicKey);
            alert(t('Hold cancelled and credits refunded.'));
            await loadConversations();
            if (activeConv) await loadMessages(activeConv.id);
        } catch (e: any) {
            alert(e?.message || t('Failed to cancel hold.'));
        } finally {
            setActionLoading(false);
        }
    }

    async function loadConversations() {
        try {
            const result = await getConversations(identity.publicKey);
            // A DM stays a DM, and a group seen locked here stays a group, whatever type the node gives it now
            // (lib/dm-guard.ts, lib/group-hold.ts).
            const locked = await lockedGroupsOrNull(identity.publicKey);
            const held = (result.conversations || []).map((c: Conversation) => holdConversation(c, locked));
            const blocked = new Set(getBlockedUsers());
            const filtered = held.filter((c: Conversation) => {
                if (c.type === 'dm') {
                    const peer = (c.participants || []).find(p => p !== identity.publicKey);
                    if (peer && blocked.has(peer)) return false;
                }
                return true;
            }).map((c: Conversation) => {
                if (activeConvIdRef.current && c.id === activeConvIdRef.current) {
                    if ((c.unreadCount ?? 0) > 0) {
                        void markReadIfNeeded(c.id, c.unreadCount);
                    }
                    return { ...c, unreadCount: 0 };
                }
                return c;
            });
            setConversations(filtered);
            // The requests waiting for this member, apart (lib/dm-requests.ts): direct chats only, never from someone
            // blocked here. Where requests are off the list has none, and there is no Requests pill.
            const heldRequests = (result.requests?.conversations || [])
                .map((c: DmRequestEntry) => holdConversation(c, locked))
                .filter((c: DmRequestEntry) => c.type === 'dm' && !(c.participants || []).some(p => p !== identity.publicKey && blocked.has(p)));
            const leftOut = (result.requests?.conversations || []).length - heldRequests.length;
            setRequests(result.requests ? { count: Math.max(heldRequests.length, (result.requests.count || 0) - leftOut), conversations: heldRequests } : null);
            // The member's own deals only where deals are not in preview (lib/features readsOwn).
            if (await readsOwn('escrow')) setUserTransactions(await getMyMarketplaceTransactions(identity.publicKey));
            setActiveConv(prev => {
                if (!prev) return null;
                const fresh = held.find(c => c.id === prev.id) ?? heldRequests.find(c => c.id === prev.id);
                return fresh ? { ...prev, ...fresh, request: requestAfterRead(prev.request, fresh) } : prev;
            });
        } catch { /* offline */ }
    }

    // Auto-open conversation when navigating from Market "Message" button or profile chat
    useEffect(() => {
        if (!openConversationId) return;
        loadConversations().then(() => {
            // Find the conversation and open it
            getConversations(identity.publicKey).then(async result => {
                const locked = await lockedGroupsOrNull(identity.publicKey);
                const held = (result.conversations || []).map((c: Conversation) => holdConversation(c, locked));
                let conv = held.find((c: Conversation) => c.id === openConversationId);
                // A request waiting for this member, opened by its id (its push): in request mode, never asked for again,
                // which would accept it (lib/dm-requests.ts).
                if (!conv) conv = (result.requests?.conversations || []).map((c: Conversation) => holdConversation(c, locked))
                    .find((c: Conversation) => c.id === openConversationId && c.type === 'dm');
                if (!conv) {
                    conv = held.find((c: Conversation) => c.type === 'dm' && c.participants.includes(openConversationId));
                }
                // Only a public key can start a DM. An event chat is opened by the event's id, which is a
                // UUID, and a host who has not tapped Going has no conversation row yet — opening one must
                // never create a DM with a stranger named by an id (docs/events-on-the-map.md §3).
                if (!conv && /^[0-9a-f]{64}$/i.test(openConversationId)) {
                    try {
                        const created = await createConversationApi('dm', [identity.publicKey, openConversationId], identity.publicKey);
                        // Asked for a DM: it is one, whatever type the answer names.
                        conv = created.conversation ? (startedDm(created.conversation, await lockedGroupsOrNull(identity.publicKey)) ?? undefined) : undefined;
                        if (created.conversation && !conv) setChatRefusal(GROUP_HOLD_STARTED_DM_TEXT);
                        await loadConversations();
                    } catch (e) {
                        // Offline stays quiet; the node refusing to open it (a new account's limit, an account's pause)
                        // says why. Every way in by someone's key lands here: a profile's Message and Collaborate, People.
                        const refusal = nodeRefusal(e);
                        if (refusal) setChatRefusal(refusal.message);
                    }
                } else if (!conv && locked?.has(groupIdKey(openConversationId))) {
                    // A group held locked here, left out of the node's list: its own chat, never an event's, which
                    // sends readable (review of #1816, finding 2; the phone's chatRouteView asks "held" first).
                    console.warn(`[group hold] locked group ${openConversationId.slice(0, 8)} is missing from the node's list: opened as a group chat`);
                    conv = {
                        id: openConversationId,
                        type: 'group_thread',
                        name: null,
                        participants: [],
                        createdBy: '',
                        createdAt: new Date().toISOString(),
                    } as Conversation;
                } else if (!conv && locked === null) {
                    // The lock store can't say whether this id is a held group: nothing opens on a guess.
                    setChatRefusal(GROUP_HOLD_UNREAD_OPEN_TEXT);
                } else if (!conv) {
                    try {
                        const chat = await getEventChat(openConversationId);
                        conv = {
                            id: openConversationId,
                            type: 'event_thread',
                            name: chat.title,
                            participants: [],
                            createdBy: '',
                            createdAt: new Date().toISOString(),
                        };
                    } catch { /* not an event chat this member may open */ }
                }
                if (conv) {
                    setActiveConv(conv);
                    const prefill = consumeChatPrefill(conv.id, conv.participants);
                    if (prefill) {
                        setDraft(prefill);
                        setTimeout(() => draftRef.current?.focus(), 100);
                    }
                }
                onConversationOpened?.();
            });
        });
    }, [openConversationId]);

    /** The group chat keyring for one group, as this browser's member (lib/group-chat-keys.ts). */
    function groupRing(groupId: string) {
        return groupKeyring(groupKeysNet, identity, groupIdKey(groupId), indexedDbGroupLockStore);
    }

    /**
     * A group's chat, read through its own route (GET /api/groups/:id/chat: its lock, the lines from this member's first
     * epoch on), its sealed lines opened and named here, and the roster the screen shows handed to the keyring (only
     * members in it are ever wrapped to). Keys missing for other members are handed over once per page.
     */
    async function loadGroupChat(convId: string, requestId: number): Promise<'dm' | boolean> {
        let answer: GroupChatAnswer | null = null;
        let error: unknown = null;
        try {
            answer = await getGroupChat(convId);
        } catch (e) {
            error = e;
        }
        // Whether the read worked, for the backstop (loadMessages), whatever this screen then makes of it.
        const read = answer !== null;
        if (activeConvIdRef.current !== convId || requestId !== messageRequestIdRef.current) return read;
        // The DM guard's line check runs over these lines before the group route takes them: a DM this browser knows, or
        // one whose lines are encrypted, stays a DM whatever the node calls it; a group held locked here still wins
        // (review of #1816, finding 1; lib/group-hold.ts).
        const kept = holdConversation({ id: convId, type: 'group_thread' }, await lockedGroupsOrNull(identity.publicKey), answer?.messages);
        if (activeConvIdRef.current !== convId || requestId !== messageRequestIdRef.current) return read;
        if (kept.type === 'dm') {
            setGroupChat(null);
            setActiveConv(prev => (prev && prev.id === convId ? { ...prev, type: 'dm' } : prev));
            return 'dm';
        }
        const ring = groupRing(convId);
        const nodeSaysLocked = chatIsLocked(answer);
        if (nodeSaysLocked) await ring.noteLocked();
        const seenLocked = await ring.seenLocked();
        let roster: DisplayRosterRow[] = [];
        if (answer) {
            try {
                const active = (await getGroupMembers(convId)).filter((r) => r.status === 'active');
                roster = active.map((r) => ({ memberPubkey: r.memberPubkey, callsign: r.callsign ?? null, formerKeys: (r as { formerKeys?: DisplayRosterRow['formerKeys'] }).formerKeys ?? null }));
                ring.noteShownRoster(active.map((r) => r.memberPubkey));
            } catch { /* names fall back to the node's; nothing is wrapped until the list reads */ }
        }
        let thread: OpenedGroupThread | null = null;
        if (answer && (nodeSaysLocked || seenLocked)) {
            // Held here though the node now says unlocked: the keys route still says which epochs are this member's.
            let enc = answer.encryption ?? null;
            if (!enc) {
                const st = await ring.sync().catch(() => null);
                enc = st ? { current: st.current, stale: st.stale, fromEpoch: st.fromEpoch } : null;
            }
            if (enc) {
                thread = await openGroupThread(ring, { messages: answer.messages as never, encryption: enc }, roster,
                    (pk) => membersByPublicKeyRef.current.get(pk)?.callsign ?? null).catch(() => null);
            }
        }
        if (activeConvIdRef.current !== convId || requestId !== messageRequestIdRef.current) return read;
        const seen = new Set<string>();
        setMessages((answer?.messages ?? []).filter((m) => {
            if (!m.id || seen.has(m.id)) return false;
            seen.add(m.id);
            return true;
        }));
        setGroupChat({ id: convId, answer, error, nodeSaysLocked, seenLocked, thread, roster });
        setChatMute(prev => chatMuteFromAnswer(answer, prev));
        if (answer) {
            await markReadIfNeeded(convId, answer.conversation?.unreadCount);
        }
        if (nodeSaysLocked && !servedMissingRef.current.has(convId)) {
            servedMissingRef.current.add(convId);
            ring.serveMissing().catch(() => 0);
        }
        return read;
    }

    /**
     * Read the open conversation's lines. Failures are swallowed (offline), so it says whether the read worked: the
     * backstop counts only one that did, and reads again on the next tick after one that didn't (review of #2558).
     */
    async function loadMessages(convId: string): Promise<boolean> {
        const requestId = ++messageRequestIdRef.current;
        if (activeConvRef.current?.id === convId && activeConvRef.current.type === 'group_thread') {
            // A DM the node calls a group's chat goes on by the DM path below.
            const read = await loadGroupChat(convId, requestId);
            if (read !== 'dm') return read;
        }
        try {
            const result = await getConversationMessages(convId);
            if (activeConvIdRef.current !== convId || requestId !== messageRequestIdRef.current) return true;
            // Deduplicate by message ID so the same message can never render twice
            const seen = new Set<string>();
            const uniqueMessages = (result.messages || []).filter((m: ApiMessage) => {
                if (!m.id || seen.has(m.id)) return false;
                seen.add(m.id);
                return true;
            });
            setMessages(uniqueMessages);
            setLoadedDmId(convId);
            if (identity?.publicKey) {
                await markReadIfNeeded(convId, result.conversation?.unreadCount);
            }
            // A DM stays a DM: one seen as one here, or whose lines are encrypted (lib/dm-guard.ts).
            const locked = result.conversation ? await lockedGroupsOrNull(identity.publicKey) : null;
            if (activeConvIdRef.current !== convId || requestId !== messageRequestIdRef.current) return true;
            const heldConv = result.conversation ? holdConversation(result.conversation, locked, uniqueMessages) : null;
            if (heldConv) {
                const isDm = heldConv.type === 'dm';
                const peerCursor = isDm ? (heldConv as any).readCursors?.find(
                    (rc: any) => rc.publicKey !== identity.publicKey
                ) : null;
                setActiveConv(prev => {
                    if (!prev || prev.id !== convId) return prev;
                    return {
                        ...prev,
                        ...heldConv,
                        unreadCount: 0,
                        request: requestAfterRead(prev.request, heldConv),
                        peerLastReadAt: isDm
                            ? (peerCursor?.lastReadAt ?? (heldConv as any).peerLastReadAt ?? prev.peerLastReadAt)
                            : null,
                    };
                });
            }
            return true;
        } catch { /* offline */ return false; }
    }

    function handleStartReply(msg: ApiMessage) {
        if (editingMessage) {
            setEditingMessage(null);
            setDraft('');
        }
        setReplyToMessage(msg);
        setActiveEmojiPickerId(null);
        draftRef.current?.focus();
    }

    function handleStartEdit(msg: ApiMessage) {
        setEditingMessage(msg);
        setReplyToMessage(null);
        setActiveEmojiPickerId(null);
        const plainText = decryptMessage(msg);
        setDraft(plainText);
        draftRef.current?.focus();
    }

    function handleCancelEdit() {
        setEditingMessage(null);
        setDraft('');
    }

    async function handleToggleReaction(messageId: string, emoji: string) {
        if (!activeConv) return;
        // Optimistic update
        setMessages(prev => prev.map(m => {
            if (m.id !== messageId) return m;
            let meta: any = {};
            if (m.metadata) {
                try {
                    const parsed = JSON.parse(m.metadata);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        meta = parsed;
                    }
                } catch { meta = {}; }
            }
            if (!Array.isArray(meta.reactions)) meta.reactions = [];
            const idx = meta.reactions.findIndex((r: any) => r && r.author === identity.publicKey);
            if (idx > -1) {
                if (meta.reactions[idx].emoji === emoji) {
                    meta.reactions.splice(idx, 1);
                } else {
                    meta.reactions[idx].emoji = emoji;
                }
            } else {
                meta.reactions.push({ emoji, author: identity.publicKey });
            }
            return { ...m, metadata: JSON.stringify(meta) };
        }));
        setActiveEmojiPickerId(null);

        try {
            const res = await toggleMessageReactionApi(messageId, identity.publicKey, emoji);
            if (res && res.metadata) {
                setMessages(prev => prev.map(m => m.id === messageId ? { ...m, metadata: res.metadata } : m));
            }
        } catch (err: any) {
            console.error('Failed to react:', err);
            const waiting = requestPendingRefusal(err);
            if (waiting) setChatRefusal(waiting);
            else alert(err.message || t('Failed to react to message'));
            await loadMessages(activeConv.id);
        }
    }

    // The directory once the node has said it has no members on demand (or couldn't say): as before the switch.
    useEffect(() => { if (membersOnDemand === false) loadMembers(); }, [membersOnDemand]);

    // With members on demand: the names this page shows that no row carries, by key, 100 a request and 3 at most a
    // change (lib/members-on-demand): the open chat's authors and people, then any one-to-one chat with no name on its
    // row. A key with no card still shows its first characters, as before.
    useEffect(() => {
        if (membersOnDemand !== true) return;
        const blocked = new Set(getBlockedUsers());
        const held = new Set(members.map(m => m.publicKey));
        const wanted: string[] = [];
        for (const m of messages) if (m.authorPubkey) wanted.push(m.authorPubkey);
        if (activeConv) wanted.push(...(activeConv.participants || []));
        for (const c of conversations) if (c.type === 'dm' && !c.peerCallsign) wanted.push(...(c.participants || []));
        // A request's sender, for when they joined on its card (the requests on screen only).
        if (activeTab === 'requests') for (const c of requests?.conversations.slice(0, REQUEST_CARDS_SHOWN) ?? []) wanted.push(...(c.participants || []));
        const missing = wanted.filter(k => k !== identity.publicKey && !blocked.has(k) && !held.has(k) && !askedKeysRef.current.has(k));
        for (const batch of memberKeysBatches(missing)) {
            batch.forEach(k => askedKeysRef.current.add(k));
            membersByKeys(batch)
                .then(cards => {
                    if (cards.length === 0) return;
                    setMembers(prev => {
                        const have = new Set(prev.map(m => m.publicKey));
                        return [...prev, ...cards.filter(c => !have.has(c.publicKey)).map(c => ({ publicKey: c.publicKey, callsign: c.callsign, avatarUrl: c.avatarUrl ?? null, joinedAt: c.joinedAt }))];
                    });
                })
                .catch(() => { batch.forEach(k => askedKeysRef.current.delete(k)); });
        }
    }, [membersOnDemand, conversations, messages, activeConv, members, identity.publicKey, activeTab, requests]);

    async function loadMembers() {
        // With members on demand nothing is read whole: a block takes the person's card out of what is held.
        if (membersOnDemandRef.current === true) {
            const blocked = new Set(getBlockedUsers());
            setMembers(prev => prev.filter(m => !blocked.has(m.publicKey)));
            return;
        }
        if (membersOnDemandRef.current !== false) return;
        try {
            // A 403 members_on_demand turns the switch on (getMembersWhole): the names then come by key.
            const result = await getMembersWhole();
            const blocked = new Set(getBlockedUsers());
            setMembers(result.filter((m: Member) => m.publicKey !== identity.publicKey && !blocked.has(m.publicKey)));
        } catch { /* offline */ }
    }

    async function handleStartDm(memberPubkey: string) {
        try {
            const result = await createConversationApi(
                'dm',
                [identity.publicKey, memberPubkey],
                identity.publicKey,
            );
            // Asked for a DM: it is one, whatever type the answer names.
            const started = startedDm(result.conversation, await lockedGroupsOrNull(identity.publicKey));
            if (!started) { setChatRefusal(GROUP_HOLD_STARTED_DM_TEXT); return; }
            setActiveConv(started);
            setShowNewDm(false);
            setChatRefusal(null);
            await loadConversations();
        } catch (err: any) {
            showChatError(err, t('Failed to start conversation'));
        }
    }

    // E2E key context for a 2-party DM, or null for groups/unknown peer (NAT-1).
    function dmCtxFor(conv: Conversation | null): DMKeyContext | null {
        return dmKeyContext(conv, identity);
    }

    /** The other person's name for the "couldn't be locked" line; never a slice of their key. */
    function peerNameFor(conv: Conversation | null): string | null {
        if (!conv) return null;
        if (conv.peerCallsign) return conv.peerCallsign;
        const peer = (conv.participants || []).find(p => p && p !== identity.publicKey);
        return (peer && membersByPublicKey.get(peer)?.callsign) || null;
    }

    /** The conversation as the node has it now: the other person may have arrived since it was opened. */
    async function freshConversation(conv: Conversation): Promise<Conversation> {
        try {
            const result = await getConversationMessages(conv.id);
            if (!result.conversation) return conv;
            const held = holdConversation(result.conversation, await lockedGroupsOrNull(identity.publicKey), result.messages);
            setActiveConv(prev => (prev && prev.id === conv.id ? { ...prev, ...held, request: requestAfterRead(prev.request, held) } : prev));
            return { ...conv, ...held };
        } catch {
            return conv;
        }
    }

    /**
     * A line as it goes to the node: readable in a group chat, locked in a DM. A DM that can't be locked gets one more
     * try with the node's copy of the conversation, then throws DmNotLockedError — never a readable fallback.
     */
    async function payloadFor(text: string, conv: Conversation, line: DmLineSeal): Promise<{ ciphertext: string; nonce: string }> {
        try {
            return payloadForChat(text, conv, identity, line);
        } catch (e) {
            if (!isDmNotLocked(e)) throw e;
            return payloadForChat(text, await freshConversation(conv), identity, line);
        }
    }

    /**
     * A line (or an edit) in a group's chat (lib/group-chat-lines.ts): the chat answer is read again first. Sealed when it
     * is locked or this browser has seen it locked (the sticky lock); readable only to a node from before locked chats,
     * from a browser that never saw this group locked; otherwise refused with a sentence, the words kept in the composer.
     */
    async function sendInGroup(conv: Conversation, wasEditing: ApiMessage | null): Promise<void> {
        const check = await groupSendCheck(conv);
        if (!check) return;
        const { plan, chat, chatErr } = check;
        const text = draft.trim();
        if (plan === 'readable') {
            // A node from before locked chats, and a browser that never saw this group locked (§14.3): as it always was.
            const { ciphertext, nonce } = encodePlaintext(text);
            if (wasEditing) await editMessageApi(wasEditing.id, identity.publicKey, ciphertext, nonce);
            else await sendMessageApi(conv.id, identity.publicKey, ciphertext, nonce, undefined, undefined,
                replyToMessage ? JSON.stringify({ replyToId: replyToMessage.id }) : undefined, newDmMessageId());
        } else {
            try {
                if (wasEditing) {
                    await editSealedGroupLine(groupKeysNet, identity, indexedDbGroupLockStore, { groupId: groupIdKey(conv.id), messageId: wasEditing.id, metadata: wasEditing.metadata, text });
                } else {
                    const newest = [...shownMessages].reverse().find((m) => m.type !== 'system' && m.authorPubkey !== 'SYSTEM');
                    await sendSealedGroupLine(groupKeysNet, identity, indexedDbGroupLockStore, {
                        groupId: groupIdKey(conv.id), text, clientId: newDmMessageId(), replyToId: replyToMessage?.id ?? null, after: newest?.id ?? null,
                        mentionCandidates: (openGroup?.roster ?? []).map((r) => ({ pubkey: r.memberPubkey, callsign: r.callsign })),
                    });
                }
            } catch (e) {
                if (saidGroupRefusal(e, chat, chatErr)) return;
                throw e;
            }
        }
        setDraft('');
        setReplyToMessage(null);
        setEditingMessage(null);
        setChatRefusal(null);
        await loadMessages(conv.id);
    }

    /**
     * Before a line, an edit or a photo goes to a group's chat: its chat answer read again, and what may go
     * (lib/group-chat-lines.ts groupChatSendPlan). Null when nothing may, its sentence then said in place: a DM the node
     * calls a group's chat (the page reopens it as the DM), the plan's refusal, or a chat that takes no new lines.
     */
    async function groupSendCheck(conv: Conversation): Promise<{ plan: 'seal' | 'readable'; chat: GroupChatAnswer | null; chatErr: unknown } | null> {
        const ring = groupRing(conv.id);
        let chat: GroupChatAnswer | null = null;
        let chatErr: unknown = null;
        try {
            chat = await getGroupChat(conv.id, 1);
        } catch (e) {
            chatErr = e;
        }
        // A DM the node calls a group's chat (finding 1): nothing leaves by the group route; the page reopens it as the DM.
        if (holdConversation({ id: conv.id, type: 'group_thread' }, await lockedGroupsOrNull(identity.publicKey), chat?.messages).type === 'dm') {
            setChatRefusal(GROUP_CHAT_IS_DM_TEXT);
            await loadMessages(conv.id);
            return null;
        }
        const plan = await groupChatSendPlan(ring, chat, chatErr);
        if (plan.kind === 'refuse') { setChatRefusal(plan.sentence); return null; }
        if (chat && chat.canPost === false) { setChatRefusal(chat.readOnly ? t(GROUP_CHAT_WORDS.closed) : t(GROUP_CHAT_WORDS.readOnly)); return null; }
        return { plan: plan.kind, chat, chatErr };
    }

    /** A sealed send's refusal said in place (true); false for anything else, which is the caller's to show. */
    function saidGroupRefusal(e: unknown, chat: GroupChatAnswer | null, chatErr: unknown): boolean {
        if (e instanceof GroupChatKeyError) { setChatRefusal(e.message); return true; }
        // The node refuses this member the keys (a removal, or a node that won't say): nothing readable went.
        if (e instanceof GroupKeysRequestError && (e.status === 403 || e.status === 404)) { setChatRefusal(heldGroupRefusal(chat, chatErr)); return true; }
        if (e instanceof GroupKeysRequestError) { setChatRefusal(e.message); return true; }
        return false;
    }

    /**
     * A photo in a group's chat (DESIGN-group-chat-photos-fable.md §2.2): fitted within 800 px on its longest side
     * (lib/photo-resize.ts, the rule for every photo, a DM's too), then its caption
     * sealed as part 'body' and the photo as part 'attachment' under the line's one key and the keyring's epoch, both sealed
     * again on a 409 (lib/group-chat-lines.ts sendSealedGroupLine). Only ever sealed: a node from before locked chats gets
     * none (§2.6). Every refusal is said above the box, the picture kept; not optimistic, as a DM photo isn't.
     */
    async function sendPhotoInGroup(conv: Conversation, file: File, caption: string, clientId: string): Promise<boolean> {
        setSending(true);
        try {
            const check = await groupSendCheck(conv);
            if (!check) return false;
            if (check.plan === 'readable') { setChatRefusal(GROUP_CHAT_OLD_NODE_NOTICE); return false; }
            const dataUri = await resizePhotoFile(file).catch(() => { throw new Error(t('Could not load image')); });
            const newest = [...shownMessages].reverse().find((m) => m.type !== 'system' && m.authorPubkey !== 'SYSTEM');
            try {
                await sendSealedGroupLine(groupKeysNet, identity, indexedDbGroupLockStore, {
                    groupId: groupIdKey(conv.id), text: caption, photo: dataUri, clientId, replyToId: replyToMessage?.id ?? null, after: newest?.id ?? null,
                    mentionCandidates: (openGroup?.roster ?? []).map((r) => ({ pubkey: r.memberPubkey, callsign: r.callsign })),
                });
            } catch (e) {
                if (saidGroupRefusal(e, check.chat, check.chatErr)) return false;
                throw e;
            }
            setReplyToMessage(null);
            setChatRefusal(null);
            await loadMessages(conv.id);
            return true;
        } catch (err: any) {
            setChatRefusal(nodeRefusal(err)?.message ?? (err?.message || t('Failed to send image')));
            return false;
        } finally {
            setSending(false);
        }
    }

    /**
     * The node took a new line of this member's in `convId`: where it said their next line was their request's, that was
     * it, so the chat waits now, before the read after it lands or if it never does (lib/dm-requests.ts requestAfterOwnLine).
     */
    function ownLineTaken(convId: string) {
        setActiveConv(prev => {
            if (!prev || prev.id !== convId) return prev;
            const request = requestAfterOwnLine(prev.request, identity.publicKey);
            return request === prev.request ? prev : { ...prev, request };
        });
    }

    async function handleSend() {
        if (!draft.trim() || !activeConv) return;
        setSending(true);

        const wasEditing = editingMessage;
        try {
            if (activeConv.type === 'group_thread') {
                await sendInGroup(activeConv, wasEditing);
                return;
            }
            // A group seen locked here, whatever the node now calls it, is sealed as a group's line or refused; with the
            // lock store unreadable, only a DM this browser knows goes on (lib/group-hold.ts).
            const route = await sendRouteOf(identity.publicKey, activeConv.id);
            if (route === 'group') {
                await sendInGroup({ ...activeConv, type: 'group_thread' }, wasEditing);
                return;
            }
            if (route === 'refuse') {
                setChatRefusal(GROUP_HOLD_UNREAD_TEXT);
                return;
            }
            // Nothing is sent, and the draft stays, when a DM can't be locked (caught below). A DM line is sealed to its
            // message id (a new one, sent with it; an edit's own) and to the line it was written after: the newest the
            // node has given us, or for an edit the one its line was written after.
            const line: DmLineSeal = wasEditing
                ? { messageId: wasEditing.id, after: lineViews?.get(wasEditing.id)?.after ?? null, replyToId: dmReplyToOf(wasEditing.metadata) ?? null }
                : { messageId: newDmMessageId(), after: dmAfterReference(shownMessages), replyToId: replyToMessage?.id ?? null };
            const { ciphertext, nonce } = await payloadFor(draft.trim(), activeConv, line);

            if (wasEditing) {
                const prevMessages = messages;
                const nowIso = new Date().toISOString();
                setMessages(prev => prev.map(m => m.id === wasEditing.id ? {
                    ...m,
                    ciphertext,
                    nonce,
                    editedAt: nowIso,
                } : m));

                try {
                    await editMessageApi(wasEditing.id, identity.publicKey, ciphertext, nonce);
                    setEditingMessage(null);
                    setDraft('');
                    setChatRefusal(null);
                    await loadMessages(activeConv.id);
                } catch (err: any) {
                    setMessages(prevMessages);
                    throw err;
                }
            } else {
                let metadata: string | undefined = undefined;
                if (replyToMessage) {
                    metadata = JSON.stringify({ replyToId: replyToMessage.id });
                }
                // 1. Store locally (Server will handle Libp2p federation relay automatically)
                await sendMessageApi(activeConv.id, identity.publicKey, ciphertext, nonce, undefined, undefined, metadata, line.messageId);
                ownLineTaken(activeConv.id);

                setDraft('');
                setReplyToMessage(null);
                setChatRefusal(null);
                await loadMessages(activeConv.id);
            }
        } catch (err: any) {
            if (isDmNotLocked(err)) setChatRefusal(dmNotLockedLine(peerNameFor(activeConv)));
            else showChatError(err, wasEditing ? t('Failed to edit message') : t('Failed to send message'));
        } finally {
            setSending(false);
        }
    }

    /**
     * The one path a photo leaves by — 📎, paste and drop all end up here. In a DM
     * nothing inside it changed: resize, encrypt the blob as the attachment,
     * encrypt the caption as the message body. A group's goes sealed as the group's
     * (sendPhotoInGroup). Returns whether it got away, so a caller holding a draft
     * knows whether to clear it. `clientId`: the id a waiting group photo keeps.
     */
    async function handleSendImage(file: File, caption = '', clientId?: string): Promise<boolean> {
        if (!activeConv) return false;
        // A group's chat, and a group seen locked here whatever the node now calls it (lib/group-hold.ts): sealed as the
        // group's photo under its keyring's epoch or not sent, never DM-sealed to whoever the node lists. An unreadable lock
        // store sends none to a conversation this browser doesn't know as a DM.
        const route = activeConv.type === 'group_thread' ? 'group' : await sendRouteOf(identity.publicKey, activeConv.id);
        if (route === 'group') return sendPhotoInGroup({ ...activeConv, type: 'group_thread' }, file, caption, clientId ?? newDmMessageId());
        if (route === 'refuse') { setChatRefusal(GROUP_HOLD_UNREAD_TEXT); return false; }
        // An event's or an enterprise's chat: the node reads it by design, so it takes no photo (design §4).
        if (activeConv.type !== 'dm') { setChatRefusal(NODE_READABLE_NO_PHOTOS_TEXT); return false; }
        setSending(true);
        try {
            const dataUri = await resizePhotoFile(file).catch(() => { throw new Error(t('Could not load image')); });
            // Locked or not sent, the picture and its caption alike; one more try with the node's copy of the chat.
            const conv = dmCtxFor(activeConv) ? activeConv : await freshConversation(activeConv);
            // Both sealed to the message's own id, each as its own part, so neither can stand in for the other.
            const messageId = newDmMessageId();
            const replyToId = replyToMessage?.id ?? null;   // sealed into both parts, as the metadata below names it
            const encImg = lockForDm(dataUri, conv, identity, { messageId, part: 'attachment', replyToId });       // big blob -> lazy attachment
            const encCap = lockForDm(caption, conv, identity, { messageId, part: 'body', after: dmAfterReference(shownMessages), replyToId });   // caption (often empty) -> message body
            let metadata: string | undefined = undefined;
            if (replyToMessage) {
                metadata = JSON.stringify({ replyToId: replyToMessage.id });
            }
            await sendMessageApi(activeConv.id, identity.publicKey, encCap.ciphertext, encCap.nonce, 'image',
                { data: encImg.ciphertext, nonce: encImg.nonce, mime: 'image/jpeg' }, metadata, messageId);
            ownLineTaken(activeConv.id);
            setReplyToMessage(null);
            setChatRefusal(null);
            await loadMessages(activeConv.id);
            return true;
        } catch (err: any) {
            if (isDmNotLocked(err)) setChatRefusal(dmNotLockedLine(peerNameFor(activeConv)));
            else showChatError(err, t('Failed to send image'));
            return false;
        } finally {
            setSending(false);
        }
    }

    /** Let go of the preview and the object URL behind its thumbnail. */
    function clearPendingImage() {
        setPendingImage(prev => {
            if (prev?.previewUrl) {
                try { URL.revokeObjectURL(prev.previewUrl); } catch {}
            }
            return null;
        });
    }

    /**
     * Where a pasted or dropped picture lands: checked, then held in the preview
     * until the person says Send. Anything we refuse says so in one line above
     * the composer rather than in an alert() the person has to dismiss.
     */
    function offerImage(file: File) {
        if (!activeConv) return;

        // A group's photo is sealed in this browser (sendPhotoInGroup), so a group chat
        // not locked here takes none: its own notice says why (groupPhotoRefusal).
        // Nor does a chat the node reads by design, an enterprise's (design §4). Say
        // so where the person is looking and send nothing. (A group chat whose answer
        // isn't in yet, and a DM whose other person isn't known yet, still open the
        // preview: Send checks again, and says why nothing went, keeping the picture.)
        if (activeConv.type === 'group_thread') {
            if (groupPhotoRefusal) {
                clearPendingImage();
                setImageNotice(groupPhotoRefusal);
                return;
            }
        } else if (activeConv.type !== 'dm') {
            clearPendingImage();
            setImageNotice(NODE_READABLE_NO_PHOTOS_TEXT);
            return;
        }

        // Nor while a message request waits for this member, or for the other to accept, or while the opener's chat is still
        // being read (lib/dm-requests.ts): a paste goes nowhere then, as a drop does, and the 📎 is hidden.
        if (!requestTakesPhoto(requestMode)) {
            clearPendingImage();
            return;
        }

        const refusal = chatImageRefusal(file);
        if (refusal) {
            clearPendingImage();
            setImageNotice(refusal);
            return;
        }

        setImageNotice(null);
        let previewUrl: string | null = null;
        try { previewUrl = URL.createObjectURL(file); } catch { previewUrl = null; }
        setPendingImage(prev => {
            if (prev?.previewUrl) {
                try { URL.revokeObjectURL(prev.previewUrl); } catch {}
            }
            return { file, previewUrl, clientId: newDmMessageId() };
        });
    }

    /** Send the previewed picture, carrying whatever is in the composer as its caption. */
    async function sendPendingImage() {
        if (!pendingImage || sending) return;
        const sent = await handleSendImage(pendingImage.file, draft.trim(), pendingImage.clientId);
        if (!sent) return;
        clearPendingImage();
        setDraft('');   // a normal send clears the draft; so does this one
    }

    /** A paste only becomes ours when it is carrying a picture. */
    function handleComposerPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
        const file = imageFromTransfer(e.clipboardData);
        if (!file) return;   // text and everything else: exactly as before
        e.preventDefault();
        offerImage(file);
    }

    // While the preview is open it owns Enter and Escape, wherever focus sits —
    // the person may still be typing the caption, or be on one of the buttons.
    useEffect(() => {
        if (!pendingImage) return;
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape') {
                e.preventDefault();
                clearPendingImage();
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                // Enter on a focused button already means "press it".
                if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return;
                e.preventDefault();
                void sendPendingImage();
            }
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    });

    // Leaving a conversation drops anything it was holding.
    useEffect(() => {
        clearPendingImage();
        setImageNotice(null);
        setChatRefusal(null);
        setDragActive(false);
        dragDepthRef.current = 0;
        setActiveEditNoticeId(null);
    }, [activeConv?.id]);

    // A picture waiting for Send goes once the chat takes none: the opener's line found in it when its read lands, or a
    // request waiting for this member. Its Send would only be refused under the sentence saying they can't yet.
    useEffect(() => {
        if (!requestTakesPhoto(requestMode)) clearPendingImage();
    }, [requestMode]);

    // So does one pasted into a group chat before its answer came, once that answer says the chat isn't locked here: the
    // chat's notice says why in its place.
    useEffect(() => {
        if (!pendingImage || !groupPhotoRefusal) return;
        clearPendingImage();
        setImageNotice(groupPhotoRefusal);
    }, [groupPhotoRefusal, pendingImage]);

    // What decryptMessage() puts in place of a body it could not read. A photo's
    // body is its caption, so these must never be shown as one.
    const UNREADABLE_BODIES = [t('[Encrypted — update your app to read]'), t('[Unable to decrypt this message]'), chatLineWords(DM_LINE_NOT_VERIFIED_TEXT)];
    /** A DM line's words: a member's as written; the app's own stand-ins (no words, a tombstone) in the member's language. */
    const dmShownText = (view: Parameters<typeof dmLineShownText>[0]): string =>
        (view?.text != null && view.text !== DM_LINE_DELETED_TEXT ? view.text : chatLineWords(dmLineShownText(view)));

    function decryptMessage(msg: ApiMessage): string {
        // A locked group chat's line, as drawn (groupLineShown): never a row's own words unless they opened.
        const g = groupShown?.get(msg.id);
        if (g) return g.text ?? formatSystemMessage(msg, identity.publicKey, userTransactionsByPostId);
        try {
            // A DM's line, as the thread check judged it: never a row's words unless they opened.
            const view = lineViews?.get(msg.id);
            if (view) {
                if (view.mark === 'not-verified' && isEncryptedNonce(msg.nonce) && !dmCtxFor(activeConv)) return t('[Encrypted — update your app to read]');
                return dmShownText(view);
            }
            if (msg.nonce === '00000') return msg.ciphertext;
            if (isEncryptedNonce(msg.nonce)) {
                const ctx = dmCtxFor(activeConv);
                if (!ctx) return t('[Encrypted — update your app to read]');
                // A line outside the loaded thread (a quoted one): opened on its own, bound the same way.
                try {
                    return openDmLine({ ciphertext: msg.ciphertext, nonce: msg.nonce }, ctx,
                        { conversationId: ctx.conversationId, senderPubHex: msg.authorPubkey, messageId: msg.id, part: 'body', metadata: msg.metadata }).text;
                } catch {
                    return chatLineWords(DM_LINE_NOT_VERIFIED_TEXT);
                }
            }
            return decodePlaintext(msg.ciphertext, msg.nonce);
        } catch {
            return t('[Unable to decrypt this message]');
        }
    }

    /**
     * The quote of the message a reply answers, from that message as the thread judged it (core dmQuoteFrom): its words
     * only if they opened, its named author only if the line is theirs, with its mark. In a DM the node can rewrite the
     * row a verified reply answers while keeping its id (as a notice, the admin page's message, or another old-format
     * line): the quote then says what the row is, never "You" or the other person's name over words it can't confirm.
     */
    function quoteOf(parent: ApiMessage | undefined): { author: string; text: string; note: string | null; named: boolean } {
        if (!parent) return { author: t('Someone'), text: t('Message not found'), note: null, named: false };
        // In a locked group chat, the answered line as drawn: under its signer's name, or nobody's.
        const g = groupShown?.get(parent.id);
        if (g) {
            // The name and words of a line that is nobody's, or a tombstone's, are the app's own: in the member's language.
            const author = g.mine ? t('You') : g.nodeLine ? 'BeanPool' : chatAuthorWords(g.name ?? GROUP_LINE_UNVERIFIED_NAME);
            // A photo line quotes as a DM's does: "🔒 Photo" (DESIGN-group-chat-photos-fable.md §2.3).
            const text = g.text === null ? formatSystemMessage(parent, identity.publicKey, userTransactionsByPostId)
                : g.unattributed || g.nodeLine ? chatLineWords(g.text) : parent.type === 'image' ? t('🔒 Photo') : g.text;
            return { author, text, note: null, named: false };
        }
        const view = lineViews?.get(parent.id);
        if (lineViews) {
            const from = dmQuoteFrom({ authorPubkey: parent.authorPubkey, nonce: parent.nonce, type: parent.type, metadata: parent.metadata }, view);
            if (from === 'notice') return { author: chatLineWords(dmQuoteLabel(from)), text: formatSystemMessage(parent, identity.publicKey, userTransactionsByPostId), note: null, named: false };
            if (from !== 'author') return { author: chatLineWords(dmQuoteLabel(from)), text: dmShownText(view), note: null, named: false };
        }
        return {
            author: membersByPublicKey.get(parent.authorPubkey)?.callsign
                || (parent.authorPubkey === identity.publicKey ? t('You') : parent.authorPubkey.substring(0, 8)),
            text: parent.type === 'image' ? t('🔒 Photo') : decryptMessage(parent),
            note: chatLineWords(dmLineMarkText(view?.mark)) ?? null,
            named: true,
        };
    }

    function getConversationTitle(conv: Conversation): string {
        // An event chat is named after its event, which is why the conversation row carries `name`.
        if (conv.type === 'event_thread') return conv.name || t('Event chat');
        if (conv.type === 'group_thread') return conv.name || t('Group');
        // An enterprise's thread is named after the enterprise (engine/enterprise-thread.ts), as the phone's header is: never
        // after whichever member's key comes first, which made its header button read "Ben, enterprise page".
        if ((conv.type as string) === 'enterprise_thread') return conv.name || t('Enterprise chat');
        // Prefer server-provided peerCallsign, fall back to member lookup
        if (conv.peerCallsign) return conv.peerCallsign;
        const otherPubkey = conv.participants.find(p => p !== identity.publicKey) || '';
        const member = membersByPublicKey.get(otherPubkey);
        return member?.callsign || otherPubkey.substring(0, 12) + '…';
    }

    /** A group chat's face, as the phone's rows and header draw it: the group's picture, else its category's emblem. */
    function groupChatPicture(conv: Conversation): string {
        return conv.avatarUrl || bundledGroupEmblem(conv.category);
    }

    /**
     * The key a chat's ready-made face is chosen from when it has no picture: a DM's other person, else the chat's own id
     * (an enterprise thread's id is the enterprise's key). The list row and the chat's header both ask here, so they agree.
     */
    function chatFaceKey(conv: Conversation): string {
        return (conv.type === 'dm' && conv.participants?.find(p => p !== identity.publicKey)) || conv.id;
    }

    /**
     * An avatar circle: the picture, else the ready-made picture chosen from `faceKey` (no bare initial, Pictures S4).
     * A key, never a name: People, MemberAvatar and the phone choose a photoless member's face from their key, and a
     * callsign here gave the same person another face one tap later (#2511 review).
     */
    function renderAvatar(avatarUrl: string | null | undefined, faceKey: string, size = 40, style?: React.CSSProperties) {
        const resolved = resolveAvatarUrl(avatarUrl, faceKey) || '/avatars/avatar_bean_green.webp';
        return (
            <img
                src={resolved}
                alt=""
                style={{
                    width: `${size}px`, height: `${size}px`, borderRadius: '50%',
                    objectFit: 'cover', flexShrink: 0, ...style,
                }}
            />
        );
    }


    // ===================== RENDER =====================

    const cardStyle: React.CSSProperties = {
        background: 'var(--bg-card)',
        border: '1px solid var(--border-primary)',
        borderRadius: '12px',
        padding: '0.75rem 1rem',
        marginBottom: '0.5rem',
        cursor: 'pointer',
        transition: 'border-color 0.2s',
    };

    const inputStyle: React.CSSProperties = {
        flex: 1,
        padding: '0.5rem 1rem',
        borderRadius: '20px',
        border: '1px solid var(--border-input)',
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        fontSize: '0.95rem',
        fontFamily: 'inherit',
        outline: 'none',
        height: '40px',
        boxSizing: 'border-box',
    };

    const chatRefusalNotice = chatRefusal ? (
        <div
            role="alert"
            data-testid="chat-refusal"
            style={{
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px',
                padding: '0.5rem 1rem', background: 'var(--bg-secondary)',
                borderTop: '1px solid var(--border-primary)',
                fontSize: '0.85rem', color: 'var(--text-secondary)',
            }}
        >
            {/* The app's own refusals (lib/group-hold.ts, group-chat-keys.ts, dm-lock.ts) in the member's language; the node's as it wrote them. */}
            <span style={{ minWidth: 0, flex: 1, wordBreak: 'break-word' }}>{chatLineWords(chatRefusal)}</span>
            <button
                type="button"
                onClick={() => setChatRefusal(null)}
                aria-label={t('Dismiss')}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem', padding: '6px', minWidth: '28px', minHeight: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
            >
                ✕
            </button>
        </div>
    ) : null;

    // New DM overlay with members on demand (lib/members-on-demand): the people this member already talks to, named
    // from their chats' rows, then a search the node answers, never a list of everyone. Every control at least 44 px.
    if (showNewDm && membersOnDemand === true) {
        const blocked = new Set(getBlockedUsers());
        const seen = new Set<string>();
        const recents = conversations.filter(c => c.type === 'dm').flatMap(c => {
            const peer = (c.participants || []).find(p => p && p !== identity.publicKey);
            if (!peer || blocked.has(peer) || seen.has(peer)) return [];
            seen.add(peer);
            const held = membersByPublicKey.get(peer);
            return [{ publicKey: peer, callsign: c.peerCallsign || held?.callsign || peer.slice(0, 8), avatarUrl: c.peerAvatar ?? held?.avatarUrl ?? null }];
        });
        // Friends not already offered above, so each person shows once.
        const friendsToPick = pickerFriends === null || pickerFriends === 'failed' ? []
            : pickerFriends.filter(f => f.publicKey && f.publicKey !== identity.publicKey && !blocked.has(f.publicKey) && !seen.has(f.publicKey))
                .map(f => ({ publicKey: f.publicKey, callsign: f.callsign || f.publicKey.slice(0, 8), avatarUrl: f.avatarUrl ?? null }));
        const typed = pickerQuery.trim();
        const found = (pickerSearch.found || []).filter(m => m.publicKey !== identity.publicKey && !blocked.has(m.publicKey));
        const pick = (p: { publicKey: string; callsign: string; avatarUrl?: string | null }) => (
            <button
                type="button"
                key={p.publicKey}
                data-testid="dm-pick"
                onClick={() => handleStartDm(p.publicKey)}
                style={{
                    ...cardStyle, display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%', minHeight: '44px',
                    textAlign: 'left', fontFamily: 'inherit', fontSize: 'inherit', color: 'var(--text-primary)',
                }}
            >
                {renderAvatar(p.avatarUrl, p.publicKey, 36)}
                <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' }}>{p.callsign}</span>
            </button>
        );
        const note: React.CSSProperties = { color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0 0 0.75rem' };
        return (
            <div className="p-4 max-w-xl mx-auto w-full" data-testid="new-message-on-demand">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                    <button
                        type="button"
                        onClick={() => { setShowNewDm(false); setPickerQuery(''); }}
                        style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '1rem', cursor: 'pointer', fontFamily: 'inherit', minHeight: '44px', minWidth: '44px', padding: '0 0.25rem' }}
                    >
                        {t('← Back')}
                    </button>
                    <h2 style={{ fontSize: '1.2rem', margin: 0 }}>
                        {t('New Message')}
                    </h2>
                </div>
                {chatRefusalNotice && <div style={{ marginBottom: '0.75rem' }}>{chatRefusalNotice}</div>}

                <label htmlFor="new-message-search" style={{ display: 'block', fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.4rem' }}>
                    {t('Find someone by name')}
                </label>
                <input
                    id="new-message-search"
                    type="search"
                    value={pickerQuery}
                    onChange={e => setPickerQuery(e.target.value)}
                    placeholder={t('Type a name…')}
                    style={{ ...inputStyle, width: '100%', height: '44px', marginBottom: '0.4rem' }}
                />
                <p style={note} aria-live="polite" data-testid="new-message-search-status">
                    {typed && typed.length < MEMBERS_SEARCH_MIN_CHARS ? tn(MEMBERS_SEARCH_MIN_CHARS, 'Type at least {n} letter of a name.', 'Type at least {n} letters of a name.')
                        : pickerSearch.state === 'searching' ? t('Searching…')
                        : pickerSearch.state === 'failed' ? (pickerSearch.refusal ?? t("Couldn't search just now. Check your connection and try again."))
                        : pickerSearch.found && found.length === 0 ? t('Nobody here has a name starting with that.')
                        : null}
                </p>
                {found.length > 0 && <div data-testid="new-message-found" style={{ marginBottom: '1rem' }}>{found.map(pick)}</div>}

                <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.5rem' }}>{t("People you've talked to")}</h3>
                {recents.length === 0
                    ? <p style={note}>{t('No one yet. Search for someone by name above.')}</p>
                    : <div data-testid="new-message-recents">{recents.map(pick)}</div>}

                {pickerFriends === 'failed' ? (
                    <p style={note} data-testid="new-message-friends-failed">{t("Couldn't load your friends just now. Search for them by name above.")}</p>
                ) : friendsToPick.length > 0 && (
                    <>
                        <h3 style={{ fontSize: '0.95rem', margin: '1rem 0 0.5rem' }}>{t('Friends')}</h3>
                        <div data-testid="new-message-friends">{friendsToPick.map(pick)}</div>
                    </>
                )}
            </div>
        );
    }

    // New DM overlay. (The old "👥 Group" chat was removed on 2026-09-19: a group chat is now the chat every
    // Commons group owns, and the Talk tab's Groups list and "New group" come in the next slice.)
    if (showNewDm) {
        return (
            <div className="p-4 max-w-xl mx-auto w-full">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                    <button
                        onClick={() => setShowNewDm(false)}
                        style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '1rem', cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                        {t('← Back')}
                    </button>
                    <h2 style={{ fontSize: '1.2rem', margin: 0 }}>
                        {t('New Message')}
                    </h2>
                </div>

                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                    {t('Choose someone to message:')}
                </p>
                {chatRefusalNotice && <div style={{ marginBottom: '0.75rem' }}>{chatRefusalNotice}</div>}
                {members.map(m => (
                    <div
                        key={m.publicKey}
                        onClick={() => handleStartDm(m.publicKey)}
                        style={{
                            ...cardStyle,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                        }}
                    >
                        <div style={{
                            width: '36px', height: '36px', borderRadius: '50%',
                            overflow: 'hidden', flexShrink: 0,
                        }}>
                            {renderAvatar(m.avatarUrl, m.publicKey, 36)}
                        </div>
                        <span style={{ fontWeight: 600 }}>{m.callsign}</span>
                    </div>
                ))}

            </div>
        );
    }

    // Pre-compute O(1) message lookup map for message rendering performance in large chat threads.
    const messagesById = new Map(messages.map(m => [m.id, m]));

    // An event chat is its own screen: the pinned note, the host's Remove, the read-only banner after the
    // event ends and the node-readable notice (docs/events-on-the-map.md §3). None of the DM machinery
    // below — E2E decryption, edits, reactions, deal actions — applies to it.
    if (activeConv && activeConv.type === 'event_thread') {
        return (
            <EventChat
                postId={activeConv.id}
                identity={identity}
                onOpenEvent={() => onNavigate?.('marketplace', activeConv.id)}
                onBack={() => {
                    setActiveConv(null);
                    loadConversations();
                }}
            />
        );
    }

    // Chat view
    if (activeConv) {
        const peerPubkey = activeConv.type === 'dm'
            ? (activeConv.participants?.find(p => p !== identity.publicKey) || '')
            : '';
        const isPeerBlocked = peerPubkey ? isUserBlocked(peerPubkey) : false;
        const inRequest = requestMode !== 'none';

        // Dropping onto a blocked conversation would only produce a message the
        // person cannot send, so the chat takes no drops at all while blocked; nor
        // while a request waits for this member to decide, or for the other to accept,
        // or while the opener's chat is still being read (its 📎 is hidden then too).
        const acceptsDrop = !isPeerBlocked && requestTakesPhoto(requestMode);

        return (
            <div
                className="h-full max-w-4xl lg:max-w-6xl xl:max-w-7xl mx-auto w-full flex flex-col"
                style={dragActive ? { outline: '2px dashed var(--accent)', outlineOffset: '-4px' } : undefined}
                onDragEnter={acceptsDrop ? (e) => {
                    if (!dragCarriesFile(e.dataTransfer)) return;
                    e.preventDefault();
                    dragDepthRef.current += 1;
                    setDragActive(true);
                } : undefined}
                onDragOver={acceptsDrop ? (e) => {
                    if (!dragCarriesFile(e.dataTransfer)) return;
                    e.preventDefault();   // without this the browser navigates to the file
                } : undefined}
                onDragLeave={acceptsDrop ? () => {
                    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                    if (dragDepthRef.current === 0) setDragActive(false);
                } : undefined}
                onDrop={acceptsDrop ? (e) => {
                    dragDepthRef.current = 0;
                    setDragActive(false);
                    // A drag with no file in it is text going into the composer —
                    // the browser's own business, so leave it alone.
                    if (!dragCarriesFile(e.dataTransfer)) return;
                    // Any file, though, is only here because onDragOver above
                    // took it, so this drop has to be prevented whatever the file
                    // turns out to be. Left to itself the browser navigates the
                    // tab to the file, taking the chat and the unsent draft.
                    e.preventDefault();
                    const file = imageFromTransfer(e.dataTransfer);
                    if (!file) return;
                    offerImage(file);
                } : undefined}
            >
                {dragActive && (
                    <div
                        data-testid="chat-drop-hint"
                        aria-hidden="true"
                        style={{
                            padding: '0.5rem 1rem', textAlign: 'center', fontWeight: 600,
                            fontSize: '0.9rem', color: 'var(--accent)', background: 'var(--bg-hover)',
                        }}
                    >
                        {t('Drop the picture to send it')}
                    </div>
                )}
                {/* Chat header. Report and Block move under the name when both can't sit beside it (at 320 px with 1.3x text
                    the name was cut to its first letter, and to nothing in a longer language). */}
                <div style={{
                    display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', rowGap: '0.5rem',
                    padding: '0.75rem 1rem', borderBottom: '1px solid var(--border-primary)',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 'min(100%, 10rem)', flex: '1 1 auto' }}>
                        <button
                            onClick={() => {
                                setActiveConv(null);
                                setEditingMessage(null);
                                setReplyToMessage(null);
                                setDraft('');
                                loadConversations();
                            }}
                            aria-label={t('Back to messages')}
                            style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '1rem', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0, minWidth: '44px', minHeight: '44px' }}
                        >
                            ←
                        </button>
                        {(() => {
                            // The phone's header (GroupChatView openOwner): a group's chat opens its group info, an
                            // enterprise's thread its enterprise page (its id is the enterprise's key, as the phone's
                            // treasury-detail). A group chat's id IS the group's id (lib/api.ts Conversation), compared
                            // in lower case (lib/group-hold groupIdKey). A DM header opens the person's public profile
                            // or the enterprise's page (matching the phone's public-profile route).
                            const ownerTab = activeConv.type === 'group_thread' ? 'group'
                                : (activeConv.type as string) === 'enterprise_thread' ? 'enterprise' : null;
                            const ownerId = ownerTab === 'group' ? groupIdKey(activeConv.id) : activeConv.id;
                            const title = getConversationTitle(activeConv);
                            const body = (
                                <>
                                    {activeConv.type === 'group_thread'
                                        ? renderAvatar(groupChatPicture(activeConv), activeConv.id, 32)
                                        : renderAvatar(activeConv.peerAvatar, chatFaceKey(activeConv), 32)}
                                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, textAlign: 'left' }}>
                                        <span style={{ fontWeight: 600, fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {title}
                                        </span>
                                        {activeConv.type === 'group_thread' && (
                                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                {groupHeaderDetail(activeConv.participants.length, isMuted(chatMute))}
                                            </span>
                                        )}
                                    </span>
                                </>
                            );
                            if (activeConv.type === 'dm' && peerPubkey && onOpenProfile) {
                                return (
                                    <button
                                        type="button"
                                        data-testid={requestMode === 'to-me' ? 'request-header-profile' : 'dm-header-profile'}
                                        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 hover:bg-[var(--bg-hover)]"
                                        onClick={() => onOpenProfile(peerPubkey)}
                                        // The visible name first, so speech input matches it (review of #1979, X2).
                                        aria-label={t("{name}, see {name}'s profile", { name: title })}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0, flex: '1 1 auto',
                                            minHeight: '44px', padding: '0 0.25rem', background: 'none', border: 'none',
                                            color: 'inherit', font: 'inherit', cursor: 'pointer', borderRadius: '0.5rem',
                                        }}
                                    >
                                        {body}
                                    </button>
                                );
                            }
                            if (!ownerTab || !onNavigate) return <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>{body}</div>;
                            return (
                                <button
                                    type="button"
                                    data-testid="chat-owner-header"
                                    className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 hover:bg-[var(--bg-hover)]"
                                    onClick={() => onNavigate(ownerTab, ownerId)}
                                    // The visible name first, so speech input matches it (review of #1979, X2).
                                    aria-label={ownerTab === 'group'
                                        ? t('{name}, group info', { name: title })
                                        : t('{name}, enterprise page', { name: title })}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0, flex: '1 1 auto',
                                        minHeight: '44px', padding: '0 0.25rem', background: 'none', border: 'none',
                                        color: 'inherit', font: 'inherit', cursor: 'pointer', borderRadius: '0.5rem',
                                    }}
                                >
                                    {body}
                                </button>
                            );
                        })()}
                    </div>
                    {activeConv.type === 'group_thread' && (
                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>
                            <button
                                type="button"
                                data-testid="group-chat-search-toggle"
                                onClick={() => setChatSearch((q) => (q === null ? '' : null))}
                                aria-label={chatSearch === null ? t('Search this chat') : t('Close search')}
                                aria-expanded={chatSearch !== null}
                                style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '1rem', minWidth: '44px', minHeight: '44px', flexShrink: 0 }}
                            >
                                {chatSearch === null ? '🔍' : '✕'}
                            </button>
                            <button
                                type="button"
                                data-testid="group-chat-menu-toggle"
                                onClick={() => { setMuteDialogOpen(false); setChatMenuOpen(true); }}
                                aria-label={t('Chat menu')}
                                style={{ background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '1.25rem', minWidth: '44px', minHeight: '44px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                            >
                                ⋮
                            </button>
                        </div>
                    )}

                    {activeConv.type === 'dm' && peerPubkey && (
                        <div className="flex items-center gap-1.5 ml-auto">
                            <button
                                type="button"
                                onClick={() => setReportTarget({ pubkey: peerPubkey, name: getConversationTitle(activeConv) })}
                                title={t('Report user')}
                                aria-label={t('Report user')}
                                className="px-2.5 py-1 rounded-lg border border-nature-300 dark:border-nature-700 bg-white/80 dark:bg-nature-800 text-nature-600 dark:text-nature-300 font-bold text-xs cursor-pointer hover:bg-nature-100 dark:hover:bg-nature-700 dark:hover:text-nature-200 transition-colors flex items-center gap-1"
                            >
                                <span>🚩</span> <span className="hidden sm:inline">{t('Report', undefined, 'button: report a member')}</span>
                            </button>
                            <button
                                type="button"
                                onClick={async () => {
                                    // The community keeps the list (lib/blocklist): a change it didn't take is said, never shown as done.
                                    try {
                                        if (isPeerBlocked) {
                                            if (window.confirm(t('Unblock {name}?', { name: getConversationTitle(activeConv) }))) {
                                                await unblockUser(peerPubkey);
                                                await loadConversations();
                                            }
                                        } else {
                                            const name = getConversationTitle(activeConv);
                                            if (window.confirm(t('Block {name}?\n\nThis will hide their messages and posts, and notify moderation.', { name }))) {
                                                await blockUser(peerPubkey, identity.publicKey, 'Abusive user reported via Chat');
                                                await loadConversations();
                                            }
                                        }
                                    } catch (e: any) {
                                        alert(e?.message || t('That did not go through. Please try again.'));
                                    }
                                }}
                                aria-label={isPeerBlocked ? t('Unblock user') : t('Block user')}
                                className={`px-2.5 py-1 rounded-lg border font-bold text-xs cursor-pointer transition-colors flex items-center gap-1 ${
                                    isPeerBlocked
                                        ? 'border-nature-300 dark:border-nature-700 bg-nature-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 hover:bg-nature-200 dark:hover:bg-nature-700 dark:hover:text-nature-200'
                                        : 'border-bp-chip-danger-ink bg-bp-chip-danger-tint text-bp-chip-danger-ink hover:brightness-95'
                                }`}
                            >
                                <span>{isPeerBlocked ? '🛡️' : '🚫'}</span>
                                <span>{isPeerBlocked ? t('Unblock') : t('Block', undefined, 'button: block a member')}</span>
                            </button>
                        </div>
                    )}
                </div>

                {activeConv.type === 'group_thread' && chatSearch !== null && (
                    // Search this chat (design §10): the loaded lines only, as opened in this browser; nothing is asked of the node.
                    <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--border-primary)' }}>
                        <input
                            type="search"
                            data-testid="group-chat-search"
                            value={chatSearch}
                            onChange={(e) => setChatSearch(e.target.value)}
                            placeholder={t('Search this chat')}
                            aria-label={t('Search this chat')}
                            autoFocus
                            style={{ ...inputStyle, width: '100%', minHeight: '44px' }}
                        />
                    </div>
                )}

                {/* The room between the chat's header and its composer (the phone's "column": dmKeyBannerMaxHeight works from the
                    same measure). Nothing in it can make the chat taller than that, so the composer never goes under the bottom
                    nav: the pinned block gives way first, then the thread, which keeps its floor while the room has it. (Its
                    children are not indented one more level, to keep this change reviewable.) */}
                <div data-testid="chat-middle" style={{ flex: '1 1 0px', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {/* The pinned block above the thread: the deal strip, the listing header, the Trust Hold banner and the pinned Rate
                    banner. It takes what the room leaves once the thread's floor is in, and scrolls inside that (the phone's
                    dmKeyBannerMaxHeight idea), so at 320 px and 1.3x text the thread keeps 120 px. Every card stays reachable by
                    scrolling and by Tab. */}
                <div data-testid="chat-pinned" style={{ flex: '0 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
                    {/* The deals with this person, both sides (the phone's pinned strip): Release / Cancel for the payer, "Awaiting
                        release" for the payee, Review once it is done. Each card opens its listing at that deal. */}
                    {activeConv.type === 'dm' && (
                        <ChatDealStrip
                            deals={stripDeals}
                            me={identity.publicKey}
                            peerName={getConversationTitle(activeConv)}
                            showsBeans={beansOn}
                            busy={actionLoading}
                            onOpen={tx => { if (tx.postId) onNavigate?.('marketplace', tx.postId, tx.id); }}
                            onRelease={tx => handleReleaseCredits(tx.id, tx.credits)}
                            onCancel={tx => handleCancelCredits(tx.id)}
                            onReview={tx => onNavigate?.('marketplace-review', tx.id)}
                        />
                    )}

                    {/* Sticky Marketplace Header */}
                    {activeConv.postId && (
                        <div style={{
                            background: 'var(--bp-chip-ok-tint)', padding: '0.75rem 1rem',
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer',
                        }} onClick={() => {}}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                <span style={{ fontSize: '1.2rem' }}>🛍️</span>
                                <div>
                                    <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--bp-chip-ok-ink)' }}>{t('View Attached Listing')}</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--bp-chip-ok-ink)' }}>{t('Marketplace Transaction Thread')}</div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Active Trust Hold / Escrow Banner */}
                    {(() => {
                        const pendingTx = activePendingTransaction;

                        if (!pendingTx) return null;
                        const isBuyer = pendingTx.buyerPublicKey === identity.publicKey;

                        return (
                            <div style={{
                                background: isBuyer ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)',
                                borderBottom: `1px solid ${isBuyer ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
                                padding: '0.75rem 1rem',
                                display: 'flex',
                                flexWrap: 'wrap',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '0.75rem'
                            }}>
                                <div style={{ flex: '1 1 10rem', minWidth: 0 }}>
                                    <div style={{ fontWeight: 'bold', fontSize: '0.85rem', color: isBuyer ? 'var(--bp-ink-success)' : 'var(--bp-ink-warning)' }}>
                                        {tn(pendingTx.credits, '🔒 Trust Hold: {n} Beans', '🔒 Trust Hold: {n} Beans')}
                                    </div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                        {isBuyer ? t('Release credits once you receive your items.') : t('Awaiting buyer to release credits.')}
                                    </div>
                                </div>
                                {isBuyer ? (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '0.5rem', marginLeft: 'auto', maxWidth: '100%' }}>
                                        <button
                                            onClick={() => handleReleaseCredits(pendingTx.id, pendingTx.credits)}
                                            disabled={actionLoading}
                                            style={{
                                                background: 'var(--bp-commit-fill)',
                                                color: 'var(--bp-commit-on)',
                                                border: 'none',
                                                borderRadius: '8px',
                                                padding: '0.4rem 0.75rem',
                                                fontWeight: 'bold',
                                                fontSize: '0.8rem',
                                                cursor: 'pointer'
                                            }}
                                        >
                                            {actionLoading ? '…' : t('✅ Release Credits')}
                                        </button>
                                        <button
                                            onClick={() => handleCancelCredits(pendingTx.id)}
                                            disabled={actionLoading}
                                            style={{
                                                background: 'rgba(239, 68, 68, 0.15)',
                                                color: '#ef4444',
                                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                                borderRadius: '8px',
                                                padding: '0.4rem 0.6rem',
                                                fontWeight: 'bold',
                                                fontSize: '0.8rem',
                                                cursor: 'pointer'
                                            }}
                                        >
                                            {t('Cancel')}
                                        </button>
                                    </div>
                                ) : (
                                    <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#f59e0b' }}>{t('⏳ Pending')}</span>
                                )}
                            </div>
                        );
                    })()}

                    {/* The list's "Action Needed" always has its way to rate here: when the unrated trade's own release line
                        isn't among the lines loaded (an older page), the same Rate your partner, pinned. */}
                    {(() => {
                        if (activeConv?.type !== 'dm' || !activePeerPubkey || loadedDmId !== activeConv.id) return null;
                        const unrated = unratedTradeWith(userTransactions, identity.publicKey, activePeerPubkey);
                        if (!unrated) return null;
                        // The strip's Review card is already the way to this trade's rating form: one door, not two.
                        if (stripDeals.some(d => d.id === unrated.id)) return null;
                        const lineShown = shownMessages.some(m => m.systemType === 'ESCROW_RELEASED' && !!m.metadata && (() => {
                            try { return tradeOfReleaseLine(userTransactions, JSON.parse(m.metadata!), m.timestamp) === unrated; } catch { return false; }
                        })());
                        if (lineShown) return null;
                        return (
                            <div data-testid="chat-rate-banner" style={{
                                borderBottom: '1px solid var(--border-primary)', padding: '0.6rem 1rem',
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap',
                            }}>
                                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('Your trade is finished. How did it go?')}</span>
                                <button type="button" onClick={() => onNavigate?.('marketplace-review', unrated.id)} style={{
                                    background: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)',
                                    padding: '4px 12px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', minHeight: '32px',
                                }}>
                                    <span aria-hidden="true">⭐ </span><span>{t('Rate your partner')}</span>
                                </button>
                            </div>
                        );
                    })()}
                </div>

                {/* Messages. The pinned block above leaves it 120 px at the least, whatever the text size; in a room under 120 px
                    (a short window) the thread is the whole room, as it was before the pinned block. */}
                <div data-testid="chat-thread" style={{
                    flex: 1, minHeight: 'min(120px, 100%)', overflowY: 'auto', padding: '1rem',
                    display: 'flex', flexDirection: 'column', gap: '0.3rem',
                }}>
                    {messages.length === 0 && (
                        <p style={{ textAlign: 'center', color: 'var(--text-faint)', marginTop: '2rem' }}>
                            {t('No messages yet. Say hello! 👋')}
                        </p>
                    )}
                    {chatSearch?.trim() && searchedMessages.length === 0 && (
                        <p data-testid="group-chat-search-none" style={{ textAlign: 'center', color: 'var(--text-faint)', marginTop: '1rem' }}>
                            {t('No messages in this chat match.')}
                        </p>
                    )}
                    {searchedMessages.map((msg, index) => {
                        const isSystem = msg.type === 'system' || msg.authorPubkey === 'SYSTEM';
                        const lineView = lineViews?.get(msg.id);
                        const groupLine = groupShown?.get(msg.id) ?? null;
                        // From before this member's membership (design §3): never drawn.
                        if (groupLine?.hidden) return null;
                        if (groupLine?.nodeLine && groupLine.text !== null) {
                            // A tombstone, in the app's own words: no name, no actions. A run of them is drawn once, by its
                            // first line, which keeps every line's anchor so a reply's "show the message" still lands.
                            const run = removedRuns.get(msg.id);
                            if (run === null) return null;
                            return (
                                <div key={msg.id} id={`msg-${msg.id}`} data-testid="group-line-tombstone" data-removed-count={run ? run.ids.length : undefined} style={{ alignSelf: 'center', margin: '0.5rem 0', maxWidth: '90%' }}>
                                    {run?.ids.slice(1).map((id) => <span key={id} id={`msg-${id}`} />)}
                                    <div style={{ background: 'var(--bg-hover)', color: 'var(--text-muted-on-hover)', borderRadius: '16px', padding: '0.4rem 0.8rem', fontSize: '0.8rem', fontStyle: 'italic', textAlign: 'center' }}>
                                        {run ? removedRunText(run.kind, run.ids.length) : chatLineWords(groupLine.text)}
                                    </div>
                                </div>
                            );
                        }
                        if (groupLine?.unattributed) {
                            // Nobody's (lib/group-chat-lines.ts): a line that opened under no key, an unsealed row in a locked
                            // chat, or one whose key hasn't reached this browser. In the middle, never in a member's bubble.
                            return (
                                <div key={msg.id} id={`msg-${msg.id}`} data-testid="group-line-unattributed" style={{
                                    alignSelf: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '0.5rem 0', maxWidth: '90%',
                                }}>
                                    {groupLine.name && (
                                        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)' }}>{chatAuthorWords(groupLine.name)}</div>
                                    )}
                                    <div style={{
                                        background: 'var(--bg-hover)', color: 'var(--text-secondary)', borderRadius: '16px', padding: '0.4rem 0.8rem',
                                        fontSize: '0.8rem', fontWeight: 500, whiteSpace: 'pre-wrap', wordBreak: 'break-word', textAlign: 'center',
                                    }}>
                                        {chatLineWords(groupLine.text)}
                                    </div>
                                    {groupLine.details && (
                                        <div data-testid="group-line-details" style={{ fontSize: '0.75rem', fontStyle: 'italic', marginTop: '4px', opacity: 0.85, textAlign: 'center' }}>
                                            {chatLineWords(groupLine.details)}
                                        </div>
                                    )}
                                </div>
                            );
                        }
                        if (!isSystem && dmLineIsUnattributed(lineView)) {
                            // A DM row shown as nobody's (e2e-crypto dmLineIsUnattributed): a line that didn't open, a row
                            // in a member's name that wasn't encrypted, or the admin page's message. In the middle of the
                            // chat, never in its named author's bubble, and with no actions.
                            const note = chatLineWords(dmLineMarkText(lineView?.mark));
                            return (
                                <div key={msg.id} id={`msg-${msg.id}`} data-testid="dm-line-unattributed" style={{
                                    alignSelf: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '0.5rem 0', maxWidth: '90%',
                                }}>
                                    <div style={{
                                        background: 'var(--bg-hover)', color: 'var(--text-secondary)', borderRadius: '16px', padding: '0.4rem 0.8rem',
                                        fontSize: '0.8rem', fontWeight: 500, whiteSpace: 'pre-wrap', wordBreak: 'break-word', textAlign: 'center',
                                    }}>
                                        {note ? '📣 ' : ''}{decryptMessage(msg)}
                                    </div>
                                    {note && (
                                        <div data-testid="dm-line-note" style={{ fontSize: '0.75rem', fontStyle: 'italic', marginTop: '4px', opacity: 0.85, textAlign: 'center' }}>
                                            {note}
                                        </div>
                                    )}
                                </div>
                            );
                        }
                        
                        if (isSystem) {
                            let icon = 'ℹ️';
                            // A trade's lines take the colour library's deal roles; others the page's grey.
                            const { background: bgColor, color: textColor, border: borderColor } = systemLineColours(msg.systemType);
                            let metaObj: any;
                            
                            try {
                                if (msg.metadata) metaObj = JSON.parse(msg.metadata);
                            } catch {}

                            if (msg.systemType === 'ESCROW_FUNDED') icon = '🔐';
                            if (msg.systemType === 'ESCROW_RELEASED') icon = '✅';
                            if (msg.systemType === 'ESCROW_CANCELLED') icon = '🚫';

                            return (
                                <div key={msg.id} style={{
                                    alignSelf: 'center',
                                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                                    margin: '0.5rem 0'
                                }}>
                                    <div style={{
                                        background: bgColor, color: textColor,
                                        border: `1px solid ${borderColor}`,
                                        borderRadius: '16px', padding: '0.4rem 0.8rem',
                                        fontSize: '0.8rem', fontWeight: 600
                                    }}>
                                        {icon} {formatSystemMessage(msg, identity.publicKey, userTransactionsByPostId)}
                                    </div>
                                    
                                    {msg.systemType === 'ESCROW_FUNDED' && metaObj?.postId && (
                                        <button
                                            onClick={() => onNavigate?.('marketplace', metaObj.postId)}
                                            style={{
                                                marginTop: '0.5rem', background: 'var(--bg-card)', color: 'var(--bp-ink-success)', border: '1px solid var(--bp-ink-success)',
                                                padding: '4px 12px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer'
                                            }}
                                        >
                                            <span aria-hidden="true">🏷️ </span><span>{t('View Post')}</span>
                                        </button>
                                    )}
                                    
                                    {msg.systemType === 'ESCROW_RELEASED' && metaObj?.postId && (() => {
                                        // This line's own trade (lib/trade-review), never the first completed row on its post.
                                        const relatedTx = tradeOfReleaseLine(userTransactions, metaObj, msg.timestamp);
                                        const hasRated = relatedTx ? iRated(relatedTx, identity.publicKey) : false;
                                        // A trade this page doesn't hold (older than the node's page of trades) can't be rated from
                                        // here: the line opens its post, as the funded line's View Post does (review #1980 N2).
                                        const canRate = !!relatedTx && !hasRated;
                                        return (
                                            <button
                                                onClick={() => canRate
                                                    ? onNavigate?.('marketplace-review', relatedTx!.id)
                                                    : onNavigate?.('marketplace', metaObj.postId)}
                                                style={{
                                                    marginTop: '0.5rem', background: 'var(--bg-card)',
                                                    color: canRate ? 'var(--bp-ink-warning)' : 'var(--bp-ink-success)',
                                                    border: `1px solid ${canRate ? 'var(--bp-ink-warning)' : 'var(--bp-ink-success)'}`,
                                                    padding: '4px 12px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
                                                    display: 'flex', alignItems: 'center', gap: '4px'
                                                }}
                                            >
                                                {!relatedTx
                                                    ? <><span aria-hidden="true">🏷️ </span><span>{t('View Post')}</span></>
                                                    : hasRated ? t('✓ Rating Submitted') : <><span aria-hidden="true">⭐ </span><span>{t('Rate your partner')}</span></>}
                                            </button>
                                        );
                                    })()}
                                </div>
                            );
                        }

                        // In a locked group chat the key that opened the line says whose it is, never the author column.
                        const isMe = groupLine ? groupLine.mine : msg.authorPubkey === identity.publicKey;
                        const isDm = activeConv.type === 'dm';
                        const readByPeer = isMe && isDm && !!activeConv?.peerLastReadAt &&
                            new Date(msg.timestamp).getTime() <= new Date(activeConv.peerLastReadAt).getTime();
                        const isEdited = !!msg.editedAt;

                        let metaObj: any = null;
                        try {
                            if (msg.metadata) {
                                const parsed = JSON.parse(msg.metadata);
                                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                                    metaObj = parsed;
                                }
                            }
                        } catch {}

                        const isTombstone = msg.type === 'removed' || metaObj?.removed === true;
                        const isConvenor = isGroupChat && !!openGroup?.answer?.isConvenor;
                        const isTextEditable = isMe && !isTombstone && msg.type !== 'image' && msg.type !== 'system' && !msg.systemType &&
                            (!isGroupChat || openGroup?.answer?.canPost !== false);
                        const elapsedMs = isTextEditable ? Date.now() - new Date(msg.timestamp).getTime() : 0;
                        const canEdit = isTextEditable && elapsedMs <= MESSAGE_EDIT_WINDOW_MS;
                        const editClosed = isTextEditable && elapsedMs > MESSAGE_EDIT_WINDOW_MS;
                        // Group chats and DMs, as on the phone: an enterprise chat refuses it (403). In a DM with a blocked peer the
                        // phone's canPost is false, so it offers no Delete either.
                        const canDelete = ((isGroupChat && openGroup?.answer?.canPost !== false) || (activeConv.type === 'dm' && !isPeerBlocked)) &&
                            isMe && !isTombstone && msg.type !== 'system' && !msg.systemType;
                        const canRemove = isGroupChat && isConvenor && !isMe && !isTombstone && msg.type !== 'system' && !msg.systemType;

                        const reactions: { emoji: string; author: string }[] = Array.isArray(metaObj?.reactions)
                            ? metaObj.reactions.filter((r: any) => r && typeof r === 'object' && typeof r.emoji === 'string')
                            : [];
                        const reactionCounts = reactions.reduce((acc: Record<string, number>, r: any) => {
                            acc[r.emoji] = (acc[r.emoji] || 0) + 1;
                            return acc;
                        }, {});
                        const uniqueEmojis = Object.keys(reactionCounts);
                        const totalReactionsCount = reactions.length;
                        const myReaction = reactions.find((r: any) => r && r.author === identity.publicKey);
                        const showEmojiPicker = !inRequest && activeEmojiPickerId === msg.id;
                        const isTopMessage = index < 2;
                        // A long message folds with "…more" (FoldedChatText); never a removed line, nor one being edited.
                        const foldable = !isTombstone && editingMessage?.id !== msg.id;

                        return (
                            <div
                                key={msg.id}
                                id={`msg-${msg.id}`}
                                className="max-w-[85%] md:max-w-[70%]"
                                style={{
                                    alignSelf: isMe ? 'flex-end' : 'flex-start',
                                    position: 'relative',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: isMe ? 'flex-end' : 'flex-start',
                                }}
                            >
                                {!isMe && activeConv.type === 'group_thread' && (
                                    <div data-testid="group-line-author" style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.15rem' }}>
                                        {groupLine
                                            ? <>{chatAuthorWords(groupLine.name)}{groupLine.nameHint && <span style={{ opacity: 0.75 }}> · {chatLineWords(groupLine.nameHint)}</span>}</>
                                            : (membersByPublicKey.get(msg.authorPubkey)?.callsign || msg.authorPubkey.substring(0, 8))}
                                    </div>
                                )}
                                {showEmojiPicker && (
                                    <div
                                        onClick={(e) => e.stopPropagation()}
                                        style={{
                                            position: 'absolute',
                                            ...(isTopMessage ? { top: '100%', marginTop: '4px' } : { bottom: '100%', marginBottom: '4px' }),
                                            [isMe ? 'right' : 'left']: 0,
                                            background: 'var(--bg-card)',
                                            border: '1px solid var(--border-primary)',
                                            borderRadius: '20px',
                                            padding: '4px 6px',
                                            display: 'flex',
                                            flexWrap: 'wrap',
                                            gap: '4px',
                                            maxWidth: 'calc(100vw - 32px)',
                                            boxShadow: 'var(--shadow-card)',
                                            zIndex: 30,
                                        }}
                                    >
                                        {ALLOWED_REACTIONS.map((emoji) => (
                                            <button
                                                key={emoji}
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleToggleReaction(msg.id, emoji);
                                                }}
                                                style={{
                                                    background: myReaction?.emoji === emoji ? 'var(--bg-hover)' : 'transparent',
                                                    border: myReaction?.emoji === emoji ? '1px solid var(--accent)' : '1px solid transparent',
                                                    borderRadius: '16px',
                                                    padding: '2px 4px',
                                                    width: '32px',
                                                    height: '32px',
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    fontSize: '1.2rem',
                                                    cursor: 'pointer',
                                                    lineHeight: 1,
                                                }}
                                                aria-label={t('React with {emoji}', { emoji })}
                                                title={t('React with {emoji}', { emoji })}
                                            >
                                                {emoji}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <div style={{
                                    background: isMe ? 'var(--accent)' : 'var(--bg-card)',
                                    color: isMe ? '#fff' : 'var(--text-primary)',
                                    borderRadius: isMe
                                        ? '12px 12px 4px 12px'
                                        : '12px 12px 12px 4px',
                                    padding: '0.35rem 0.6rem',
                                    fontSize: '0.95rem',
                                    lineHeight: 1.3,
                                    border: isMe ? 'none' : '1px solid var(--border-primary)',
                                    wordBreak: 'break-word',
                                }}>
                                    {metaObj && metaObj.replyToId && (() => {
                                        // The answered message as the thread judged it (quoteOf), never its row's raw words and name.
                                        const quoted = quoteOf(messagesById.get(metaObj.replyToId));
                                        const parentText = quoted.text;
                                        const parentAuthor = quoted.author;
                                        return (
                                            <div 
                                                data-testid="dm-quote"
                                                style={{
                                                    background: isMe ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.04)',
                                                    borderLeft: `3px solid ${isMe ? '#fff' : 'var(--accent)'}`,
                                                    padding: '4px 8px',
                                                    borderRadius: '4px',
                                                    marginBottom: '6px',
                                                    fontSize: '0.8rem',
                                                    opacity: 0.85,
                                                    cursor: 'pointer',
                                                }} 
                                                onClick={() => {
                                                    const el = document.getElementById(`msg-${metaObj.replyToId}`);
                                                    if (el) {
                                                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                                        el.style.transition = 'background-color 0.5s';
                                                        const origBg = el.style.backgroundColor;
                                                        el.style.backgroundColor = 'var(--bg-hover)';
                                                        setTimeout(() => { el.style.backgroundColor = origBg; }, 1500);
                                                    }
                                                }}
                                            >
                                                <div style={{ fontWeight: 700, fontSize: '0.75rem', color: isMe ? '#fff' : 'var(--accent)', marginBottom: '2px' }}>
                                                    {parentAuthor}
                                                </div>
                                                <div style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '280px' }}>
                                                    {parentText}
                                                </div>
                                                {quoted.note && (
                                                    <div data-testid="dm-quote-note" style={{ fontStyle: 'italic', fontSize: '0.7rem', whiteSpace: 'normal' }}>⚠️ {quoted.note}</div>
                                                )}
                                            </div>
                                        );
                                    })()}
                                    <div dir="auto" style={{ display: 'inline', whiteSpace: 'pre-wrap' }}>
                                        {msg.type === 'image' ? (() => {
                                            if (groupLine && openGroup) {
                                                // A locked group chat's photo line (DESIGN-group-chat-photos-fable.md §2.3): its words
                                                // opened, so its photo is fetched and opened under the same key and signer, with its
                                                // caption under it as a DM photo's is.
                                                const view = openGroup.thread?.views.get(msg.id);
                                                return (
                                                    <>
                                                        <GroupChatImageBubble
                                                            photoKey={`${msg.id}|${view?.signer ?? ''}|${view?.epoch ?? ''}`}
                                                            open={() => getDecryptedGroupAttachment(groupKeysNet, identity, indexedDbGroupLockStore, {
                                                                groupId: groupIdKey(activeConv.id), line: { ...msg, type: 'image' }, view,
                                                            })}
                                                            onOpen={setViewerUri}
                                                        />
                                                        {groupLine.text && (
                                                            <div style={{ marginTop: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                                                <FoldedChatText text={groupLine.text} enabled={foldable} display="block" mine={isMe} />
                                                            </div>
                                                        )}
                                                    </>
                                                );
                                            }
                                            const ctx = dmCtxFor(activeConv);
                                            if (!ctx) return <span style={{ fontStyle: 'italic', opacity: 0.7 }}>{t('🔒 Image')}</span>;
                                            // An image message's body is its caption, which is
                                            // usually empty. The phone already shows it; show it
                                            // here too, or a caption typed on the web would be
                                            // invisible to the person who typed it.
                                            const body = decryptMessage(msg).trim();
                                            const caption = UNREADABLE_BODIES.includes(body) ? '' : body;
                                            // A request waiting for this member: the photo stays closed, and isn't even
                                            // fetched, until they accept (design §4.6). Its caption is words, and reads.
                                            if (requestMode === 'to-me') {
                                                return (
                                                    <>
                                                        <span style={{ fontStyle: 'italic', opacity: 0.8 }}><span aria-hidden="true">🖼️ </span>{closedPhotoWords()}</span>
                                                        {caption && (
                                                            <div style={{ marginTop: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                                                <FoldedChatText text={caption} enabled={foldable} display="block" mine={isMe} />
                                                            </div>
                                                        )}
                                                    </>
                                                );
                                            }
                                            return (
                                                <>
                                                    <ChatImageBubble
                                                        messageId={msg.id}
                                                        conversationId={ctx.conversationId}
                                                        authorPubkey={msg.authorPubkey}
                                                        metadata={msg.metadata}
                                                        bodyFormat={lineView?.format ?? null}
                                                        peerPubHex={ctx.peerEdPubHex}
                                                        myPrivHex={ctx.myEdPrivHex}
                                                        onOpen={setViewerUri}
                                                    />
                                                    {caption && (
                                                        <div style={{ marginTop: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                                            <FoldedChatText text={caption} enabled={foldable} display="block" mine={isMe} />
                                                        </div>
                                                    )}
                                                </>
                                            );
                                        })() : <FoldedChatText text={decryptMessage(msg)} enabled={foldable} mine={isMe} />}
                                    </div>
                                    {groupLine?.details && (
                                        <div data-testid="group-line-details" style={{ display: 'block', fontSize: '0.75rem', fontStyle: 'italic', marginTop: '4px', opacity: 0.85, whiteSpace: 'normal' }}>
                                            {chatLineWords(groupLine.details)}
                                        </div>
                                    )}
                                    {(() => {
                                        // A line the node moved or reordered, or an old-format line (checkDmThread).
                                        const note = chatLineWords(dmLineMarkText(lineView?.mark));
                                        return note ? (
                                            <div data-testid="dm-line-note" style={{ display: 'block', fontSize: '0.75rem', fontStyle: 'italic', marginTop: '4px', opacity: 0.85, whiteSpace: 'normal' }}>
                                                ⚠️ {note}
                                            </div>
                                        ) : null;
                                    })()}
                                    <span style={{
                                        float: 'right',
                                        fontSize: '0.75rem',
                                        color: isMe ? 'rgba(255, 255, 255, 0.85)' : 'var(--text-faint)',
                                        marginLeft: '8px',
                                        marginTop: '4px',
                                        display: 'inline-flex',
                                        flexWrap: 'wrap',
                                        alignItems: 'center',
                                        justifyContent: 'flex-end',
                                        gap: '2px',
                                        userSelect: 'none',
                                        verticalAlign: 'bottom',
                                    }}>
                                        {isEdited ? t('edited · {time}', { time: messageTime(msg.timestamp) }) : messageTime(msg.timestamp)}
                                        {isMe && (
                                            <span style={{ marginLeft: '2px', color: readByPeer ? '#38bdf8' : 'rgba(255, 255, 255, 0.6)' }} aria-label={readByPeer ? t('Read by recipient') : t('Sent', undefined, 'message status')}>
                                                {readByPeer ? '✓✓' : '✓'}
                                            </span>
                                        )}
                                        {/* No replies or reactions in a chat that is still a request: the opener's are
                                            refused until it is accepted, and the person it is for decides first. Nor on
                                            a deleted line: the node refuses a reaction to it (403), as the phone hides them. */}
                                        {!inRequest && !isTombstone && <>
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); handleStartReply(msg); }}
                                            style={{
                                                background: 'none',
                                                border: 'none',
                                                font: 'inherit',
                                                fontSize: '0.75rem',
                                                lineHeight: 1,
                                                padding: '4px 6px',
                                                minHeight: '24px',
                                                cursor: 'pointer',
                                                color: isMe ? '#ffffff' : 'var(--accent)',
                                                fontWeight: 600,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                textDecoration: 'underline',
                                                textUnderlineOffset: '2px',
                                            }}
                                            aria-label={t('Reply to message')}
                                        >
                                            {t('Reply')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setActiveEmojiPickerId(activeEmojiPickerId === msg.id ? null : msg.id);
                                            }}
                                            style={{
                                                background: 'none',
                                                border: 'none',
                                                font: 'inherit',
                                                fontSize: '0.75rem',
                                                lineHeight: 1,
                                                padding: '4px 6px',
                                                minHeight: '24px',
                                                cursor: 'pointer',
                                                color: isMe ? '#ffffff' : 'var(--accent)',
                                                fontWeight: 600,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                textDecoration: 'underline',
                                                textUnderlineOffset: '2px',
                                            }}
                                            aria-label={t('React to message')}
                                            title={t('React')}
                                        >
                                            {t('React')}
                                        </button>
                                        {/* Someone else's line of a locked group chat, opened here: reported with its own key (S6). */}
                                        {groupLine && groupLocked && !groupLine.mine && !groupLine.unattributed && !!openGroup?.thread?.views.get(msg.id)?.signer && (
                                            <button
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); setReportingLine(msg); }}
                                                style={{
                                                    background: 'none',
                                                    border: 'none',
                                                    font: 'inherit',
                                                    fontSize: '0.75rem',
                                                    lineHeight: 1,
                                                    padding: '4px 6px',
                                                    minHeight: '24px',
                                                    cursor: 'pointer',
                                                    color: 'var(--accent)',
                                                    fontWeight: 600,
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                    textDecoration: 'underline',
                                                    textUnderlineOffset: '2px',
                                                }}
                                                aria-label={t('Report message')}
                                            >
                                                {t('Report', undefined, 'button: report a message')}
                                            </button>
                                        )}
                                        </>}
                                        {canDelete && (
                                            <button
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); setConfirmDeleteMsg(msg); }}
                                                style={{
                                                    background: 'none',
                                                    border: 'none',
                                                    font: 'inherit',
                                                    fontSize: '0.75rem',
                                                    lineHeight: 1,
                                                    padding: '4px 6px',
                                                    minHeight: '24px',
                                                    cursor: 'pointer',
                                                    color: isMe ? '#ffffff' : 'var(--accent)',
                                                    fontWeight: 600,
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                    textDecoration: 'underline',
                                                    textUnderlineOffset: '2px',
                                                }}
                                                aria-label={t('Delete message')}
                                            >
                                                {t('Delete')}
                                            </button>
                                        )}
                                        {canRemove && (
                                            <button
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); setConfirmRemoveMsg(msg); }}
                                                style={{
                                                    background: 'none',
                                                    border: 'none',
                                                    font: 'inherit',
                                                    fontSize: '0.75rem',
                                                    lineHeight: 1,
                                                    padding: '4px 6px',
                                                    minHeight: '24px',
                                                    cursor: 'pointer',
                                                    color: 'var(--accent)',
                                                    fontWeight: 600,
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                    textDecoration: 'underline',
                                                    textUnderlineOffset: '2px',
                                                }}
                                                aria-label={t('Remove message')}
                                            >
                                                {t('Remove')}
                                            </button>
                                        )}
                                        {canEdit && (
                                            <button
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); handleStartEdit(msg); }}
                                                style={{
                                                    background: 'none',
                                                    border: 'none',
                                                    font: 'inherit',
                                                    fontSize: '0.75rem',
                                                    lineHeight: 1,
                                                    padding: '4px 6px',
                                                    minHeight: '24px',
                                                    cursor: 'pointer',
                                                    color: isMe ? '#ffffff' : 'var(--accent)',
                                                    fontWeight: 600,
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                    textDecoration: 'underline',
                                                    textUnderlineOffset: '2px',
                                                }}
                                                aria-label={t('Edit message')}
                                            >
                                                {t('Edit', undefined, 'button: edit a message')}
                                            </button>
                                        )}
                                        {editClosed && (
                                            activeEditNoticeId === msg.id ? (
                                                <span
                                                    role="status"
                                                    tabIndex={-1}
                                                    ref={(el) => {
                                                        if (el && focusEditNoticeRef.current) {
                                                            focusEditNoticeRef.current = false;
                                                            el.focus();
                                                        }
                                                    }}
                                                    style={{
                                                        fontSize: '0.75rem',
                                                        lineHeight: 1.3,
                                                        padding: '4px 6px',
                                                        color: isMe ? 'var(--bp-accent-on)' : 'var(--text-muted)',
                                                        whiteSpace: 'normal',
                                                        outline: 'none',
                                                    }}
                                                >
                                                    {t('You can edit a message for 15 minutes after sending it.')}
                                                </span>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        focusEditNoticeRef.current = activeEditNoticeId !== msg.id;
                                                        setActiveEditNoticeId(activeEditNoticeId === msg.id ? null : msg.id);
                                                    }}
                                                    style={{
                                                        background: 'none',
                                                        border: 'none',
                                                        font: 'inherit',
                                                        fontSize: '0.75rem',
                                                        lineHeight: 1,
                                                        padding: '4px 6px',
                                                        minHeight: '24px',
                                                        cursor: 'pointer',
                                                        color: isMe ? '#ffffff' : 'var(--accent)',
                                                        fontWeight: 600,
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        textDecoration: 'underline',
                                                        textUnderlineOffset: '2px',
                                                    }}
                                                    aria-label={t('Edit message')}
                                                >
                                                    {t('Edit', undefined, 'button: edit a message')}
                                                </button>
                                            )
                                        )}
                                    </span>
                                </div>
                                {totalReactionsCount > 0 && (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setActiveEmojiPickerId(activeEmojiPickerId === msg.id ? null : msg.id);
                                        }}
                                        style={{
                                            marginTop: '3px',
                                            marginBottom: '2px',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '3px',
                                            background: 'var(--bg-card)',
                                            border: `1px solid ${myReaction ? 'var(--accent)' : 'var(--border-primary)'}`,
                                            borderRadius: '12px',
                                            padding: '2px 8px',
                                            minHeight: '24px',
                                            fontSize: '0.75rem',
                                            lineHeight: 1,
                                            cursor: 'pointer',
                                            boxShadow: 'var(--shadow-card)',
                                            color: 'var(--text-primary)',
                                            userSelect: 'none',
                                        }}
                                        aria-label={t('Reactions: {emojis}. Total: {total}', { emojis: uniqueEmojis.join(' '), total: totalReactionsCount })}
                                        title={reactions.map((r: any) => t('{name}: {emoji}', { name: r.author === identity.publicKey ? t('You') : (membersByPublicKey.get(r.author)?.callsign || r.author.slice(0, 8)), emoji: r.emoji })).join('\n')}
                                    >
                                        <span>{uniqueEmojis.join(' ')}</span>
                                        {totalReactionsCount > 1 && (
                                            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                                                {totalReactionsCount}
                                            </span>
                                        )}
                                    </button>
                                )}
                            </div>
                        );
                    })}
                    <div ref={messagesEndRef} />
                </div>
                </div>

                {/* Edit Preview */}
                {editingMessage && (
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '0.5rem 1rem', background: 'var(--bg-secondary)',
                        borderTop: '1px solid var(--border-primary)',
                        fontSize: '0.85rem', color: 'var(--text-secondary)',
                        gap: '8px',
                    }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', borderLeft: '3px solid var(--accent)', paddingLeft: '8px', minWidth: 0, flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: '0.8rem', color: 'var(--accent)' }}>
                                {t('Editing message')}
                            </div>
                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                                {decryptMessage(editingMessage)}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={handleCancelEdit}
                            aria-label={t('Cancel edit')}
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem', padding: '6px', minWidth: '28px', minHeight: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                            ✕
                        </button>
                    </div>
                )}

                {/* Reply Preview */}
                {replyToMessage && !editingMessage && (
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '0.5rem 1rem', background: 'var(--bg-secondary)',
                        borderTop: '1px solid var(--border-primary)',
                        fontSize: '0.85rem', color: 'var(--text-secondary)',
                        gap: '8px',
                    }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', borderLeft: '3px solid var(--accent)', paddingLeft: '8px', minWidth: 0, flex: 1 }}>
                            {(() => {
                                // What is being answered, as the thread judged it (quoteOf).
                                const q = quoteOf(replyToMessage);
                                return (
                                    <>
                                        <div style={{ fontWeight: 600, fontSize: '0.8rem', color: 'var(--accent)' }}>
                                            {t('Replying to {name}', { name: !q.named ? q.author : replyToMessage.authorPubkey === identity.publicKey ? t('You') : (membersByPublicKey.get(replyToMessage.authorPubkey)?.callsign || t('Someone')) })}
                                        </div>
                                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                                            {q.text}
                                        </div>
                                        {q.note && <div style={{ fontStyle: 'italic', fontSize: '0.75rem', whiteSpace: 'normal' }}>⚠️ {q.note}</div>}
                                    </>
                                );
                            })()}
                        </div>
                        <button
                            type="button"
                            onClick={() => setReplyToMessage(null)}
                            aria-label={t('Cancel reply')}
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem', padding: '6px', minWidth: '28px', minHeight: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                            ✕
                        </button>
                    </div>
                )}

                {imageNotice && (
                    <div
                        role="status"
                        data-testid="chat-image-notice"
                        style={{
                            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px',
                            padding: '0.5rem 1rem', background: 'var(--bg-secondary)',
                            borderTop: '1px solid var(--border-primary)',
                            fontSize: '0.85rem', color: 'var(--text-secondary)',
                        }}
                    >
                        <span style={{ minWidth: 0, flex: 1, wordBreak: 'break-word' }}>{chatLineWords(imageNotice)}</span>
                        <button
                            type="button"
                            onClick={() => setImageNotice(null)}
                            aria-label={t('Dismiss')}
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem', padding: '6px', minWidth: '28px', minHeight: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                        >
                            ✕
                        </button>
                    </div>
                )}

                {openGroup && (
                    // The app's own words for what it decided about this chat (lib/group-chat-lines.ts), never the node's.
                    <div data-testid="group-chat-notice" style={{
                        padding: '0.4rem 1rem', borderTop: '1px solid var(--border-primary)', background: 'var(--bg-secondary)',
                        fontSize: '0.75rem', color: 'var(--text-muted)', wordBreak: 'break-word',
                    }}>
                        {groupLocked ? '🔒 ' : ''}{chatLineWords(groupChatNotice({ nodeSaysLocked: openGroup.nodeSaysLocked, seenLocked: openGroup.seenLocked, chatError: openGroup.answer ? null : openGroup.error }))}
                        {openGroup.thread?.waitingForNextKey ? ` ${chatLineWords(GROUP_KEY_WAITING_TEXT)}` : ''}
                    </div>
                )}

                {chatRefusalNotice}

                {pendingImage && (
                    <div
                        data-testid="chat-image-preview"
                        style={{
                            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px',
                            padding: '0.5rem 1rem', background: 'var(--bg-secondary)',
                            borderTop: '1px solid var(--border-primary)',
                        }}
                    >
                        {pendingImage.previewUrl ? (
                            <img
                                src={pendingImage.previewUrl}
                                alt=""
                                style={{ width: '48px', height: '48px', objectFit: 'cover', borderRadius: '8px', flexShrink: 0 }}
                            />
                        ) : (
                            <div style={{ width: '48px', height: '48px', borderRadius: '8px', background: 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>🖼️</div>
                        )}
                        {/* The question keeps room to read as a sentence: on a narrow screen the buttons go under it
                            (at 320 px with 1.3x text it was one word a line beside them). */}
                        <div style={{ minWidth: 0, flex: '1 1 8rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            {draft.trim() ? t('Send this picture, with what you have typed as its caption?') : t('Send this picture?')}
                        </div>
                        <div style={{ display: 'flex', gap: '8px', flexShrink: 0, marginLeft: 'auto' }}>
                            <button
                                type="button"
                                onClick={clearPendingImage}
                                style={{ minHeight: '32px', padding: '0 12px', borderRadius: '8px', border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: '0.85rem', cursor: 'pointer' }}
                            >
                                {t('Cancel')}
                            </button>
                            <button
                                type="button"
                                onClick={sendPendingImage}
                                disabled={sending}
                                style={{ minHeight: '32px', padding: '0 12px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#fff', fontFamily: 'inherit', fontSize: '0.85rem', fontWeight: 600, cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.6 : 1 }}
                            >
                                {sending ? t('Sending…') : t('Send')}
                            </button>
                        </div>
                    </div>
                )}

                {/* Send bar / Blocked Notice */}
                {isPeerBlocked ? (
                    <div
                        role="alert"
                        className="p-3.5 m-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 text-xs sm:text-sm font-bold flex flex-wrap items-center justify-between gap-2 sm:gap-3"
                    >
                        <span className="min-w-0 flex-1 break-words"><span aria-hidden="true">🚫 </span>{t('You have blocked this user. Messaging is disabled.')}</span>
                        <button
                            type="button"
                            onClick={async () => {
                                if (window.confirm(t('Unblock {name}?', { name: getConversationTitle(activeConv) }))) {
                                    try {
                                        await unblockUser(peerPubkey);
                                        await loadConversations();
                                    } catch (e: any) {
                                        alert(e?.message || t('That did not go through. Please try again.'));
                                    }
                                }
                            }}
                            className="px-3 py-1 bg-white dark:bg-nature-900 border border-red-300 dark:border-red-700 text-red-600 dark:text-red-300 font-bold rounded-lg text-xs cursor-pointer hover:bg-red-50 dark:hover:bg-red-950/30 shrink-0"
                        >
                            {t('Unblock')}
                        </button>
                    </div>
                ) : requestMode === 'to-me' ? (
                    // Request mode (design §4.5): the lines read above, and in place of the composer the card's three
                    // buttons. Report is in the header. Nothing is written until the node takes the decision.
                    <div data-testid="request-mode" style={{
                        padding: '0.75rem 1rem', borderTop: '1px solid var(--border-primary)', background: 'var(--bg-secondary)',
                    }}>
                        <p style={{ margin: 0, fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                            {t('{name} wants to message you', { name: getConversationTitle(activeConv) })}
                        </p>
                        <p style={{ margin: '0.25rem 0 0.6rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            {t('Accept to reply. If you ignore it, they are not told.')}
                        </p>
                        <RequestActions
                            conversationId={activeConv.id}
                            peerPubkey={peerPubkey}
                            peerName={getConversationTitle(activeConv)}
                            identity={identity}
                            onAccepted={(request) => {
                                const id = activeConv.id;
                                setActiveConv(prev => (prev && prev.id === id ? { ...prev, request } : prev));
                                void loadConversations();
                            }}
                            onIgnored={() => { setActiveConv(null); setActiveTab('requests'); void loadConversations(); }}
                            onBlocked={() => { setActiveConv(null); setActiveTab('requests'); void loadConversations(); }}
                        />
                    </div>
                ) : requestMode === 'mine-waiting' && !editingMessage ? (
                    // The opener's line is in: what happens now, honestly, and nothing the node didn't say (an ignore and a
                    // block read as a request nobody has opened yet). Their own line still edits, from its bubble.
                    <div role="status" data-testid="request-waiting" style={{
                        padding: '0.75rem 1rem', borderTop: '1px solid var(--border-primary)', background: 'var(--bg-secondary)',
                        fontSize: '0.85rem', color: 'var(--text-secondary)', overflowWrap: 'anywhere',
                        display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
                    }}>
                        <span style={{ flex: '1 1 14rem' }}>
                            {t('Sent as a request. {name} will see it under Requests. You can write more once they accept.', { name: getConversationTitle(activeConv) })}
                        </span>
                        <button
                            type="button"
                            data-testid="request-cancel"
                            disabled={cancellingRequest}
                            onClick={async () => {
                                if (cancellingRequest) return;
                                setCancellingRequest(true);
                                try {
                                    const answer = await decideMessageRequest(activeConv.id, 'cancel');
                                    const nextRequest = answer.request ?? { ...activeConv.request, nextLineIsRequest: true };
                                    setActiveConv(prev => (prev && prev.id === activeConv.id ? { ...prev, request: nextRequest } : prev));
                                    setMessages([]);
                                    void loadConversations();
                                } catch (e) {
                                    alert((e as Error | null)?.message || t('That did not go through. Please try again.'));
                                } finally {
                                    setCancellingRequest(false);
                                }
                            }}
                            style={{
                                minHeight: '44px', padding: '0.4rem 0.85rem', borderRadius: '10px',
                                border: '1px solid var(--border-primary)', background: 'var(--bg-card)',
                                color: 'var(--text-primary)', font: 'inherit', fontSize: '0.85rem', fontWeight: 600,
                                cursor: cancellingRequest ? 'not-allowed' : 'pointer', opacity: cancellingRequest ? 0.6 : 1, whiteSpace: 'nowrap',
                            }}
                        >
                            {t('Cancel request')}
                        </button>
                    </div>
                ) : (
                    <>
                    {requestMode === 'mine-unsent' && (
                        <div data-testid="request-first-line" style={{
                            padding: '0.5rem 1rem', borderTop: '1px solid var(--border-primary)', background: 'var(--bg-secondary)',
                            fontSize: '0.8rem', color: 'var(--text-secondary)', overflowWrap: 'anywhere',
                        }}>
                            {t('Your first message goes to {name} as a request. You can write more once they accept.', { name: getConversationTitle(activeConv) })}
                        </div>
                    )}
                    <div style={{
                        display: 'flex', gap: '0.5rem',
                        padding: '0.5rem 1rem',
                        alignItems: 'flex-end',
                        borderTop: '1px solid var(--border-primary)',
                        background: 'var(--bg-secondary)',
                    }}>
                        {/* A DM's photo, and a locked group's (sealed here); none in an old node's group chat (design §2.6). */}
                        {(activeConv.type === 'dm' || groupLocked) && requestTakesPhoto(requestMode) && (
                            <label title={t('Send photo')} style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                width: '40px', height: '40px', borderRadius: '50%',
                                fontSize: '1.2rem',
                                cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.5 : 1,
                                flexShrink: 0,
                                background: 'transparent',
                            }}>
                                📎
                                <input
                                    type="file"
                                    accept="image/*"
                                    disabled={sending}
                                    style={{ display: 'none' }}
                                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleSendImage(f); e.target.value = ''; }}
                                />
                            </label>
                        )}
                        <textarea
                            ref={draftRef}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onPaste={handleComposerPaste}
                            onKeyDown={(e) => {
                                // While a picture is waiting, Enter and Escape belong to
                                // the preview — it handles them on the window.
                                if (pendingImage) return;
                                // An input method is mid-word: Enter picks the characters
                                // being composed, and must not cut the message short.
                                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                                // Enter sends; Shift+Enter inserts a newline.
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleSend();
                                }
                            }}
                            placeholder={editingMessage ? t('Edit message...') : t('Message...')}
                            disabled={sending}
                            rows={1}
                            style={{
                                ...inputStyle,
                                height: '40px',
                                maxHeight: '100px',
                                resize: 'none',
                                overflowY: 'auto',
                                lineHeight: 1.4,
                                paddingTop: '0.55rem',
                                paddingBottom: '0.55rem',
                            }}
                        />
                        <button
                            type="button"
                            onClick={handleSend}
                            disabled={sending || !draft.trim()}
                            title={editingMessage ? t('Save edit') : t('Send message')}
                            style={{
                                height: '40px',
                                width: '40px',
                                borderRadius: '50%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                border: 'none',
                                background: draft.trim() ? 'var(--accent)' : 'var(--bg-hover)',
                                color: draft.trim() ? '#fff' : 'var(--text-muted)',
                                fontSize: '1.2rem',
                                cursor: draft.trim() ? 'pointer' : 'default',
                                fontFamily: 'inherit',
                                flexShrink: 0,
                                padding: 0,
                            }}
                        >
                            {sending ? '…' : (editingMessage ? '✓' : '↑')}
                        </button>
                    </div>
                    </>
                )}

                {reportTarget && (
                    <ReportModal
                        isOpen={!!reportTarget}
                        onClose={() => setReportTarget(null)}
                        reporterPubkey={identity.publicKey}
                        targetPubkey={reportTarget.pubkey}
                        targetName={reportTarget.name}
                    />
                )}
                {reportingLine && openGroup && (
                    // The DM report card's reasons and words, sending this one line with its key (lib/group-chat-lines.ts).
                    <ReportModal
                        isOpen
                        onClose={() => setReportingLine(null)}
                        reporterPubkey={identity.publicKey}
                        targetPubkey={reportingLine.authorPubkey}
                        targetName=""
                        title={t('Report this message')}
                        note={reportingLine.type === 'image'
                            ? t("This community's moderators will see this one message, its photo and who sent it. Nothing else in this chat is shared with them.")
                            : t("This community's moderators will see this one message and who sent it. Nothing else in this chat is shared with them.")}
                        onSubmitReason={async (reason) => {
                            try {
                                await reportSealedGroupLine(groupKeysNet, identity, indexedDbGroupLockStore, {
                                    groupId: groupIdKey(openGroup.id), messageId: reportingLine.id, view: openGroup.thread?.views.get(reportingLine.id), reason,
                                });
                            } catch (e) {
                                // This browser's own sentence in the member's language; the node's words as it sent them.
                                throw new Error(chatLineWords(e instanceof Error ? e.message : '') || t('Could not reach the node.'));
                            }
                        }}
                    />
                )}

                <ChatConfirmDialog
                    isOpen={!!confirmDeleteMsg}
                    title={t('Delete for everyone?')}
                    message={
                        activeConv?.type === 'dm'
                            ? t('It will read "This message was deleted" for both of you.')
                            : t('It will read "This message was deleted" to everyone in the chat.')
                    }
                    cancelLabel={t('Cancel')}
                    confirmLabel={t('Delete')}
                    destructive
                    onCancel={() => setConfirmDeleteMsg(null)}
                    onConfirm={handleConfirmDelete}
                />
                <ChatConfirmDialog
                    isOpen={!!confirmRemoveMsg}
                    title={t('Remove this message?')}
                    message={t('It will read "Removed by a convenor" to everyone in the chat.')}
                    cancelLabel={t('Keep it')}
                    confirmLabel={t('Remove')}
                    destructive
                    onCancel={() => setConfirmRemoveMsg(null)}
                    onConfirm={handleConfirmRemove}
                />
                {activeConv && activeConv.type === 'group_thread' && (
                    <ChatMenuModal
                        isOpen={chatMenuOpen || muteDialogOpen}
                        muteOpen={muteDialogOpen}
                        isMuted={isMuted(chatMute)}
                        isConvenor={!!openGroup?.answer?.isConvenor}
                        onClose={() => { setChatMenuOpen(false); setMuteDialogOpen(false); }}
                        onOpenMute={() => setMuteDialogOpen(true)}
                        onPickMute={handleSetMute}
                        onSearch={() => setChatSearch('')}
                        onGroupInfo={() => onNavigate?.('group', groupIdKey(activeConv.id))}
                    />
                )}
                {/* A chat photo opened full screen (parity gap 4). */}
                <ChatPhotoViewer uri={viewerUri} onClose={() => setViewerUri(null)} />
            </div>
        );
    }

    // The rows the list shows (empty conversations are left out by the node), and the Groups chip's unread count from them.
    const listedConversations = conversations.filter(c => (c.unreadCount || 0) > 0 || c.createdAt);
    const groupsUnread = groupsUnreadCount(listedConversations);
    const hasGroups = listedConversations.some(isGroupLikeChat);
    const headerButtonStyle: CSSProperties = {
        padding: '0.4rem 0.75rem', borderRadius: '8px', minHeight: '36px',
        border: '1px solid var(--border-input)', background: 'var(--bg-hover)',
        color: 'var(--text-primary)', fontSize: '0.8rem', cursor: 'pointer',
        fontFamily: 'inherit', whiteSpace: 'nowrap',
    };
    // Find groups: Commons, which opens on its Groups (the phone's FIND_GROUPS_HREF).
    const findGroups = () => onNavigate?.('projects');
    const filterChips: Array<{ id: ConversationTab; label: string; count: number }> = [
        { id: 'all', label: t('All'), count: 0 },
        { id: 'transactions', label: t('Transactions'), count: 0 },
        { id: 'direct', label: t('Direct'), count: 0 },
        { id: 'groups', label: t('Groups'), count: groupsUnread },
    ];
    // Requests (lib/dm-requests.ts): only where the community has them on and one is waiting, or while it is open (so it
    // doesn't vanish under the member as they decide the last). Its count is its own, never in the unread ones.
    const requestCount = requests?.count ?? 0;
    if (requests && (requestCount > 0 || activeTab === 'requests')) filterChips.push({ id: 'requests', label: t('Requests'), count: requestCount });
    const showingRequests = activeTab === 'requests' && !!requests;
    // When a person joined, on a request card, where this page holds their card.
    const joinedWordsOf = (pubkey: string): string | null => {
        const joinedAt = membersByPublicKey.get(pubkey)?.joinedAt;
        const date = joinedAt ? conversationDate(joinedAt) : '';
        return date ? t('Joined {date}', { date }) : null;
    };

    return (
        <div className="p-4 md:p-6 max-w-4xl lg:max-w-6xl xl:max-w-7xl mx-auto w-full">
            {/* Wraps: at 320px with 1.3x text, Groups' two buttons go under the title rather than squeeze it. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                <h2 style={{ fontSize: '1.3rem', margin: 0 }}>{t('💬 Messages')}</h2>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '0.5rem', marginLeft: 'auto' }}>
                    {activeTab !== 'groups' ? (
                        <button onClick={() => { setShowNewDm(true); loadMembers(); }} style={headerButtonStyle}>
                            {t('✉️ New DM')}
                        </button>
                    ) : hasGroups && (
                        // As the phone's Groups: the empty view has its own two, so these show with a list.
                        <>
                            <button onClick={findGroups} style={headerButtonStyle}>
                                <span aria-hidden="true">🔍 </span>{t('Find groups')}
                            </button>
                            <button onClick={() => setShowCreateGroup(true)} style={headerButtonStyle}>
                                <span aria-hidden="true">+ </span>{t('New group')}
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Wraps instead of scrolling: at 320px with 1.3x text the four chips need ~470px, and a sideways
                scroller hid "Direct" behind a grey scrollbar. scrollbar-none in case a translation still overflows. */}
            <div className="scrollbar-none" data-testid="conversation-filter-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid var(--border-primary)', paddingBottom: '1rem', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                {filterChips.map(chip => {
                    const active = activeTab === chip.id;
                    const isRequests = chip.id === 'requests';
                    return (
                        <button
                            key={chip.id}
                            onClick={() => setActiveTab(chip.id)}
                            aria-pressed={active}
                            aria-label={chip.count > 0
                                ? (isRequests
                                    ? tn(chip.count, 'Requests, {n} person wants to message you', 'Requests, {n} people want to message you')
                                    : t('{label}, {count} unread', { label: chip.label, count: chip.count }))
                                : undefined}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap', background: active ? 'var(--text-primary)' : 'var(--bg-hover)', color: active ? 'var(--bg-primary)' : 'var(--text-primary)', border: 'none', padding: '0.5rem 1.25rem', borderRadius: '20px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                        >
                            {chip.label}
                            {chip.count > 0 && (
                                <span
                                    aria-hidden="true"
                                    data-testid={`conversation-filter-count-${chip.id}`}
                                    style={{
                                        // Requests' count is not unread lines: the sage accent, not the unread red.
                                        background: isRequests ? 'var(--bp-accent-fill)' : 'var(--danger)', color: isRequests ? 'var(--bp-accent-on)' : 'var(--on-danger)', fontSize: '0.7rem', fontWeight: 800,
                                        minWidth: '18px', height: '18px', borderRadius: '9px', display: 'inline-flex', alignItems: 'center',
                                        justifyContent: 'center', padding: '0 5px', lineHeight: 1,
                                    }}
                                >{chip.count > 99 ? '99+' : chip.count}</span>
                            )}
                        </button>
                    );
                })}
            </div>

            {chatRefusalNotice && <div style={{ marginBottom: '1rem' }}>{chatRefusalNotice}</div>}

            {showCreateGroup && (
                <CreateGroupModal
                    isOpen
                    onClose={() => setShowCreateGroup(false)}
                    onStartWithBeans={!beansOn ? undefined : () => {
                        setShowCreateGroup(false);
                        onNavigate?.('projects', 'start');
                    }}
                    onCreated={(group) => {
                        // As the phone's (decision 8): straight into the new group's chat. Its id is the group's.
                        setShowCreateGroup(false);
                        setActiveConv({
                            id: group.id, type: 'group_thread', name: group.name, participants: [identity.publicKey],
                            createdBy: identity.publicKey, createdAt: new Date().toISOString(),
                            avatarUrl: group.avatarUrl ?? null, category: group.category ?? null,
                        });
                        loadMembers();
                        loadConversations();
                    }}
                />
            )}

            {showingRequests ? (
                <MessageRequestsList
                    entries={requests!.conversations}
                    count={requestCount}
                    identity={identity}
                    store={requestPreviews}
                    avatar={renderAvatar}
                    joinedWordsOf={joinedWordsOf}
                    onOpen={(entry) => { setActiveConv(entry); loadMembers(); }}
                    onOpenProfile={onOpenProfile}
                    onAccepted={(entry, request) => {
                        // Accepted: an ordinary chat now, opened (design §4.5), found under All when they come back.
                        setActiveTab('all');
                        setActiveConv({ ...entry, request });
                        loadMembers();
                        void loadConversations();
                    }}
                    onChanged={() => { void loadConversations(); }}
                    onReport={(pubkey, name) => setReportTarget({ pubkey, name })}
                />
            ) : activeTab === 'groups' && !hasGroups ? (
                // On a card as the list is, so the words never sit on the page's doodles.
                <div data-testid="groups-empty" style={{ textAlign: 'center', padding: '2rem 1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: '1rem' }}>
                    <p aria-hidden="true" style={{ fontSize: '2.75rem', margin: 0 }}>🌻</p>
                    <p style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-primary)', margin: '0.6rem 0 0' }}>{t('No groups yet')}</p>
                    <p style={{ fontSize: '0.9rem', lineHeight: 1.45, color: 'var(--text-secondary)', margin: '0.4rem auto 0', maxWidth: '28rem' }}>
                        {t("A group is a chat for some people rather than everyone — your street, a garden crew, a choir. Enterprises you keep and events you're going to show up here too.")}
                    </p>
                    <button
                        onClick={() => setShowCreateGroup(true)}
                        style={{
                            marginTop: '1rem', minHeight: '44px', padding: '0.55rem 1.25rem', borderRadius: '12px', border: 'none',
                            background: 'var(--text-primary)', color: 'var(--bg-primary)', fontWeight: 700, fontSize: '0.95rem',
                            cursor: 'pointer', fontFamily: 'inherit',
                        }}
                    >
                        <span aria-hidden="true">+ </span>{t('New group')}
                    </button>
                    <div>
                        <button
                            onClick={findGroups}
                            style={{
                                marginTop: '0.5rem', minHeight: '44px', padding: '0.5rem 0.75rem', border: 'none', background: 'none',
                                color: 'var(--link)', fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer', fontFamily: 'inherit',
                            }}
                        >
                            {t('Find a group to join →')}
                        </button>
                    </div>
                </div>
            ) : conversations.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-faint)' }}>
                    <p style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>💬</p>
                    <p>{t('No conversations yet.')}</p>
                    <p style={{ fontSize: '0.85rem' }}>{t('Start by sending a DM or creating a group.')}</p>
                </div>
            ) : (
                <div className="bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm divide-y divide-nature-100 dark:divide-nature-800 overflow-hidden">
                    {listedConversations
                        .filter(c => inConversationTab(c, activeTab))
                        .sort((a, b) => {
                            // Transactions Tab sorting priority
                            if (activeTab === 'transactions') {
                                const isAActive = ['active', 'pending'].includes(a.postStatus || '');
                                const isBActive = ['active', 'pending'].includes(b.postStatus || '');
                                if (isAActive && !isBActive) return -1;
                                if (!isAActive && isBActive) return 1;
                            }
                            
                            // Default Unread & Date sorting priority
                            const aUnread = a.unreadCount || 0;
                            const bUnread = b.unreadCount || 0;
                            if (aUnread > 0 && bUnread === 0) return -1;
                            if (bUnread > 0 && aUnread === 0) return 1;
                            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
                        })
                        .map(conv => {
                            // A finished trade with this DM's other person that I haven't rated (lib/trade-review) — the
                            // same answer the chat's rate button gives, as the phone's chat list does. Not the thread's
                            // last line: a trade chat is one DM per pair, its post_id NULL, so that read "unrated" forever.
                            const convPeer = conv.type === 'dm' ? (conv.participants?.find(p => p !== identity.publicKey) || '') : '';
                            const needsReview = !!convPeer && !!unratedTradeWith(userTransactions, identity.publicKey, convPeer);
                            // The deals with this person whose next step is mine (core's dealsNeedingMe): the phone's per-deal
                            // Action Required. Beans of mine held in trust to release, or a request on my listing to answer.
                            const dealsToAct = convPeer ? (dealsNeedingMeByPeer.get(convPeer) ?? []) : [];
                            const dealsToActWords = dealsToAct.every(tx => dealStep(tx, identity.publicKey).state === 'to-release')
                                ? tn(dealsToAct.length, 'Release Credits ({n})', 'Release Credits ({n})')
                                : tn(dealsToAct.length, 'Action Required ({n})', 'Action Required ({n})');

                            return (
                            <div
                                key={conv.id}
                                onClick={() => { setActiveConv(conv); loadMembers(); }}
                                className={`p-3 px-4 flex items-center gap-3 cursor-pointer transition-colors hover:bg-oat-50/50 dark:hover:bg-nature-800/30 ${
                                    needsReview || dealsToAct.length > 0 ? 'bg-amber-50/40 dark:bg-amber-950/10 border-l-4 border-amber-500 pl-3' : ''
                                }`}
                            >
                                {conv.postId ? (
                                    <div style={{
                                        width: '44px', height: '44px', borderRadius: '12px',
                                        overflow: 'hidden', flexShrink: 0, position: 'relative',
                                        background: '#d1fae5', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    }}>
                                        {conv.postPhoto ? (
                                            <img src={listPhotoUrl(conv.postPhoto)} alt="" style={{
                                                width: '44px', height: '44px', objectFit: 'cover', borderRadius: '12px',
                                            }} />
                                        ) : (
                                            <span style={{ fontSize: '1.3rem' }}>🛍️</span>
                                        )}
                                        {/* Peer profile overlay */}
                                        <div style={{
                                            position: 'absolute', bottom: '-3px', right: '-3px',
                                            width: '22px', height: '22px', borderRadius: '50%',
                                            border: '2px solid var(--bg-primary)', overflow: 'hidden',
                                        }}>
                                            {renderAvatar(conv.peerAvatar, chatFaceKey(conv), 22)}
                                        </div>
                                        {(conv.unreadCount || 0) > 0 && (
                                            <span style={{
                                                position: 'absolute', top: '-4px', left: '-4px',
                                                background: 'var(--danger)', color: 'var(--on-danger, #fff)', fontSize: '0.6rem', fontWeight: 700,
                                                minWidth: '16px', height: '16px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                padding: '0 3px', lineHeight: 1, boxShadow: '0 0 6px var(--danger)',
                                            }}>{conv.unreadCount! > 99 ? '99+' : conv.unreadCount}</span>
                                        )}
                                    </div>
                                ) : (
                                    <div style={{ position: 'relative', flexShrink: 0 }}>
                                        {conv.type === 'group_thread'
                                            ? renderAvatar(groupChatPicture(conv), conv.id, 44, { border: '1px solid var(--border-primary)' })
                                            : renderAvatar(conv.peerAvatar, chatFaceKey(conv), 44)}
                                        {(conv.unreadCount || 0) > 0 && (
                                            <span style={{
                                                position: 'absolute', top: '-4px', right: '-4px',
                                                background: 'var(--danger)', color: 'var(--on-danger, #fff)', fontSize: '0.6rem', fontWeight: 700,
                                                minWidth: '16px', height: '16px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                padding: '0 3px', lineHeight: 1, boxShadow: '0 0 6px var(--danger)',
                                            }}>{conv.unreadCount! > 99 ? '99+' : conv.unreadCount}</span>
                                        )}
                                    </div>
                                )}
    
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '0.4rem', fontWeight: (conv.unreadCount || 0) > 0 ? 700 : 600, fontSize: '0.95rem' }}>
                                        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{getConversationTitle(conv)}</span>
                                        {/* The member's own request, not accepted yet (design §4.4): a small tag, and nothing more.
                                            Only once the chat has a line: the node makes the request's row at the open, before
                                            they type, and nobody is asked anything until they write (engine/dm-requests.ts). */}
                                        {conv.type === 'dm' && conv.request && conv.request.state !== 'accepted' && conv.request.from === identity.publicKey && conv.lastMsgType && (
                                            <span data-testid="request-tag" style={{
                                                fontSize: '0.7rem', fontWeight: 700, padding: '1px 7px', borderRadius: '999px',
                                                background: 'var(--bp-chip-accent-tint)', color: 'var(--bp-chip-accent-ink)', border: '1px solid var(--bp-chip-accent-border)',
                                            }}>
                                                {t('request', undefined, "tag: the member's own message request, still waiting")}
                                            </span>
                                        )}
                                    </div>
                                    {/* The listing's title, then its status: the status drops under the title rather than squeezing it
                                        (a longer language's status at 320 px left the title a few pixels wide). */}
                                    {conv.postTitle && (
                                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '0.5rem', rowGap: '0.15rem', marginTop: '0.15rem' }}>
                                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, maxWidth: '100%' }}>
                                                {conv.postTitle}
                                            </div>
                                            {conv.postStatus && (
                                                <div style={{
                                                    padding: '2px 6px', borderRadius: '4px', fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.5px',
                                                    background: conv.postStatus === 'active' ? '#dbeafe' : conv.postStatus === 'pending' ? '#d1fae5' : '#f3f4f6',
                                                    color: conv.postStatus === 'active' ? '#1d4ed8' : conv.postStatus === 'pending' ? '#047857' : '#4b5563',
                                                }}>
                                                    {postStatusWords(conv.postStatus)}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {!conv.postTitle && (
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {conv.type === 'group_thread' ? tn(conv.participants.length, '{n} member', '{n} members') : conversationDate(conv.createdAt)}
                                        </div>
                                    )}
                                    
                                    {needsReview && (
                                        <div style={{ fontSize: '0.75rem', color: '#d97706', fontWeight: 700, marginTop: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                            <span style={{ fontSize: '0.8rem' }}>⭐</span> {t('Action Needed: Review Partner')}
                                        </div>
                                    )}
                                    {dealsToAct.length > 0 && (
                                        <div style={{ marginTop: '0.25rem' }}>
                                            <span data-testid="deal-action-chip" style={{
                                                display: 'inline-flex', alignItems: 'center', gap: '0.25rem', padding: '2px 8px', borderRadius: '12px',
                                                fontSize: '0.75rem', fontWeight: 700, background: 'var(--bp-chip-warn-tint)', color: 'var(--bp-chip-warn-ink)',
                                            }}>
                                                <span aria-hidden="true">⚡</span><span>{dealsToActWords}</span>
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                            );
                        })}
                </div>
            )}

            {/* A request card's 🚩 Report (the chat has its own, in its header). */}
            {reportTarget && (
                <ReportModal
                    isOpen={!!reportTarget}
                    onClose={() => setReportTarget(null)}
                    reporterPubkey={identity.publicKey}
                    targetPubkey={reportTarget.pubkey}
                    targetName={reportTarget.name}
                />
            )}
        </div>
    );
}
