import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet, AppState, DeviceEventEmitter } from 'react-native';
import { router, usePathname } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useIdentity } from '../app/IdentityContext';
import { useTheme } from '../app/ThemeContext';
import { palette } from '../constants/colors';
import { getUnreadByConversation, getMarketplaceTransactions, signedGet } from '../utils/db';
import { createRefreshGate } from '../utils/refresh-gate';
import { anchorUrl, signedPost } from '../utils/node-post';
import { noticeRoute } from '../utils/push-notice-check';
import { cachedNodeRole, canManageNode, fetchAdminQueue, forgetNodeRole } from '../utils/node-admin';
import { getCachedNodeProfile, decisionsOn, type NodeFeatures } from '../utils/node-profile';
import type { BeanPoolIdentity } from '../utils/identity';
import {
    buildNeedsYou, isOwnInviteChange, needsTargetHref, NEEDS_YOU_PRIORITY, NEEDS_YOU_SLOT,
    type NeedsYouEntry, type NeedsYouInputs, type NeedsYouKind, type NeedsYouTarget,
} from '../utils/needs-you';
import { useManageNode } from './useManageNode';
import {
    BELL_EVENTS, bellBadge, bellClearWords, bellLabel, isOthersListingDoorbell, isPushNoticeKind, needsYouCounts, t, timeAgo, unseenBellNotices, withoutBellNotices, type BellNotice,
} from '@beanpool/core';
import { HOME_HEADER_WAIT_MS, forgetHomeForHeader, homeForHeader, homePath, onHomeRead } from '../utils/home-store';
import { localNeeds, mergeNeeds, type HomeAnswer, type HomeNeedsItem } from '../utils/home-cards';

// The bell (scratch/fable-design/DESIGN-web-notifications-fable.md §2.1, slice W0; Marty, 9 Nov 2026: it takes the
// needs-you row), between the bean and the invite icon: parity with the web's apps/pwa components/NeedsYouIcons.tsx. A red
// count of the notices not yet opened (the node's list, GET /api/notices/push?unseen=1: what this phone is buzzed with, and
// what a phone with no push still gets), an amber dot when nothing is new but something needs the member, and a sheet with
// the open things at the top ("Needs you": what the icons were; what counts, the order, the accent and the wording live in
// utils/needs-you.ts) and what happened under it, newest first, with the real words. A row leaves only when it is tapped
// (it opens its thing, by the push tap's own route table, and is marked), when its ✕ is pressed (marked, opens nothing), when
// "Clear all" is pressed (every notice, one request: { all: true }) or when its thing is opened (a chat read: the node marks
// it and tells the sockets, `bell_activity` here); opening the sheet marks nothing. "Needs you" is none of those: its rows
// are the open things, and leave when they are done (Marty, 10 Nov 2026, replacing the 9 Nov rule that had no "Clear all").
//
// Home's answer (GET /api/home, utils/home-store.ts) carries the same lines (design §5.2 "The header reads Home's
// answer"): while one is fresher than two minutes the node's part (admin work, votes, group lines) is drawn from it and
// the header asks the node nothing; on Home it waits a moment for the read Home has under way. The phone's own deals
// and unread messages still come from its database.

const ICON: Record<NeedsYouKind, React.ComponentProps<typeof MaterialCommunityIcons>['name']> = {
    admin: 'shield-account-outline',
    knock: 'door-open',
    ask: 'account-plus-outline',
    deal: 'handshake-outline',
    // A bill waiting on its payer (core bills.ts): its rows come from the node only to an app that opens a bill (B2).
    bill: 'receipt-text-outline',
    vote: 'vote-outline',
    invite: 'email-outline',
    message: 'message-text-outline',
    group: 'account-group-outline',
};

// Warm and readable on the vine header, which is dark in both themes. Calm: no red.
const ACCENT = palette.amber300;
const NEUTRAL = '#ffffff';
// What asks the node (Decisions, Your groups) runs at most once per 15 s, whatever triggered it. The local
// reads (deals and unread counts, both SQLite) run on every trigger; they cost no request.
const NODE_MIN_GAP_MS = 15_000;
// A backstop for anything no event announces (a vote opening, say). Only while the app is in front.
const SAFETY_POLL_MS = 120_000;
// A notice kept: the list is read again this long after, so a burst is one read.
const BELL_SETTLE_MS = 300;
// The small bell, where the row has room for it but not for the full one; under it, none.
const SMALL_BELL = 32;
// A ws nudge usually means a message is on its way into the local database; the tab layout's sync
// writes it there, so read a moment later rather than immediately.
const WS_SETTLE_MS = 3_000;

