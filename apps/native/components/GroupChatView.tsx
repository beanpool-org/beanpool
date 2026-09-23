/**
 * GroupChatView — the chat every Commons group owns, and every enterprise's public discussion thread (groups
 * decisions 3, 8, 9, 12, 13). One screen shape for both: the owner header ("🌻 Garden Crew · group", "🥖 Bakery ·
 * enterprise"), bubbles, grey centred system lines (joins, leaves, role changes), a composer, and an honest notice
 * of who can read it. Both chats are node-readable `plaintext-v1`, unlike DMs. A group's chat is its members' only;
 * an enterprise's thread is readable by any member of the community (the node checks no role on its read) and is
 * the same thread its page shows as "Public coordination for this enterprise".
 *
 * A group whose convenor is still alone in it opens on "Who do you want to invite?" with a big Invite people
 * button (decision 8) — skippable; Invite people then lives in the header menu for good.
 *
 * Chat parity (2026-09-23): the thread, the bubbles, the tap-for-actions, the emoji row, the quoted replies, the
 * day pills and the message box are the SHARED ones in components/chat — the same code the DM screen renders
 * through, not a second version of it. A group chat therefore gets reply, react, edit (15 minutes), delete for
 * everyone, a convenor's remove, "edited", Resend / Discard on a failed send and an inverted list that keeps the
 * newest message above the keyboard ("new message in group is hidden behind kb", Damo, 2026-09-23). What a
 * message actually offers is decided once, in utils/chat-actions — an enterprise thread is read-and-write only,
 * this round, and its bubbles offer nothing.
 *
 * Keyboard: KeyboardAvoidingView from react-native-keyboard-controller, padding on both platforms, no nested
 * provider (memory keyboard-avoidance-pattern). At 320dp and 1.3× text the header truncates the name, the
 * composer keeps a Send that never shrinks and the notice wraps.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, Alert } from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView, KeyboardController, useKeyboardState } from 'react-native-keyboard-controller';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useIdentity } from '../app/IdentityContext';
import * as Crypto from 'expo-crypto';
import {
    getGroupChat, postGroupChatMessage, getEnterpriseChat, postEnterpriseChatMessage, muteChatApi, fetchGroupDetails,
    markThreadReadOnNode, toggleMessageReactionApi, editThreadMessage, deleteMessageApi, removeGroupChatMessage,
    type GroupItem,
} from '../utils/db';
import { decodeEventChatText } from '../utils/events';
import {
    isMuted, showInvitePrompt as shouldShowInvitePrompt, chatMuteFromRows, chatMuteFromAnswer, muteMenuLabel,
    ENTERPRISE_CHAT_NOTICE,
    type YourChatMute,
} from '../utils/your-groups';
import {
    buildChatListItems, chatActionErrorMessage, isTombstone, messageActions, normaliseThreadMessage,
    shouldFollowNewMessages, showsAuthorName, tombstoneText, type ChatMessage, type ChatViewer,
} from '../utils/chat-actions';
import { normaliseTappedUrl } from '../utils/chat-links';
import { Linking } from 'react-native';
import { makeChatStyles } from './chat/styles';
import { ChatMessageList, scrollChatToBottom } from './chat/ChatMessageList';
import { ChatMessageRow } from './chat/ChatMessageRow';
import { ChatComposer, type ChatComposerHandle } from './chat/ChatComposer';
import { ChatEditBanner, ChatMenuSheet, ChatReplyBanner, type ChatMenuItem } from './chat/ChatBanners';
import { yourGroupsStore } from './useYourGroups';
import { hapticTick, hapticSuccess, hapticWarning } from '../utils/haptics';
import { ChatOwnerHeader } from './ChatOwnerHeader';
import { InvitePeopleSheet } from './InvitePeopleSheet';
import { GroupDetailModal } from './GroupDetailModal';

interface Props {
    kind: 'group' | 'enterprise';
    /** Group id or enterprise pubkey — also the conversation id. */
    id: string;
    /** Set when the member has just created this group: open on the invite prompt. */
    justCreated?: boolean;
    /** Shown until the chat loads. */
    initialName?: string;
}

const GROUP_MESSAGE_MAX = 2000;

/**
 * A message this phone is still sending, or could not send. The node holds nothing for it yet, so it lives
 * here until the chat is read again — that is what lets a group chat offer Resend / Discard the way a DM
 * does. The client id is the same one the POST carries, so a resend is stored once, not twice.
 */
