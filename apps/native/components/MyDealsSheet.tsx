import React, { useState, useEffect, useMemo, useRef } from 'react';
import { View, Text, Pressable, Modal, FlatList, Image, StyleSheet, Dimensions, ScrollView } from 'react-native';
import { ListPhoto } from './ListPhoto';
import { router } from 'expo-router';
import { getMarketplaceTransactions, getPosts, getMyPosts, peerReadCursors } from '../utils/db';
import { ReviewModal } from './ReviewModal';
import { MemberAvatar } from './MemberAvatar';
import { palette } from '../constants/colors';
import { useTheme, useStyles } from '../app/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { listSheetLayout } from '../utils/bottom-sheet-layout';
import { billLines, dealsNeedingMe, openDeals, dealStep, dealStateWords, formatDate, formatHundredths, itemDealTitle, notSeenOfDeal, notSeenWords, standingHistoryLine, standingLines, standingLoweredHistoryLine, standingPanel, t, word, type WordKey } from '@beanpool/core';
import { Sentence } from './Sentence';
import { LISTING_MOMENT, takeNotifyMoment, useNotifyLine } from './NotifyLine';
import { ExampleHeader, LocalCommunityMark, LocalCommunitySheet } from './showcase/LocalCommunityMark';
import { SAMPLE_DEALS_ME, sampleDeals } from './showcase/sample-screens';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const NONE: any[] = [];
const NO_CURSORS: ReadonlyMap<string, string | null> = new Map();

/** A deal's status on its badge: word() keys, shown through t(); a status this build doesn't know, as the node wrote it. */
const DEAL_STATUS_WORDS: Readonly<Record<string, WordKey>> = {
    pending: word('PENDING', 'deal status'),
    requested: word('REQUESTED', 'deal status'),
    completed: word('COMPLETED', 'deal status'),
    cancelled: word('CANCELLED', 'deal status'),
    rejected: word('REJECTED', 'deal status'),
};
function dealStatusWords(status: string): string {
    return DEAL_STATUS_WORDS[status] ? t(DEAL_STATUS_WORDS[status]) : String(status ?? '').toUpperCase();
}

/** The day a deal began, as core writes dates ("3 Oct 2026"), in the member's language; nothing for a date it can't read. */
function dealDate(iso: string | null | undefined): string {
    const d = iso ? new Date(iso) : null;
    return d && Number.isFinite(d.getTime()) ? formatDate(d, 'day-month-year') : '';
}

interface MyDealsSheetProps {
    visible: boolean;
    identity: { publicKey: string } | null;
    onClose: () => void;
    /** Optional: which sub-tab to default open to */
    initialTab?: DealsTab;
    /**
     * Your deals → Bills (DESIGN-getting-paid-fable §4), drawn by the screen (components/Bills.tsx BillsTab) where the node's
     * `bills` switch is on or a door names a bill; handed the sheet's close, as every way forward closes it first. Absent: no tab.
     */
    bills?: ((leave: () => void) => React.ReactNode) | null;
    /** False on a community with Beans off (the Market's `showsBeans`): the cards draw no Beans amount. The sheet
     *  still opens there from a link (`dealsTab`), and My Posts lists the member's posts. */
    showsBeans?: boolean;
    /** Where the node previews deals (its `showcase` on, escrow off: scratch/global-node/DESIGN-global-showcase-fable.md
     *  §1 row 3, §4 "one component"): this same sheet fed Example Valley (sample-screens.ts sampleDeals), for "an
     *  example member". Nothing is asked of a node; Review, Edit and every deal open the 🏘️ Local community sheet. */
    preview?: boolean;
}

export type DealsTab = 'active' | 'pending' | 'history' | 'bills';

