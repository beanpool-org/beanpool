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
 * Keyboard: KeyboardAvoidingView from react-native-keyboard-controller, padding on both platforms, no nested
 * provider (memory keyboard-avoidance-pattern). At 320dp and 1.3× text the header truncates the name, the
 * composer keeps a 48dp Send that never shrinks and the notice wraps.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, TextInput, ActivityIndicator, Alert, Modal } from 'react-native';
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
    markThreadReadOnNode,
    type GroupItem,
} from '../utils/db';
import { decodeEventChatText } from '../utils/events';
import {
    isMuted, threadMessageText, showInvitePrompt as shouldShowInvitePrompt, chatMuteFromRows, chatMuteFromAnswer, muteMenuLabel,
    ENTERPRISE_CHAT_NOTICE,
    type YourChatMute,
} from '../utils/your-groups';
import { yourGroupsStore } from './useYourGroups';
import { hapticTick } from '../utils/haptics';
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

const MUTE_CHOICES: Array<{ key: '8h' | '1w' | 'always'; label: string }> = [
    { key: '8h', label: 'For 8 hours' },
    { key: '1w', label: 'For a week' },
    { key: 'always', label: 'Always' },
];

export function GroupChatView({ kind, id, justCreated, initialName }: Props) {
    const insets = useSafeAreaInsets();
    const { colors, theme } = useTheme();
    const styles = useStyles(makeStyles);
    const { identity } = useIdentity();
    const keyboardVisible = useKeyboardState(s => s.isVisible);
    const me = identity?.publicKey;

    const [view, setView] = useState<any | null>(null);
    const [group, setGroup] = useState<GroupItem | null>(null);
    const [memberKeys, setMemberKeys] = useState<Set<string>>(new Set());
    const [invitedCount, setInvitedCount] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [muteOpen, setMuteOpen] = useState(false);
    const [inviteOpen, setInviteOpen] = useState(false);
    const [infoOpen, setInfoOpen] = useState(false);
    const [inviteSkipped, setInviteSkipped] = useState(false);
    // Seeded from this chat's "Your groups" row, so a mute set on an earlier visit shows (and can be undone) before
    // the chat loads — and on a node too old to return the mute with an enterprise thread.
    const [mute, setMute] = useState<YourChatMute | null>(() => chatMuteFromRows(yourGroupsStore.getState().items, id));
    const draftRef = useRef('');
    // One id per message being written, so a send retried after a dropped connection is stored once (the node
    // de-duplicates on it). A new one once the node has it.
    const clientIdRef = useRef<string>(Crypto.randomUUID());
    const listRef = useRef<FlatList>(null);
    const inFlight = useRef(false);
    const readUpTo = useRef<string | null>(null);
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
            let chat: any;
            if (kind === 'group') {
                chat = await getGroupChat(id);
                setView(chat);
                setMute(m => chatMuteFromAnswer(chat, m));
            } else {
                chat = await getEnterpriseChat(id);
                setView({ ...chat, canPost: !chat.readOnly, notice: ENTERPRISE_CHAT_NOTICE });
                setMute(m => chatMuteFromAnswer(chat, m));
            }
            setError(null);
            const msgs: any[] = chat?.messages || [];
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
    const messages: any[] = view?.messages || [];
    const spoken = messages.filter(m => m.type !== 'system' && m.authorPubkey !== 'SYSTEM');
    const isConvenor = !!view?.isConvenor;
    const activeCount = group?.memberCount ?? null;
    const aloneInGroup = kind === 'group' && isConvenor && (activeCount ?? 0) <= 1;
    // The big prompt is for a convenor still alone with nobody asked yet; once invitations are out it steps aside
    // and the empty chat says who is on the way.
    const showInvitePrompt = shouldShowInvitePrompt({
        kind, isConvenor, justCreated: !!justCreated, activeCount, invitedCount, spokenCount: spoken.length, skipped: inviteSkipped,
    });
    const muted = isMuted(mute);

    const detail = useMemo(() => {
        const bits: string[] = [];
        if (kind === 'group' && activeCount != null) bits.push(`${activeCount} ${activeCount === 1 ? 'member' : 'members'}`);
        if (muted) bits.push('muted');
        return bits.join(' · ') || null;
    }, [kind, activeCount, muted]);

    const send = async () => {
        const text = draftRef.current.trim();
        if (!text || sending) return;
        setSending(true);
        hapticTick();
        try {
            if (kind === 'group') await postGroupChatMessage(id, text, clientIdRef.current);
            else await postEnterpriseChatMessage(id, text, clientIdRef.current);
            clientIdRef.current = Crypto.randomUUID();
            draftRef.current = '';
            setDraft('');
            // A poll may be mid-flight with the chat as it was before this message; wait for it, then read again.
            while (inFlight.current) await new Promise(r => setTimeout(r, 100));
            await load();
            listRef.current?.scrollToEnd({ animated: true });
        } catch (e: any) {
            await Promise.race([KeyboardController.dismiss(), new Promise(r => setTimeout(r, 400))]);
            Alert.alert('Not sent', e?.message || 'Could not reach the node. Try again when you have signal.');
        } finally {
            setSending(false);
        }
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
                <Text style={styles.errorText} accessibilityRole="alert">{error}</Text>
                <Pressable style={styles.retryBtn} onPress={() => { setError(null); loadDetails().catch(() => { }); load(); }} accessibilityRole="button">
                    <Text style={styles.retryText}>Try again</Text>
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
                <View style={styles.listContent} accessibilityRole="progressbar" accessibilityLabel="Loading the chat">
                    {[{ w: '62%', mine: false }, { w: '48%', mine: true }, { w: '70%', mine: false }].map((b, i) => (
                        <View key={i} style={[styles.skeletonRow, b.mine && styles.bubbleRowMine]}>
                            <View style={[styles.skeletonBubble, { width: b.w as any }]} />
                        </View>
                    ))}
                </View>
            </View>
        );
    }

    const canPost = !!view.canPost && !!me;

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

    const menuItems: Array<{ icon: string; label: string; onPress: () => void; hidden?: boolean }> = [
        { icon: 'account-plus', label: 'Invite people', hidden: kind !== 'group' || !isConvenor, onPress: () => { setMenuOpen(false); setInviteOpen(true); } },
        { icon: muted ? 'bell-ring-outline' : 'bell-off-outline', label: muteMenuLabel(mute), onPress: () => { setMenuOpen(false); if (muted) setMuteTo('off'); else setMuteOpen(true); } },
        { icon: 'information-outline', label: kind === 'group' ? 'Group info' : 'Enterprise page', onPress: () => { setMenuOpen(false); openOwner(); } },
    ];

    return (
        <KeyboardAvoidingView style={[styles.container, { paddingTop: insets.top }]} behavior="padding">
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            {header}

            {!!view.readOnly && (
                <Text style={styles.readOnly} numberOfLines={3}>This chat is read-only now.</Text>
            )}

            {showInvitePrompt ? (
                <FlatList
                    data={messages}
                    keyExtractor={(m: any) => m.id}
                    contentContainerStyle={styles.listContent}
                    ListHeaderComponent={invitePrompt}
                    renderItem={({ item }) => <SystemLine item={item} styles={styles} />}
                />
            ) : (
                <FlatList
                    ref={listRef}
                    data={messages}
                    keyExtractor={(m: any) => m.id}
                    contentContainerStyle={styles.listContent}
                    onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
                    ListEmptyComponent={
                        <Text style={styles.empty}>
                            {invitedCount > 0 && aloneInGroup
                                ? `${invitedCount} ${invitedCount === 1 ? 'invitation' : 'invitations'} sent. You'll see people here as they join.`
                                : 'No messages yet. Say hello.'}
                        </Text>
                    }
                    renderItem={({ item, index }) => {
                        if (item.type === 'system' || item.authorPubkey === 'SYSTEM') return <SystemLine item={item} styles={styles} />;
                        const mine = item.authorPubkey === me;
                        const prev = messages[index - 1];
                        const showAuthor = !mine && (!prev || prev.authorPubkey !== item.authorPubkey || prev.type === 'system');
                        const removed = item.type === 'removed';
                        const time = new Date(item.timestamp);
                        return (
                            <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
                                <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                                    {showAuthor && (
                                        <Text style={styles.author} numberOfLines={1}>{item.authorCallsign || (item.authorPubkey || '').slice(0, 8)}</Text>
                                    )}
                                    <Text style={[styles.msgText, mine && styles.msgTextMine, removed && styles.msgRemoved]} selectable={!removed}>
                                        {threadMessageText(item, decodeEventChatText)}
                                    </Text>
                                    <Text style={[styles.msgTime, mine && styles.msgTimeMine]}>
                                        {isNaN(time.getTime()) ? '' : `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`}
                                    </Text>
                                </View>
                            </View>
                        );
                    }}
                />
            )}

            {canPost && (
                <View style={[styles.composer, { paddingBottom: keyboardVisible ? 8 : Math.max(insets.bottom, 12) }]}>
                    <Text style={styles.notice}>{view.notice}</Text>
                    <View style={styles.composerRow}>
                        <TextInput
                            style={styles.input}
                            value={draft}
                            onChangeText={(t) => { draftRef.current = t; setDraft(t); }}
                            // A long name wrapped the placeholder to three lines at 320dp; short ones read better named.
                            placeholder={name.length <= 18 ? `Message ${name}…` : (kind === 'group' ? 'Message the group…' : 'Message…')}
                            placeholderTextColor={colors.text.muted}
                            accessibilityLabel={`Message ${name}`}
                            multiline
                            maxLength={2000}
                        />
                        <Pressable
                            onPress={send}
                            disabled={sending || !draft.trim()}
                            style={[styles.sendBtn, (sending || !draft.trim()) && styles.sendBtnDisabled]}
                            accessibilityRole="button"
                            accessibilityLabel="Send"
                            accessibilityState={{ disabled: sending || !draft.trim(), busy: sending }}
                        >
                            {sending ? <ActivityIndicator size="small" color="#fff" /> : <MaterialCommunityIcons name="send" size={22} color="#fff" />}
                        </Pressable>
                    </View>
                </View>
            )}

            {/* Header menu. A small sheet, not a popover: the rows are full-width 56dp targets at 320dp. */}
            <Modal visible={menuOpen || muteOpen} transparent animationType="fade" onRequestClose={() => { setMenuOpen(false); setMuteOpen(false); }}>
                <Pressable style={styles.menuBackdrop} onPress={() => { setMenuOpen(false); setMuteOpen(false); }} accessibilityLabel="Close menu">
                    <View style={[styles.menuSheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
                        <Text style={styles.menuTitle} numberOfLines={1}>{muteOpen ? 'Mute notifications' : name}</Text>
                        {muteOpen ? (
                            <>
                                {MUTE_CHOICES.map(c => (
                                    <Pressable key={c.key} style={styles.menuRow} onPress={() => setMuteTo(c.key)} accessibilityRole="button">
                                        <Text style={styles.menuLabel}>{c.label}</Text>
                                    </Pressable>
                                ))}
                                {/* Only a group's chat sends @mention pushes; an enterprise thread has none to let through. */}
                                {kind === 'group' && <Text style={styles.menuHint}>@mentions still reach you.</Text>}
                            </>
                        ) : menuItems.filter(m => !m.hidden).map(m => (
                            <Pressable key={m.label} style={styles.menuRow} onPress={m.onPress} accessibilityRole="button">
                                <MaterialCommunityIcons name={m.icon as any} size={22} color={colors.text.body} />
                                <Text style={styles.menuLabel} numberOfLines={1}>{m.label}</Text>
                            </Pressable>
                        ))}
                    </View>
                </Pressable>
            </Modal>

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

function SystemLine({ item, styles }: { item: any; styles: ReturnType<typeof makeStyles> }) {
    return (
        <View style={styles.systemWrap}>
            <Text style={styles.systemText}>{threadMessageText(item, decodeEventChatText)}</Text>
        </View>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) =>
    StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        readOnly: {
            marginHorizontal: 12, marginTop: 10, padding: 10, borderRadius: 10,
            backgroundColor: colors.surface.subtle, color: colors.text.secondary, fontSize: 13, textAlign: 'center',
        },
        listContent: { padding: 12, flexGrow: 1 },
        empty: { fontSize: 14, color: colors.text.secondary, paddingVertical: 24, textAlign: 'center' },
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
        bubbleRow: { flexDirection: 'row', marginVertical: 3 },
        bubbleRowMine: { justifyContent: 'flex-end' },
        bubble: { maxWidth: '82%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
        bubbleMine: { backgroundColor: colors.accent.primary, borderBottomRightRadius: 4 },
        bubbleTheirs: {
            backgroundColor: colors.surface.card, borderBottomLeftRadius: 4,
            borderWidth: theme === 'dark' ? 0 : 1, borderColor: colors.border.default,
        },
        author: { fontSize: 12, fontWeight: '800', color: colors.brand.primary, marginBottom: 2 },
        msgText: { fontSize: 15, lineHeight: 21, color: colors.text.body },
        msgTextMine: { color: '#fff' },
        msgRemoved: { fontStyle: 'italic', opacity: 0.7 },
        msgTime: { fontSize: 10, color: colors.text.muted, alignSelf: 'flex-end', marginTop: 2 },
        msgTimeMine: { color: 'rgba(255,255,255,0.8)' },
        composer: { paddingHorizontal: 12, paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.border.default, backgroundColor: colors.surface.app },
        notice: { fontSize: 11, color: colors.text.muted, marginBottom: 6 },
        composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
        input: {
            flex: 1, minWidth: 0, minHeight: 48, maxHeight: 120, borderWidth: 1, borderColor: colors.border.default,
            borderRadius: 24, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15,
            color: colors.text.body, backgroundColor: colors.surface.card,
        },
        sendBtn: {
            flexShrink: 0, width: 48, height: 48, borderRadius: 24,
            alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent.primary,
        },
        sendBtnDisabled: { opacity: 0.5 },
        errorText: { margin: 16, fontSize: 15, color: colors.text.body, lineHeight: 21 },
        retryBtn: { minHeight: 48, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 16 },
        retryText: { fontSize: 15, fontWeight: '800', color: colors.brand.primary },
        skeletonRow: { flexDirection: 'row', marginVertical: 6 },
        skeletonBubble: { height: 40, borderRadius: 16, backgroundColor: colors.surface.subtle },
        menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
        menuSheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 8 },
        menuTitle: { fontSize: 13, fontWeight: '800', color: colors.text.secondary, paddingHorizontal: 20, paddingVertical: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
        menuRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingHorizontal: 20 },
        menuLabel: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.text.body },
        menuHint: { fontSize: 13, color: colors.text.muted, paddingHorizontal: 20, paddingVertical: 10 },
    });
