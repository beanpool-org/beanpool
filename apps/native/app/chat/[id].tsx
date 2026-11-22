import React, { useState, useRef, useCallback, useEffect } from 'react';
import { askPhotoSource } from '../../utils/post-photo';
import { View, Text, StyleSheet, Pressable, FlatList, ScrollView, Image, Linking, DeviceEventEmitter, AppState, useWindowDimensions, type AppStateStatus } from 'react-native';
import { LightBarModal } from '../../components/LightBarModal';
import { Alert } from '../../utils/keyboard-alert';
import { KeyboardAvoidingView, KeyboardController, useKeyboardState } from 'react-native-keyboard-controller';
import { withJitter } from '../../utils/jitter';
import { dealStateWords, dealStep, formatHundredths, freePriceWords, isLiveStanding, itemDealTitle, itemTrustLine, normaliseTappedUrl, t, tn, requestModeOf, requestTakesPhoto, requestAfterOwnLine, requestReportNotSentWords, chatAboutDrafts, type RequestReportOutcome } from '@beanpool/core';
import { localDealRow, localDealMoves, isChatStripDeal } from '../../utils/deal-rows';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, useFocusEffect, Stack, ErrorBoundary } from 'expo-router';
import { leaveScreen } from '../../utils/leave-screen';
import { PUSH_RECEIVED_EVENT } from '../../utils/app-events';

export { ErrorBoundary };
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import { chatPhotoDataUri } from '../../utils/chat-photo';
import { useIdentity } from '../IdentityContext';
import { getMessages, getConversation, insertMessage, editMessage, sendImageMessage, sendVoiceMessage, getDecryptedVoice, syncMessages, syncSingleConversation, markConversationRead, oldestUnreadAt, completeMarketplaceTransaction, cancelMarketplaceTransaction, getDealsBetween, syncDealsBetween, stopStandingDeal, lowerStandingPeriod, answerStandingAsk, withdrawStandingAsk, whileChatInPlace, getDb, toggleMessageReactionApi, deleteLocalMessage, deleteMessageApi, muteChatApi, getKnownChatMute, getConversationKind, knownDmConversationId, isHeldGroupChat, isLockedGroupChat, getDmKeyChange, getDmKeyCodeInfo, acceptOfferedPeer, decideMessageRequest, reportDmLine, enterChatInPlace, leaveChatInPlace, type DmKeyChange } from '../../utils/db';
import { isDmPinStoreError } from '../../utils/dm-peer-pins';
import { DmKeyChangedPane } from '../../components/chat/DmKeyChangedPane';
import { ChatScrollPage } from '../../components/chat/ChatScrollPage';
import { chatColumnFit } from '../../utils/chat-column-fit';
import { DmKeyChangedNotice } from '../../components/chat/DmKeyChangedNotice';
import { ChatImage, dmKeyContextOf } from '../../components/chat/DmChatImage';
import { dmKeyBannerMaxHeight, dmKeyCodeShowsVerified } from '../../utils/dm-key-change';
import { keyCodeOf } from '../../utils/key-code';
import { EventChatView } from '../../components/EventChatView';
import { GroupChatView } from '../../components/GroupChatView';
import { routeChat, screenIdOf, type ChatRoute as ChatRouteAnswer, type ChatRouteAsks } from '../../utils/chat-route';
import { chatInPlaceRoute, type ChatInPlaceRoute } from '../../utils/held-chats';
import { openInCommunity } from '../../utils/open-in-community';
import { postRoute } from '../../utils/post-after-join';
import { useNodeStatus } from '../NodeStatusContext';
import { getBlockedUsers, BLOCKLIST_UPDATED_EVENT } from '../../utils/blocklist';
import { dmPeerName, isDmBlocked } from '../../utils/dm-blocked';
import { hapticSuccess, hapticWarning } from '../../utils/haptics';
import { ReviewModal } from '../../components/ReviewModal';
import { StandingPanel, type StandingLowerStep } from '../../components/StandingDeal';
import { MemberAvatar } from '../../components/MemberAvatar';
import { palette } from '../../constants/colors';
import { useTheme, useStyles } from '../ThemeContext';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';
import { useNodeProfile } from '../../utils/use-node-profile';
import { beansOn, getCachedNodeProfile, type NodeFeatures } from '../../utils/node-profile';
import { makeChatStyles } from '../../components/chat/styles';
import { ChatMessageList, scrollChatToBottom } from '../../components/chat/ChatMessageList';
import { ChatMessageRow } from '../../components/chat/ChatMessageRow';
import { ChatEditBanner, ChatMenuSheet, ChatReplyBanner, type ChatMenuItem } from '../../components/chat/ChatBanners';
import { ChatAboutBanner, ChatAboutCard } from '../../components/chat/ChatAbout';
import { useAboutListings } from '../../utils/about-listings';
import { releaseLineTradeId, type PhoneTradeRow } from '../../utils/release-line-trade';
import { ChatComposer, type ChatComposerHandle } from '../../components/chat/ChatComposer';
import { VoiceBubble } from '../../components/chat/VoiceBubble';
import { VoicePlaybackProvider } from '../../components/chat/VoicePlayback';
import { VOICE_LINES_WORDS, voiceLinesOn, type VoiceInput } from '@beanpool/core';
import { VoiceNotSentError, voiceSendWithin } from '../../utils/voice-recorder';
import { newVoiceAudioOwner } from '../../utils/voice-audio';
import { useChatSoftInputMode } from '../../components/chat/useChatSoftInputMode';
import { refusedSendNotice, restoredDraft, dmKeyChangedLine, dmLineSlotText, DM_LOCK_WORDS } from '../../utils/dm-lock';
import {
    buildChatListItems, chatActionErrorMessage, dmQuoteFor, hasAnyAction, isTombstone, messageActions, messageTime, tombstoneText,
    shouldFollowNewMessages, shouldShowChatLoadError, requestDecisionFailureWords, requestIsGone, type ChatViewer,
} from '../../utils/chat-actions';
import { isMuted, muteMenuLabel, type YourChatMute } from '../../utils/your-groups';
// db.ts and the DM line checks never reach the words layer: the sentences they write are translated where shown.
import { chatLineWords } from '../../utils/chat-line-words';
import { listingHeaderStatusWords } from '../../utils/listing-status-words';
import { NotDeliveredMark } from '../../components/chat/NotDeliveredMark';
import { NotSeenLine } from '../../components/chat/NotSeenLine';
import { chatMoment, takeNotifyMoment, useNotifyLine, useScreenShowing, type NotifyLineOffer } from '../../components/NotifyLine';
import { notSeenInThread, notSeenWords, notifyWaitedDays } from '@beanpool/core';
import { Sentence } from '../../components/Sentence';
import { signedRequestWords } from '../../components/signed-request-lines';
import { ReportMessageSheet } from '../../components/ReportMessageSheet';
import { reportedAlertBody } from '../../utils/reportReasons';
import { reportRequestAndBlock, ReportedNotBlockedError, requestLineIn, wordsOfLine } from '../../utils/request-report';
import { useScreenKeyboardOffset } from '../../components/useScreenKeyboardOffset';

// The edit window, the emoji row, the day labels, the link splitting, the bubble, the action buttons and
// the composer all moved to utils/chat-actions, components/chat/* and core's chat-links (chat parity,
// 2026-09-23), so a group chat behaves the same way rather than nearly the same way.

// History window (WhatsApp-style): open with the newest page, grow by a page each
// time the user scrolls up to the oldest loaded message. Keeps open-a-chat cost
// (SQLite read + per-message decrypt) flat no matter how long the thread is.
const MESSAGE_PAGE_SIZE = 50;

// Bound an await so a hung step can never latch sendingRef forever — a hung
// insertMessage left the send button silently dead until an app restart
// (field report 2026-07-18). The underlying work isn't cancelled; the caller's
// catch/finally run and the UI stays usable.
/** The same keys as before keeps the same array, so a reload that changed nothing never re-reads the block list. */
function keepKeys(prev: string[], next: string[]): string[] {
    return prev.length === next.length && prev.every((k, i) => k === next[i]) ? prev : next;
}

/** In place (slice S6c): the deals with the person that their own community has answered, by id, and how the asking stands. */
interface DealsThere { ids: ReadonlyMap<string, { postAuthorPublicKey?: string | null; postType?: string | null; status?: string | null }>; state: 'asking' | 'answered' | 'failed' }
const DEALS_UNASKED: DealsThere = { ids: new Map(), state: 'asking' };
/**
 * In place: whether a deal's own community has answered about it this visit, and its row reads as that answer said (its
 * status as the node gave it; a node that gave none: any). A row the copy held before the answer was read back offers nothing.
 */
function answeredThere(there: DealsThere, deal: { txId: string; status?: string | null }): boolean {
    const said = there.ids.get(deal.txId);
    return !!said && (!said.status || said.status === deal.status);
}

function withTimeout<T>(promise: Promise<T>, ms: number, tooLong: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(tooLong)), ms)),
    ]);
}

/** What the route asks the phone (utils/chat-route.ts tests these wirings). */
const ROUTE_ASKS: ChatRouteAsks = { isHeldGroupChat, isLockedGroupChat, knownDmConversationId, getConversationKind };

/**
 * `/chat/:id` serves several kinds of conversation, and utils/chat-route.ts decides which screen, in this order: a group
 * whose keys this phone has held (its group chat, sealed or refused), a known DM (the DM screen), a chat this phone has seen
 * locked (its group chat), an event chat, a group's or an enterprise's thread, else a DM. An event chat is its own screen (docs/events-on-the-map.md §2.2): node-readable
 * `plaintext-v1`, members that follow the RSVPs, a host who can remove a message, read-only once the event ends — none of
 * which the DM pipeline below (E2E, edits, reactions, deals) knows about, and all of which it would quietly get wrong.
 *
 * Nothing draws until the phone has asked its own key memory, its DM list and the conversation's kind (a SecureStore read
 * and a few small SQLite reads; the node only when there is no row yet): every screen here can post, and which one may is
 * what is being decided. The held check is asked of the id lower-cased, and a group's screen gets that id; the DM guard is
 * asked of the link's own spelling, which it folds itself and answers whenever the phone knows a DM under it. So no
 * spelling is a DM to one check and a group to the next, and a link to a DM's own id opens that DM, never a twin in other
 * capitals (routeChat; #1841 review, findings 1 and 4; #1863 review). The Inbox row, the event detail and "Your groups"
 * say the kind on the way in (`event=1`, `group=1`, `enterprise=1`); the conversation's type is the fallback for an older
 * link or a push.
 */
export default function ChatRoute() {
    // `communityName` (a held row's, a contact's) is never shown: the name is the one the phone saved (#3305 review F2).
    const { id, event, group, enterprise, created, name, info, community } = useLocalSearchParams<{
        id?: string; event?: string; group?: string; enterprise?: string; created?: string; name?: string; info?: string;
        community?: string; communityName?: string;
    }>();
    const { identity } = useIdentity();
    // A chat named with a community (slice S2): what this phone holds there decides, before anything draws (#3305 review
    // F1). A link can carry any id and any address, so only a direct chat that community's own copy already holds opens in
    // place, at its saved address and under its saved name; the community in use takes the ordinary route; anything else
    // opens nothing there (utils/held-chats.ts chatInPlaceRoute).
    const placeKey = id && community ? `${String(community)}\n${String(id)}` : null;
    const [placed, setPlaced] = useState<{ for: string; answer: ChatInPlaceRoute } | null>(null);
    useEffect(() => {
        // Asked once the account on the phone is known (a link can open the app before it has loaded): until then nothing draws.
        if (!placeKey || !identity?.publicKey) return;
        let alive = true;
        setPlaced(null);
        chatInPlaceRoute(identity.publicKey, String(id), String(community))
            .catch((): ChatInPlaceRoute => ({ open: 'nothing' }))
            .then((answer) => { if (alive) setPlaced({ for: placeKey, answer }); });
        return () => { alive = false; };
        // The key names the id and the community; the account is read as the answer is asked.
    }, [placeKey, identity?.publicKey]);
    const placedNow = placeKey && placed?.for === placeKey ? placed.answer : null;
    // No community named, or the one in use: the ordinary route.
    const ordinary = !community || placedNow?.open === 'here';
    // The answer for the id it was asked of: a new id draws nothing until its own answer is in.
    const [route, setRoute] = useState<{ for: string; answer: ChatRouteAnswer } | null>(null);
    useEffect(() => {
        if (!id || !ordinary) return;
        let alive = true;
        setRoute(null);
        routeChat(ROUTE_ASKS, String(id), { event: event === '1', thread: group === '1' ? 'group' : enterprise === '1' ? 'enterprise' : null })
            .then(answer => { if (alive) setRoute({ for: String(id), answer }); });
        return () => { alive = false; };
    }, [id, event, group, enterprise, ordinary]);

    // A direct chat of another community this phone holds, read and written there in place (slice S2): its screen reaches
    // that community by name for everything.
    if (id && community && !placedNow) return null;
    // A group of that community (slice S6): the group's chat, its id as the node makes it.
    if (id && placedNow?.open === 'in-place' && placedNow.kind === 'group') return <GroupChatView kind="group" id={screenIdOf(String(id))} initialName={name} inPlace={{ community: placedNow.community, name: placedNow.name }} />;
    // An event of that community (slice S6): the event's chat, with that community's own gates.
    if (id && placedNow?.open === 'in-place' && placedNow.kind === 'event') return <EventChatView eventId={screenIdOf(String(id))} inPlace={{ community: placedNow.community, name: placedNow.name }} />;
    // One screen per chat and community (slice S6c): no deal, or anything else, of one is ever shown under another's name.
    if (id && placedNow?.open === 'in-place') return <ChatScreen key={placedNow.community + ' ' + id} id={String(id)} inPlace={{ community: placedNow.community, name: placedNow.name }} />;
    if (id && (placedNow?.open === 'move' || placedNow?.open === 'nothing')) return <ChatNotInPlace id={String(id)} where={placedNow} />;
    if (!id || !route || route.for !== String(id)) return null;
    const { view, screenId } = route.answer;
    if (view === 'group' || view === 'group_thread') return <GroupChatView kind="group" id={screenId} justCreated={created === '1'} initialName={name} openInfo={info === '1'} />;
    if (view === 'event') return <EventChatView eventId={screenId} />;
    if (view === 'enterprise_thread') return <GroupChatView kind="enterprise" id={screenId} justCreated={created === '1'} initialName={name} openInfo={info === '1'} />;
    return <ChatScreen key={screenId} id={screenId} />;
}

/**
 * A chat named with a community that doesn't open in place (#3305 review F1): nothing of that community's copy is opened,
 * read or written here, and nothing is asked of its server. A community this phone holds as a member: one tap moves the
 * phone there and opens the chat, as Chat's held row of a group's chat does (S1, utils/push-notice-switch.ts
 * openNoticeIn). Any other: only that the chat can't be opened.
 */