interface PendingMessage {
    clientId: string;
    text: string;
    replyToId: string | null;
    state: 'sending' | 'failed';
    timestamp: string;
}

export function GroupChatView({ kind, id, justCreated, initialName }: Props) {
    const insets = useSafeAreaInsets();
    const { colors, theme } = useTheme();
    const styles = useStyles(makeStyles);
    const chat = useStyles(makeChatStyles);
    const { identity } = useIdentity();
    const keyboardVisible = useKeyboardState(s => s.isVisible);
    const me = identity?.publicKey;

    const [view, setView] = useState<any | null>(null);
    const [group, setGroup] = useState<GroupItem | null>(null);
    const [memberKeys, setMemberKeys] = useState<Set<string>>(new Set());
    const [invitedCount, setInvitedCount] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [pending, setPending] = useState<PendingMessage[]>([]);
    const [menuOpen, setMenuOpen] = useState(false);
    const [muteOpen, setMuteOpen] = useState(false);
    const [inviteOpen, setInviteOpen] = useState(false);
    const [infoOpen, setInfoOpen] = useState(false);
    const [inviteSkipped, setInviteSkipped] = useState(false);
    const [replyToMessage, setReplyToMessage] = useState<ChatMessage | null>(null);
    const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
    const [activeMessageActionsId, setActiveMessageActionsId] = useState<string | null>(null);
    const [activeEmojiPickerId, setActiveEmojiPickerId] = useState<string | null>(null);
    const [pickerPosition, setPickerPosition] = useState<'top' | 'bottom'>('top');
    // Seeded from this chat's "Your groups" row, so a mute set on an earlier visit shows (and can be undone) before
    // the chat loads — and on a node too old to return the mute with an enterprise thread.
    const [mute, setMute] = useState<YourChatMute | null>(() => chatMuteFromRows(yourGroupsStore.getState().items, id));
    // One id per message being written, so a send retried after a dropped connection is stored once (the node
    // de-duplicates on it). A new one once the node has it.
    const clientIdRef = useRef<string>(Crypto.randomUUID());
    const listRef = useRef<FlatList>(null);
    const composerRef = useRef<ChatComposerHandle>(null);
    const inFlight = useRef(false);
    const readUpTo = useRef<string | null>(null);
    // Whether the newest message is on screen: a message arriving while it is follows the thread down,
    // one arriving while someone reads history does not yank them.
    const atBottomRef = useRef(true);
    const messageCountRef = useRef(0);
    // A link tap bubbles to the bubble's own onPress — swallow it so it does not open the actions bar too.
    const linkPressedRef = useRef(false);
    // undefined until the first answer: the details are already being fetched on the way in.
    const lastSystemId = useRef<string | null | undefined>(undefined);

    // Members and invitations (the header's count, the invite prompt, who is already in): on the way in, then only
    // when a join/leave line appears in the chat or this member changed something. Not on every poll.
    const loadDetails = useCallback(async () => {
        if (kind !== 'group') return;
        const details = await fetchGroupDetails(id);
        if (!details) return;
        setGroup(details.group);
        setMemberKeys(new Set(details.members
            .filter(m => m.status === 'active' || m.status === 'invited')
            .map(m => m.memberPubkey)));
        setInvitedCount(details.members.filter(m => m.status === 'invited').length);
    }, [kind, id]);

    // Opening the chat reads it (decision 7: only Talk shows counts, so only reading clears one). The node's marker
    // moves only when there is something new, and "Your groups" drops the count at once and again once the node
    // has it, so a refresh already on its way cannot bring it back.
    const markRead = useCallback((latestId: string | null) => {
        if (!me || !latestId || readUpTo.current === latestId) return;
        readUpTo.current = latestId;
        yourGroupsStore.markRead(id);
        markThreadReadOnNode(id, me)
            .then(() => yourGroupsStore.markRead(id))
            .catch(() => { readUpTo.current = null; /* offline: the next poll tries again */ });
    }, [id, me]);

    // One request per poll (the chat), and never two at once on a slow connection.
    const load = useCallback(async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        try {
            let answer: any;
            if (kind === 'group') {
                answer = await getGroupChat(id);
                setView(answer);
                setMute(m => chatMuteFromAnswer(answer, m));
            } else {
                answer = await getEnterpriseChat(id);
                setView({ ...answer, canPost: !answer.readOnly, notice: ENTERPRISE_CHAT_NOTICE });
                setMute(m => chatMuteFromAnswer(answer, m));
            }
            setError(null);
            const msgs: any[] = answer?.messages || [];
            // A message of mine that the node now holds is no longer pending here.
            setPending(prev => prev.filter(p => !msgs.some((m: any) => String(m.id) === p.clientId)));
            if (shouldFollowNewMessages({ grew: msgs.length > messageCountRef.current, isBackgroundPoll: true, atBottom: atBottomRef.current })) {
                setTimeout(() => scrollChatToBottom(listRef, true), 100);
            }
            messageCountRef.current = msgs.length;
            markRead(msgs.length ? String(msgs[msgs.length - 1].id) : null);
            const system = [...msgs].reverse().find(m => m.type === 'system' || m.authorPubkey === 'SYSTEM');
            const systemId = system ? String(system.id) : null;
            if (systemId !== lastSystemId.current) {
                const firstAnswer = lastSystemId.current === undefined;
                lastSystemId.current = systemId;
                if (!firstAnswer) loadDetails().catch(() => { });
            }
        } catch (e: any) {
            setError(e?.message || 'Could not open this chat.');
        } finally {
            inFlight.current = false;
        }
    }, [kind, id, markRead, loadDetails]);

    useEffect(() => {
        loadDetails().catch(() => { });
        load();
    }, [load, loadDetails]);
    useEffect(() => {
        const t = setInterval(load, 15000);
        return () => clearInterval(t);
    }, [load]);

    const goBack = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)/chats'); };

    const name = view?.group?.name || group?.name || view?.conversation?.name || initialName || (kind === 'group' ? 'Group' : 'Enterprise');
    const category = view?.group?.category || group?.category || null;
    const rawMessages: any[] = view?.messages || [];
    const isConvenor = !!view?.isConvenor;
    const canPost = !!view?.canPost && !!me;

    /** The node's messages in the one shape every chat's components speak, plus what this phone still owes. */
    const messages: ChatMessage[] = useMemo(() => {
        const fromNode = rawMessages.map(m => normaliseThreadMessage(m, decodeEventChatText, me));
        const mine: ChatMessage[] = pending.map(p => ({
            id: p.clientId,
            senderId: me || '',
            text: p.text,
            type: 'text',
            metadata: p.replyToId ? { replyToId: p.replyToId } : undefined,
            sendState: p.state,
            outgoing: true,
            rawTimestamp: p.timestamp,
            timestamp: new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }));
        return [...fromNode, ...mine];
    }, [rawMessages, pending, me]);

    const spokenCount = useMemo(
        () => rawMessages.filter(m => m.type !== 'system' && m.authorPubkey !== 'SYSTEM').length,
        [rawMessages],
    );
    const messagesById = useMemo(() => new Map(messages.map(m => [m.id, m])), [messages]);
    const listItems = useMemo(() => buildChatListItems(messages), [messages]);
    const showAuthorById = useMemo(() => {
        const map = new Map<string, boolean>();
        messages.forEach((m, i) => map.set(m.id, showsAuthorName(m, messages[i - 1], { kind, myPubkey: me })));
        return map;
    }, [messages, kind, me]);

    const viewer: ChatViewer = useMemo(() => ({
        kind,
        myPubkey: me ?? null,
        canPost,
        // An enterprise thread's removals stay a keeper matter on its own page this round.
        isModerator: kind === 'group' && isConvenor,
    }), [kind, me, canPost, isConvenor]);

    const activeCount = group?.memberCount ?? null;
    const aloneInGroup = kind === 'group' && isConvenor && (activeCount ?? 0) <= 1;
    // The big prompt is for a convenor still alone with nobody asked yet; once invitations are out it steps aside
    // and the empty chat says who is on the way.
    const showInvitePrompt = shouldShowInvitePrompt({
        kind, isConvenor, justCreated: !!justCreated, activeCount, invitedCount, spokenCount, skipped: inviteSkipped,
    });
    const muted = isMuted(mute);

    const detail = useMemo(() => {
        const bits: string[] = [];
        if (kind === 'group' && activeCount != null) bits.push(`${activeCount} ${activeCount === 1 ? 'member' : 'members'}`);
        if (muted) bits.push('muted');
        return bits.join(' · ') || null;
    }, [kind, activeCount, muted]);

    const openUrl = useCallback((raw: string) => {
        linkPressedRef.current = true;
        setTimeout(() => { linkPressedRef.current = false; }, 350);
        const url = normaliseTappedUrl(raw);
        if (!url) return;
        Linking.openURL(url).catch(() => Alert.alert('Cannot open link', url));
    }, []);

    /** Deliver one message. Shared by a first send and by a Resend, so both are the same code path. */
    const deliver = useCallback(async (p: PendingMessage) => {
        try {
            if (kind === 'group') await postGroupChatMessage(id, p.text, p.clientId, p.replyToId);
            else await postEnterpriseChatMessage(id, p.text, p.clientId);
            // A poll may be mid-flight with the chat as it was before this message; wait for it, then read again.
            while (inFlight.current) await new Promise(r => setTimeout(r, 100));
            await load();
            setPending(prev => prev.filter(x => x.clientId !== p.clientId));
            scrollChatToBottom(listRef, true);
        } catch (e: any) {
            // The bubble stays, marked "not delivered" — tapping it offers Resend or Discard, as in a DM.
            setPending(prev => prev.map(x => (x.clientId === p.clientId ? { ...x, state: 'failed' } : x)));
            console.warn('[GroupChat] send failed:', e?.message || e);
        }
    }, [kind, id, load]);

    const send = async (text: string) => {
        if (!text || sending) return;
        setSending(true);
        hapticTick();
        try {
            if (editingMessage) {
                const target = editingMessage;
                setEditingMessage(null);
                try {
                    await editThreadMessage(target.id, text);
                    await load();
                } catch (e: any) {
                    await Promise.race([KeyboardController.dismiss(), new Promise(r => setTimeout(r, 400))]);
                    Alert.alert('Not changed', chatActionErrorMessage(e?.status, e?.message));
                }
                return;
            }
            const p: PendingMessage = {
                clientId: clientIdRef.current,
                text,
                replyToId: replyToMessage?.id ?? null,
                state: 'sending',
                timestamp: new Date().toISOString(),
            };
            clientIdRef.current = Crypto.randomUUID();
            setPending(prev => [...prev, p]);
            setReplyToMessage(null);
            scrollChatToBottom(listRef, true);
            await deliver(p);
        } finally {
            setSending(false);
        }
    };

    /** A failed send renders "! not delivered" — tapping the bubble lands here, exactly as in a DM. */
    const handleFailedMessagePress = async (item: ChatMessage) => {
        const p = pending.find(x => x.clientId === item.id);
        if (!p) return;
        await Promise.race([KeyboardController.dismiss(), new Promise(r => setTimeout(r, 400))]);
        Alert.alert('Message not delivered', 'This message could not be sent.', [
            { text: 'Discard', style: 'destructive', onPress: () => setPending(prev => prev.filter(x => x.clientId !== p.clientId)) },
            { text: 'Resend', onPress: () => {
                setPending(prev => prev.map(x => (x.clientId === p.clientId ? { ...x, state: 'sending' } : x)));
                deliver({ ...p, state: 'sending' });
            } },
            { text: 'Cancel', style: 'cancel' },
        ]);
    };

    const react = async (messageId: string, emoji: string) => {
        if (!me) return;
        setActiveEmojiPickerId(null);
        setActiveMessageActionsId(null);
        try {
            await toggleMessageReactionApi(messageId, me, emoji);
            hapticSuccess();
            await load();
        } catch (e: any) {
            hapticWarning();
            Alert.alert('Not reacted', chatActionErrorMessage(e?.status, e?.message));
        }
    };

    const removeMessage = async (item: ChatMessage) => {
        setActiveMessageActionsId(null);
        setActiveEmojiPickerId(null);
        const author = item.authorName || (item.senderId || '').slice(0, 8) || 'this member';
        await Promise.race([KeyboardController.dismiss(), new Promise(r => setTimeout(r, 400))]);
        Alert.alert('Remove this message?', 'It will read "Removed by a convenor" to everyone in the chat.', [
            { text: 'Keep it', style: 'cancel' },
            { text: 'Remove', style: 'destructive', onPress: async () => {
                try {
                    await removeGroupChatMessage(id, item.id);
                    await load();
                } catch (e: any) {
                    Alert.alert('Not removed', chatActionErrorMessage(e?.status, e?.message) || `Could not remove ${author}'s message.`);
                }
            } },
        ]);
    };

    const deleteMessage = async (item: ChatMessage) => {
        setActiveMessageActionsId(null);
        setActiveEmojiPickerId(null);
        await Promise.race([KeyboardController.dismiss(), new Promise(r => setTimeout(r, 400))]);
        Alert.alert('Delete for everyone?', 'It will read "This message was deleted" to everyone in the chat.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: async () => {
                try {
                    await deleteMessageApi(item.id);
                    hapticSuccess();
                    await load();
                } catch (e: any) {
                    hapticWarning();
                    Alert.alert('Not deleted', chatActionErrorMessage(e?.status, e?.message));
                }
            } },
        ]);
    };

    const setMuteTo = async (duration: '8h' | '1w' | 'always' | 'off') => {
        setMuteOpen(false);
        try {
            const res = await muteChatApi(id, duration);
            const next = duration === 'off' ? null : (res?.mute ?? { conversationId: id, mutedUntil: null, always: duration === 'always' });
            setMute(next);
            yourGroupsStore.setMute(id, next);
        } catch (e: any) {
            Alert.alert('Not changed', e?.message || 'Could not reach the node.');
        }
    };

    const openOwner = () => {
        if (kind === 'enterprise') {
            router.push({ pathname: '/treasury-detail', params: { publicKey: id, name } });
            return;
        }
        if (group) setInfoOpen(true);
    };

    const openMenu = async () => {
        await Promise.race([KeyboardController.dismiss(), new Promise(r => setTimeout(r, 400))]);
        setMenuOpen(true);
    };

    const header = (
        <ChatOwnerHeader
            kind={kind}
            name={name}
            category={category}
            detail={detail}
            onBack={goBack}
            onOpenOwner={openOwner}
            onMenu={openMenu}
        />
    );

    if (error && !view) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
                {header}
                <Text style={chat.errorText} accessibilityRole="alert">{error}</Text>
                <Pressable style={chat.retryBtn} onPress={() => { setError(null); loadDetails().catch(() => { }); load(); }} accessibilityRole="button">
                    <Text style={chat.retryText}>Try again</Text>
                </Pressable>
            </View>
        );
    }
    if (!view) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
                {header}
                {/* The chat's outline while it loads: the header already names it, from the tap. */}
                <View style={chat.listContent} accessibilityRole="progressbar" accessibilityLabel="Loading the chat">
                    {[{ w: '62%', mine: false }, { w: '48%', mine: true }, { w: '70%', mine: false }].map((b, i) => (
                        <View key={i} style={[chat.skeletonRow, b.mine && chat.skeletonRowMine]}>
                            <View style={[chat.skeletonBubble, { width: b.w as any }]} />
                        </View>
                    ))}
                </View>
            </View>
        );
    }

    const invitePrompt = (
        <View style={styles.inviteCard}>
            <Text style={styles.inviteEmoji} allowFontScaling={false}>👋</Text>
            <Text style={styles.inviteTitle}>Who do you want to invite?</Text>
            <Text style={styles.inviteBody}>
                {name} is ready. It's just you so far — invite the people you want to talk to here.
            </Text>
            <Pressable
                style={styles.inviteBigBtn}
                onPress={() => setInviteOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Invite people"
            >
                <MaterialCommunityIcons name="account-plus" size={22} color={colors.text.inverse} />
                <Text style={styles.inviteBigText} numberOfLines={1}>Invite people</Text>
            </Pressable>
            <Pressable
                style={styles.skipBtn}
                onPress={() => setInviteSkipped(true)}
                accessibilityRole="button"
                accessibilityLabel="Not now. You can invite people later from the menu."
            >
                <Text style={styles.skipText}>Not now</Text>
            </Pressable>
            <Text style={styles.inviteHint}>You can invite people any time from the ⋮ menu.</Text>
        </View>
    );

    const menuItems: ChatMenuItem[] = [
        { icon: 'account-plus', label: 'Invite people', hidden: kind !== 'group' || !isConvenor, onPress: () => { setMenuOpen(false); setInviteOpen(true); } },
        { icon: muted ? 'bell-ring-outline' : 'bell-off-outline', label: muteMenuLabel(mute), onPress: () => { setMenuOpen(false); if (muted) setMuteTo('off'); else setMuteOpen(true); } },
        { icon: 'information-outline', label: kind === 'group' ? 'Group info' : 'Enterprise page', onPress: () => { setMenuOpen(false); openOwner(); } },
    ];

    const renderMessage = (item: ChatMessage) => {
        if (item.type === 'system' || item.senderId === 'SYSTEM') return <SystemLine text={item.text} styles={styles} />;

        const isMe = !!me && item.senderId === me;
        const actions = messageActions(item, viewer);

        const quote = item.metadata?.replyToId ? (() => {
            const parent = messagesById.get(item.metadata.replyToId);
            const parentText = !parent
                ? 'Message not found'
                : isTombstone(parent) ? tombstoneText(parent) : parent.text;
            const parentAuthor = !parent
                ? 'Someone'
                : (me && parent.senderId === me) ? 'You' : (parent.authorName || (parent.senderId || '').slice(0, 8) || 'Someone');
            return {
                author: parentAuthor,
                text: parentText,
                onPress: () => {
                    const index = listItems.findIndex((m: any) => m.id === item.metadata.replyToId);
                    if (index > -1) {
                        try { listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 }); }
                        catch (e) { console.warn(e); }
                    }
                },
            };
        })() : null;

        const status = isMe ? (
            item.sendState === 'sending' ? (
                <Text style={{ fontSize: 10, color: colors.chat.tickUnread }}> ◷</Text>
            ) : item.sendState === 'failed' ? (
                <Text style={{ fontSize: 10, color: colors.feedback.danger.solid, fontWeight: '800' }}> ! not delivered</Text>
            ) : (
                // One tick: the node has it. A group has no single reader, so there is no second tick to earn.
                <Text style={{ fontSize: 10, color: colors.chat.tickUnread }}> ✓</Text>
            )
        ) : null;

        return (
            <ChatMessageRow
                item={item}
                isMe={isMe}
                styles={chat}
                actions={actions}
                showActions={activeMessageActionsId === item.id}
                showEmojiPicker={activeEmojiPickerId === item.id}
                pickerPosition={pickerPosition}
                onPressBubble={(event: any) => {
                    if (linkPressedRef.current) { linkPressedRef.current = false; return; }
                    if (item.sendState === 'failed') { handleFailedMessagePress(item); return; }
                    const pageY = event?.nativeEvent?.pageY;
                    setPickerPosition(pageY && pageY < 230 ? 'bottom' : 'top');
                    if (activeMessageActionsId === item.id) {
                        setActiveMessageActionsId(null);
                        setActiveEmojiPickerId(null);
                    } else {
                        setActiveMessageActionsId(item.id);
                        setActiveEmojiPickerId(null);
                    }
                }}
                onReply={() => { setReplyToMessage(item); setEditingMessage(null); setActiveMessageActionsId(null); }}
                onToggleEmojiPicker={() => setActiveEmojiPickerId(activeEmojiPickerId === item.id ? null : item.id)}
                onEdit={() => {
                    setEditingMessage(item);
                    setReplyToMessage(null);
                    composerRef.current?.setText(item.text || '');
                    setActiveMessageActionsId(null);
                    setActiveEmojiPickerId(null);
                }}
                onDelete={() => deleteMessage(item)}
                onRemove={() => removeMessage(item)}
                onPickEmoji={emoji => react(item.id, emoji)}
                onPressUrl={openUrl}
                authorLabel={showAuthorById.get(item.id) ? (item.authorName || (item.senderId || '').slice(0, 8)) : null}
                quote={quote}
                status={status}
            />
        );
    };

    return (
        <KeyboardAvoidingView style={[styles.container, { paddingTop: insets.top }]} behavior="padding">
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            {header}

            {!!view.readOnly && (
                <Text style={styles.readOnly} numberOfLines={3}>This chat is read-only now.</Text>
            )}

            <ChatMessageList
                listRef={listRef}
                items={listItems}
                styles={chat}
                renderMessage={renderMessage}
                activeId={activeEmojiPickerId || activeMessageActionsId}
                onAtBottomChange={atBottom => { atBottomRef.current = atBottom; }}
                onScrollBeginDrag={() => { setActiveMessageActionsId(null); setActiveEmojiPickerId(null); }}
                // Inverted: the footer is what renders at the visual TOP, above the oldest message.
                ListFooterComponent={showInvitePrompt ? invitePrompt : null}
                ListEmptyComponent={
                    showInvitePrompt ? null : (
                        <Text style={chat.empty}>
                            {invitedCount > 0 && aloneInGroup
                                ? `${invitedCount} ${invitedCount === 1 ? 'invitation' : 'invitations'} sent. You'll see people here as they join.`
                                : 'No messages yet. Say hello.'}
                        </Text>
                    )
                }
            />

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
                    author={me && replyToMessage.senderId === me ? 'You' : (replyToMessage.authorName || 'Someone')}
                    text={replyToMessage.text}
                    onCancel={() => setReplyToMessage(null)}
                />
            )}

            {canPost && (
                <ChatComposer
                    ref={composerRef}
                    styles={chat}
                    onSend={send}
                    busy={sending}
                    maxLength={GROUP_MESSAGE_MAX}
                    notice={view.notice}
                    // A long name wrapped the placeholder to three lines at 320dp; short ones read better named.
                    placeholder={name.length <= 18 ? `Message ${name}…` : (kind === 'group' ? 'Message the group…' : 'Message…')}
                    accessibilityLabel={`Message ${name}`}
                    bottomPadding={keyboardVisible ? 8 : Math.max(insets.bottom, 12)}
                />
            )}

            <ChatMenuSheet
                styles={chat}
                menuOpen={menuOpen}
                muteOpen={muteOpen}
                title={name}
                items={menuItems}
                // Only a group's chat sends @mention pushes; an enterprise thread has none to let through.
                muteHint={kind === 'group' ? '@mentions still reach you.' : null}
                onClose={() => { setMenuOpen(false); setMuteOpen(false); }}
                onPickMute={setMuteTo}
                bottomInset={insets.bottom}
            />

            {kind === 'group' && (
                <InvitePeopleSheet
                    isOpen={inviteOpen}
                    groupId={id}
                    groupName={name}
                    existing={memberKeys}
                    myPubkey={me}
                    onClose={() => setInviteOpen(false)}
                    onInvited={(n) => { if (n > 0) { setInviteSkipped(true); loadDetails().catch(() => { }); } }}
                />
            )}
            {kind === 'group' && (
                <GroupDetailModal
                    group={group}
                    isOpen={infoOpen}
                    onClose={() => setInfoOpen(false)}
                    myPubkey={me}
                    onMembershipChanged={() => { loadDetails().catch(() => { }); load(); }}
                />
            )}
        </KeyboardAvoidingView>
    );
}