/** Every landing but 'admin', which needs the phone unlock and sign-in link (useManageNode). Home's Needs you card too. */
export function goToNeedsTarget(target: Exclude<NeedsYouTarget, { to: 'admin' }>) {
    return router.push(needsTargetHref(target));
}

type LocalParts = Pick<NeedsYouInputs, 'transactions' | 'conversations'>;
type NodeParts = Pick<NeedsYouInputs, 'groupChats' | 'groupInvites' | 'admin'> & {
    communityName: string | null;
    /** Home's vote line, from the header's own read (loadNode); drawn by Home's rule (mergeNeeds) with the switches beside it. */
    votes: HomeNeedsItem[] | null;
    features: HomeAnswer['features'] | null;
};
const NO_NODE_PARTS: NodeParts = { groupChats: null, groupInvites: null, admin: null, communityName: null, votes: null, features: null };
const settle = <T,>(p: Promise<T>) => p.catch(() => null);

/** From the phone's own database: no request, nothing decrypted. */
async function loadLocal(me: string): Promise<LocalParts> {
    const [transactions, conversations] = await Promise.all([
        settle(getMarketplaceTransactions(me)),
        settle(getUnreadByConversation(me)),
    ]);
    return { transactions, conversations };
}

/**
 * Owners, admins and moderators only: the role is remembered for ten minutes (utils/node-admin.ts), and the
 * admin queue is asked for only when it says one of those (a moderator's holds the reports alone). Everyone else sends no queue request at all.
 */
async function loadAdmin(identity: BeanPoolIdentity): Promise<Pick<NodeParts, 'admin' | 'communityName'>> {
    const url = await anchorUrl();
    if (!url) return { admin: null, communityName: null };
    const mine = await cachedNodeRole(url, identity);
    if (!canManageNode(mine.role)) return { admin: { role: mine.role, queue: null }, communityName: mine.communityName };
    const queue = await fetchAdminQueue(url, identity);
    // Refused or unanswered: a demotion looks like this, so ask the role afresh next time.
    if (!queue) forgetNodeRole(url, identity.publicKey);
    return { admin: { role: mine.role, queue }, communityName: mine.communityName };
}

/** The switches of the community the phone is on, as it last said (the tab strip keeps that copy current). No request. */
async function switchesHere(): Promise<NodeFeatures | null> {
    const profile = await settle((async () => getCachedNodeProfile(await anchorUrl()))());
    return profile?.features ?? null;
}

/**
 * Two signed requests to the node, plus the admin queue for owners and admins. The votes are Home's own vote line, asked
 * as Home asks it (GET /api/home?cards=needs&lands=enterprise): the community's Decisions and the keepers' votes the
 * member is on the roll of, the line landing where Home's does (an enterprise's own screen for a keepers' vote). It is
 * drawn by Home's rule (`mergeNeeds`): a vote on Commons → Decide only where that tab is there (home-cards.ts
 * `decideOnNode`), so a vote never opens a hidden tab, and the icon doesn't come and go with the age of Home's answer
 * (PR #1483 review 4166559525; review opus-1767 N3). With Decisions off (the worldwide community) nothing is asked, and
 * the 🛡️ words don't say an emergency suspension is being voted on.
 */
async function loadNode(identity: BeanPoolIdentity): Promise<NodeParts> {
    const features = await switchesHere();
    const [home, yourGroups, admin] = await Promise.all([
        decisionsOn(features) ? settle(signedGet(homePath(['needs'])).then(r => (r.ok ? r.json() : null))) : null,
        settle(signedGet('/api/your-groups').then(r => (r.ok ? r.json() : null))),
        settle(loadAdmin(identity)),
    ]);
    const needs = home?.cards?.needs?.items;
    return {
        votes: Array.isArray(needs) ? needs.filter((i: HomeNeedsItem) => i?.kind === 'vote') : null,
        features: features ? { ...features } : null,
        groupChats: Array.isArray(yourGroups?.items) ? yourGroups.items : null,
        // The member's open invitations to groups, beside their chats (a node from before them says none).
        groupInvites: Array.isArray(yourGroups?.invites) ? yourGroups.invites : null,
        admin: admin?.admin ? { ...admin.admin, decisions: decisionsOn(features) } : null,
        communityName: admin?.communityName ?? null,
    };
}