function ChatNotInPlace({ id, where }: { id: string; where: ChatInPlaceRoute }) {
    const { colors } = useTheme();
    const { identity } = useIdentity();
    const { recheck } = useNodeStatus();
    const [moving, setMoving] = useState(false);
    // A tap that moved nothing says so, as Chat's held rows do (app/(tabs)/chats.tsx switchNote): a join or a switch under
    // way (openNoticeIn's 'held'), or a switch that failed.
    const [moveNote, setMoveNote] = useState<string | null>(null);
    const move = where.open === 'move' ? where : null;
    // As Contacts' own move button (app/contacts.tsx `go`): central tokens, readable light and dark, 44 dp and wrapping.
    const styles = useStyles(({ colors: c }) => StyleSheet.create({
        page: { flex: 1, backgroundColor: c.surface.card },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
        back: { width: 44, height: 44, justifyContent: 'center', alignItems: 'flex-start' },
        body: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
        words: { fontSize: 15, color: c.text.body, lineHeight: 21, textAlign: 'center' },
        go: { minHeight: 44, maxWidth: '100%', paddingHorizontal: 16, borderRadius: 10, backgroundColor: c.brand.fill, alignItems: 'center', justifyContent: 'center' },
        goText: { fontSize: 15, fontWeight: '800', color: c.text.inverse, textAlign: 'center' },
    }));
    const moveThere = async () => {
        if (!move || !identity?.publicKey || moving) return;
        setMoveNote(null);
        setMoving(true);
        try {
            const result = await openInCommunity(move.community, `/chat/${id}`, identity.publicKey, recheck);
            if (result !== 'switched') setMoveNote(t("Something went wrong. Try again in a moment."));
        } finally {
            setMoving(false);
        }
    };
    return (
        <SafeAreaView style={styles.page} edges={['top', 'bottom']}>
            <View style={styles.header}>
                <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={() => leaveScreen(router, 'chat/[id]')} style={styles.back}>
                    <MaterialCommunityIcons name="arrow-left" size={28} color={colors.text.body} />
                </Pressable>
            </View>
            <View style={styles.body} testID="chat-not-in-place">
                <Text style={styles.words} accessibilityRole="alert">{t('Could not open this chat.')}</Text>
                {move ? (
                    <Pressable accessibilityRole="button" style={styles.go} disabled={moving} onPress={() => void moveThere()}>
                        <Text style={styles.goText}>{t('Open {community} ›', { community: move.name })}</Text>
                    </Pressable>
                ) : null}
                {move && moveNote ? <Text style={styles.words} accessibilityRole="alert">{moveNote}</Text> : null}
            </View>
        </SafeAreaView>
    );
}

/**
 * The DM screen, on routeChat's id: a known DM's own spelling, else the link's. `inPlace`: a DM of another community this
 * phone holds, read and written there without a switch (slice S2): every read and write below names it (`at`). Its deals are
 * that community's (slice S6c): read from it, and every step on one asked of it, never of the community in use. What isn't
 * done there is not offered (photos and voice sent, a profile), or says so and offers the move (a listing, a request to answer).
 */