export function MyDealsSheet({ visible, identity: ownIdentity, onClose, preview = false, bills, initialTab = 'pending', showsBeans = true }: MyDealsSheetProps) {
    const identity = preview ? SAMPLE_DEALS_ME : ownIdentity;
    // Bills where the screen draws them (never in preview: a node with bills has Beans).
    const billsShown = !preview && !!bills;
    const [markOpen, setMarkOpen] = useState(false);
    const openMark = () => setMarkOpen(true);
    const { colors, theme } = useTheme();
    // The room the sheet is drawn in, measured: on Android the Modal covers the navigation bar, which the window's height leaves out.
    const [room, setRoom] = useState(SCREEN_HEIGHT);
    const sheetLayout = listSheetLayout(room, useSafeAreaInsets());
    // The held and pending cards' tones: light keeps its tints; dark takes the scheme's success and warning tones, with
    // each status line in its tone's ink, so every text on them reads at 4.5:1 or more (my-deals-dark-render.test.ts).
    const isDark = theme === 'dark';
    const heldTone = {
        backgroundColor: isDark ? colors.feedback.success.bg : palette.green50,
        borderColor: isDark ? colors.feedback.success.border : palette.green200,
    };
    const actionTone = {
        backgroundColor: isDark ? colors.feedback.warning.bg : palette.amber50,
        borderColor: isDark ? colors.feedback.warning.border : palette.yellow300,
    };
    const styles = useStyles(({ colors, theme }) => StyleSheet.create({
        overlay: {
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.4)',
            justifyContent: 'flex-end',
        },
        sheet: {
            backgroundColor: colors.surface.card,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            padding: 20,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: -4 },
            shadowOpacity: 0.1,
            shadowRadius: 12,
            elevation: 10,
        },
        handleBar: {
            width: 40,
            height: 4,
            borderRadius: 2,
            backgroundColor: colors.border.strong,
            alignSelf: 'center',
            marginBottom: 12,
        },
        sheetHeader: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
        },
        sheetTitle: {
            fontSize: 22,
            fontWeight: '900',
            color: colors.text.body,
        },
        sheetSubtitle: {
            fontSize: 12,
            fontWeight: '600',
            color: colors.text.muted,
            marginTop: 2,
        },
        dealStateText: {
            fontSize: 12,
            fontWeight: '600',
            color: theme === 'dark' ? colors.text.secondary : colors.text.muted,
            marginTop: 2,
        },
        closeBtn: {
            fontSize: 20,
            color: colors.text.muted,
            fontWeight: '700',
            padding: 4,
        },

        // Tab bar
        // Each tab is as wide as its words, and the tabs fill the bar; where they don't fit one line (320 dp at 1.3x, a longer
        // language) they take a second, so a tab's name is never broken inside a word (walk 148: "In Pro / gress").
        tabBar: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            backgroundColor: colors.surface.subtle,
            borderRadius: 12,
            padding: 4,
            marginBottom: 16,
        },
        tab: {
            flexGrow: 1,
            maxWidth: '100%',
            paddingVertical: 10,
            paddingHorizontal: 4,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 8,
            flexDirection: 'row',
            gap: 4,
        },
        tabActive: {
            backgroundColor: colors.surface.card,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.05,
            shadowRadius: 2,
            elevation: 1,
        },
        // A name longer than the whole bar wraps inside it, never past it.
        tabText: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.text.secondary,
            flexShrink: 1,
            textAlign: 'center',
        },
        tabTextActive: {
            color: colors.text.body,
            fontWeight: '800',
        },
        badgeCount: {
            backgroundColor: colors.feedback.danger.solid,
            paddingHorizontal: 5,
            paddingVertical: 1,
            borderRadius: 8,
        },
        badgeCountText: {
            color: colors.text.inverse,
            fontSize: 9,
            fontWeight: '900',
        },

        // History sub-filter
        historyFilterRow: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: 8,
            marginBottom: 16,
        },
        historyChip: {
            paddingHorizontal: 14,
            paddingVertical: 6,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: colors.border.strong,
            backgroundColor: colors.surface.card,
        },
        historyChipActive: {
            backgroundColor: colors.text.body,
            borderColor: colors.text.body,
        },
        historyChipText: {
            fontSize: 12,
            fontWeight: '700',
            color: theme === 'dark' ? colors.text.secondary : palette.gray600,
        },
        historyChipTextActive: {
            color: theme === 'dark' ? colors.surface.app : colors.text.inverse, // white on the dark scheme's pale chip was 1.1:1
        },

        // Deal cards
        dealCard: {
            backgroundColor: colors.surface.card,
            borderRadius: 16,
            padding: 0,
            marginBottom: 12,
            borderWidth: 1,
            borderColor: colors.border.default,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.04,
            shadowRadius: 4,
            elevation: 1,
            flexDirection: 'row',
            overflow: 'hidden',
        },
        dealThumb: {
            width: 96,
            height: '100%',
            backgroundColor: colors.border.default,
        },
        dealThumbFallback: {
            backgroundColor: colors.surface.subtle,
            alignItems: 'center',
            justifyContent: 'center',
        },
        dealTitle: {
            fontSize: 15,
            fontWeight: '800',
            color: colors.text.body,
            marginBottom: 2,
        },
        dateText: {
            fontSize: 12,
            fontWeight: '600',
            color: theme === 'dark' ? colors.text.secondary : colors.text.muted, // dark muted is 3.60:1 on the card
        },
        creditAmount: {
            fontWeight: '900',
            fontSize: 15,
            color: colors.accent.primary,
        },
        beanIcon: {
            width: 14,
            height: 14,
            marginLeft: 2,
            resizeMode: 'contain',
        },
        statusBadge: {
            backgroundColor: colors.border.default,
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 8,
        },
        statusCompleted: {
            backgroundColor: theme === 'dark' ? colors.feedback.success.bg : palette.emerald100,
        },
        statusText: {
            fontSize: 10,
            fontWeight: '800',
            color: theme === 'dark' ? colors.text.secondary : palette.gray600,
            textTransform: 'uppercase',
        },
        statusTextCompleted: {
            color: theme === 'dark' ? colors.feedback.success.fg : palette.emerald800,
        },
        typeBadge: {
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 8,
        },
        badgeOffer: {
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            borderWidth: 1,
            borderColor: 'rgba(16, 185, 129, 0.2)',
        },
        badgeNeed: {
            backgroundColor: 'rgba(245, 158, 11, 0.1)',
            borderWidth: 1,
            borderColor: 'rgba(245, 158, 11, 0.2)',
        },
        dealCardPaused: { opacity: 0.6 },
        pausedBadge: {
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 8,
            backgroundColor: 'rgba(245, 158, 11, 0.15)',
            borderWidth: 1,
            borderColor: 'rgba(245, 158, 11, 0.35)',
        },
        pausedBadgeText: {
            fontSize: 10,
            fontWeight: '800',
            color: colors.feedback.warning.fg, // ink.warning (amber-700 was 3.47:1 on the dark card)
            letterSpacing: 0.3,
        },
        typeBadgeText: {
            fontSize: 10,
            fontWeight: '800',
            color: colors.text.body,
            letterSpacing: 0.5,
        },
        partnerText: {
            fontSize: 12,
            fontWeight: '600',
            color: colors.text.secondary,
        },
        partnerName: {
            color: colors.text.body,
            fontWeight: '800',
        },
        reviewBtn: {
            backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : palette.amber100,
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme === 'dark' ? colors.feedback.warning.border : palette.yellow300,
        },
        reviewBtnText: {
            color: theme === 'dark' ? colors.feedback.warning.fg : palette.amber700,
            fontSize: 12,
            fontWeight: '800',
        },

        // Empty state
        emptyState: {
            padding: 32,
            alignItems: 'center',
        },
        emptyEmoji: {
            fontSize: 48,
            opacity: 0.3,
            marginBottom: 12,
        },
        emptyTitle: {
            fontSize: 18,
            fontWeight: '800',
            color: colors.text.body,
            marginBottom: 8,
        },
        emptySubtext: {
            fontSize: 14,
            color: colors.text.secondary,
            textAlign: 'center',
            marginBottom: 20,
        },
        ctaBtn: {
            backgroundColor: colors.accent.fill,
            paddingHorizontal: 24,
            paddingVertical: 12,
            borderRadius: 12,
        },
        ctaBtnText: {
            color: colors.text.onAccent,
            fontWeight: '800',
            fontSize: 14,
        },
    }));

    const [dealsTab, setDealsTab] = useState<DealsTab>(initialTab);
    const [historyFilter, setHistoryFilter] = useState<'all' | 'buying' | 'selling'>('all');
    const [heldPosts, setPosts] = useState<any[]>(NONE);
    const [heldTransactions, setTransactions] = useState<any[]>(NONE);
    const [readCursors, setReadCursors] = useState<ReadonlyMap<string, string | null>>(NO_CURSORS);
    // Whether what is held is Example Valley's. It is drawn only in preview: a preview that turns live while the sheet is
    // open never shows the sample's deals as the member's own, nor lets a live press (a card, Review) reach a sample id
    // (review of #1852, finding 2). Nor, the other way, are the member's own drawn in preview.
    const [heldSample, setHeldSample] = useState(false);
    const posts = heldSample === preview ? heldPosts : NONE;
    const transactions = heldSample === preview ? heldTransactions : NONE;
    const [promptReview, setPromptReview] = useState<{ txId: string; targetPubkey: string; targetCallsign: string } | null>(null);

    useEffect(() => {
        if (visible && identity) {
            loadData();
        }
    }, [visible, identity, preview]);

    useEffect(() => {
        if (initialTab) setDealsTab(initialTab);
    }, [initialTab]);

    // Just posted (app/new-listing.tsx lands here on My Posts): the named line "Hear when someone answers." over the list
    // (slice N2a; core's rule says whether). Never in the preview. Market keeps this sheet mounted and only flips `visible`,
    // so the line belongs to one visit of My Posts: the sheet closed, or another tab of it, and the line is gone for good.
    const notify = useNotifyLine(ownIdentity?.publicKey, visible && !preview && dealsTab === 'active');
    useEffect(() => {
        if (!visible || preview || dealsTab !== 'active') return;
        const moment = takeNotifyMoment(LISTING_MOMENT);
        if (moment) void notify.offer(moment);
    }, [visible, preview, dealsTab]);

    // Each load's answers land only while it is the latest: a load begun before a switch to preview never draws the
    // member's own deals over Example Valley's.
    const loadGen = useRef(0);
    const loadData = async () => {
        const gen = ++loadGen.current;
        if (preview) {
            const sample = sampleDeals();
            setPosts(sample.posts);
            setTransactions(sample.transactions);
            setHeldSample(true);
            return;
        }
        if (heldSample) { setPosts(NONE); setTransactions(NONE); setHeldSample(false); }
        if (!identity) return;
        try {
            // Every audience: a deal on a group listing is still my deal.
            const allPosts = await getPosts({ allScopes: true });
            // Merge in the member's own posts (incl. paused, which getPosts hides from the feed) so
            // "My Posts" can show + re-activate them. Dedupe by id — getMyPosts wins (fresher status).
            const mine = identity ? await getMyPosts(identity.publicKey) : [];
            const byId = new Map<string, any>();
            for (const p of allPosts) byId.set(p.id, p);
            for (const p of mine) byId.set(p.id, p);
            if (gen !== loadGen.current) return;
            setPosts(Array.from(byId.values()));
            const txs = await getMarketplaceTransactions(identity.publicKey);
            if (gen !== loadGen.current) return;
            setTransactions(txs);
        } catch (e) {
            console.error('MyDealsSheet: failed to load data', e);
        }
    };

    // For each request of mine still waiting, the other person's read cursor in our one chat (core notSeenOfDeal, slice N4),
    // read once the deals are in. Never in preview; none read, nothing said.
    const myKey = preview ? '' : identity?.publicKey ?? '';
    const askedPeers = useMemo(() => (!myKey ? '' : transactions
        .filter((tx: any) => dealStep(tx, myKey).state === 'asked')
        .map((tx: any) => (tx.buyerPublicKey === myKey ? tx.sellerPublicKey : tx.buyerPublicKey))
        .sort().join('\n')), [transactions, myKey]);
    useEffect(() => {
        setReadCursors(NO_CURSORS);
        if (!visible || !myKey || !askedPeers) return;
        let live = true;
        Promise.resolve()
            .then(() => peerReadCursors(myKey, askedPeers.split('\n')))
            .then((cursors) => { if (live) setReadCursors(cursors); })
            .catch(() => { /* no cursor: no line */ });
        return () => { live = false; };
    }, [visible, myKey, askedPeers]);

    // ⚡ Bolt: Group active/requested transactions by postId into a 1:N Map for O(1) lookups without array scans
    const activeTxsByPostId = useMemo(() => {
        const map = new Map<string, any[]>();
        for (const t of transactions) {
            if (t.status === 'pending' || t.status === 'requested') {
                const list = map.get(t.postId);
                if (list) {
                    list.push(t);
                } else {
                    map.set(t.postId, [t]);
                }
            }
        }
        return map;
    }, [transactions]);
    // A one-off listing a standing deal took stays off the board ('pending') while the deal runs, yet nothing is held in
    // trust: each period is paid at its start (DESIGN-standing-deals-upfront-fable §1, §3). Its card says 🔁 STANDING.
    const standingPostIds = useMemo(() => new Set(transactions
        .filter(t => !!t.standingId && (t.standingPhase === 'paid' || t.standingPhase === 'short'))
        .map(t => t.postId)), [transactions]);

    // ── Data derivation ──
    const myPosts = posts.filter(p => {
        if (!identity) return false;
        if (p.author_pubkey === identity.publicKey || p.accepted_by === identity.publicKey) return true;
        const txs = activeTxsByPostId.get(p.id);
        return txs?.some(t => t.buyerPublicKey === identity.publicKey || t.sellerPublicKey === identity.publicKey);
    }).sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1;
        if (b.status === 'pending' && a.status !== 'pending') return 1;
        if (a.status === 'active' && b.status !== 'active') return -1;
        if (b.status === 'active' && a.status !== 'active') return 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    const effectiveTxs = useMemo(() => {
        if (!transactions.length || !posts.length) return transactions;
        const postMap = new Map(posts.map(p => [p.id, p]));
        return transactions.map(t => {
            if (t.postAuthorPublicKey && t.postType) return t;
            const p = postMap.get(t.postId);
            if (!p) return t;
            return {
                ...t,
                postAuthorPublicKey: t.postAuthorPublicKey ?? p.author_pubkey ?? p.authorPublicKey,
                postType: t.postType ?? p.type,
                postRepeatable: t.postRepeatable ?? p.repeatable,
                postLendable: t.postLendable ?? p.lendable,
            };
        });
    }, [transactions, posts]);

    const underWayCount = openDeals(effectiveTxs, identity?.publicKey).length;
    const needingMeCount = dealsNeedingMe(effectiveTxs, identity?.publicKey || '').length;
    const titleRowText = needingMeCount === 1
        ? t('{n} under way · 1 needs you', { n: underWayCount })
        : t('{n} under way · {m} need you', { n: underWayCount, m: needingMeCount });

    const pendingDeals = useMemo(() => {
        const list = openDeals(effectiveTxs, identity?.publicKey);
        return list.slice().sort((a, b) => {
            const aMe = dealStep(a, identity?.publicKey || '').needsMe;
            const bMe = dealStep(b, identity?.publicKey || '').needsMe;
            if (aMe && !bMe) return -1;
            if (!aMe && bMe) return 1;
            return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
        });
    }, [effectiveTxs, identity?.publicKey]);

    const pendingCount = pendingDeals.length;

    const getData = () => {
        if (dealsTab === 'active') return myPosts.filter(p => (p.status === 'active' || p.status === 'paused' || p.status === 'pending') && p.author_pubkey === identity?.publicKey);
        if (dealsTab === 'pending') return pendingDeals;
        // History
        let txs = transactions.filter(t => t.status === 'completed' || t.status === 'cancelled' || t.status === 'rejected');
        if (historyFilter === 'buying') txs = txs.filter(t => t.buyerPublicKey === identity?.publicKey);
        if (historyFilter === 'selling') txs = txs.filter(t => t.sellerPublicKey === identity?.publicKey);
        return txs;
    };

    const listData = getData();

    const renderDealItem = ({ item }: { item: any }) => {
        // Transaction items (history + pending tx view)
        if (dealsTab === 'history' || (dealsTab === 'pending' && item.buyerPublicKey)) {
            const isBuyer = item.buyerPublicKey === identity?.publicKey;
            const isCompleted = item.status === 'completed';
            const isPending = item.status === 'pending';
            const isRequested = item.status === 'requested';
            const step = dealStep(item, identity?.publicKey || '');
            // A standing deal still running, on its current period's row (DESIGN-standing-deals-fable §2.2): one card with
            // 🔁 STANDING and its panel's line (the payer's short-funds warning, with the end of its week), as on the web.
            const standing = dealsTab === 'pending' ? standingPanel(item, identity?.publicKey || '', (iso) => formatDate(new Date(iso), 'day-month')) : null;
            // Core's rule: a standing deal asks for one review, on its first period (design §3).
            const needsReview = !standing && isCompleted && step.state === 'done-to-review';
            // An ended standing deal's History line: stopped in the grace, or its grace run out (amendment §1, §2); else a period
            // paid at less than the price by agreement, in the Ledger memo's words (DESIGN-getting-paid-fable §3.2), as on the web.
            const historyLine = dealsTab === 'history'
                ? (standingHistoryLine(item, identity?.publicKey || '', (iso) => formatDate(new Date(iso), 'day-month'))
                    ?? standingLoweredHistoryLine(item, transactions, identity?.publicKey || ''))
                : null;
            const partnerPubkey = isBuyer ? item.sellerPublicKey : item.buyerPublicKey;
            // No card held for the partner yet (a community that says `membersOnDemand`): the key's first 8 characters,
            // never a blank after "From " (DESIGN-global-members-by-area §2.4).
            const partnerCallsign = (isBuyer ? item.sellerCallsign : item.buyerCallsign) || (partnerPubkey || '').slice(0, 8);
            const partnerAvatar = isBuyer ? item.sellerAvatar : item.buyerAvatar;
            const notSeenText = !preview && dealsTab === 'pending' && !standing ? notSeenWords(notSeenOfDeal({
                asked: step.state === 'asked',
                chat: !!partnerPubkey && readCursors.has(partnerPubkey),
                createdAt: item.createdAt,
                peerReadAt: partnerPubkey ? readCursors.get(partnerPubkey) : null,
            }, Date.now()), (isBuyer ? item.sellerCallsign : item.buyerCallsign) || null) : null;

            const card = (
                <View testID={`deal-card-${item.id}`} style={[
                    styles.dealCard,
                    !isCompleted && !isPending && !isRequested && { opacity: 0.5 },
                    isPending && heldTone,
                ]}>
                    <ListPhoto
                        photo={item.coverImage && typeof item.coverImage === 'string' && item.coverImage.trim() !== '' && item.coverImage !== 'null' && item.coverImage !== 'undefined' ? item.coverImage : null}
                        style={styles.dealThumb}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        fallback={(
                            <View style={[styles.dealThumb, styles.dealThumbFallback]}>
                                <Text style={{ fontSize: 24, opacity: 0.5 }}>{isBuyer ? '🛒' : '🏷️'}</Text>
                            </View>
                        )}
                    />
                    <View style={{ flex: 1, padding: 12, justifyContent: 'space-between', minHeight: 96 }}>
                        {/* Badge, date and Beans side by side, wrapping where they don't fit (320 dp at 1.3x text): the amount
                            keeps the right edge and never shrinks, so it drops to its own line whole instead of being pushed
                            off the card by the date. */}
                        <View testID={`deal-top-${item.id}`} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 2 }}>
                            {/* A standing deal's row out of trust (short: the period last settled) is no finished deal: its card
                                says 🔁 STANDING only, never COMPLETED (round 2 of #3000), as on the web. */}
                            {!(standing && !isPending) && (
                            <View style={[styles.statusBadge, isCompleted && styles.statusCompleted]}>
                                <Text style={[styles.statusText, isCompleted && styles.statusTextCompleted]}>
                                    {dealStatusWords(item.status)}
                                </Text>
                            </View>
                            )}
                            {!!standing && (
                                <View testID={`standing-chip-${item.id}`} style={[styles.statusBadge, styles.statusCompleted]}>
                                    <Text style={[styles.statusText, styles.statusTextCompleted]}>{standingLines.chip()}</Text>
                                </View>
                            )}
                            <Text style={styles.dateText}>
                                {dealDate(item.createdAt)}
                            </Text>
                            {/* What the deal holds, whole hundredths, as formatHundredths writes it ("—" for no figure). */}
                            {showsBeans && (
                            <View testID={`deal-amount-${item.id}`} style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 'auto', flexShrink: 0 }}>
                                <Text style={[styles.creditAmount, { color: isBuyer ? colors.feedback.danger.fg : colors.brand.primary }]} numberOfLines={1}>
                                    {isBuyer ? '- ' : '+ '}{formatHundredths(item.amount_c)}
                                </Text>
                                <Image source={require('../assets/images/bean.png')} style={styles.beanIcon} />
                            </View>
                            )}
                        </View>
                        {/* A per-item deal says how many (DESIGN-per-item-price-fable.md §2.3): "3 × Solar Panels". */}
                        <Text style={styles.dealTitle} numberOfLines={1}>{item.postTitle ? itemDealTitle(item, item.postTitle) : item.postTitle}</Text>
                        {dealsTab === 'pending' && (
                            <Text testID={`deal-state-${item.id}`} accessibilityRole={standing?.warning ? 'alert' : undefined}
                                style={[styles.dealStateText, standing?.warning && { color: colors.feedback.warning.fg, fontWeight: '800' }]}
                                numberOfLines={3}>
                                {standing ? standing.status : dealStateWords(step, partnerCallsign)}
                            </Text>
                        )}
                        {/* My request still waiting, and the other person not in our chat since I made it (core notSeenOfDeal,
                            slice N4): "Not seen yet." after a day, the other way after 3. The same for everyone: only the tick's cursor. */}
                        {notSeenText && (
                            <Text testID={`deal-not-seen-${item.id}`} style={[styles.dealStateText, { color: colors.text.secondary }]}>{notSeenText}</Text>
                        )}
                        {/* The payer's open ask to pay less, for either side (DESIGN-getting-paid-fable §3.2): its line only; the card
                            opens the listing, where Answer and Take it back are (small cards open the item), as on the web. */}
                        {!!standing?.askLine && (
                            <Text testID={`deal-ask-${item.id}`} style={[styles.dealStateText, { color: colors.text.body, fontWeight: '700' }]} numberOfLines={3}>
                                {standing.askLine}
                            </Text>
                        )}
                        {historyLine && (
                            <Text testID={`deal-history-${item.id}`} style={styles.dealStateText}>{historyLine}</Text>
                        )}
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                                <MemberAvatar avatarUrl={partnerAvatar} pubkey={partnerPubkey || ''} callsign={partnerCallsign || '?'} size={20} />
                                <Text style={[styles.partnerText, { fontSize: 11 }]} numberOfLines={1}>
                                    <Sentence text={isBuyer ? t('From {name}') : t('To {name}')} parts={{ name: <Text style={styles.partnerName}>{partnerCallsign}</Text> }} />
                                </Text>
                            </View>
                            {/* Review (or Edit a review) is for a finished deal; a standing one still running has neither, as on the web. */}
                            {isCompleted && !standing && (
                                needsReview ? (
                                    <Pressable
                                        accessibilityRole="button"
                                        style={[styles.reviewBtn, { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }]}
                                        onPress={preview ? openMark : () => setPromptReview({ txId: item.id, targetPubkey: partnerPubkey, targetCallsign: partnerCallsign })}
                                    >
                                        <Text style={[styles.reviewBtnText, { fontSize: 11 }]}>{t('Review', undefined, 'button: review a finished deal')}</Text>
                                    </Pressable>
                                ) : (
                                    <Pressable
                                        accessibilityRole="button"
                                        style={[styles.reviewBtn, { backgroundColor: colors.surface.subtle, borderColor: colors.border.strong, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 }]}
                                        onPress={preview ? openMark : () => setPromptReview({ txId: item.id, targetPubkey: partnerPubkey, targetCallsign: partnerCallsign })}
                                    >
                                        <Text style={[styles.reviewBtnText, { color: theme === 'dark' ? colors.text.secondary : palette.gray600, fontSize: 11 }]}>{t('Edit', undefined, 'button: change your review')}</Text>
                                    </Pressable>
                                )
                            )}
                        </View>
                    </View>
                </View>
            );

            if (isPending || dealsTab === 'pending') {
                return (
                    <Pressable accessibilityRole="button" onPress={preview ? openMark : () => { onClose(); router.push({ pathname: '/post/[id]', params: { id: item.postId, txId: item.id } }); }}>
                        {card}
                    </Pressable>
                );
            }
            return card;
        }

        // Active post items
        let coverImage: string | null = null;
        if (item.photos) {
            try { 
                const arr = Array.isArray(item.photos) ? item.photos : JSON.parse(item.photos); 
                if (arr.length > 0) coverImage = arr[0]; 
            } catch {}
        }

        const relatedTx = activeTxsByPostId.get(item.id)?.[0];
        let displayStatusText = t('Active', undefined, 'listing status');
        let highlightStyle = {};
        // The status line's ink: light as it was (muted, amber for Action Required); dark, its card's tone.
        let statusInk: string | undefined;
        // Action Required is drawn bold.
        let actionRequired = false;

        if (item.status === 'pending' && relatedTx?.status !== 'pending' && standingPostIds.has(item.id)) {
            displayStatusText = standingLines.chip();
        } else if (item.status === 'pending' || relatedTx?.status === 'pending') {
            displayStatusText = t('🤝 Held in Trust');
            highlightStyle = heldTone;
            if (isDark) statusInk = colors.feedback.success.fg;
        } else if (relatedTx?.status === 'requested') {
            if (item.author_pubkey === identity?.publicKey) {
                displayStatusText = t('⚠️ Action Required');
                actionRequired = true;
                highlightStyle = actionTone;
                statusInk = colors.feedback.warning.fg;
            } else {
                displayStatusText = t('⏳ Awaiting Approval');
                highlightStyle = { backgroundColor: colors.surface.subtle, borderColor: colors.border.default };
                if (isDark) statusInk = colors.text.secondary;
            }
        }

        return (
            <Pressable accessibilityRole="button" onPress={preview ? openMark : () => { onClose(); router.push(`/post/${item.id}`); }}>
                <View testID={`deal-card-${item.id}`} style={[styles.dealCard, highlightStyle, item.status === 'paused' && styles.dealCardPaused]}>
                    <ListPhoto
                        photo={coverImage && typeof coverImage === 'string' && coverImage.trim() !== '' && coverImage !== 'null' && coverImage !== 'undefined' ? coverImage : null}
                        style={styles.dealThumb}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        fallback={(
                            <View style={[styles.dealThumb, styles.dealThumbFallback]}>
                                <Text style={{ fontSize: 24, opacity: 0.5 }}>📦</Text>
                            </View>
                        )}
                    />
                    <View style={{ flex: 1, padding: 12, justifyContent: 'center', minHeight: 96 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <View style={[styles.typeBadge, item.type === 'offer' ? styles.badgeOffer : styles.badgeNeed]}>
                                    <Text style={styles.typeBadgeText}>{item.type === 'offer' ? t('OFFER') : item.type === 'need' ? t('NEED') : item.type?.toUpperCase()}</Text>
                                </View>
                                {item.status === 'paused' && (
                                    <View style={styles.pausedBadge}><Text style={styles.pausedBadgeText}>{t('⏸ PAUSED')}</Text></View>
                                )}
                            </View>
                            {/* The listing's price, whole hundredths: none sent reads "?", as it always did; one that isn't whole hundredths "—". */}
                            {showsBeans && (
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <Text style={styles.creditAmount} numberOfLines={1}>
                                    {item.price_c === undefined ? '?' : formatHundredths(item.price_c)}
                                </Text>
                                <Image source={require('../assets/images/bean.png')} style={styles.beanIcon} />
                            </View>
                            )}
                        </View>
                        <Text style={styles.dealTitle} numberOfLines={1}>{item.title}</Text>
                        <Text style={[styles.dateText, statusInk !== undefined && { color: statusInk }, actionRequired && { fontWeight: '800' }, { marginTop: 2 }]}>{displayStatusText}</Text>
                    </View>
                </View>
            </Pressable>
        );
    };

    return (
        <Modal visible={visible} transparent animationType="slide">
            <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} style={styles.overlay} onPress={onClose} onLayout={e => setRoom(e.nativeEvent.layout.height)}>
                <Pressable accessibilityRole="button" style={[styles.sheet, sheetLayout]} onPress={e => e.stopPropagation()} testID="deals-sheet">
                    {/* Handle bar */}
                    <View style={styles.handleBar} />

                    {/* Header */}
                    <View style={styles.sheetHeader}>
                        <View>
                            <Text style={styles.sheetTitle}>{t('Your deals')}</Text>
                            <Text style={styles.sheetSubtitle}>{titleRowText}</Text>
                        </View>
                        <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} onPress={onClose}>
                            <Text style={styles.closeBtn}>✕</Text>
                        </Pressable>
                    </View>

                    {/* Tab bar */}
                    <View style={styles.tabBar} testID="deals-tabs">
                        {[
                            { id: 'pending' as const, label: t('In Progress'), badge: pendingCount },
                            { id: 'active' as const, label: t('My Posts') },
                            { id: 'history' as const, label: t('History') },
                            ...(billsShown ? [{ id: 'bills' as const, label: billLines.tab() }] : []),
                        ].map((tab: { id: DealsTab; label: string; badge?: number }) => (
                            <Pressable
                                accessibilityRole="button"
                                accessibilityState={{ selected: dealsTab === tab.id }}
                                key={tab.id}
                                style={[styles.tab, dealsTab === tab.id && styles.tabActive]}
                                onPress={() => setDealsTab(tab.id)}
                            >
                                <Text style={[styles.tabText, dealsTab === tab.id && styles.tabTextActive]}>
                                    {tab.label}
                                </Text>
                                {tab.badge && tab.badge > 0 ? (
                                    <View style={styles.badgeCount}>
                                        <Text style={styles.badgeCountText}>{tab.badge}</Text>
                                    </View>
                                ) : null}
                            </Pressable>
                        ))}
                    </View>

                    {/* History sub-filter */}
                    {dealsTab === 'history' && (
                        <View style={styles.historyFilterRow}>
                            {[{ id: 'all' as const, label: t('All') }, { id: 'buying' as const, label: t('Received') }, { id: 'selling' as const, label: t('Given') }].map(f => (
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: historyFilter === f.id }}
                                    key={f.id}
                                    style={[styles.historyChip, historyFilter === f.id && styles.historyChipActive]}
                                    onPress={() => setHistoryFilter(f.id)}
                                >
                                    <Text style={[styles.historyChipText, historyFilter === f.id && styles.historyChipTextActive]}>
                                        {f.label}
                                    </Text>
                                </Pressable>
                            ))}
                        </View>
                    )}

                    {/* List; Bills is the screen's (components/Bills.tsx BillsTab), read from the node as it opens. */}
                    {dealsTab === 'bills' && bills && !preview ? (
                        <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled" testID="deals-bills">
                            {bills(onClose)}
                        </ScrollView>
                    ) : (
                    <FlatList
                        data={listData}
                        keyExtractor={item => item.id}
                        renderItem={renderDealItem}
                        contentContainerStyle={{ paddingBottom: 24 }}
                        showsVerticalScrollIndicator={false}
                        // In preview the strip and "Example" head the list and scroll away with it, as on the Ledger: in the
                        // fixed head they filled a 320 dp sheet, and no deal showed until the strip was closed.
                        ListHeaderComponent={preview ? (
                            <View testID="deals-preview-head">
                                {/* Your deals is a Modal: every way forward closes it first, so the next screen opens on top. */}
                                <LocalCommunityMark variant="strip" feature="escrow" onLeave={onClose} />
                                <ExampleHeader />
                            </View>
                        ) : dealsTab === 'active' && notify.view ? <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>{notify.view}</View> : null}
                        ListEmptyComponent={
                            <View style={styles.emptyState}>
                                <Text style={styles.emptyEmoji}>
                                    {dealsTab === 'history' ? '📜' : dealsTab === 'pending' ? '🤝' : '📋'}
                                </Text>
                                <Text style={styles.emptyTitle}>
                                    {dealsTab === 'history' ? t('No history yet') : dealsTab === 'pending' ? t('No deals in progress') : t('No active posts')}
                                </Text>
                                <Text style={styles.emptySubtext}>
                                    {dealsTab === 'active'
                                        ? t('Post an offer or need to get started!')
                                        : dealsTab === 'pending'
                                        ? t('Accepted deals will appear here while they are held in trust.')
                                        : t('Completed deals will show up here.')}
                                </Text>
                                {dealsTab === 'active' && (
                                    <Pressable
                                        accessibilityRole="button"
                                        style={styles.ctaBtn}
                                        onPress={() => { onClose(); router.push('/(tabs)/market'); }}
                                    >
                                        <Text style={styles.ctaBtnText}>{t('+ Create a Post')}</Text>
                                    </Pressable>
                                )}
                            </View>
                        }
                    />
                    )}
                </Pressable>
            </Pressable>

            <LocalCommunitySheet feature="escrow" visible={markOpen} onClose={() => setMarkOpen(false)} onLeave={onClose} />

            {/* Review Modal */}
            {promptReview && !preview && (
                <ReviewModal
                    visible={!!promptReview}
                    txId={promptReview.txId}
                    targetPubkey={promptReview.targetPubkey}
                    targetCallsign={promptReview.targetCallsign}
                    onClose={() => setPromptReview(null)}
                    onSuccess={() => {
                        setPromptReview(null);
                        loadData();
                    }}
                />
            )}
        </Modal>
    );
}

/** Export pending count helper for header badge */
export function usePendingDealsCount(identity: { publicKey: string } | null, postsOrTxs: any[], maybeTransactions?: any[]): number {
    if (!identity) return 0;
    const txs = Array.isArray(maybeTransactions) ? maybeTransactions : (Array.isArray(postsOrTxs) ? postsOrTxs : []);
    return dealsNeedingMe(txs, identity.publicKey).length;
}

// Empty since stylesheet has been refactored inside the component body