function NeedIcon({ e, open }: { e: NeedsYouEntry; open: (t: NeedsYouTarget) => void }) {
    const color = e.accent ? ACCENT : NEUTRAL;
    return (
        <Pressable onPress={() => open(e.target)} style={({ pressed }) => [s.slot, pressed && s.pressed]}
            accessibilityRole="button" accessibilityLabel={e.label}>
            <MaterialCommunityIcons name={ICON[e.kind]} size={24} color={color} style={s.iconShadow} />
            {e.count > 1 && (
                <View style={[s.countDot, { backgroundColor: e.accent ? ACCENT : 'rgba(255,255,255,0.9)' }]}>
                    <Text style={s.countText} allowFontScaling={false}>{e.count > 9 ? '9+' : e.count}</Text>
                </View>
            )}
        </Pressable>
    );
}

// Shown to members only: a guest or a phone with no community sees the header's Join / Connect pill here instead.
export function NeedsYouIcons({ sheetTop }: { sheetTop: number }) {
    const { identity } = useIdentity();
    const { colors } = useTheme();
    const pathname = usePathname();
    const [entries, setEntries] = useState<NeedsYouEntry[]>([]);
    const [notices, setNotices] = useState<BellNotice[]>([]);
    const [sheet, setSheet] = useState(false);
    const [width, setWidth] = useState(0);
    const me = identity?.publicKey;
    const identityRef = useRef(identity);
    identityRef.current = identity;
    const manage = useManageNode();

    const local = useRef<LocalParts>({ transactions: null, conversations: null });
    const node = useRef<NodeParts>(NO_NODE_PARTS);
    /** The node's lines from Home's answer, with the node's switches, while the header draws from it (null: from its own reads). */
    const home = useRef<{ items: HomeNeedsItem[]; features: HomeAnswer['features'] } | null>(null);
    const localBusy = useRef(false);
    const localAgain = useRef(false);
    const nodeBusy = useRef(false);
    const gate = useRef<ReturnType<typeof createRefreshGate> | null>(null);
    const pathnameRef = useRef(pathname);
    pathnameRef.current = pathname;

    const rebuild = useCallback(() => {
        if (!me) { setEntries([]); return; }
        const now = Date.now();
        if (home.current) {
            setEntries(mergeNeeds(home.current.items, localNeeds(me, now, local.current.transactions, local.current.conversations), now, home.current.features));
            return;
        }
        const { groupChats, groupInvites, admin, votes, features } = node.current;
        const rank = (k: NeedsYouKind) => NEEDS_YOU_PRIORITY.indexOf(k);
        setEntries([...buildNeedsYou({ me, now, ...local.current, decisions: null, groupChats, groupInvites, admin }), ...mergeNeeds(votes, null, now, features)]
            .sort((a, b) => rank(a.kind) - rank(b.kind)));
    }, [me]);

    const refreshLocal = useCallback(async () => {
        if (!me) return;
        if (localBusy.current) { localAgain.current = true; return; }
        localBusy.current = true;
        try {
            do {
                localAgain.current = false;
                local.current = await loadLocal(me);
                rebuild();
            } while (localAgain.current);
        } catch { /* keep what we had */ } finally { localBusy.current = false; }
    }, [me, rebuild]);

    // The bell's list, read with the node's part (at most once per 15 s), and at once when the node says one was kept.
    const bellBusy = useRef(false);
    const refreshBell = useCallback(async () => {
        if (!me || bellBusy.current) return;
        bellBusy.current = true;
        try {
            const r = await signedGet('/api/notices/push?unseen=1');
            if (r.ok && identityRef.current?.publicKey === me) setNotices(unseenBellNotices(await r.json()));
        } catch { /* a node from before the bell, or no network: keep what we had */ } finally { bellBusy.current = false; }
    }, [me]);

    // A new identity starts from nothing, and gets its own gate.
    useEffect(() => {
        local.current = { transactions: null, conversations: null };
        node.current = NO_NODE_PARTS;
        home.current = null;
        setEntries([]);
        setNotices([]);
        if (!me) return;
        const g = createRefreshGate(NODE_MIN_GAP_MS, async () => {
            const id = identityRef.current;
            if (nodeBusy.current || !id || id.publicKey !== me) return;
            refreshBell();
            nodeBusy.current = true;
            try {
                // Home's answer when it is fresh (or, on Home, the one its read is about to bring): no request of our own.
                const url = await anchorUrl();
                const fromHome = await homeForHeader(url, me, pathnameRef.current === '/' ? HOME_HEADER_WAIT_MS : 0);
                if (fromHome) {
                    home.current = { items: fromHome.answer.cards.needs?.items ?? [], features: fromHome.answer.features };
                    node.current = { ...node.current, communityName: fromHome.answer.cards.community?.name ?? node.current.communityName };
                } else {
                    home.current = null;
                    node.current = await loadNode(id);
                }
                rebuild();
            } catch { /* keep what we had */ } finally { nodeBusy.current = false; }
        });
        gate.current = g;
        // Home's read landed: draw from it at once (its lines are the node's, as fresh as they come).
        const off = onHomeRead((read, _url, publicKey) => {
            if (read.kind !== 'answer' || publicKey !== me || !read.stored.asked.split(',').includes('needs')) return;
            home.current = { items: read.stored.answer.cards.needs?.items ?? [], features: read.stored.answer.features };
            rebuild();
        });
        return () => { g.cancel(); off(); if (gate.current === g) gate.current = null; };
    }, [me, rebuild, refreshBell]);

    // The node's word on the bell (services/ws-client.ts): a notice kept for this member, or some marked seen (a chat read
    // here or on another device, a row tapped on the web).
    useEffect(() => {
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        const sub = DeviceEventEmitter.addListener('bell_activity', (data: { type?: unknown; ids?: unknown }) => {
            if (data?.type === BELL_EVENTS.seen && Array.isArray(data.ids)) {
                setNotices(list => withoutBellNotices(list, data.ids as unknown[]));
                return;
            }
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(refreshBell, BELL_SETTLE_MS);
        });
        return () => { sub.remove(); if (settleTimer) clearTimeout(settleTimer); };
    }, [refreshBell]);

    const poke = useCallback(() => {
        refreshLocal();
        gate.current?.request();
    }, [refreshLocal]);

    // Each page change is a focus: returning from a chat you just read, or switching tab.
    useEffect(() => { poke(); }, [poke, pathname]);

    // Coming back to the app, a debounced ws nudge, and the slow safety poll while the app is in front.
    useEffect(() => {
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        let poll: ReturnType<typeof setInterval> | null = null;
        const startPoll = () => { if (!poll) poll = setInterval(poke, SAFETY_POLL_MS); };
        const stopPoll = () => { if (poll) clearInterval(poll); poll = null; };
        if (AppState.currentState === 'active') startPoll();
        const app = AppState.addEventListener('change', st => {
            if (st === 'active') { poke(); startPoll(); } else stopPoll();
        });
        const ws = DeviceEventEmitter.addListener('ws_activity', (data: unknown) => {
            // One of the member's own group invitations made, taken up, declined or withdrawn: Home's answer is from
            // before it, so the next read is the header's own (GET /api/your-groups lists what is still open).
            if (isOwnInviteChange(data, me)) forgetHomeForHeader();
            // A new listing by someone else changes none of what this row shows (core isOthersListingDoorbell): Home's own
            // read of it, a random 3 to 15 s on, is what the row draws from when it is fresh; the 120 s poll is the rest.
            if (isOthersListingDoorbell(data, me)) return;
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(poke, WS_SETTLE_MS);
        });
        return () => { stopPoll(); app.remove(); ws.remove(); if (settleTimer) clearTimeout(settleTimer); };
    }, [poke, me]);

    // 🛡️ is the Settings "Manage" press, landing at the item's /settings section; the rest are app routes.
    const open = (t: NeedsYouTarget) => {
        if (t.to === 'admin') { manage.start(node.current.communityName || 'this community', t.section); return; }
        goToNeedsTarget(t);
    };

    // A tap on a notice: off the bell at once (and on the node, which tells the member's other apps), then to its thing by
    // the push tap's own fixed routes (utils/push-notice-check.ts noticeRoute).
    const openNotice = (n: BellNotice) => {
        setSheet(false);
        setNotices(list => withoutBellNotices(list, [n.id]));
        const id = identityRef.current;
        (async () => {
            const url = await anchorUrl();
            if (!url || !id) return;
            const r = await signedPost(url, '/api/notices/push/seen', { ids: [n.id] }, id);
            if (!r.ok) refreshBell();
        })().catch(() => { refreshBell(); });
        router.push(noticeRoute(isPushNoticeKind(n.kind) ? n.kind : null, n.data) as never);
    };

    // A notice's ✕: the same mark as a tap, and it opens nothing and leaves the sheet up. A failed mark reads the list again,
    // so the row comes back.
    const clearNotice = (n: BellNotice) => {
        setNotices(list => withoutBellNotices(list, [n.id]));
        const id = identityRef.current;
        (async () => {
            const url = await anchorUrl();
            if (!url || !id) return;
            const r = await signedPost(url, '/api/notices/push/seen', { ids: [n.id] }, id);
            if (!r.ok) refreshBell();
        })().catch(() => { refreshBell(); });
    };

    // "Clear all": every notice, one request (the node marks only this member's). Never "Needs you": those are `entries`, the
    // open things, and they leave when they are done.
    const clearAll = () => {
        setNotices([]);
        const id = identityRef.current;
        (async () => {
            const url = await anchorUrl();
            if (!url || !id) return;
            const r = await signedPost(url, '/api/notices/push/seen', { all: true }, id);
            if (!r.ok) refreshBell();
        })().catch(() => { refreshBell(); });
    };

    const clearWords = bellClearWords();
    const unseen = notices.length;
    // The payee's line of a short standing deal is listed, not counted (core needsYouCounts).
    const counted = entries.filter(needsYouCounts).length;
    const label = bellLabel(unseen, counted);
    const small = width < NEEDS_YOU_SLOT;
    const now = Date.now();

    return (
        <View style={s.row} onLayout={e => setWidth(e.nativeEvent.layout.width)}>
            {width >= SMALL_BELL && (
                <Pressable onPress={() => setSheet(true)} style={({ pressed }) => [s.slot, small && s.slotSmall, pressed && s.pressed]}
                    accessibilityRole="button" accessibilityLabel={label}>
                    <MaterialCommunityIcons name="bell-outline" size={small ? 20 : 24} color={NEUTRAL} style={s.iconShadow} />
                    {unseen > 0 ? (
                        <View style={[s.countDot, small && s.countDotSmall, { backgroundColor: colors.feedback.danger.solid }]}>
                            <Text style={[s.countText, { color: colors.text.onDanger }]} allowFontScaling={false}>{bellBadge(unseen)}</Text>
                        </View>
                    ) : counted > 0 ? <View style={[s.needsDot, { backgroundColor: ACCENT }]} /> : null}
                </Pressable>
            )}

            <Modal visible={sheet} transparent animationType="fade" onRequestClose={() => setSheet(false)}>
                <Pressable style={s.sheetBg} onPress={() => setSheet(false)} accessibilityRole="button" accessibilityLabel={t('Close')}>
                    <View style={[s.sheet, { marginTop: sheetTop, backgroundColor: colors.surface.card }]}>
                        <Text style={[s.sheetTitle, { color: colors.text.secondary }]} accessibilityRole="header">{t('Notifications')}</Text>
                        <ScrollView style={s.sheetScroll}>
                            {entries.length > 0 && (
                                <Text style={[s.sectionTitle, { color: colors.text.muted }]} accessibilityRole="header">{t('Needs you')}</Text>
                            )}
                            {entries.map(e => (
                                <Pressable key={e.kind} style={({ pressed }) => [s.sheetRow, pressed && { backgroundColor: colors.surface.subtle }]}
                                    onPress={() => { setSheet(false); open(e.target); }} accessibilityRole="button" accessibilityLabel={e.label}>
                                    <MaterialCommunityIcons name={ICON[e.kind]} size={22}
                                        color={e.accent ? colors.feedback.warning.fg : colors.text.secondary} />
                                    <Text style={[s.sheetText, { color: colors.text.heading, fontWeight: e.accent ? '700' : '500' }]} numberOfLines={2}>
                                        {e.label}
                                    </Text>
                                    <MaterialCommunityIcons name="chevron-right" size={20} color={colors.text.muted} />
                                </Pressable>
                            ))}
                            {entries.length > 0 && notices.length > 0 && <View style={[s.divider, { backgroundColor: colors.border.default }]} />}
                            {entries.length === 0 && notices.length === 0 && (
                                <Text style={[s.empty, { color: colors.text.secondary }]}>{t('Nothing new.')}</Text>
                            )}
                            {notices.length > 0 && (
                                <View style={s.clearAllRow}>
                                    <Pressable style={({ pressed }) => [s.clearAll, pressed && { backgroundColor: colors.surface.subtle }]}
                                        onPress={clearAll} accessibilityRole="button" accessibilityLabel={clearWords.all}>
                                        <Text style={[s.clearAllText, { color: colors.text.link }]}>{clearWords.all}</Text>
                                    </Pressable>
                                </View>
                            )}
                            {notices.map(n => (
                                <View key={n.id} style={s.noticeLine}>
                                    <Pressable style={({ pressed }) => [s.sheetRow, s.noticeRow, s.noticeOpen, pressed && { backgroundColor: colors.surface.subtle }]}
                                        onPress={() => openNotice(n)} accessibilityRole="button" accessibilityLabel={[n.title, n.body].filter(Boolean).join('. ')}>
                                        <View style={[s.unseenDot, { backgroundColor: colors.feedback.danger.solid }]} />
                                        <View style={s.noticeWords}>
                                            <Text style={[s.noticeTitle, { color: colors.text.heading }]} numberOfLines={2}>{n.title || n.body}</Text>
                                            {!!n.title && !!n.body && (
                                                <Text style={[s.noticeBody, { color: colors.text.body }]} numberOfLines={3}>{n.body}</Text>
                                            )}
                                            <Text style={[s.noticeWhen, { color: colors.text.muted }]}>{timeAgo(Math.max(0, now - n.sentAt * 1000))}</Text>
                                        </View>
                                    </Pressable>
                                    <Pressable style={({ pressed }) => [s.clearOne, pressed && { backgroundColor: colors.surface.subtle }]}
                                        onPress={() => clearNotice(n)} accessibilityRole="button" accessibilityLabel={clearWords.one}>
                                        <MaterialCommunityIcons name="close" size={20} color={colors.text.muted} />
                                    </Pressable>
                                </View>
                            ))}
                            <Text style={[s.lifetime, { color: colors.text.muted }]}>{t('Older notices are gone after 7 days.')}</Text>
                        </ScrollView>
                    </View>
                </Pressable>
            </Modal>
            {manage.dialog}
        </View>
    );
}

