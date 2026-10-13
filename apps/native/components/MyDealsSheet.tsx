import React, { useState, useEffect, useMemo, useRef } from 'react';
import { View, Text, Pressable, Modal, FlatList, Image, StyleSheet, Dimensions } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { router } from 'expo-router';
import { getMarketplaceTransactions, getPosts, getMyPosts } from '../utils/db';
import { ReviewModal } from './ReviewModal';
import { MemberAvatar } from './MemberAvatar';
import { palette } from '../constants/colors';
import { useTheme, useStyles } from '../app/ThemeContext';
import { listPhotoUrl } from '@beanpool/core';
import { ExampleHeader, LocalCommunityMark, LocalCommunitySheet } from './showcase/LocalCommunityMark';
import { SAMPLE_DEALS_ME, sampleDeals } from './showcase/sample-screens';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const NONE: any[] = [];

interface MyDealsSheetProps {
    visible: boolean;
    identity: { publicKey: string } | null;
    onClose: () => void;
    /** Optional: which sub-tab to default open to */
    initialTab?: 'active' | 'pending' | 'history';
    /** False on a community with Beans off (the Market's `showsBeans`): the cards draw no Beans amount. The sheet
     *  still opens there from a link (`dealsTab`), and My Posts lists the member's posts. */
    showsBeans?: boolean;
    /** Where the node previews deals (its `showcase` on, escrow off: scratch/global-node/DESIGN-global-showcase-fable.md
     *  §1 row 3, §4 "one component"): this same sheet fed Example Valley (sample-screens.ts sampleDeals), for "an
     *  example member". Nothing is asked of a node; Review, Edit and every deal open the 🏘️ Local community sheet. */
    preview?: boolean;
}