function ChatScreen({ id, inPlace }: { id: string; inPlace?: { community: string; name: string } }) {
    const { theme, colors } = useTheme();
    // The community this chat lives in when it is not the one in use: undefined, the one in use, as before.
    const at = inPlace?.community;
    const { triggerReview, txId: txIdParam, focusTx, prefill } = useLocalSearchParams<{ triggerReview?: string; txId?: string; focusTx?: string; prefill?: string }>();
    const { identity } = useIdentity();
    const { recheck } = useNodeStatus();
    const [messages, setMessages] = useState<any[]>([]);
    const [activeMessageActionsId, setActiveMessageActionsId] = useState<string | null>(null);
    const [activeEmojiPickerId, setActiveEmojiPickerId] = useState<string | null>(null);
    const [pickerPosition, setPickerPosition] = useState<'top' | 'bottom'>('top');
    const [peerName, setPeerName] = useState(() => t('Loading...'));
    const [peerPubkey, setPeerPubkey] = useState<string | null>(null);
    /** Every key the other person is known by here (utils/db.ts getConversation peerKeys): a block of any holds the thread. */
    const [peerKeys, setPeerKeys] = useState<string[]>([]);
    // `blocks`: Report on a request, and the sender it blocks. `item` is then the request's line, or null with none left.
    const [reportingLine, setReportingLine] = useState<{ item: any; blocks: string | null } | null>(null);
    const [isPeerBlocked, setIsPeerBlocked] = useState(false);
    const [peerAvatar, setPeerAvatar] = useState<string | null>(null);
    // True when this thread is a 2-party DM (the only threads we E2E-encrypt).
    const [isEncrypted, setIsEncrypted] = useState(false);
    const [postContext, setPostContext] = useState<any>(null);
    // On a community with Beans off (the worldwide one) a post has no price: the header under it says none.
    const nodeProfile = useNodeProfile();
    // In place (slice S6c) that profile is the community in use's: a deal of the chat's own community shows its Beans as that
    // community says, from what this phone last heard of it (no network; unknown counts as Beans on, as beansOn reads it).
    const [placeFeatures, setPlaceFeatures] = useState<NodeFeatures | null>(null);
    React.useEffect(() => {
        if (!at) return;
        let live = true;
        getCachedNodeProfile(at).then(p => { if (live) setPlaceFeatures(p?.features ?? null); }, () => {});
        return () => { live = false; };
    }, [at]);
    const showsBeans = at ? beansOn(placeFeatures) : beansOn(nodeProfile?.features);
    // Voice messages only where the community says it takes them (core voiceLinesOn; a live community, 14 Nov): a node from before
    // voice V2 stores one as words with a sound no one can play. Read at send time from the ref, as the recorder holds the
    // onVoice it was given while a recording waits.
    const voiceHere = !at && voiceLinesOn(nodeProfile?.features);
    const voiceHereRef = useRef(voiceHere);
    voiceHereRef.current = voiceHere;
    // `amount_c`: what the deal holds, whole hundredths of a Bean (null when the phone holds no figure for it).
    const [pendingTx, setPendingTx] = useState<{ id: string; amount_c: number | null; isPayer: boolean } | null>(null);
    const [isDynamicContext, setIsDynamicContext] = useState(false);
    const [actionLoading, setActionLoading] = useState(false);
    const [promptReviewForTx, setPromptReviewForTx] = useState<{ txId: string; targetPubkey: string; targetCallsign: string } | null>(null);
    const [ratedPostIds, setRatedPostIds] = useState<Set<string>>(new Set());
    // The trades I rated, by id: a release line names its own trade (metadata.transactionId), and one pair can trade the
    // same repeatable offer twice, so "a rating on this post" can be the other deal's (Marty 15 Oct, web; same here).
    const [ratedTxIds, setRatedTxIds] = useState<Set<string>>(new Set());
    // My finished trades: an old release line (no transactionId) is read against them (utils/release-line-trade).
    const [myCompletedTrades, setMyCompletedTrades] = useState<PhoneTradeRow[]>([]);
    const [replyToMessage, setReplyToMessage] = useState<any | null>(null);
    const [editingMessage, setEditingMessage] = useState<any | null>(null);
    const [deals, setDeals] = useState<any[]>([]);
    // In place (slice S6c): the deals with this person their own community answered since this chat came into view, by id, as
    // its copy now holds them (syncDealsBetween). A money step shows on no other deal there: a copy not synced since the phone
    // was last set to it may be weeks old. `failed`: that community didn't answer.
    const [dealsThere, setDealsThere] = useState<DealsThere>(DEALS_UNASKED);
    const [viewerUri, setViewerUri] = useState<string | null>(null);
    // The first local read has come back (a cold database open is not instant), and what went wrong if it did not.
    const [firstLoadDone, setFirstLoadDone] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    // A DM line that couldn't be locked was not sent (utils/dm-lock): one plain line above the box, until a send goes.
    const [lockNotice, setLockNotice] = useState<string | null>(null);
    // This screen's owner of the audio session's holds (utils/voice-audio.ts): its player and its recorder share it, so a
    // recording waiting here never stops play in a chat opened on top of this one.
    const [voiceOwner] = useState(() => newVoiceAudioOwner(String(id)));
    // The node lists another key in place of the one this phone pinned for the chat (utils/dm-peer-pins.ts): the box is
    // disabled, with one line, until the member decides on the banner below the header. Every send refuses meanwhile (db.ts).
    // First sight that found lines it couldn't place (rule 5 of the §3.4 amendment) has the banner too, with the listed
    // key's code, or Not now only (15 Oct words design, D1), and rule 5's own line under the box.
    const [keyChange, setKeyChange] = useState<DmKeyChange | null>(null);
    const keyChangePending = !!keyChange;
    const unplaced = !!keyChange?.unplaced;
    // "Verified ✓" beside "🔒 End-to-end encrypted" (DESIGN-dm-key-signal-model §7 S2): while the member's mark holds and no
    // new key waits, exactly when the key code screen shows it.
    const [peerVerified, setPeerVerified] = useState(false);
    // The key card's page (the card, then the bars down to the thread) has the column under the header as measured, less
    // the box and a keyboard still up (utils/dm-key-change dmKeyBannerMaxHeight): the paused box is never cut, edge-to-edge
    // too, and the thread gives way while nothing can be sent (walk of 17 Nov at 320 dp and 1.3× text).
    const { height: windowHeight } = useWindowDimensions();
    const [column, setColumn] = useState({ column: 0, composer: 0 });
    const measured = (part: 'composer') => (e: { nativeEvent: { layout: { height: number } } }) => {
        const h = Math.round(e.nativeEvent.layout.height);
        setColumn((c) => (c[part] === h ? c : { ...c, [part]: h }));
    };
    // The column runs from the header's bottom to the KeyboardAvoidingView's bottom, both read in the screen's own frame.
    // Never measure it with a View wrapped round the KeyboardAvoidingView: the library pads by its frame IN ITS PARENT
    // (y + height − the keyboard's top), so a wrapper starting under the header made the padding short by the header and
    // the keyboard covered the composer in every DM (1.2.61; utils/__tests__/chat-keyboard-tree.test.ts).
    const columnEdges = useRef({ header: 0, bottom: 0 });
    // The screen's top in the window, for the KeyboardAvoidingView: a DM opened from a listing is an iPhone sheet that
    // starts ~50 pt down, and without it the keyboard covered the message box (Rob, 17 Nov; utils/screen-keyboard-offset).
    const screenKeyboard = useScreenKeyboardOffset();
    const measuredEdge = (edge: 'header' | 'bottom') => (e: { nativeEvent: { layout: { y: number; height: number } } }) => {
        columnEdges.current[edge] = Math.round(e.nativeEvent.layout.y + e.nativeEvent.layout.height);
        const { header, bottom } = columnEdges.current;
        if (header > 0 && bottom > header) setColumn((c) => (c.column === bottom - header ? c : { ...c, column: bottom - header }));
    };
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
    // True from the focus effect's start to its cleanup: a read still on its way once the chat is left asks nothing more
    // (no mark read, nothing shown), so nothing is asked of a chat in place's community after it is left (#3305 review).
    const inViewRef = useRef(false);
    const messagesLenRef = useRef(0);
    const loadingOlderRef = useRef(false);
    // While the keyboard is up, KeyboardAvoidingView already lifts the input bar to sit
    // on the keyboard — adding the nav-bar inset on top of that shows as a dead gap.
    const keyboardVisible = useKeyboardState(s => s.isVisible);
    // A keyboard already up when a pause starts pads the column's KeyboardAvoidingView by up to its height: the banner's
    // cap takes it off the room, so the paused box is never under it (#1872/#1873 confirmation 2, finding 5).
    const keyboardHeight = useKeyboardState(s => (s.isVisible ? s.height : 0));
    // Without the card, the column shares its room in an order (utils/chat-column-fit): the composer whole, the Editing or
    // Replying to banner whole beside it (the field stops growing first), one line of the thread, then the bars and the
    // About chip, which scroll as pages or fold away while typing on a small phone (walk of 17 Nov: a market DM at 320 dp
    // and 1.3× left the thread 0 dp and the box under the keyboard; deciding review of f4bbcfa4: the banner folded). The
    // composer and the banner are measured on their own, so no room waits on its own height. While a line's menu or emoji
    // row is open the thread keeps room for the line and its menu (CHAT_MENU_ROOM), the bars and the About chip giving way,
    // so Reply and Edit are in view (emulator walk 146: in one line of thread only Copy showed, and dragging it closes the menu).
    const [inputHeight, setInputHeight] = useState(0);
    const [bannerHeight, setBannerHeight] = useState(0);
    const fit = chatColumnFit({
        column: column.column, box: column.composer, input: inputHeight, banner: bannerHeight,
        windowHeight, keyboard: keyboardHeight, paused: keyChangePending,
        menu: !!(activeMessageActionsId || activeEmojiPickerId),
    });
    // Modals get their own native window, and keyboard-controller only hears keyboard
    // events on the main window. If a modal opens while the keyboard is up, the hide
    // happens under the modal's window and the chat stays padded by a phantom keyboard
    // (screen squeezed into the top half). So: fully dismiss the keyboard BEFORE any
    // modal is allowed to mount.
    const [reviewModalReady, setReviewModalReady] = useState(false);
    const [convRow, setConvRow] = useState<any>(null);
    const [cancellingRequest, setCancellingRequest] = useState(false);
    const [decidingRequest, setDecidingRequest] = useState(false);
    // The node has answered this chat's poll since it opened (syncSingleConversation): until then what this phone holds
    // may not be the node's word on a message request (PR #2540 review 4393642152).
    const [nodeAnswered, setNodeAnswered] = useState(false);
    useEffect(() => { setNodeAnswered(false); }, [id]);
    // The request's line sent from here (insertMessage's id) until the node has taken it or refused it: the chat reads as
    // waiting only once the node has taken it, as the web waits for the 200 (review 4393642166).
    const [requestLineId, setRequestLineId] = useState<string | null>(null);
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
        // 44 x 44 dp, its own target (it was 40): the arrow stays at the header's left edge, where it was drawn.
        backButton: { width: 44, height: 44, justifyContent: 'center', alignItems: 'flex-start' },
        headerProfileContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', marginLeft: 8, gap: 10 },
        headerTextContainer: { flex: 1, justifyContent: 'center' },
        headerTitle: { fontSize: 16, fontWeight: '800', color: colors.text.body, letterSpacing: 0.5 },
        headerSubtitle: { fontSize: 11, color: colors.brand.primary, fontWeight: '600', marginTop: 2 },
        // A chat in place (slice S2): its community's name in grey under the person's, as Chat's held row says it.
        headerCommunity: { fontSize: 11, color: colors.text.secondary, fontWeight: '600', marginTop: 2 },
        // The subtitle's row: "🔒 End-to-end encrypted" gives way first at 320 dp and 1.3× text, so "Verified ✓" stays whole.
        headerSubtitleRow: { flexDirection: 'row', alignItems: 'center' },
        headerSubtitleText: { flexShrink: 1 },
        headerVerified: { flexShrink: 0, marginLeft: 6 },
        moreButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'flex-end' },
        stickyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.emerald50, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme === 'dark' ? colors.border.default : palette.emerald100 },
        stickyHeaderLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, paddingRight: 16 },
        stickyPostTitle: { fontSize: 15, fontWeight: '700', color: theme === 'dark' ? colors.text.body : palette.emerald800 },
        stickyPostCredits: { fontSize: 13, color: colors.brand.primary, fontWeight: '600', marginTop: 2 },
        statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
        statusBadgeText: { fontSize: 11, fontWeight: '800' },
        keyboardView: { flex: 1 },
        // Pinned active-deals strip
        dealStrip: { backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.green50, borderBottomWidth: 1, borderBottomColor: theme === 'dark' ? colors.border.default : palette.green200 },
        dealCard: { backgroundColor: colors.surface.card, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.emerald100, width: 200 },
        dealCardTitle: { fontSize: 14, fontWeight: '800', color: colors.text.body },
        dealCardMeta: { fontSize: 12, color: colors.text.secondary, marginTop: 2, marginBottom: 8 },
        // Wraps: in a longer language Cancel goes under Release rather than squeezing it in the 200dp card.
        dealCardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
        dealBtn: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
        dealBtnRelease: { backgroundColor: colors.brand.fill, flex: 1 },
        dealBtnReleaseText: { color: colors.text.inverse, fontWeight: '800', fontSize: 13 },
        dealBtnCancel: { backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.red50, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.red200 },
        dealBtnCancelText: { color: colors.feedback.danger.fg, fontWeight: '700', fontSize: 13 },
        dealBtnReview: { backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.amber50, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.amber200, flex: 1 },
        dealBtnReviewText: { color: theme === 'dark' ? colors.text.body : colors.feedback.warning.fg, fontWeight: '800', fontSize: 13 },
        standingThere: { paddingHorizontal: 12, paddingTop: 10, backgroundColor: colors.surface.card },
        dealsUnread: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.surface.card },
        dealsUnreadText: { flex: 1, minWidth: 160, fontSize: 13, color: colors.text.secondary },
        dealsUnreadBtn: { flex: 0, minHeight: 44, paddingHorizontal: 16 },
        dealAwaiting: { color: colors.text.secondary, fontSize: 12, fontWeight: '600', fontStyle: 'italic' },
        // Full-screen image viewer
        imageViewerOverlay: { flex: 1, backgroundColor: colors.overlay.imageViewerBg, alignItems: 'center', justifyContent: 'center' },
        imageViewerImage: { width: '100%', height: '100%' },
        imageViewerClose: { position: 'absolute', top: 50, right: 20, width: 44, height: 44, borderRadius: 22, backgroundColor: colors.overlay.imageViewerCloseBg, alignItems: 'center', justifyContent: 'center' },
        // Inline Action Bar
        inlineActionBar: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, gap: 8, backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.yellow50, borderBottomWidth: 1, borderBottomColor: theme === 'dark' ? colors.border.default : palette.yellow200 },
        inlineActionBtn: { flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingVertical: 10, borderRadius: 10 },
        inlineActionRelease: { backgroundColor: colors.brand.fill },
        inlineActionReleaseText: { color: colors.text.inverse, fontWeight: '800', fontSize: 14 },
        inlineActionCancel: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.red300 },
        inlineActionCancelText: { color: colors.feedback.danger.fg, fontWeight: '700', fontSize: 14 },
        blockedNotice: { padding: 14, alignItems: 'center', marginHorizontal: 12, borderRadius: 12, backgroundColor: colors.feedback.danger.bg, borderWidth: 1, borderColor: colors.feedback.danger.border },
        blockedNoticeText: { color: colors.feedback.danger.fg, fontSize: 13, fontWeight: '700' },
        waitingContainer: {
            padding: 12,
            marginHorizontal: 12,
            borderRadius: 12,
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.gray50,
            borderWidth: 1,
            borderColor: colors.border.default,
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
        },
        waitingText: {
            flex: 1,
            minWidth: 160,
            fontSize: 13,
            color: colors.text.secondary,
            lineHeight: 18,
        },
        cancelRequestBtn: {
            minHeight: 44,
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border.default,
            backgroundColor: colors.surface.card,
            justifyContent: 'center',
            alignItems: 'center',
        },
        cancelRequestBtnText: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.text.body,
        },
        toMeContainer: {
            padding: 12,
            marginHorizontal: 12,
            borderRadius: 12,
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.default,
            gap: 6,
        },
        toMeTitle: {
            fontSize: 14,
            fontWeight: '800',
            color: colors.text.body,
        },
        toMeSubtitle: {
            fontSize: 12,
            color: colors.text.secondary,
            marginBottom: 4,
        },
        toMeButtons: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
        },
        toMeAcceptBtn: {
            flex: 1,
            minWidth: 100,
            minHeight: 44,
            backgroundColor: colors.brand.fill,
            borderRadius: 10,
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 12,
        },
        toMeAcceptBtnText: {
            color: colors.text.inverse,
            fontWeight: '800',
            fontSize: 13,
        },
        toMeIgnoreBtn: {
            flex: 1,
            minWidth: 100,
            minHeight: 44,
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.gray100,
            borderWidth: 1,
            borderColor: colors.border.default,
            borderRadius: 10,
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 12,
        },
        toMeIgnoreBtnText: {
            color: colors.text.body,
            fontWeight: '700',
            fontSize: 13,
        },
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
        Linking.openURL(url).catch(() => Alert.alert(t('Cannot open link'), url));
    }, []);

    // The list is inverted (newest message = index 0), so "bottom" is offset 0.
    const scrollToBottom = useCallback((animated: boolean) => {
        scrollChatToBottom(flatListRef, animated);
    }, []);

    // The window's soft-input mode — the same hook every chat calls.
    useChatSoftInputMode();

    const loadRatedTransactions = useCallback(async () => {
        // The release lines' ratings are the community in use's: in place (slice S6c) a deal is rated from its card.
        if (!identity?.publicKey || at) return;
        try {
            const db = await getDb();
            const ratedRows = await db.getAllAsync<any>(
                "SELECT mt.post_id, mt.id AS tx_id FROM ratings r JOIN marketplace_transactions mt ON r.transaction_id = mt.id WHERE r.rater_pubkey = ?",
                [identity.publicKey]
            );
            const ids = new Set<string>(ratedRows.map(r => r.post_id).filter(Boolean));
            setRatedPostIds(ids);
            setRatedTxIds(new Set<string>(ratedRows.map(r => r.tx_id).filter(Boolean)));
            setMyCompletedTrades(await db.getAllAsync<PhoneTradeRow>(
                "SELECT id, post_id, buyer_pubkey, seller_pubkey, completed_at, created_at FROM marketplace_transactions WHERE status='completed' AND (buyer_pubkey = ? OR seller_pubkey = ?) ORDER BY completed_at DESC",
                [identity.publicKey, identity.publicKey]
            ));
        } catch (e) {
            console.error("[Chat] Failed to load rated transaction list:", e);
        }
    }, [identity?.publicKey, at]);

    // Blocked when any key the other person is known by here is on the block list (utils/dm-blocked.ts): the name order
    // may pick their new key after a re-key, and the member blocked the old one (review of #3268, finding 2).
    const peerKeysKey = (peerKeys.length > 0 ? peerKeys : (peerPubkey ? [peerPubkey] : [])).join(',');
    useEffect(() => {
        const keys = peerKeysKey ? peerKeysKey.split(',') : [];
        if (keys.length === 0) return;
        let isMounted = true;
        const read = async () => {
            try {
                const blocked = isDmBlocked(keys, await getBlockedUsers());
                if (isMounted) setIsPeerBlocked(blocked);
            } catch {
                // A list that can't be read changes nothing shown: getBlockedUsers answers [] itself when storage fails.
            }
        };
        void read();
        const sub = DeviceEventEmitter.addListener(BLOCKLIST_UPDATED_EVENT, () => { void read(); });
        return () => {
            isMounted = false;
            sub.remove();
        };
    }, [peerKeysKey]);

    const loadConversationData = useCallback(async () => {
        if (id && identity?.publicKey) {
            let res: any;
            try {
                res = await getConversation(id as string, identity.publicKey, at);
            } catch (e: any) {
                // A read refused (in place: that community's copy can't be opened now, or the chat was left meanwhile): its
                // name is never "Loading..." for good (#3305 review F4), and nothing more is read or asked. The thread's own
                // read, refused the same way, shows the chat's not-available words (loadMessages).
                if (!inViewRef.current) return;
                console.warn('[Chat] Could not read this conversation:', e?.message || e);
                setPeerName(String(id).slice(0, 8));
                return;
            }
            if (res) {
                setConvRow(res);
                // Talk's list and Needs you name it by the same rule (utils/dm-blocked.ts dmPeerName): never the conversation's id.
                setPeerName(dmPeerName(res));
                if (res.otherPubkey) setPeerPubkey(res.otherPubkey);
                setPeerKeys(prev => keepKeys(prev, Array.isArray(res.peerKeys) ? res.peerKeys : []));
                setIsEncrypted(res.type === 'dm' && !!res.otherPubkey);
                setPeerAvatar(res.otherAvatar || null);
                if (res.postId && !at) {
                    setPostContext({
                        id: res.postId,
                        title: res.postTitle,
                        status: res.postStatus,
                        priceType: res.price_type,
                        // The listing's price, whole hundredths of a Bean (null: no figure, shown "—").
                        price_c: res.price_c
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
                                    targetCallsign: dmPeerName(res)
                                });
                            }
                        } catch (e) {
                            console.error('[Rating] Auto-trigger review load failed:', e);
                        }
                    }
                } else {
                    setIsDynamicContext(true);
                }
                // Track pending transaction for inline action bar (in place it comes from that community's deals, below)
                if (res.pendingTxId && identity.publicKey && !at) {
                    setPendingTx({
                        id: res.pendingTxId,
                        amount_c: res.pendingAmount_c ?? null,
                        isPayer: res.txBuyerPubkey === identity.publicKey
                    });
                } else if (res.postId) {
                    setPendingTx(null);
                }

                // Consolidated-thread review deep-link: the inbox passes the specific deal's txId
                // (per-pair threads have no postId, so the post-based trigger above won't fire).
                if (triggerReview === 'true' && txIdParam && !promptedRef.current && res.otherPubkey && !at) {
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
    }, [id, identity, triggerReview, at]);

    // All deals with this peer, from local SQLite. Re-queried on focus, on the poll,
    // and on sync events below so a deal written moments after navigation
    // (e.g. accept-offer → chat) still surfaces without a remount.
    const loadDeals = useCallback(async () => {
        if (!identity?.publicKey || !peerPubkey || (at && !inViewRef.current)) return;
        try {
            const next = await getDealsBetween(identity.publicKey, peerPubkey, at);
            if (at && !inViewRef.current) return;
            // Polled every few seconds — keep the previous reference when nothing
            // changed so unchanged ticks don't re-render the thread.
            setDeals(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
        } catch (e) {
            console.warn('[Deals] load failed', e);
        }
    }, [identity?.publicKey, peerPubkey, at]);

    React.useEffect(() => { loadDeals(); }, [loadDeals]);
    // In place (slice S6c): the chat's own community is asked for its deals with this person, one ask at a time; one wanted
    // while another is on its way (a step just taken) is asked after it, so the newest answer is the last one kept.
    const dealsAsk = useRef<{ running: Promise<void> | null; again: boolean }>({ running: null, again: false });
    const askDeals = useCallback((): Promise<void> => {
        const ask = dealsAsk.current;
        if (!at || !identity?.publicKey || !peerPubkey || !inViewRef.current) return Promise.resolve();
        if (ask.running) { ask.again = true; return ask.running; }
        const me = identity.publicKey;
        ask.running = (async () => {
            do {
                ask.again = false;
                const ids = await syncDealsBetween(me, peerPubkey, at).catch(() => null);
                if (!inViewRef.current) return;
                // The copy as that answer wrote it is read back first: a step shows only on the deal as its community now says
                // it is, never on the row the copy held before (a release made elsewhere drew Release for one read: #3363 N1).
                await loadDeals();
                if (!inViewRef.current) return;
                setDealsThere(prev => (ids ? { ids, state: 'answered' } : prev.state === 'answered' ? prev : { ids: prev.ids, state: 'failed' }));
            } while (ask.again && inViewRef.current);
        })().finally(() => { ask.running = null; });
        return ask.running;
    }, [identity?.publicKey, peerPubkey, at, loadDeals]);
    const askDealsRef = useRef(askDeals);
    askDealsRef.current = askDeals;
    // Asked once the person is known, and whenever a deal's own line comes (funded, released, cancelled, a standing deal's).
    const dealLines = at ? messages.reduce((n, m: any) => n + (m.type === 'system' || m.senderId === 'SYSTEM' ? 1 : 0), 0) : 0;
    React.useEffect(() => { void askDeals(); }, [askDeals, dealLines]);
    // The peer's key, once read, changes loadDeals, and the focus effect runs again so an ordinary chat's deals read under
    // it. In place that re-run would let go of the community's copy and hold it again, cutting the first poll from that
    // community's server on its way (#3305 review): there the key arriving runs the effects above and nothing else again.
    const dealsRerun = at ? null : loadDeals;

    useFocusEffect(
        useCallback(() => {
            setReplyToMessage(null);
            setEditingMessage(null);
            // Fresh window on each (re)open — a long thread starts at one page again.
            msgLimitRef.current = MESSAGE_PAGE_SIZE;
            let interval: ReturnType<typeof setInterval> | null = null;
            let appStateSub: any = null;
            promptedRef.current = false;
            // From here to the cleanup: a follow-up of anything begun meanwhile (a poll, a push, the first sync) that lands
            // once the chat is left runs nothing (#3305 review). In place, db.ts refuses the copy too (enterChatInPlace).
            let active = true;
            inViewRef.current = true;
            // Held in place (slice S2) before the first read: its copy opens again, once a close still under way is done.
            if (at) enterChatInPlace(at);
            // Its deals are that community's word from this visit only (slice S6c).
            if (at) { setDealsThere(DEALS_UNASKED); void askDealsRef.current(); }

            let sub: any = null;
            let wsSub: any = null;
            if (id && identity?.publicKey) {
                // Initial Load
                loadConversationData();
                loadRatedTransactions();
                loadDeals();
                loadMessages().then(() => {
                    // The whole sync is the community in use's: a chat in place polls its own community below.
                    if (at || !active) return;
                    syncMessages(identity!.publicKey).then(() => {
                        if (!active) return;
                        loadConversationData();
                        loadMessages(true);
                        loadRatedTransactions();
                        loadDeals();
                    });
                });

                // Background Poll. The chat is the node's word once its answer is read back here (nodeAnswered).
                // In place (slice S2): every few seconds from that community's own server, no socket of its own.
                // A poll or a push whose answer lands once the chat is left: nothing more is read or asked.
                const afterSingle = async (answered: boolean) => {
                    if (!active) return;
                    loadDeals();
                    await Promise.all([loadConversationData(), loadMessages(true)]);
                    if (active && answered !== false) setNodeAnswered(true);
                };
                const pollSingle = () => {
                    syncSingleConversation(id as string, at).then(afterSingle);
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

                sub = DeviceEventEmitter.addListener('sync_data_updated', () => {
                    if (!active) return;
                    loadConversationData();
                    loadMessages(true);
                    loadRatedTransactions();
                    loadDeals();
                });

                // Fast path: the WebSocket doorbell nudges us to refresh THIS
                // conversation immediately with a single targeted fetch, rather
                // than waiting for the heavier full reconciliation (requestSync)
                // to finish and emit 'sync_data_updated'.
                // In place, the doorbell is a push from that community (utils/push-notifications.ts PUSH_RECEIVED_EVENT): the
                // socket is the community in use's.
                wsSub = DeviceEventEmitter.addListener(at ? PUSH_RECEIVED_EVENT : 'ws_activity', () => {
                    if (active && AppState.currentState === 'active') {
                        syncSingleConversation(id as string, at).then(afterSingle);
                        // In place, a push may be a deal's step with no line of its own (a standing deal's ask).
                        if (at) void askDealsRef.current();
                    }
                });
            }
            return () => {
                active = false;
                inViewRef.current = false;
                if (interval) clearInterval(interval);
                if (appStateSub) appStateSub.remove();
                if (sub) sub.remove();
                if (wsSub) wsSub.remove();
                // Left: that community's copy open in place closes, and opens for nothing until the chat is back (or its key
                // code screen holds it: then it closes as that screen goes).
                if (at) void leaveChatInPlace(at);
            };
        }, [id, identity, loadConversationData, dealsRerun, at])
    );

    // Change signature for the poll-tick compare in loadMessages: every field that
    // can alter how a bubble renders, EXCEPT the message text — text is pinned by
    // (id, editedAt), and stringifying the full decrypted thread twice every 3s is
    // what made ticks expensive once the history window grew. Metadata stays in
    // (it's tiny and carries reactions/reply refs/send state).
    const messagesSignature = (rows: any[]) => rows.map(m =>
        [m.id, m.rawTimestamp, m.editedAt ?? '', m.readByPeer ? 1 : 0, m.sendState ?? '', m.type ?? '', m.text?.length ?? 0, m.metadata ? JSON.stringify(m.metadata) : '', m.integrityNote ?? '', m.unattributed ? 1 : 0, m.fromOfferedKey ? 1 : 0].join('\u0001')
    ).join('\u0002');

    const loadMessages = async (isBackgroundPoll = false) => {
        // Left (the focus effect's cleanup): nothing is read or asked, and one still on its way stops at the next step below
        // (#3305 review). In place, db.ts refuses that community's copy from the leave on as well (leaveChatInPlace).
        if (!inViewRef.current) return;
        // The fact line (slice N3): how long the oldest line unread here waited, read once on this screen from the phone's own
        // copy, before the thread is read and marked read below, so the named line's effect (after the first read) already
        // knows. Here, above the key check, which stays straight before the thread's read. Nothing read: no fact line, and
        // the thread reads as always.
        if (waitedRef.current === undefined && identity?.publicKey) {
            try {
                waitedRef.current = notifyWaitedDays(await oldestUnreadAt(id as string, identity.publicKey, at), Date.now());
            } catch {
                waitedRef.current = null;
            }
            if (!inViewRef.current) return;
        }
        // The key check first (DESIGN-dm-key-signal-model §7 S1): it applies the resting rule, so a person not marked
        // verified has already moved to the new key when the thread is read, and no frame shows the paused box or the
        // "Sent from the new key" line for them. Unreadable pins: the banner stays as it was (undefined), and a send says why
        // it refused. A rule-5 record comes back as a change too (unplaced).
        const change = await getDmKeyChange(id as string, at).catch(() => undefined);
        // Read after the check, so it sees the pin as the resting rule left it. Reads only; unreadable pins keep what showed.
        const codeInfo = await getDmKeyCodeInfo(id as string, at).catch(() => undefined);
        let data: any[];
        try {
            data = await getMessages(id as string, { limit: msgLimitRef.current, notices: true, community: at });
            setLoadError(null);
        } catch (e: any) {
            // A read refused because the chat was left meanwhile (in place: its copy is closed) is not this chat's error.
            if (!inViewRef.current) return;
            console.warn('[Chat] Could not read this conversation:', e?.message || e);
            setLoadError(e?.message || t('Could not open this chat.'));
            return;
        } finally {
            setFirstLoadDone(true);
        }
        // Left while it read: not marked read, nothing asked of the chat's server, nothing shown.
        if (!inViewRef.current) return;
        // Lines only: the key-changed notices are the phone's own and don't count toward the history window.
        messagesLenRef.current = data.filter((m: any) => !m.keyChangedNotice).length;
        if (change !== undefined) setKeyChange(change);
        if (codeInfo !== undefined) setPeerVerified(dmKeyCodeShowsVerified(codeInfo, keyCodeOf(codeInfo?.peer)));
        if (identity?.publicKey) {
            await markConversationRead(id as string, identity.publicKey, at).catch(() => {});
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

    // "Continue with the new key", after the member ticked that they checked the code with the person (pick 1). The pin
    // moves only to the key whose code the banner showed: if the node offered another meanwhile, nothing moves.
    const handleContinueWithNewKey = async (peer: string) => {
        try {
            const moved = await acceptOfferedPeer(id as string, peer, at);
            if (!moved) {
                const now = await getDmKeyChange(id as string, at).catch(() => undefined);
                if (now === null) Alert.alert(t('Nothing changed'), t('This chat no longer offers that key, so nothing was moved.'));
                else Alert.alert(t('Nothing changed'), t('The key on offer changed while you were checking. Look at the new code and check it again.'));
            }
        } catch (e: any) {
            Alert.alert(t('Nothing changed'), isDmPinStoreError(e) || !e?.message
                ? t("This phone couldn't read or save who this chat is with, so nothing was moved. Try again in a moment.")
                : chatLineWords(e.message));
        }
        await loadMessages(true).catch(() => {});
    };

    // Before the node has answered, a request for this reader is decided as one whose lines aren't read yet (the Accept card,
    // no composer), and a chat this phone holds no request on waits for the node, unless the reader opened it or has a line
    // in it the node took, which no request for them allows without accepting it (PR #2540 review 4393642152), or the node's
    // list named it among their chats, where no request waiting for them is: a DM someone else opened answers offline too
    // (review 4394120110). A local read is never the node's: the line may not be here yet, or be one its opener withdrew since.
    const me = identity?.publicKey ?? '';
    const heldRequest = convRow?.request ?? null;
    const requestKnown = nodeAnswered || (!!heldRequest && heldRequest.from === me)
        || (!!convRow && !heldRequest && (convRow.listed === 1 || convRow.createdBy === me || messages.some((m: any) => m.senderId === me && !m.sendState)));
    const modeFromRows = requestModeOf(convRow ? { ...convRow, id: String(id) } : null, me, firstLoadDone && requestKnown ? messages : null);
    const requestMode = modeFromRows === 'none' && !requestKnown && heldRequest?.state !== 'accepted' ? 'mine-loading' : modeFromRows;
    // The request's line sent from here: taken by the node, the chat waits for the other's answer; refused, or never
    // delivered, it stays unsent, the composer with it, and the line's mark says it didn't go (review 4393642166).
    useEffect(() => {
        if (!requestLineId) return;
        const line = messages.find((m: any) => m.id === requestLineId);
        if (!line || line.sendState === 'sending') return;
        setRequestLineId(null);
        if (line.sendState === 'failed' || !identity?.publicKey) return;
        setConvRow((prev: any) => prev ? { ...prev, request: requestAfterOwnLine(prev.request, identity.publicKey) } : prev);
    }, [messages, requestLineId, identity?.publicKey]);

    const handleCancelRequest = async () => {
        if (cancellingRequest) return;
        setCancellingRequest(true);
        try {
            const answer = await decideMessageRequest(String(id), 'cancel', at);
            const nextRequest = answer.request ?? { ...convRow?.request, nextLineIsRequest: true };
            setConvRow((prev: any) => prev ? { ...prev, request: nextRequest } : prev);
            if (messages.length > 0) {
                for (const m of messages) {
                    if (m.keyChangedNotice) continue;
                    await deleteLocalMessage(m.id, at).catch(() => {});
                }
            }
            await loadMessages(true);
            void syncSingleConversation(String(id), at);
        } catch (e: any) {
            Alert.alert(t('Could not cancel request'), e.message ? chatLineWords(e.message) : t('That did not go through. Please try again.'));
        } finally {
            setCancellingRequest(false);
        }
    };

    // A request holds every send until it is decided, or the node has answered; the opener's, once their line is in, until
    // the other accepts. Not an edit of that line, which the node and the web allow (PR #2540 review 4394827275).
    const requestLine = requestMode === 'to-me' ? requestLineIn(messages, identity?.publicKey, heldRequest?.at) : null;
    // With no line here, only the node's word says none is left: this phone may just not have it yet.
    // In place too (slice S3): its report and block go to the chat's own community (submitLineReport, `at`).
    const canReportRequest = !!requestLine || nodeAnswered;
    const requestHoldsSends = requestMode === 'to-me' || requestMode === 'mine-loading' || (requestMode === 'mine-waiting' && !editingMessage);
    // The named line at the member's own moment (slice N2a; core's rule says whether: each kind once on a phone, one soft ask
    // a day, never after the phone's no): "Hear when {name} answers." under my first message sent, "Hear when {name} writes
    // again." under their line read here (a request accepted included), "Hear when {name} says yes." after a request on
    // their listing (app/post/[id].tsx hands that moment over; it waits for a line to hang under). One per visit.
    // A visit is while the chat is in front: a screen opened over it (a profile, a listing) and back, and the line is gone.
    const inFront = useScreenShowing();
    const notify = useNotifyLine(identity?.publicKey, inFront);
    const namedFor = convRow && peerPubkey ? peerName : null;
    const momentRef = useRef<NotifyLineOffer | null>(null);
    /** Whole days the oldest unread line waited when this screen first read the thread (core notifyWaitedDays); undefined: not read yet. */
    const waitedRef = useRef<number | null | undefined>(undefined);
    useEffect(() => {
        const m = takeNotifyMoment(chatMoment(String(id)));
        if (m) momentRef.current = m;
    }, [id]);

    // Asked before the composer empties the box, so a refused send keeps what was typed.
    const canSendNow = () => !!identity?.publicKey && !isPeerBlocked && !keyChangePending && !sendingRef.current && !requestLineId && !requestHoldsSends;

    // An Edit fills the box once it is drawn: while the opener's request waits, the composer only appears with the edit
    // (review 4394827275), so it isn't there yet when Edit is tapped.
    useEffect(() => {
        if (editingMessage) composerRef.current?.setText(editingMessage.text || '');
    }, [editingMessage]);

    // The composer owns the box and hands over the text it has already cleared and put under its sweep.
    const handleSend = async (currentDraft: string) => {
        if (!currentDraft || !canSendNow() || !identity?.publicKey || requestHoldsSends) return;

        sendingRef.current = true;
        const wasEditing = editingMessage;
        try {
            if (wasEditing) {
                await withTimeout(editMessage(id as string, wasEditing.id, currentDraft, at), 15_000, t('Editing is taking too long — please try again.'));
                setEditingMessage(null);
                loadMessages(true);
            } else {
                let metadata: string | undefined = undefined;
                if (replyToMessage) {
                    metadata = JSON.stringify({ replyToId: replyToMessage.id });
                }
                // The listing the member came from (Message on a Need or an Offer) goes with this line, sealed beside its words; the
                // chip is spent once the line is written, and the line itself holds it from there, so a Resend carries it too.
                const about = chatAboutDrafts.get(String(id));
                const sentId = await withTimeout(insertMessage(id as string, identity.publicKey, currentDraft, metadata, undefined, about, at), 15_000, t('Sending is taking too long — please try again.'));
                if (about) chatAboutDrafts.drop(String(id));
                setReplyToMessage(null);
                // Written here and on its way: the chat waits only once the node has taken it (the effect above).
                if (requestMode === 'mine-unsent' && typeof sentId === 'string') setRequestLineId(sentId);
                // A request's moment, if one waits, takes this line instead (the effect below).
                if (typeof sentId === 'string' && namedFor && !momentRef.current) void notify.offer({ kind: 'answer', name: namedFor, anchor: sentId, align: 'end' });
                loadMessages();
            }
            setLockNotice(null);
        } catch (err: any) {
            const refused = refusedSendNotice(err, peerPubkey ? peerName : null);
            if (refused) {
                // Nothing went (the line couldn't be locked, or the phone couldn't read its group key memory). The words
                // go back in the box (with anything typed since), an edit stays an edit, and the next Send tries again.
                hapticWarning();
                composerRef.current?.setText(restoredDraft(currentDraft, composerRef.current?.currentText() ?? ''));
                setLockNotice(refused);
                return;
            }
            Alert.alert(wasEditing ? t('Edit Failed') : t('Message Failed'), err.message ? chatLineWords(err.message) : t('Could not execute send.'));
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
        Alert.alert(t('Delete for everyone?'), t('It will read "This message was deleted" for both of you.'), [
            { text: t('Cancel'), style: 'cancel' },
            { text: t('Delete'), style: 'destructive', onPress: async () => {
                try {
                    await deleteMessageApi(item.id, at);
                    hapticSuccess();
                    loadMessages(true);
                } catch (e: any) {
                    hapticWarning();
                    Alert.alert(t('Not deleted'), chatActionErrorMessage(e));
                }
            } },
        ]);
    };

    const setMuteTo = async (duration: '8h' | '1w' | 'always' | 'off') => {
        setMuteOpen(false);
        setMenuOpen(false);
        try {
            const res = await muteChatApi(id as string, duration, at);
            setMute(duration === 'off' ? null : (res?.mute ?? { conversationId: String(id), mutedUntil: null, always: duration === 'always' }));
        } catch (e: any) {
            Alert.alert(t('Not changed'), chatActionErrorMessage(e));
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
        const errorText = (typeof item.metadata?.__sendError === 'string' && item.metadata.__sendError.trim())
            ? chatLineWords(item.metadata.__sendError)
            : t('This message could not be sent.');
        Alert.alert(t('Message not delivered'), errorText, [
            { text: t('Discard'), style: 'destructive', onPress: async () => {
                await deleteLocalMessage(item.id, at).catch(() => {});
                loadMessages(true);
            }},
            { text: t('Resend'), onPress: async () => {
                if (!identity?.publicKey) return;
                const meta = { ...(item.metadata || {}) };
                delete meta.__sendState;
                delete meta.__sendError;
                const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : undefined;
                try {
                    // Reuse the failed row's id: if the original POST actually landed
                    // (timeout after server commit), the retry is idempotent instead
                    // of a duplicate the peer sees twice. insertMessage replaces the
                    // failed row only once the words are locked, so a resend that
                    // can't be locked leaves it here to try again.
                    const sentId = await insertMessage(id as string, identity.publicKey, item.text, metaStr, item.id, undefined, at);
                    if (requestMode === 'mine-unsent' && typeof sentId === 'string') setRequestLineId(sentId);
                    setLockNotice(null);
                } catch (e: any) {
                    const refused = refusedSendNotice(e, peerPubkey ? peerName : null);
                    if (refused) setLockNotice(refused);
                    else Alert.alert(t('Message Failed'), e.message ? chatLineWords(e.message) : t('Could not resend.'));
                }
                loadMessages(true);
            }},
            { text: t('Cancel'), style: 'cancel' },
        ]);
    };

    // A voice message (DESIGN-cross-chat-voice-fable.md §5.3, slice V3): only in a chat both have accepted, never as a
    // request (§3.5). Awaits the node as a photo does; a refusal shows above the box as the photo's does, anything else the
    // recorder says. Either way it throws, so the recorder keeps the recording for another try (PR #3112 review, round 2):
    // the same line id (`lineId`, the recording's own) on every try, and the 60 s gives the send up for real (its POST
    // aborted, nothing written here after), so a Send after a timeout is the node's duplicate, never a second message.
    const sendVoice = async (voice: VoiceInput, lineId: string) => {
        // The community no longer says it takes voice messages (asked again since the recording began): kept, not sent. Never
        // in place (slice S2): a voice message goes to the community in use.
        if (!voiceHereRef.current || at) {
            const why = t(VOICE_LINES_WORDS.notTaken);
            setLockNotice(why);
            throw new VoiceNotSentError(why);
        }
        if (!identity?.publicKey || sendingRef.current) throw new Error(t('Wait for the last message to go.'));
        sendingRef.current = true;
        try {
            const metadata = replyToMessage ? JSON.stringify({ replyToId: replyToMessage.id }) : undefined;
            await voiceSendWithin(60_000, t('Sending the voice message is taking too long — please try again.'),
                (signal) => sendVoiceMessage(id as string, voice, metadata, { messageId: lineId, signal }));
            setReplyToMessage(null);
            setLockNotice(null);
            hapticSuccess();
            loadMessages();
        } catch (err: any) {
            hapticWarning();
            const refused = refusedSendNotice(err, peerPubkey ? peerName : null);
            // Said above the box; not sent, so the recorder keeps it and says nothing more.
            if (refused) { setLockNotice(refused); throw new VoiceNotSentError(refused); }
            throw new Error(err?.message ? chatLineWords(err.message) : t('Could not send the voice message.'));
        } finally {
            sendingRef.current = false;
        }
    };

    const pickAndSendImage = async () => {
        // Photos go to the community in use: not offered in place (slice S2).
        if (!identity?.publicKey || sendingRef.current || at) return;
        if (!requestTakesPhoto(requestMode) || requestLineId) return;
        // Same phantom-keyboard hazard as the review modal: the source-picker Alert and
        // the image-picker Activity are separate windows — hide the keyboard first.
        await KeyboardController.dismiss();
        const sendUri = async (asset: ImagePicker.ImagePickerAsset) => {
            sendingRef.current = true;
            try {
                // Within 800 px on its longest side, as every chat photo (utils/chat-photo.ts; Marty, 25 Oct).
                const dataUri = await withTimeout(chatPhotoDataUri(asset), 30_000, t('Processing the image is taking too long — please try again.'));
                let metadata: string | undefined = undefined;
                if (replyToMessage) {
                    metadata = JSON.stringify({ replyToId: replyToMessage.id });
                }
                // Image sends still await the server round-trip (not optimistic) —
                // the timeout keeps a dead network from latching sendingRef forever.
                await withTimeout(sendImageMessage(id as string, dataUri, '', metadata), 60_000, t('Sending the image is taking too long — please try again.'));
                setReplyToMessage(null);
                setConvRow((prev: any) => prev ? { ...prev, request: requestAfterOwnLine(prev.request, identity.publicKey) } : prev);
                setLockNotice(null);
                hapticSuccess();
                loadMessages();
            } catch (err: any) {
                hapticWarning();
                const refused = refusedSendNotice(err, peerPubkey ? peerName : null);
                if (refused) setLockNotice(refused);
                else Alert.alert(t('Image Failed'), err.message ? chatLineWords(err.message) : t('Could not send image.'));
            } finally {
                sendingRef.current = false;
            }
        };
        askPhotoSource(t('Send Photo'), {
            camera: async () => {
                const perm = await ImagePicker.requestCameraPermissionsAsync();
                if (!perm.granted) { Alert.alert(t('Permission needed'), t('Camera access is required.')); return; }
                const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
                if (!r.canceled && r.assets[0]?.uri) sendUri(r.assets[0]);
            },
            gallery: async () => {
                const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, defaultTab: 'albums' });
                if (!r.canceled && r.assets[0]?.uri) sendUri(r.assets[0]);
            },
            files: async () => {
                const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, legacy: true });
                if (!r.canceled && r.assets[0]?.uri) sendUri(r.assets[0]);
            },
        });
    };

    const handleReleaseCredits = async () => {
        // In place (slice S6c) it is released in the deal's own community, by name (`at`), never in the one in use.
        if (!pendingTx || !identity?.publicKey) return;
        await KeyboardController.dismiss(); // Alert = separate window; see review-modal note
        // English writes one form for both; a language with more forms has them.
        Alert.alert(
            t('Release Beans'),
            tn((pendingTx.amount_c ?? 0) / 100, 'Release {n} Beans to the provider? This action cannot be undone.', 'Release {n} Beans to the provider? This action cannot be undone.', { n: formatHundredths(pendingTx.amount_c) }),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Release'),
                    style: 'destructive',
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            await whileChatInPlace(at, () => completeMarketplaceTransaction(pendingTx.id, identity.publicKey, undefined, at));
                            hapticSuccess();
                            Alert.alert(t('Success'), t('The Beans have been released!'));
                            
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
                            syncSingleConversation(id as string, at).then(() => {
                                loadConversationData();
                                loadDeals();
                                loadMessages(true);
                            });
                            void askDeals();
                        } catch (e: any) {
                            hapticWarning();
                            Alert.alert(t('Failed'), e.message ? signedRequestWords(e.message) : t('Could not release the Beans.'));
                            // No answer, or a refusal: what became of it is that community's word, asked again.
                            void askDeals();
                        } finally {
                            setActionLoading(false);
                        }
                    }
                }
            ]
        );
    };

    const handleCancelEscrow = async () => {
        // In place (slice S6c), in the deal's own community, as the release above.
        if (!pendingTx || !identity?.publicKey) return;
        await KeyboardController.dismiss();
        Alert.alert(
            t('Cancel Hold'),
            t('Are you sure you want to cancel this hold? The Beans held in trust will be refunded.'),
            [
                { text: t('Keep'), style: 'cancel' },
                {
                    text: t('Cancel Hold'),
                    style: 'destructive',
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            await whileChatInPlace(at, () => cancelMarketplaceTransaction(pendingTx.id, identity.publicKey, at));
                            hapticWarning();
                            Alert.alert(t('Cancelled'), t('The hold has been cancelled and the Beans refunded.'));
                            syncSingleConversation(id as string, at).then(() => {
                                loadConversationData();
                                loadDeals();
                                loadMessages(true);
                            });
                            void askDeals();
                        } catch (e: any) {
                            hapticWarning();
                            Alert.alert(t('Failed'), e.message ? signedRequestWords(e.message) : t('Could not cancel the hold.'));
                            void askDeals();
                        } finally {
                            setActionLoading(false);
                        }
                    }
                }
            ]
        );
    };

    // ---- Consolidated thread: per-deal action handlers (loadDeals lives above the focus effect) ----

    // Pinned-strip deals: live escrow, a completed deal still awaiting my review, or a request on my listing waiting for my
    // answer (core's dealStep `to-answer`: the web's strip carries it too, and Talk's Action Required counts it, so the chat
    // it opens must show it). My own request, a declined one and a stranger's are not here.
    const myKey = identity?.publicKey;
    // In place (slice S6c) that community's copy may not hold a deal's listing: whose it is, and its kind, as its node says them.
    const shownDeals = React.useMemo(() => (at ? deals.map(d => ({
        ...d,
        postAuthorPublicKey: d.postAuthorPublicKey ?? dealsThere.ids.get(d.txId)?.postAuthorPublicKey,
        postType: d.postType ?? dealsThere.ids.get(d.txId)?.postType,
    })) : deals), [deals, dealsThere, at]);
    // Which deals and which buttons are core's one rule (dealMoves, through utils/deal-rows): a standing deal's rows never
    // show Release or Cancel, and only its first period asks for a review (DESIGN-standing-deals-upfront-fable §0, §3).
    const activeDeals = React.useMemo(
        () => (myKey ? shownDeals.filter(d => isChatStripDeal(d, myKey)) : []),
        [shownDeals, myKey]
    );
    // The deals a money step may show on: in place (slice S6c), those their own community has answered this visit.
    const actDeals = React.useMemo(() => (at ? shownDeals.filter(d => answeredThere(dealsThere, d)) : shownDeals), [shownDeals, dealsThere, at]);
    // A standing deal's panel is on its listing's page, which doesn't open in place: there it is here, over the cards.
    const standing = React.useMemo(() => (at && myKey ? shownDeals.filter(d => isLiveStanding(localDealRow(d, myKey))) : []), [shownDeals, at, myKey]);
    const standingThere = standing.filter(d => answeredThere(dealsThere, d));

    // The inline bar's deal, as core reads it: Release and Cancel only where dealMoves offers them. A deal the phone hasn't
    // read yet shows no bar (never a button the node would refuse).
    const pendingMoves = React.useMemo(() => {
        if (!pendingTx || !myKey) return null;
        const d = actDeals.find(x => x.txId === pendingTx.id);
        return d ? localDealMoves(d, myKey) : null;
    }, [actDeals, pendingTx, myKey]);
    const showInlineBar = !!pendingTx && !!pendingMoves?.release && postContext?.status === 'pending';

    // Filter out the deal from the top strip if it is currently displayed in the richer bottom Inline Action Bar
    const visibleDeals = React.useMemo(() => {
        return activeDeals.filter(d => !(showInlineBar && d.txId === pendingTx?.id));
    }, [activeDeals, pendingTx, showInlineBar]);

    // Reactive dynamic context: if there is no hardcoded postContext (consolidated thread),
    // derive postContext and pendingTx automatically from active deals where the user is the buyer.
    React.useEffect(() => {
        if (!isDynamicContext) return;

        let selectedDeal = null;
        const me = identity?.publicKey ?? '';
        if (focusTx) {
            selectedDeal = actDeals.find(d => d.txId === focusTx && (localDealMoves(d, me)?.cancelHold || localDealMoves(d, me)?.release));
        }
        if (!selectedDeal) {
            selectedDeal = actDeals.find(d => localDealMoves(d, me)?.release);
        }

        if (selectedDeal) {
            setPendingTx({
                id: selectedDeal.txId,
                amount_c: selectedDeal.amount_c ?? null,
                isPayer: selectedDeal.iAmBuyer
            });
            setPostContext({
                id: selectedDeal.postId || '',
                title: selectedDeal.postTitle || t('Deal'),
                status: selectedDeal.status || 'pending',
                priceType: 'fixed',
                price_c: selectedDeal.amount_c ?? null
            });
        } else {
            setPendingTx(null);
            setPostContext(null);
        }
    }, [actDeals, isDynamicContext, focusTx, identity?.publicKey]);

    // postId -> item title, so escrow events can be labelled by deal in the merged timeline.
    const dealTitleByPostId = React.useMemo(() => {
        const map: Record<string, string> = {};
        for (const d of deals) if (d.postId && d.postTitle) map[d.postId] = d.postTitle;
        return map;
    }, [deals]);

    /** `amount_c`: what the deal holds, whole hundredths of a Bean (null: no figure, said "—"). */
    const handleReleaseDeal = async (txId: string, amount_c: number | null) => {
        if (!identity?.publicKey) return;
        await KeyboardController.dismiss();
        Alert.alert(t('Release Beans'), tn((amount_c ?? 0) / 100, 'Release {n} Beans to the provider? This action is final.', 'Release {n} Beans to the provider? This action is final.', { n: formatHundredths(amount_c) }), [
            { text: t('Cancel'), style: 'cancel' },
            { text: t('Release'), style: 'destructive', onPress: async () => {
                setActionLoading(true);
                try {
                    await whileChatInPlace(at, () => completeMarketplaceTransaction(txId, identity.publicKey, undefined, at));
                    hapticSuccess();
                    if (peerPubkey) setPromptReviewForTx({ txId, targetPubkey: peerPubkey, targetCallsign: peerName });
                    await syncSingleConversation(id as string, at);
                    await askDeals();
                    await loadDeals();
                    loadMessages(true);
                } catch (e: any) {
                    hapticWarning();
                    Alert.alert(t('Failed'), e.message ? signedRequestWords(e.message) : t('Could not release the Beans.'));
                    void askDeals();
                } finally { setActionLoading(false); }
            }}
        ]);
    };

    const handleCancelDeal = async (txId: string) => {
        if (!identity?.publicKey) return;
        await KeyboardController.dismiss();
        Alert.alert(t('Cancel Deal'), t('Cancel this deal? The Beans held in trust will be refunded.'), [
            { text: t('Keep'), style: 'cancel' },
            { text: t('Cancel Deal'), style: 'destructive', onPress: async () => {
                setActionLoading(true);
                try {
                    await whileChatInPlace(at, () => cancelMarketplaceTransaction(txId, identity.publicKey, at));
                    hapticWarning();
                    await syncSingleConversation(id as string, at);
                    await askDeals();
                    await loadDeals();
                    loadMessages(true);
                } catch (e: any) {
                    hapticWarning();
                    Alert.alert(t('Failed'), e.message ? signedRequestWords(e.message) : t('Could not cancel.'));
                    void askDeals();
                } finally { setActionLoading(false); }
            }}
        ]);
    };

    const handleReviewDeal = (deal: any) => {
        if (peerPubkey) setPromptReviewForTx({ txId: deal.txId, targetPubkey: peerPubkey, targetCallsign: peerName });
    };

    // ---- In place (slice S6c): a standing deal's steps, and what isn't done here ----

    // Stop, as the listing's page asks it (the panel confirms, in core's words), asked of the deal's own community.
    const stopThere = async (standingId: string) => {
        if (!myKey) return;
        setActionLoading(true);
        try {
            await whileChatInPlace(at, () => stopStandingDeal(standingId, myKey, at));
            hapticSuccess();
        } catch (e: any) {
            hapticWarning();
            Alert.alert(t('Failed'), e?.message ? signedRequestWords(e.message) : t('Something went wrong. Try again in a moment.'));
        } finally {
            await askDeals();
            setActionLoading(false);
        }
    };
    // A short week's lowering, ask, answer or take-back: a refusal goes back to the panel in words, which shows it.
    const lowerThere = async (step: StandingLowerStep) => {
        try {
            await whileChatInPlace(at, async () => {
                if (step.move === 'lower') await lowerStandingPeriod(step.standingId, step.changeId, step.periodNo, step.beans_c, myKey, at);
                else if (step.move === 'answer') await answerStandingAsk(step.standingId, step.changeId, step.yes, myKey, at);
                else await withdrawStandingAsk(step.standingId, step.changeId, myKey, at);
            });
        } catch (e: any) {
            hapticWarning();
            void askDeals();
            throw new Error(e?.message ? signedRequestWords(e.message) : t('Something went wrong. Try again in a moment.'));
        }
        hapticSuccess();
        // Wait a little for that community's word, so the card doesn't offer the same step again meanwhile; never long.
        await Promise.race([askDeals(), new Promise(done => setTimeout(done, 5000))]);
    };
    // A listing (its deal's requests are answered there too) opens in its own community: says so, and one tap moves the phone
    // there through the one switch (utils/open-in-community.ts). A second tap while it moves does nothing.
    const movingThere = useRef(false);
    const openThere = async (postId: string, txId?: string) => {
        // Its id is that community's data: only one in the shape of a listing's id makes a route (#3363 N2).
        const route = postRoute(postId);
        if (!inPlace || !identity?.publicKey || !route || movingThere.current) return;
        movingThere.current = true;
        try {
            const moved = await openInCommunity(inPlace.community, `${route}${txId ? `?txId=${encodeURIComponent(txId)}` : ''}`, identity.publicKey, recheck);
            if (moved !== 'switched') Alert.alert(inPlace.name, t('Something went wrong. Try again in a moment.'));
        } finally {
            movingThere.current = false;
        }
    };
    const offerThere = async (title: string | null | undefined, postId: string, txId?: string) => {
        // No move is offered for an id that is no listing's.
        if (!inPlace || !postRoute(postId)) return;
        await Promise.race([KeyboardController.dismiss(), new Promise(r => setTimeout(r, 400))]);
        Alert.alert(inPlace.name, t('{title} is in {community}. Opens that community.', { title: title || t('Deal'), community: inPlace.name }), [
            { text: t('Cancel'), style: 'cancel' },
            { text: t('Open {community} ›', { community: inPlace.name }), onPress: () => { void openThere(postId, txId); } },
        ]);
    };
    /** A listing named in this chat: its page, or in place the offer to open it in its own community. */
    const openListing = (postId: string, title?: string | null, txId?: string) => {
        if (at) void offerThere(title, postId, txId);
        else if (txId) router.push({ pathname: '/post/[id]', params: { id: postId, txId } });
        else router.push(`/post/${postId}`);
    };

    // ⚡ Bolt: O(1) Map lookup for parent messages in reply threads instead of repeated O(M) .find() scans
    const messagesById = React.useMemo(() => new Map(messages.map(m => [m.id, m])), [messages]);

    // Day pills interleaved, then reversed for the inverted list. Shared with every chat so a group's
    // Today / Yesterday / "Mon, 12 May" reads exactly like a DM's (utils/chat-actions).
    const listItems = React.useMemo(() => buildChatListItems(messages), [messages]);
    // "Not seen yet." under my newest line the other person hasn't seen or answered (core notSeenInThread, slice N4): from
    // the tick and the times only, the same whoever they are. A notice, a node's line or one shown as nobody's is passed
    // over, and so is a deleted line (nothing left to see); a line still sending or failed has its own mark. Never while the
    // chat is a message request: the sender is told only what the node said, and it withholds the other's cursor until they
    // accept (engine/dm-requests.ts). Worked out when the thread changes.
    const notSeen = React.useMemo(() => {
        const myKey = identity?.publicKey;
        if (!myKey || requestMode !== 'none') return null;
        const found = notSeenInThread(messages.map((m: any) => ({
            mine: m.senderId === myKey && !!m.outgoing,
            at: m.rawTimestamp,
            seen: !!m.readByPeer,
            delivered: !m.sendState,
            counts: !m.keyChangedNotice && m.type !== 'system' && m.senderId !== 'SYSTEM' && !m.unattributed && !m.fromOfferedKey && !isTombstone(m),
        })), Date.now());
        return found ? { id: messages[found.index]?.id as string, notSeen: found.notSeen } : null;
    }, [messages, identity?.publicKey, requestMode]);
    // The newest line the named line can hang under: a person's, never a notice, a node's line or a deleted one.
    const newestLine = React.useMemo(() => {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m: any = messages[i];
            if (m.keyChangedNotice || m.type === 'system' || m.senderId === 'SYSTEM' || m.unattributed || m.fromOfferedKey || isTombstone(m)) continue;
            return { id: String(m.id), mine: !!identity?.publicKey && m.senderId === identity.publicKey };
        }
        return null;
    }, [messages, identity?.publicKey]);
    useEffect(() => {
        if (!firstLoadDone || !namedFor || !newestLine || isPeerBlocked || keyChangePending) return;
        const moment = momentRef.current;
        if (moment) {
            momentRef.current = null;
            void notify.offer({ ...moment, name: moment.name || namedFor, anchor: newestLine.id, align: newestLine.mine ? 'end' : 'start' });
        } else if (!newestLine.mine && requestMode === 'none') {
            const again: NotifyLineOffer = { kind: 'again', name: namedFor, anchor: newestLine.id };
            // It waited a day or more: "This waited 2 days for you. Tell me next time ›" in the named line's place, never both
            // (amend1 §4.3). Where core's rule won't have the fact line (shown in the last 30 days), the named line as before.
            const days = waitedRef.current;
            if (days) void notify.offer({ ...again, fact: days }).then((ok) => { if (!ok) void notify.offer(again); });
            else void notify.offer(again);
        }
    }, [firstLoadDone, namedFor, newestLine?.id, requestMode, isPeerBlocked, keyChangePending]);
    // The listings the messages name (Message on a listing; core chat-about.ts), as this member can read them.
    const aboutListings = useAboutListings(React.useMemo(() => (at ? [] : messages.filter((m) => m.about).map((m) => m.about.postId as string)), [messages, at]));

    // Who this member is in this chat. The one place the action rules are asked, so a DM and a group chat
    // can never disagree about what tapping a bubble offers.
    const viewer: ChatViewer = React.useMemo(() => ({
        kind: 'dm' as const,
        myPubkey: identity?.publicKey ?? null,
        canPost: !isPeerBlocked,
        isModerator: false,
        // A report goes to the moderators of the chat's own community: in place, that community's (slice S3).
        reportsLines: true,
    }), [identity?.publicKey, isPeerBlocked]);

    // One line reported to the moderators, as its sender's signature and these words (core dm-line-report.ts). `blocks`:
    // Report on a request, which blocks its sender too (utils/request-report.ts). The sheet stays under the dialog until OK.
    // In place (slice S3), every part of it goes to the chat's own community by name (`at`), never the one in use.
    const submitLineReport = async (reason: string) => {
        if (!reportingLine) return;
        const { item, blocks } = reportingLine;
        try {
            let outcome: RequestReportOutcome = 'reported';
            if (blocks) outcome = await reportRequestAndBlock(String(id), item, blocks, reason, identity?.publicKey ?? '', ...(at ? [at] as const : [] as const));
            else await reportDmLine(String(id), String(item.id), wordsOfLine(item), reason, at);
            hapticSuccess();
            const notSent = outcome === 'reported' ? null : requestReportNotSentWords(outcome);
            // A report that did not go whole still blocked them (each such sentence ends "They are blocked."): that is the title,
            // and the sentence is the message, since Android cuts a title at two lines.
            Alert.alert(notSent ? t('User Blocked') : t('Reported'), notSent ?? reportedAlertBody(undefined, reason), [{ text: t('OK'), onPress: () => {
                setReportingLine(null);
                if (blocks) router.navigate('/(tabs)/chats');
            } }]);
        } catch (e: any) {
            hapticWarning();
            const halfDone = e instanceof ReportedNotBlockedError;
            Alert.alert(
                halfDone ? t('Reported') : t('Not sent'),
                halfDone ? t('Reported, but not blocked. Please try again.') : chatActionErrorMessage({ status: e?.status ?? null, message: e?.message, nodeAnswered: !!e?.nodeAnswered }),
            );
            throw e; // the box keeps the choice and the words
        }
    };

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
            iconColor = colors.brand.primary;
            bgColor = colors.chatSystem.releasedBg;
            borderColor = colors.brand.dark;
        }
        if (item.systemType === 'STANDING_DEAL') {
            // A standing deal's record line (due, covered, ended, stopped in the grace): the node's own sentence as its text.
            iconName = 'repeat';
            iconColor = colors.brand.primary;
        }
        if (item.systemType === 'ESCROW_CANCELLED') {
            iconName = 'cash-refund';
            iconColor = colors.feedback.danger.fg;
            bgColor = colors.chatSystem.cancelledBg;
            borderColor = colors.feedback.danger.solid;
        }

        return (
            <View style={[chat.systemMessageContainer, { marginTop: 16, marginBottom: 16 }]}>
                <View style={[chat.systemMessageBubble, { backgroundColor: bgColor, borderColor: borderColor, borderWidth: 1 }]}>
                    <MaterialCommunityIcons name={iconName} size={16} color={iconColor} style={{ marginRight: 6 }} />
                    <Text style={[chat.systemMessageText, { color: theme === 'dark' ? colors.text.secondary : palette.gray700, fontSize: 13, fontWeight: '500' }]}>
                        {(() => {
                            const title = item.metadata?.postId ? dealTitleByPostId[item.metadata.postId] : undefined;
                            // A per-item deal's trust line carries how many, as its push does (DESIGN-per-item-price-fable.md §2.3):
                            // 'Dana took 3 of "Solar Panels". 900 Beans are held in trust.', from the line's own metadata.
                            const buyerKey = item.metadata?.buyerPubkey;
                            const buyer = buyerKey && buyerKey === identity?.publicKey ? identity?.callsign : buyerKey && buyerKey === peerPubkey ? peerName : null;
                            const counted = item.systemType === 'ESCROW_FUNDED' ? itemTrustLine(item.metadata, buyer, title) : null;
                            return counted ?? (title ? t('{title}: {text}', { title, text: chatLineWords(item.text) }) : chatLineWords(item.text));
                        })()}
                    </Text>
                </View>
                <Text style={chat.systemTimestamp}>{messageTime(item)}</Text>

                {/* Inline post link — only when it points somewhere the sticky header doesn't already cover. In place (slice
                    S6c) it offers the listing's own community: the listing screen reads the community in use. */}
                {item.metadata?.postId && item.metadata.postId !== postContext?.id && (
                    <Pressable
                        accessibilityRole="button"
                        style={chat.systemActionBtn}
                        onPress={() => openListing(item.metadata.postId, dealTitleByPostId[item.metadata.postId])}
                    >
                        <MaterialCommunityIcons name="tag-outline" size={14} color={colors.brand.primary} style={{ marginRight: 4 }} />
                        <Text style={chat.systemActionText}>{t('View Post')}</Text>
                    </Pressable>
                )}

                {!at && item.systemType === 'ESCROW_RELEASED' && item.metadata?.postId && (() => {
                    // This line's own trade: its transactionId, or for an older line the one that finished with it — the
                    // same rule the web reads it by (review #1980 B1).
                    const lineTxId = releaseLineTradeId(myCompletedTrades, item.metadata, item.rawTimestamp, identity?.publicKey, peerPubkey);
                    const hasRated = lineTxId ? ratedTxIds.has(lineTxId) : ratedPostIds.has(item.metadata.postId);
                    return (
                        <Pressable
                            accessibilityRole="button"
                            style={[chat.systemActionBtn, { borderColor: hasRated ? colors.brand.primary : colors.feedback.warning.solid }]}
                            onPress={async () => {
                                try {
                                    const db = await getDb();
                                    // This line's own trade; one the phone couldn't place: the newest completed one on its
                                    // post between me and this peer, never another buyer's.
                                    const txRow = lineTxId
                                        ? await db.getFirstAsync<any>(
                                            "SELECT id, buyer_pubkey, seller_pubkey FROM marketplace_transactions WHERE id=? AND status='completed'",
                                            [lineTxId]
                                        )
                                        : await db.getFirstAsync<any>(
                                            "SELECT id, buyer_pubkey, seller_pubkey FROM marketplace_transactions WHERE post_id=? AND status='completed' AND ((buyer_pubkey=? AND seller_pubkey=?) OR (buyer_pubkey=? AND seller_pubkey=?)) ORDER BY completed_at DESC LIMIT 1",
                                            [item.metadata.postId, identity?.publicKey ?? '', peerPubkey ?? '', peerPubkey ?? '', identity?.publicKey ?? '']
                                        );
                                    if (txRow && identity?.publicKey) {
                                        const targetPubkey = txRow.buyer_pubkey === identity.publicKey ? txRow.seller_pubkey : txRow.buyer_pubkey;
                                        setPromptReviewForTx({
                                            txId: txRow.id,
                                            targetPubkey,
                                            targetCallsign: peerName
                                        });
                                    } else {
                                        Alert.alert(t('Notice', undefined, 'alert title'), t('Transaction details not found locally. Please try viewing the post.'));
                                    }
                                } catch (e) {
                                    console.error(e);
                                    Alert.alert(t('Error'), t('Could not load transaction details for rating.'));
                                }
                            }}
                        >
                            <MaterialCommunityIcons
                                name={hasRated ? "star" : "star-outline"}
                                size={14}
                                color={hasRated ? colors.brand.primary : colors.feedback.warning.fg}
                                style={{ marginRight: 4 }}
                            />
                            <Text style={[chat.systemActionText, { color: hasRated ? colors.brand.primary : colors.feedback.warning.fg }]}>
                                {hasRated ? t('✓ Rating submitted (Tap to edit)') : t('Rate your partner')}
                            </Text>
                        </Pressable>
                    );
                })()}
            </View>
        );
    };

    // A DM row shown as nobody's (e2e-crypto dmLineIsUnattributed): a line that didn't open, a row in a member's name
    // that wasn't encrypted, or the admin page's message. In the middle of the chat, never in its named author's bubble,
    // and with no actions: there is nobody's line to answer or react to. A line from the key offered in the pinned one's
    // place shows only the fixed line (dmLineSlotText), never its words, until the member continues.
    const renderUnattributedLine = (item: any) => (
        <View style={[chat.systemMessageContainer, { marginTop: 12, marginBottom: 12 }]} testID="dm-line-unattributed">
            <View style={[chat.systemMessageBubble, { maxWidth: '90%', backgroundColor: colors.chatSystem.defaultBg, borderColor: colors.chatSystem.defaultBorder, borderWidth: 1 }]}>
                <MaterialCommunityIcons name={item.integrityNote ? 'bullhorn-outline' : 'shield-alert-outline'} size={16} color={colors.text.secondary} style={{ marginRight: 6 }} />
                <Text style={[chat.systemMessageText, { flexShrink: 1, color: theme === 'dark' ? colors.text.secondary : palette.gray700, fontSize: 13, fontWeight: '500' }]}>
                    {/* The admins' message is their words, shown as written; any other line here is a stand-in BeanPool wrote. */}
                    {item.quoteFrom === 'admins' ? dmLineSlotText(item) : chatLineWords(dmLineSlotText(item))}
                </Text>
            </View>
            {item.integrityNote ? (
                <Text style={[chat.systemTimestamp, { fontSize: 12, fontStyle: 'italic', textAlign: 'center', maxWidth: '90%' }]}>{chatLineWords(item.integrityNote)}</Text>
            ) : null}
            <Text style={chat.systemTimestamp}>{messageTime(item)}</Text>
        </View>
    );

    // The key code screen for this chat (DESIGN-dm-key-signal-model §3): from the ⋯ menu and from a key-changed notice.
    const openKeyCode = () => router.push({ pathname: '/chat/key-code', params: at ? { id: String(id), community: at } : { id: String(id) } });

    const renderMessage = (item: any) => {
        // The phone's own notice that the key changed and the chat carried on (a person not marked verified): never anyone's words.
        if (item.keyChangedNotice) return <DmKeyChangedNotice peerName={peerName} onPress={openKeyCode} />;
        if (item.type === 'system' || item.senderId === 'SYSTEM') return renderSystemMessage(item);
        if (item.unattributed || item.fromOfferedKey) return renderUnattributedLine(item);

        const isMe = identity?.publicKey ? item.senderId === identity.publicKey : false;
        const showActions = activeMessageActionsId === item.id;
        // A chat that is still a request offers no Reply and no React, as the web (MessagesPage `inRequest`): the person it
        // is for decides first, and their reaction would reach the opener while it still reads waiting; the opener's are
        // refused until it is accepted (PR #2540 review 4394827119). Their own line still edits and deletes.
        const inRequest = requestMode !== 'none';
        const showEmojiPicker = !inRequest && activeEmojiPickerId === item.id;
        const allowed = messageActions(item, viewer);
        // Nor a line's own Report: a request's is the bar's, which blocks its sender too (the web's the same).
        const actions = inRequest ? { ...allowed, reply: false, react: false, report: false } : allowed;

        const handleEmojiSelect = async (emoji: string) => {
            if (!identity?.publicKey || inRequest) return;
            try {
                await toggleMessageReactionApi(item.id, identity.publicKey, emoji, at);
                hapticSuccess();
                setActiveEmojiPickerId(null);
                setActiveMessageActionsId(null);
                loadMessages(true);
            } catch (e: any) {
                console.error('Failed to react to message:', e);
                Alert.alert(t('Not reacted'), chatActionErrorMessage(e));
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
            // The box takes the line's words from the effect on editingMessage, once the composer is drawn.
            setEditingMessage(item);
            setReplyToMessage(null);
            setActiveMessageActionsId(null);
            setActiveEmojiPickerId(null);
        };

        const quote = item.metadata?.replyToId ? (() => {
            // The answered message as the thread judged it (dmQuoteFor), never its row's raw words and named author.
            const q = dmQuoteFor(messagesById.get(item.metadata.replyToId), identity?.publicKey, peerName);
            return {
                author: q.author,
                text: q.text,
                note: q.note,
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
                <NotDeliveredMark color={colors.feedback.danger.fg} />
            ) : (
                <Text style={{ fontSize: 10, color: item.readByPeer ? palette.cyan200 : colors.chat.tickUnread }}>
                    {item.readByPeer ? ' ✓✓' : ' ✓'}
                </Text>
            )
        ) : null;

        const row = (
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
                onReport={() => {
                    setActiveMessageActionsId(null);
                    setReportingLine({ item, blocks: null });
                }}
                onPickEmoji={handleEmojiSelect}
                onPressUrl={requestMode === 'none' ? openUrl : undefined}
                editing={editingMessage?.id === item.id}
                quote={quote}
                about={item.about ? (
                    <ChatAboutCard about={item.about} live={aboutListings.get(item.about.postId)} isMe={isMe} onOpen={(postId) => openListing(postId, item.about.title)} />
                ) : null}
                attachment={item.type === 'image' ? (requestMode === 'to-me' ? (
                    // A request waiting for this member: the photo stays closed, and isn't even fetched, until they accept
                    // (design §4.6, as the web; PR #2540 review 4393642129). Its caption is words, and reads.
                    <Text testID="request-photo-closed" style={{ color: colors.text.muted, fontStyle: 'italic', padding: 8 }}>
                        <Text aria-hidden={true} importantForAccessibility="no">🖼️ </Text>{t('Photo: shown when you accept')}
                    </Text>
                ) : (
                    // oldLine: conversion code, log row OLDCHAT, remove after 12 Dec 2026.
                    <ChatImage conversationId={id as string} messageId={item.id} onOpen={openImageViewer} oldLine={!!item.oldLine} keyContext={dmKeyContextOf(keyChange)} community={at} />
                )) : item.type === 'voice' && !item.oldLine ? (requestMode === 'to-me' ? (
                    // No voice message comes from a request (design §3.5): one that came anyway stays closed, unfetched.
                    <Text testID="request-voice-closed" style={{ color: colors.text.muted, fontStyle: 'italic', padding: 8 }}>
                        <Text aria-hidden={true} importantForAccessibility="no">🎤 </Text>{t('Voice message: shown when you accept')}
                    </Text>
                ) : (
                    <VoiceBubble messageId={item.id} isMe={isMe} load={() => getDecryptedVoice(id as string, item.id, at)} />
                )) : null}
                status={status}
                footer={((item.type === 'image' || item.type === 'voice') && !item.text) || item.integrityNote ? (
                    <>
                        {(item.type === 'image' || item.type === 'voice') && !item.text ? (
                            <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: isMe ? 'flex-end' : 'flex-start', marginTop: 4 }}>
                                <Text style={[chat.messageTime, isMe ? chat.messageTimeMe : chat.messageTimeOther]}>
                                    {messageTime(item)}
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
                        {/* A line the node moved or reordered (e2e-crypto checkDmThread). */}
                        {item.integrityNote ? (
                            <Text style={[chat.messageTime, isMe ? chat.messageTimeMe : chat.messageTimeOther, { fontSize: 12, fontStyle: 'italic', alignSelf: 'flex-start' }]}>
                                ⚠️ {chatLineWords(item.integrityNote)}
                            </Text>
                        ) : null}
                    </>
                ) : null}
            />
        );
        // The other person's name only once the chat has said it (never "Loading..."); before, "them".
        const notSeenText = notSeen && notSeen.id === item.id ? notSeenWords(notSeen.notSeen, convRow ? peerName : null) : null;
        // Never in a chat blocked, or paused on a new key, since the line was offered (both are read after the thread).
        const named = notify.line?.anchor === item.id && !isPeerBlocked && !keyChangePending ? notify.view : null;
        return notSeenText || named ? (
            <View>
                {row}
                {notSeenText ? <NotSeenLine text={notSeenText} /> : null}
                {named}
            </View>
        ) : row;
    };

    const menuItems: ChatMenuItem[] = [
        {
            icon: isMuted(mute) ? 'bell-ring-outline' : 'bell-off-outline',
            label: muteMenuLabel(mute),
            onPress: () => { setMenuOpen(false); if (isMuted(mute)) setMuteTo('off'); else setMuteOpen(true); },
        },
        {
            icon: 'account-outline',
            label: t('View profile'),
            // The profile screen reads the community in use: not offered in place (slice S2).
            hidden: !peerPubkey || !!at,
            onPress: () => {
                setMenuOpen(false);
                if (peerPubkey) router.push({ pathname: '/public-profile', params: { publicKey: peerPubkey, callsign: peerName } });
            },
        },
        {
            // The person's key code, where the member checks it and marks them verified (§3). DMs only.
            icon: 'shield-key-outline',
            label: t('Key code'),
            hidden: !isEncrypted,
            onPress: () => { setMenuOpen(false); openKeyCode(); },
        },
    ];

    return (
        <SafeAreaView style={styles.container} edges={['top']} onLayout={screenKeyboard.onScreenLayout}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            
            {/* Header */}
            <View style={styles.header} onLayout={measuredEdge('header')}>
                <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={() => leaveScreen(router, 'chat/[id]')} style={styles.backButton}>
                    <MaterialCommunityIcons name="arrow-left" size={28} color={colors.text.body} />
                </Pressable>

                <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                        if (peerPubkey && !at) {
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
                        {/* In place (slice S2): the community this chat lives in, its name as the phone saved it, in grey. */}
                        {inPlace?.name ? <Text style={styles.headerCommunity} numberOfLines={1} testID="chat-in-place-community">{inPlace.name}</Text> : null}
                        <View style={styles.headerSubtitleRow}>
                            <Text style={[styles.headerSubtitle, styles.headerSubtitleText]} numberOfLines={1}>
                                {isEncrypted ? t('🔒 End-to-end encrypted') : t('Connected via your community')}
                            </Text>
                            {isEncrypted && peerVerified && (
                                <Text style={[styles.headerSubtitle, styles.headerVerified]} numberOfLines={1}>{t('Verified ✓')}</Text>
                            )}
                        </View>
                    </View>
                </Pressable>

                <Pressable accessibilityRole="button" accessibilityLabel={t('More options')} style={styles.moreButton} onPress={openMenu}>
                    <MaterialCommunityIcons name="dots-horizontal" size={28} color={colors.text.secondary} />
                </Pressable>
            </View>

            {/* Everything between the header and the thread: the deals strip, the listing's header and the release bar. While
                the key behind this DM has changed (utils/dm-peer-pins.ts), the card (what changed, the new key's code, and the
                member's choice) sits above them and they scroll with it as one page, in the room above the paused box once the
                box (the composer with any banner over it) and a keyboard still up are taken out (dmKeyBannerMaxHeight): nothing
                can be sent meanwhile, so the thread gives way. A page taller than that scrolls with its scroll bar shown, and a
                keyboard up when the pause starts is put away, once (DmKeyChangedPane; walk of 17 Nov at 320 dp and 1.3× text;
                deciding review of 6775428c). The column holds nothing else, so nothing new goes between this and the keyboard
                view: it goes in here. Keyed on the offered key, so a tick given for one code never carries over to another.
                Named from the key's member row, never the conversation id. Without the card the bars are a page of their own
                (barsRoom, chatColumnFit): whole while they fit, scrolling once taller (kept at the end, so the deals strip
                gives way first), folded away while typing leaves no room,
                so the box and one line of the thread always have theirs (walk of 17 Nov, the market DM at 320 dp and 1.3×). */}
            <DmKeyChangedPane
                key={keyChange?.offeredPeer ?? 'none'}
                card={keyChange ? { peerName: keyChange.name, change: keyChange, onContinue: handleContinueWithNewKey, onNotNow: () => leaveScreen(router, 'chat/[id]') } : null}
                maxHeight={dmKeyBannerMaxHeight({ ...column, windowHeight, keyboard: keyboardHeight })}
                barsRoom={fit.bars}
            >

            {/* In place (slice S6c): this person's standing deals, and the one line that says their community didn't answer
                about its deals (their money steps wait for its word), with the next try. */}
            {standingThere.map(d => (
                <View key={`standing-${d.txId}`} style={styles.standingThere}>
                    <StandingPanel tx={{ ...localDealRow(d, myKey!), amount_c: d.amount_c ?? null }} actingAs={myKey!} busy={actionLoading}
                        onStop={() => { void stopThere(String(d.standing_id)); }} onLower={lowerThere} />
                </View>
            ))}
            {!!inPlace && dealsThere.state === 'failed' && (activeDeals.length > 0 || standing.length > 0) && (
                <View style={styles.dealsUnread} testID="deals-unread">
                    <Text style={styles.dealsUnreadText} accessibilityRole="alert">{t("Can't reach {name} right now. Check your connection and try again.", { name: inPlace.name })}</Text>
                    <Pressable accessibilityRole="button" style={[styles.dealBtn, styles.dealBtnReview, styles.dealsUnreadBtn]} onPress={() => { void askDeals(); }}>
                        <Text style={styles.dealBtnReviewText}>{t('Try again')}</Text>
                    </Pressable>
                </View>
            )}

            {/* Pinned active-deals strip — per-deal actions live here (one card per live deal),
                always visible so a Release/Review is never buried in the conversation scroll. While the key card is up it
                sits under the card in the page they scroll as, never in the thread (DmKeyChangedPane). */}
            {visibleDeals.length > 0 && (
                <View style={styles.dealStrip}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingVertical: 10 }}>
                        {visibleDeals.map(d => (
                            <Pressable
                                key={d.txId}
                                accessibilityRole="button"
                                style={styles.dealCard}
                                onPress={() => d.postId && openListing(d.postId, d.postTitle, d.txId)}
                            >
                                {/* A per-item deal says how many, as Your deals does: "3 × Solar Panels". */}
                                <Text style={styles.dealCardTitle} numberOfLines={1}>{d.postTitle ? itemDealTitle(d, d.postTitle) : t('Deal')}</Text>
                                {d.status === 'requested' ? (
                                    // Nothing is held yet, so never "held in trust": whose step it is, in core's words. Approve and Deny
                                    // live on the listing, which the card opens at this deal.
                                    <Text style={styles.dealCardMeta} numberOfLines={1}>{dealStateWords(dealStep(localDealRow(d, identity!.publicKey), identity!.publicKey), null)}</Text>
                                ) : (
                                    <Text style={styles.dealCardMeta} numberOfLines={1}>
                                        <Sentence text={d.status === 'completed' ? t('{amount} · completed') : t('{amount} · held in trust')} parts={{ amount: <CurrencyDisplay amount={formatHundredths(d.amount_c)} style={styles.dealCardMeta} /> }} />
                                    </Text>
                                )}
                                {(() => {
                                // In place, no step before the deal's own community has answered about it this visit.
                                const acts = !at || answeredThere(dealsThere, d);
                                const moves = acts ? localDealMoves(d, identity!.publicKey) : null;
                                // What is done only there, said on the card: a request to answer, a deal that community didn't name.
                                const onlyThere = !!inPlace && !!postRoute(d.postId) && (acts ? !!moves?.answer : dealsThere.state === 'answered');
                                return (
                                <View style={styles.dealCardActions}>
                                    {onlyThere && (
                                        <Pressable accessibilityRole="button" style={[styles.dealBtn, styles.dealBtnReview]} onPress={() => { void offerThere(d.postTitle, d.postId, d.txId); }}>
                                            <Text style={styles.dealBtnReviewText} numberOfLines={2}>{t('Open {community} ›', { community: inPlace!.name })}</Text>
                                        </Pressable>
                                    )}
                                    {moves?.release && (
                                        <>
                                            <Pressable accessibilityRole="button" accessibilityLabel={d.postTitle ? t('Release Beans for {title}', { title: d.postTitle }) : t('Release Beans for deal')} style={[styles.dealBtn, styles.dealBtnRelease]} disabled={actionLoading} onPress={() => handleReleaseDeal(d.txId, d.amount_c ?? null)}>
                                                <Text style={styles.dealBtnReleaseText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{actionLoading ? '…' : t('Release')}</Text>
                                            </Pressable>
                                            {moves.cancelHold && (
                                            <Pressable accessibilityRole="button" accessibilityLabel={t('Cancel deal')} style={[styles.dealBtn, styles.dealBtnCancel]} disabled={actionLoading} onPress={() => handleCancelDeal(d.txId)}>
                                                <Text style={styles.dealBtnCancelText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Cancel')}</Text>
                                            </Pressable>
                                            )}
                                        </>
                                    )}
                                    {moves?.step.state === 'to-deliver' && (
                                        <Text style={styles.dealAwaiting}>{t('⏳ Awaiting release')}</Text>
                                    )}
                                    {moves?.step.state === 'done-to-review' && (
                                        <Pressable accessibilityRole="button" accessibilityLabel={d.postTitle ? t('Leave a review for {title}', { title: d.postTitle }) : t('Leave a review for deal')} style={[styles.dealBtn, styles.dealBtnReview]} onPress={() => handleReviewDeal(d)}>
                                            <Text style={styles.dealBtnReviewText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('⭐ Review')}</Text>
                                        </Pressable>
                                    )}
                                </View>
                                );
                                })()}
                            </Pressable>
                        ))}
                    </ScrollView>
                </View>
            )}

            {/* Sticky Marketplace Header */}
            {postContext && (
                <Pressable accessibilityRole="button" onPress={() => openListing(postContext.id, postContext.title)} style={styles.stickyHeader}>
                    <View style={styles.stickyHeaderLeft}>
                        <MaterialCommunityIcons name="shopping-outline" size={24} color={colors.brand.primary} />
                        <View style={{ marginLeft: 12 }}>
                            <Text style={styles.stickyPostTitle} numberOfLines={1}>{postContext.title}</Text>
                            {/* English writes one form for both; a language with more forms has them. */}
                            {/* Priced at 0 it reads Free (core listing-price.ts), as on every card, whatever the unit. */}
                            {/* Whole hundredths (price_c): the figure by formatHundredths, "—" for none, never a number made up. */}
                            {showsBeans && <Text style={styles.stickyPostCredits}>{freePriceWords(postContext.price_c, null) ?? (postContext.priceType === 'hourly'
                                ? tn((postContext.price_c ?? 0) / 100, '{n} Beans / hr', '{n} Beans / hr', { n: formatHundredths(postContext.price_c) })
                                : tn((postContext.price_c ?? 0) / 100, '{n} Beans', '{n} Beans', { n: formatHundredths(postContext.price_c) }))}</Text>}
                        </View>
                    </View>
                    <View style={[styles.statusBadge,
                        postContext.status === 'active' ? { backgroundColor: theme === 'dark' ? colors.feedback.success.bg : palette.emerald100 } :
                        postContext.status === 'pending' ? { backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : palette.amber100 } :
                        { backgroundColor: colors.border.default }
                    ]}>
                        <Text style={[styles.statusBadgeText,
                            postContext.status === 'active' ? { color: theme === 'dark' ? colors.feedback.success.fg : colors.brand.dark } :
                            postContext.status === 'pending' ? { color: colors.feedback.warning.fg } :
                            { color: theme === 'dark' ? colors.text.secondary : palette.gray600 }
                        ]}>{listingHeaderStatusWords(postContext.status)}</Text>
                    </View>
                </Pressable>
            )}

            {/* Inline Action Bar: Release/Cancel only where core's dealMoves offers them (never on a standing deal) */}
            {showInlineBar && pendingTx && (
                <View style={[styles.inlineActionBar, { flexDirection: 'column' }]}>
                    <View style={{ width: '100%', marginBottom: 10 }}>
                        <Text style={{ color: colors.feedback.warning.fg, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 4 }}>
                            {t('⚠️ Action needed: release the Beans')}
                        </Text>
                        <Text style={{ color: theme === 'dark' ? colors.text.body : palette.amber900, fontSize: 11, textAlign: 'center', paddingHorizontal: 16 }}>
                            {t("Only release the Beans once the provider has done what you agreed. This can't be undone.")}
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
                            <Text style={[styles.inlineActionReleaseText, { flexShrink: 1 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                                {actionLoading ? t('Processing...') : (
                                    <Sentence text={t('Release {amount}')} parts={{ amount: <CurrencyDisplay amount={formatHundredths(pendingTx.amount_c)} style={styles.inlineActionReleaseText} /> }} />
                                )}
                            </Text>
                        </Pressable>
                        {pendingMoves?.cancelHold && (
                        <Pressable
                            accessibilityRole="button"
                            style={[styles.inlineActionBtn, styles.inlineActionCancel]}
                            onPress={handleCancelEscrow}
                            disabled={actionLoading}
                        >
                            <MaterialCommunityIcons name="close-circle-outline" size={18} color={colors.feedback.danger.fg} style={{ marginRight: 6 }} />
                            <Text style={[styles.inlineActionCancelText, { flexShrink: 1 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Cancel')}</Text>
                        </Pressable>
                        )}
                    </View>
                </View>
            )}
            </DmKeyChangedPane>

            <KeyboardAvoidingView
                style={styles.keyboardView}
                behavior="padding"
                keyboardVerticalOffset={screenKeyboard.keyboardVerticalOffset}
                onLayout={measuredEdge('bottom')}
            >
                {/* The thread. Inverted, day-separated and keyboard-following — the shared list every chat uses. */}
                {shouldShowChatLoadError({ loadError, messageCount: messages.length }) ? (
                    <View style={{ flex: 1 }}>
                        <Text style={chat.errorText} accessibilityRole="alert">{chatLineWords(loadError)}</Text>
                        <Pressable style={chat.retryBtn} accessibilityRole="button" onPress={() => { setLoadError(null); loadMessages(); }}>
                            <Text style={chat.retryText}>{t('Try again')}</Text>
                        </Pressable>
                    </View>
                ) : !firstLoadDone ? (
                    // The thread's outline while the first read comes back: the header already names who it is with.
                    <View style={[chat.listContent, { flex: 1 }]} accessibilityRole="progressbar" accessibilityLabel={t('Loading the chat')}>
                        {[{ w: '62%', mine: false }, { w: '48%', mine: true }, { w: '70%', mine: false }].map((b, k) => (
                            <View key={k} style={[chat.skeletonRow, b.mine && chat.skeletonRowMine]}>
                                <View style={[chat.skeletonBubble, { width: b.w as any }]} />
                            </View>
                        ))}
                    </View>
                ) : (
                    <VoicePlaybackProvider owner={voiceOwner} voices={messages.filter((m: any) => m?.type === 'voice').map((m: any) => ({ id: String(m.id), mine: !!identity?.publicKey && m.senderId === identity.publicKey }))}>
                    <ChatMessageList
                        listRef={flatListRef}
                        items={listItems}
                        styles={chat}
                        renderMessage={renderMessage}
                        activeId={activeEmojiPickerId || activeMessageActionsId}
                        activeEmojiRow={activeEmojiPickerId ? pickerPosition : null}
                        onAtBottomChange={atBottom => { atBottomRef.current = atBottom; }}
                        onCloseMenu={() => {
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
                    </VoicePlaybackProvider>
                )}

                {/* The box: everything under the thread, measured whole for the key card's room (dmKeyBannerMaxHeight). The
                    About chip is a page in what the composer, the banner and one line of the thread leave (chatColumnFit),
                    the last to give way after the bars. The Editing or Replying to banner sits whole on the composer while
                    typing: the field gives way to it (ChatComposer maxHeight), and only once that is down to its line is
                    the banner's padding cropped, its words and ✕ centred (deciding review of f4bbcfa4, findings 1 and 2). */}
                <View onLayout={measured('composer')}>
                {!editingMessage && (
                    <ChatScrollPage testID="chat-about-page" maxHeight={fit.about}>
                        <ChatAboutBanner conversationId={String(id)} />
                    </ChatScrollPage>
                )}

                <View testID="chat-box-banner" style={{ maxHeight: fit.banner, overflow: 'hidden', justifyContent: 'center' }}>
                <View onLayout={(e) => setBannerHeight(Math.ceil(e.nativeEvent.layout.height))}>
                {editingMessage && (
                    <ChatEditBanner
                        styles={chat}
                        text={editingMessage.text}
                        onCancel={() => { setEditingMessage(null); composerRef.current?.reset(); }}
                    />
                )}

                {replyToMessage && !editingMessage && (() => {
                    // What is being answered, as the thread judged it (dmQuoteFor).
                    const q = dmQuoteFor(replyToMessage, identity?.publicKey, peerName);
                    return <ChatReplyBanner styles={chat} author={q.author} text={q.text} note={q.note} onCancel={() => setReplyToMessage(null)} />;
                })()}
                </View>
                </View>

                {/* The composer (or a request's panel) alone, measured for the About chip's and the banner's rooms. */}
                <View onLayout={(e) => setInputHeight(Math.round(e.nativeEvent.layout.height))}>
                {isPeerBlocked ? (
                    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.blockedNotice, { marginBottom: Math.max(insets.bottom, 12) }]}>
                        <Text style={styles.blockedNoticeText}>
                            <Text aria-hidden={true} importantForAccessibility="no">🚫 </Text>{t('You have blocked this user. Messaging is disabled.')}
                        </Text>
                    </View>
                ) : requestMode === 'to-me' ? (
                    <View
                        role="region"
                        accessibilityLabel={t('{name} wants to message you', { name: peerName })}
                        style={[styles.toMeContainer, { marginBottom: Math.max(insets.bottom, 12) }]}
                    >
                        <Text style={styles.toMeTitle}>
                            {t('{name} wants to message you', { name: peerName })}
                        </Text>
                        <Text style={styles.toMeSubtitle}>
                            {t('Accept to reply. If you decline, they are not told.')}
                        </Text>
                        <View style={styles.toMeButtons}>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('Accept', undefined, 'button: accept a message request')}
                                style={[styles.toMeAcceptBtn, decidingRequest && { opacity: 0.7 }]}
                                disabled={decidingRequest}
                                onPress={async () => {
                                    if (decidingRequest) return;
                                    setDecidingRequest(true);
                                    try {
                                        const answer = await decideMessageRequest(String(id), 'accept', at);
                                        setConvRow((prev: any) => prev ? { ...prev, request: answer.request } : prev);
                                        void syncSingleConversation(String(id), at);
                                    } catch (e: any) {
                                        // Gone from the node (its opener cancelled it): back to Talk, as Ignore goes.
                                        if (requestIsGone(e)) { router.navigate('/(tabs)/chats'); return; }
                                        Alert.alert(t('Message requests'), requestDecisionFailureWords(e));
                                    } finally {
                                        setDecidingRequest(false);
                                    }
                                }}
                            >
                                <Text style={styles.toMeAcceptBtnText}>{t('Accept', undefined, 'button: accept a message request')}</Text>
                            </Pressable>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('Decline', undefined, 'button: decline a message request')}
                                style={[styles.toMeIgnoreBtn, decidingRequest && { opacity: 0.7 }]}
                                disabled={decidingRequest}
                                onPress={async () => {
                                    if (decidingRequest) return;
                                    setDecidingRequest(true);
                                    try {
                                        await decideMessageRequest(String(id), 'ignore', at);
                                        router.navigate('/(tabs)/chats');
                                    } catch (e: any) {
                                        if (requestIsGone(e)) { router.navigate('/(tabs)/chats'); return; }
                                        Alert.alert(t('Message requests'), requestDecisionFailureWords(e));
                                    } finally {
                                        setDecidingRequest(false);
                                    }
                                }}
                            >
                                <Text style={styles.toMeIgnoreBtnText}>{t('Decline', undefined, 'button: decline a message request')}</Text>
                            </Pressable>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('Report', undefined, 'button: report a message request')}
                                testID="request-report"
                                style={[styles.toMeIgnoreBtn, (decidingRequest || !canReportRequest) && { opacity: 0.7 }]}
                                disabled={decidingRequest || !canReportRequest}
                                onPress={() => setReportingLine({ item: requestLine, blocks: heldRequest.from })}
                            >
                                <Text style={[styles.toMeIgnoreBtnText, { color: colors.feedback.danger.fg }]}>{t('Report', undefined, 'button: report a message request')}</Text>
                            </Pressable>
                        </View>
                    </View>
                ) : requestMode === 'mine-waiting' && !editingMessage ? (
                    <View
                        role="status"
                        testID="request-waiting"
                        style={[styles.waitingContainer, { marginBottom: Math.max(insets.bottom, 12) }]}
                    >
                        <Text style={styles.waitingText}>
                            {t('Sent as a message request. {name} will see it under Message requests, without a notification. You can write again once they accept.', { name: peerName })}
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('Cancel request')}
                            testID="request-cancel"
                            style={[styles.cancelRequestBtn, cancellingRequest && { opacity: 0.7 }]}
                            disabled={cancellingRequest}
                            onPress={handleCancelRequest}
                        >
                            <Text style={styles.cancelRequestBtnText}>{t('Cancel request')}</Text>
                        </Pressable>
                    </View>
                ) : (
                    <ChatComposer
                        ref={composerRef}
                        styles={chat}
                        onSend={handleSend}
                        canSend={canSendNow}
                        disabled={keyChangePending}
                        busy={requestMode === 'mine-loading' || !!requestLineId}
                        notice={unplaced ? t(DM_LOCK_WORDS.unplaced) : keyChangePending ? dmKeyChangedLine(keyChange?.name) : lockNotice ? chatLineWords(lockNotice) : (requestMode === 'mine-unsent' && !requestLineId ? t('Your first message goes to {name} as a request. You can write more once they accept.', { name: peerName }) : requestMode === 'mine-loading' ? t('Loading the chat') : null)}
                        placeholder={t('Message...')}
                        accessibilityLabel={t('Message', undefined, 'message box')}
                        bottomPadding={keyboardVisible ? 8 : Math.max(insets.bottom, 12)}
                        maxHeight={fit.composer}
                        onVoice={voiceHere && requestMode === 'none' && !requestLineId && !editingMessage ? sendVoice : undefined}
                        voiceOwner={voiceOwner}
                        leading={at ? undefined : (
                            <Pressable accessibilityRole="button" accessibilityLabel={t('Attach image')} style={chat.attachBtn} onPress={pickAndSendImage}>
                                <MaterialCommunityIcons name="plus-circle-outline" size={26} color={colors.text.muted} />
                            </Pressable>
                        )}
                    />
                )}
                </View>
                </View>
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
                    community={at}
                    onClose={() => {
                        setPromptReviewForTx(null);
                        if (triggerReview === 'true') {
                            router.navigate('/(tabs)/chats');
                        }
                    }}
                    onSuccess={() => {
                        Alert.alert(t('Success'), t('Your rating has been submitted!'));
                        setPromptReviewForTx(null);
                        loadRatedTransactions();
                        loadDeals(); // reviewed deal drops off the pinned strip
                        void askDeals();
                        if (triggerReview === 'true') {
                            router.navigate('/(tabs)/chats');
                        }
                    }}
                />
            )}

            <ReportMessageSheet
                isOpen={!!reportingLine}
                photo={false}
                blocks={!!reportingLine?.blocks}
                onSubmit={submitLineReport}
                onClose={() => setReportingLine(null)}
            />
            {/* Full-screen image viewer — opened from a tapped chat image (the 800 px photo, from the
                local cache so it's instant/offline after first view).
                The Modal is its own full-screen window, outside this screen's SafeAreaView, so the close
                button takes the status-bar inset itself: a fixed 50 is less than the 59pt inset on Dynamic Island iPhones. */}
            {viewerUri && (
                <LightBarModal visible transparent animationType="fade" onRequestClose={() => setViewerUri(null)}>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('Dismiss full-size photo')} style={styles.imageViewerOverlay} onPress={() => setViewerUri(null)}>
                        <Image source={{ uri: viewerUri }} style={styles.imageViewerImage} resizeMode="contain" accessibilityLabel={t('Full-size photo')} />
                        <Pressable accessibilityRole="button" accessibilityLabel={t('Close photo')} style={[styles.imageViewerClose, { top: Math.max(50, insets.top + 8) }]} onPress={() => setViewerUri(null)}>
                            <MaterialCommunityIcons name="close" size={28} color={colors.text.inverse} />
                        </Pressable>
                    </Pressable>
                </LightBarModal>
            )}
        </SafeAreaView>
    );
}