const s = StyleSheet.create({
    // Right-aligned: the bell sits by the invite/Settings/avatar group, the gap by the bean.
    row: { flex: 1, minWidth: 0, height: NEEDS_YOU_SLOT, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
    slot: { width: NEEDS_YOU_SLOT, height: NEEDS_YOU_SLOT, alignItems: 'center', justifyContent: 'center', borderRadius: NEEDS_YOU_SLOT / 2 },
    slotSmall: { width: SMALL_BELL },
    pressed: { backgroundColor: 'rgba(255,255,255,0.15)' },
    iconShadow: { textShadowColor: 'rgba(0,0,0,0.75)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
    countDot: { position: 'absolute', top: 6, right: 4, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
    countDotSmall: { right: -2 },
    countText: { fontSize: 10, fontWeight: '900' },
    needsDot: { position: 'absolute', top: 12, right: 12, width: 9, height: 9, borderRadius: 5 },
    sheetBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center' },
    sheet: { width: '92%', maxHeight: '75%', borderRadius: 16, paddingVertical: 8, elevation: 6 },
    sheetScroll: { flexGrow: 0 },
    sheetTitle: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, paddingHorizontal: 16, paddingVertical: 8 },
    sectionTitle: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 2 },
    sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16, paddingVertical: 8 },
    sheetText: { flex: 1, fontSize: 15 },
    divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 16, marginVertical: 4 },
    empty: { fontSize: 15, textAlign: 'center', paddingHorizontal: 16, paddingVertical: 16 },
    noticeRow: { alignItems: 'flex-start' },
    // A notice and its ✕ side by side; the ✕ is 44 dp square (the touch floor) and "Clear all" 44 dp tall, at any font size.
    noticeLine: { flexDirection: 'row', alignItems: 'flex-start' },
    noticeOpen: { flex: 1, minWidth: 0, paddingRight: 4 },
    clearOne: { width: 44, height: 44, marginRight: 8, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    clearAllRow: { alignItems: 'flex-end', paddingHorizontal: 8 },
    clearAll: { minHeight: 44, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    clearAllText: { fontSize: 14, fontWeight: '700' },
    unseenDot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
    noticeWords: { flex: 1, minWidth: 0 },
    noticeTitle: { fontSize: 15, fontWeight: '700' },
    noticeBody: { fontSize: 15 },
    noticeWhen: { fontSize: 12, marginTop: 2 },
    lifetime: { fontSize: 12, textAlign: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
});