export function MyDealsSheet({ visible, identity: ownIdentity, onClose, preview = false, initialTab = 'pending', showsBeans = true }: MyDealsSheetProps) {
    const identity = preview ? SAMPLE_DEALS_ME : ownIdentity;
    const [markOpen, setMarkOpen] = useState(false);
    const openMark = () => setMarkOpen(true);
    const { colors, theme } = useTheme();
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
            paddingBottom: 40,
            maxHeight: SCREEN_HEIGHT * 0.75,
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
        closeBtn: {
            fontSize: 20,
            color: colors.text.muted,
            fontWeight: '700',
            padding: 4,
        },

        // Tab bar
        tabBar: {
            flexDirection: 'row',
            backgroundColor: colors.surface.subtle,
            borderRadius: 12,
            padding: 4,
            marginBottom: 16,
        },
        tab: {
            flex: 1,
            paddingVertical: 10,
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
        tabText: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.text.secondary,
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
            color: theme === 'dark' ? colors.feedback.warning.fg : '#b45309', // amber700 is 3.47:1 on the dark card
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
            backgroundColor: colors.accent.primary,
            paddingHorizontal: 24,
            paddingVertical: 12,
            borderRadius: 12,
        },
        ctaBtnText: {
            color: colors.text.inverse,
            fontWeight: '800',
            fontSize: 14,
        },
    }));

    const [dealsTab, setDealsTab] = useState<'active' | 'pending' | 'history'>(initialTab);
    const [historyFilter, setHistoryFilter] = useState<'all' | 'buying' | 'selling'>('all');
    const [heldPosts, setPosts] = useState<any[]>(NONE);
    const [heldTransactions, setTransactions] = useState<any[]>(NONE);
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

    const pendingDeals = posts.filter(p => {
        if (!identity) return false;
        if (p.status === 'pending' && (p.author_pubkey === identity.publicKey || p.accepted_by === identity.publicKey)) return true;
        return activeTxsByPostId.has(p.id);
    });

    const pendingCount = pendingDeals.length;

    const getData = () => {
        if (dealsTab === 'active') return myPosts.filter(p => (p.status === 'active' || p.status === 'paused') && p.author_pubkey === identity?.publicKey);
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
            const needsReview = isCompleted && ((isBuyer && !item.ratedByBuyer) || (!isBuyer && !item.ratedBySeller));
            const partnerPubkey = isBuyer ? item.sellerPublicKey : item.buyerPublicKey;
            // No card held for the partner yet (a community that says `membersOnDemand`): the key's first 8 characters,
            // never a blank after "From " (DESIGN-global-members-by-area §2.4).
            const partnerCallsign = (isBuyer ? item.sellerCallsign : item.buyerCallsign) || (partnerPubkey || '').slice(0, 8);
            const partnerAvatar = isBuyer ? item.sellerAvatar : item.buyerAvatar;

            const card = (
                <View testID={`deal-card-${item.id}`} style={[
                    styles.dealCard,
                    !isCompleted && !isPending && { opacity: 0.5 },
                    isPending && heldTone,
                ]}>
                    {item.coverImage && typeof item.coverImage === 'string' && item.coverImage.trim() !== '' && item.coverImage !== 'null' && item.coverImage !== 'undefined' ? (
                        <ExpoImage source={{ uri: listPhotoUrl(item.coverImage) }} style={styles.dealThumb} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                    ) : (
                        <View style={[styles.dealThumb, styles.dealThumbFallback]}>
                            <Text style={{ fontSize: 24, opacity: 0.5 }}>{isBuyer ? '🛒' : '🏷️'}</Text>
                        </View>
                    )}
                    <View style={{ flex: 1, padding: 12, justifyContent: 'space-between', minHeight: 96 }}>
                        {/* Badge, date and Beans side by side, wrapping where they don't fit (320 dp at 1.3x text): the amount
                            keeps the right edge and never shrinks, so it drops to its own line whole instead of being pushed
                            off the card by the date. */}
                        <View testID={`deal-top-${item.id}`} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 2 }}>
                            <View style={[styles.statusBadge, isCompleted && styles.statusCompleted]}>
                                <Text style={[styles.statusText, isCompleted && styles.statusTextCompleted]}>
                                    {item.status.toUpperCase()}
                                </Text>
                            </View>
                            <Text style={styles.dateText}>
                                {new Date(item.createdAt).toLocaleDateString()}
                            </Text>
                            {showsBeans && (
                            <View testID={`deal-amount-${item.id}`} style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 'auto', flexShrink: 0 }}>
                                <Text style={[styles.creditAmount, { color: isBuyer ? palette.red600 : colors.brand.dark }]} numberOfLines={1}>
                                    {isBuyer ? '- ' : '+ '}{item.credits}
                                </Text>
                                <Image source={require('../assets/images/bean.png')} style={styles.beanIcon} />
                            </View>
                            )}
                        </View>
                        <Text style={styles.dealTitle} numberOfLines={1}>{item.postTitle}</Text>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                                <MemberAvatar avatarUrl={partnerAvatar} pubkey={partnerPubkey || ''} callsign={partnerCallsign || '?'} size={20} />
                                <Text style={[styles.partnerText, { fontSize: 11 }]} numberOfLines={1}>
                                    {isBuyer ? 'From ' : 'To '}
                                    <Text style={styles.partnerName}>{partnerCallsign}</Text>
                                </Text>
                            </View>
                            {isCompleted && (
                                needsReview ? (
                                    <Pressable
                                        accessibilityRole="button"
                                        style={[styles.reviewBtn, { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }]}
                                        onPress={preview ? openMark : () => setPromptReview({ txId: item.id, targetPubkey: partnerPubkey, targetCallsign: partnerCallsign })}
                                    >
                                        <Text style={[styles.reviewBtnText, { fontSize: 11 }]}>Review</Text>
                                    </Pressable>
                                ) : (
                                    <Pressable
                                        accessibilityRole="button"
                                        style={[styles.reviewBtn, { backgroundColor: colors.surface.subtle, borderColor: colors.border.strong, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 }]}
                                        onPress={preview ? openMark : () => setPromptReview({ txId: item.id, targetPubkey: partnerPubkey, targetCallsign: partnerCallsign })}
                                    >
                                        <Text style={[styles.reviewBtnText, { color: theme === 'dark' ? colors.text.secondary : palette.gray600, fontSize: 11 }]}>Edit</Text>
                                    </Pressable>
                                )
                            )}
                        </View>
                    </View>
                </View>
            );

            if (isPending) {
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
        let displayStatusText = 'Active';
        let highlightStyle = {};
        // The status line's ink: light as it was (muted, amber for Action Required); dark, its card's tone.
        let statusInk: string | undefined;

        if (item.status === 'pending' || relatedTx?.status === 'pending') {
            displayStatusText = '🤝 Held in Trust';
            highlightStyle = heldTone;
            if (isDark) statusInk = colors.feedback.success.fg;
        } else if (relatedTx?.status === 'requested') {
            if (item.author_pubkey === identity?.publicKey) {
                displayStatusText = '⚠️ Action Required';
                highlightStyle = actionTone;
                statusInk = isDark ? colors.feedback.warning.fg : palette.amber600;
            } else {
                displayStatusText = '⏳ Awaiting Approval';
                highlightStyle = { backgroundColor: colors.surface.subtle, borderColor: colors.border.default };
                if (isDark) statusInk = colors.text.secondary;
            }
        }

        return (
            <Pressable accessibilityRole="button" onPress={preview ? openMark : () => { onClose(); router.push(`/post/${item.id}`); }}>
                <View testID={`deal-card-${item.id}`} style={[styles.dealCard, highlightStyle, item.status === 'paused' && styles.dealCardPaused]}>
                    {coverImage && typeof coverImage === 'string' && coverImage.trim() !== '' && coverImage !== 'null' && coverImage !== 'undefined' ? (
                        <ExpoImage source={{ uri: listPhotoUrl(coverImage) }} style={styles.dealThumb} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                    ) : (
                        <View style={[styles.dealThumb, styles.dealThumbFallback]}>
                            <Text style={{ fontSize: 24, opacity: 0.5 }}>📦</Text>
                        </View>
                    )}
                    <View style={{ flex: 1, padding: 12, justifyContent: 'center', minHeight: 96 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <View style={[styles.typeBadge, item.type === 'offer' ? styles.badgeOffer : styles.badgeNeed]}>
                                    <Text style={styles.typeBadgeText}>{item.type?.toUpperCase()}</Text>
                                </View>
                                {item.status === 'paused' && (
                                    <View style={styles.pausedBadge}><Text style={styles.pausedBadgeText}>⏸ PAUSED</Text></View>
                                )}
                            </View>
                            {showsBeans && (
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <Text style={styles.creditAmount} numberOfLines={1}>
                                    {item.credits ?? '?'}
                                </Text>
                                <Image source={require('../assets/images/bean.png')} style={styles.beanIcon} />
                            </View>
                            )}
                        </View>
                        <Text style={styles.dealTitle} numberOfLines={1}>{item.title}</Text>
                        <Text style={[styles.dateText, statusInk !== undefined && { color: statusInk }, displayStatusText.includes('Action') && { fontWeight: '800' }, { marginTop: 2 }]}>{displayStatusText}</Text>
                    </View>
                </View>
            </Pressable>
        );
    };

    return (
        <Modal visible={visible} transparent animationType="slide">
            <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.overlay} onPress={onClose}>
                <Pressable accessibilityRole="button" style={styles.sheet} onPress={e => e.stopPropagation()}>
                    {/* Handle bar */}
                    <View style={styles.handleBar} />

                    {/* Header */}
                    <View style={styles.sheetHeader}>
                        <Text style={styles.sheetTitle}>My Deals</Text>
                        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose}>
                            <Text style={styles.closeBtn}>✕</Text>
                        </Pressable>
                    </View>

                    {preview && (
                        <View testID="deals-preview-head">
                            <LocalCommunityMark variant="strip" feature="escrow" />
                            <ExampleHeader />
                        </View>
                    )}

                    {/* Tab bar */}
                    <View style={styles.tabBar}>
                        {[
                            { id: 'pending' as const, label: 'In Progress', badge: pendingCount },
                            { id: 'active' as const, label: 'My Posts' },
                            { id: 'history' as const, label: 'History' },
                        ].map(tab => (
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
                            {[{ id: 'all' as const, label: 'All' }, { id: 'buying' as const, label: 'Received' }, { id: 'selling' as const, label: 'Given' }].map(f => (
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

                    {/* List */}
                    <FlatList
                        data={listData}
                        keyExtractor={item => item.id}
                        renderItem={renderDealItem}
                        contentContainerStyle={{ paddingBottom: 24 }}
                        showsVerticalScrollIndicator={false}
                        ListEmptyComponent={
                            <View style={styles.emptyState}>
                                <Text style={styles.emptyEmoji}>
                                    {dealsTab === 'history' ? '📜' : dealsTab === 'pending' ? '🤝' : '📋'}
                                </Text>
                                <Text style={styles.emptyTitle}>
                                    {dealsTab === 'history' ? 'No history yet' : dealsTab === 'pending' ? 'No deals in progress' : 'No active posts'}
                                </Text>
                                <Text style={styles.emptySubtext}>
                                    {dealsTab === 'active'
                                        ? 'Post an offer or need to get started!'
                                        : dealsTab === 'pending'
                                        ? 'Accepted deals will appear here while they are held in trust.'
                                        : 'Completed deals will show up here.'}
                                </Text>
                                {dealsTab === 'active' && (
                                    <Pressable
                                        accessibilityRole="button"
                                        style={styles.ctaBtn}
                                        onPress={() => { onClose(); router.push('/(tabs)/market'); }}
                                    >
                                        <Text style={styles.ctaBtnText}>+ Create a Post</Text>
                                    </Pressable>
                                )}
                            </View>
                        }
                    />
                </Pressable>
            </Pressable>

            <LocalCommunitySheet feature="escrow" visible={markOpen} onClose={() => setMarkOpen(false)} />

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
export function usePendingDealsCount(identity: { publicKey: string } | null, posts: any[], transactions: any[]): number {
    if (!identity) return 0;
    const activeTxPostIds = new Set(
        transactions
            .filter((t: any) => t.status === 'pending' || t.status === 'requested')
            .map((t: any) => t.postId)
    );
    return posts.filter(p => {
        if (p.status === 'pending' && (p.author_pubkey === identity.publicKey || p.accepted_by === identity.publicKey)) return true;
        return activeTxPostIds.has(p.id);
    }).length;
}

// Empty since stylesheet has been refactored inside the component body