function SystemLine({ text, styles }: { text: string; styles: ReturnType<typeof makeStyles> }) {
    return (
        <View style={styles.systemWrap}>
            <Text style={styles.systemText}>{text}</Text>
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) =>
    StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        readOnly: {
            marginHorizontal: 12, marginTop: 10, padding: 10, borderRadius: 10,
            backgroundColor: colors.surface.subtle, color: colors.text.secondary, fontSize: 13, textAlign: 'center',
        },
        inviteCard: {
            alignItems: 'center', padding: 20, marginTop: 12, marginBottom: 16, borderRadius: 18,
            backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default,
        },
        inviteEmoji: { fontSize: 40 },
        inviteTitle: { fontSize: 22, fontWeight: '800', color: colors.text.heading, marginTop: 8, textAlign: 'center' },
        inviteBody: { fontSize: 15, lineHeight: 21, color: colors.text.secondary, textAlign: 'center', marginTop: 8 },
        inviteBigBtn: {
            flexDirection: 'row', gap: 10, alignSelf: 'stretch', minHeight: 56, marginTop: 18, borderRadius: 16,
            alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brand.primary, paddingHorizontal: 16,
        },
        inviteBigText: { color: colors.text.inverse, fontSize: 18, fontWeight: '800' },
        skipBtn: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, marginTop: 4 },
        skipText: { fontSize: 15, fontWeight: '700', color: colors.text.secondary },
        inviteHint: { fontSize: 12, color: colors.text.muted, textAlign: 'center' },
        systemWrap: { alignItems: 'center', marginVertical: 6, paddingHorizontal: 16 },
        systemText: {
            fontSize: 12, color: colors.text.secondary, textAlign: 'center', overflow: 'hidden',
            backgroundColor: colors.surface.subtle, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10,
        },
    });
