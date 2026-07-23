import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, FlatList, Pressable, SafeAreaView, Platform, Alert, TextInput, ScrollView, DeviceEventEmitter, ActivityIndicator, RefreshControl } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { useFocusEffect, router, useLocalSearchParams } from 'expo-router';
import { getPosts, getMarketplaceTransactions, reportAbuse, getBalance } from '../../utils/db';
import { getLastSyncTime, requestSync } from '../../services/pillar-sync';
import { useIdentity } from '../IdentityContext';
import { RadiusPickerModal } from '../../components/RadiusPickerModal';
import { CategoryPickerSheet } from '../../components/CategoryPickerSheet';
import { MyDealsSheet, usePendingDealsCount } from '../../components/MyDealsSheet';
import { PostAuthorTrust, isElder } from '../../components/PostAuthorTrust';
import { TrustPickerSheet, TRUST_FILTERS } from '../../components/TrustPickerSheet';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';
import { categoryEmoji, categoryLabel } from '../../constants/categories';
import { palette } from '../../constants/colors';
import { useTheme, useStyles } from '../ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import synonymMap from '../../utils/synonyms.json';

// Build reverse synonym index: given a category/synonym, find all words that map to it
// e.g. "fruit" → ["lemon", "lime", "orange", "apple", ...]
const reverseSynonyms: Record<string, string[]> = {};
for (const [word, syns] of Object.entries(synonymMap)) {
    if (word === '_meta') continue;
    for (const syn of syns as string[]) {
        if (!reverseSynonyms[syn]) reverseSynonyms[syn] = [];
        reverseSynonyms[syn].push(word);
    }
}

/** Expand a search query using synonyms: "fruit" → ["fruit", "lemon", "lime", ...] */
function expandSearchTerms(query: string): string[] {
    const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1);
    const expanded = new Set<string>(words);
    for (const w of words) {
        // Forward: word → its synonyms (e.g. "lemon" → ["fruit", "citrus"])
        const fwd = (synonymMap as any)[w];
        if (fwd) for (const s of fwd) expanded.add(s);
        // Reverse: word → all words that have it as synonym (e.g. "fruit" → ["lemon", "lime"])
        if (reverseSynonyms[w]) for (const s of reverseSynonyms[w]) expanded.add(s);
        // Also try stemmed forms
        let stem = w;
        if (w.endsWith('ies')) stem = w.slice(0, -3) + 'y';
        else if (w.endsWith('es')) stem = w.slice(0, -2);
        else if (w.endsWith('s') && w.length > 3) stem = w.slice(0, -1);
        else if (w.endsWith('ing') && w.length > 5) stem = w.slice(0, -3);
        if (stem !== w) {
            expanded.add(stem);
            const fwdStem = (synonymMap as any)[stem];
            if (fwdStem) for (const s of fwdStem) expanded.add(s);
            if (reverseSynonyms[stem]) for (const s of reverseSynonyms[stem]) expanded.add(s);
        }
    }
    return [...expanded];
}

export const MARKETPLACE_CATEGORIES = [
    { id: 'all', emoji: '🏷️', label: 'All Categories' },
    { id: 'food', emoji: '🥕', label: 'Food' },
    { id: 'services', emoji: '🤝', label: 'Services' },
    { id: 'labour', emoji: '👷', label: 'Labour' },
    { id: 'tools', emoji: '🛠️', label: 'Tools' },
    { id: 'goods', emoji: '📦', label: 'Goods' },
    { id: 'garden', emoji: '🌻', label: 'Garden' },
    { id: 'housing', emoji: '🏠', label: 'Housing' },
    { id: 'transport', emoji: '🚗', label: 'Transport' },
    { id: 'education', emoji: '📚', label: 'Education' },
    { id: 'arts', emoji: '🎨', label: 'Arts' },
    { id: 'health', emoji: '🌿', label: 'Health' },
    { id: 'care', emoji: '❤️', label: 'Care' },
    { id: 'animals', emoji: '🐾', label: 'Animals' },
    { id: 'tech', emoji: '💻', label: 'Tech' },
    { id: 'energy', emoji: '☀️', label: 'Energy' },
    { id: 'general', emoji: '🌱', label: 'General' },
];

function deg2rad(deg: number) {
    return deg * (Math.PI / 180);
}

function getDistanceInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371;
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1); 
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    return R * c;
}

export default function MarketScreen() {
    const { theme, colors } = useTheme();
    const { identity } = useIdentity();

    // Contributions-First quest card: shown until the member has listed their
    // first Offer (the gate that unlocks posting Needs / accepting Offers), so
    // the rule reads as a friendly next step here instead of being discovered
    // through a rejection modal mid-trade. Re-checked on every focus, so it
    // disappears the moment their first Offer is posted.
    const [showFirstOfferQuest, setShowFirstOfferQuest] = useState(false);
    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                if (!identity?.publicKey) return;
                if (await AsyncStorage.getItem('beanpool_first_offer_quest_dismissed')) return;
                try {
                    const b: any = await getBalance(identity.publicKey);
                    if (!cancelled) setShowFirstOfferQuest(!!b?.isBlockedFromTrading);
                } catch {
                    // Unknown (offline / old node) — don't show the card on a guess.
                }
            })();
            return () => { cancelled = true; };
        }, [identity?.publicKey])
    );
    const dismissFirstOfferQuest = () => {
        setShowFirstOfferQuest(false);
        AsyncStorage.setItem('beanpool_first_offer_quest_dismissed', 'true').catch(() => {});
    };
    const [filter, setFilter] = useState<'all' | 'needs' | 'offers' | 'for-you'>('all');
    
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        safeArea: { flex: 1, backgroundColor: colors.surface.app },
        listContent: { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 100 },

        // Search row
        searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
        searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface.card, borderRadius: 19, paddingHorizontal: 14, height: 38, borderWidth: 1, borderColor: colors.border.default, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1 },
        searchInput: { flex: 1, marginLeft: 8, fontSize: 14, color: colors.text.body, fontWeight: '500' },
        iconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1 },
        dealsIconBtn: {
            paddingHorizontal: 14, height: 38, borderRadius: 19,
            backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : palette.amber50,
            borderWidth: 1,
            borderColor: theme === 'dark' ? colors.feedback.warning.border : palette.amber300,
            justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1
        },
        dealsIconBadge: { position: 'absolute', top: -4, right: -4, backgroundColor: colors.feedback.danger.solid, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 8, minWidth: 14, alignItems: 'center' },

        // Deal badge (positioned on icon button)
        dealBadge: { position: 'absolute', top: -4, right: -4, backgroundColor: colors.feedback.danger.solid, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 8, minWidth: 16, alignItems: 'center' },
        dealBadgeText: { color: colors.text.inverse, fontSize: 9, fontWeight: '900' },

        // Horizontal filter chips
        chipScrollContainer: { flexGrow: 1, justifyContent: 'center', flexDirection: 'row', gap: 4, paddingHorizontal: 16, paddingVertical: 4 },
        foundingChip: {
            alignSelf: 'center', marginTop: 8, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, borderWidth: 1,
            borderColor: theme === 'dark' ? colors.trust.founding.border : 'rgba(34,197,94,0.4)',
            backgroundColor: colors.surface.card
        },
        foundingChipActive: {
            backgroundColor: theme === 'dark' ? colors.trust.founding.bg : palette.green100,
            borderColor: theme === 'dark' ? colors.trust.founding.border : palette.green500
        },
        foundingChipText: { fontSize: 12, fontWeight: '800', color: theme === 'dark' ? colors.trust.founding.fg : palette.green700 },
        foundingChipTextActive: { color: theme === 'dark' ? colors.trust.founding.fg : palette.green800 },
        chip: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 8,
            paddingHorizontal: 10,
            borderRadius: 20,
            borderWidth: 1,
            borderColor: colors.border.default,
            backgroundColor: colors.surface.card,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.03,
            shadowRadius: 2,
            elevation: 1,
        },
        chipText: { fontSize: 13, fontWeight: '700', color: colors.text.secondary },
        chipTextActive: { color: colors.text.inverse },
        chipAllActive: {
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.gray800,
            borderColor: theme === 'dark' ? colors.border.strong : palette.gray800
        },
        chipOfferActive: {
            backgroundColor: colors.market.offer.bg,
            borderColor: colors.market.offer.fg
        },
        chipNeedActive: {
            backgroundColor: colors.market.need.bg,
            borderColor: colors.market.need.fg
        },
        chipActive: {
            backgroundColor: colors.accent.primary,
            borderColor: colors.accent.primary
        },
        chipDistanceActive: {
            backgroundColor: colors.feedback.warning.bg,
            borderColor: colors.feedback.warning.border
        },
        chipDivider: { width: 1, height: 24, backgroundColor: colors.border.default, alignSelf: 'center' },

        // Cards
        card: {
            backgroundColor: colors.surface.card,
            borderRadius: 14,
            marginBottom: 8,
            borderWidth: 1,
            borderColor: colors.border.default,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.05,
            shadowRadius: 8,
            elevation: 2,
            overflow: 'hidden'
        },
        elderCard: {
            borderLeftWidth: 3,
            borderLeftColor: colors.trust.star,
            shadowColor: colors.trust.star,
            shadowOpacity: 0.15,
        },
        gridRow: { gap: 16 },
        gridCard: { flex: 1, marginBottom: 16 },
        gridImageWrapper: { position: 'relative', width: '100%', aspectRatio: 1 },
        gridImage: { width: '100%', height: '100%' },
        gridFallback: { backgroundColor: colors.surface.subtle, justifyContent: 'center', alignItems: 'center' },
        gridFallbackEmoji: { fontSize: 32, opacity: 0.3 },
        gridPriceBadge: { position: 'absolute', bottom: 8, right: 8, backgroundColor: colors.overlay.scrim, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: colors.overlay.scrimEdge },
        gridPriceText: { color: colors.text.inverse, fontSize: 13, fontWeight: 'bold' },
        gridTypeBadge: { position: 'absolute', top: 8, left: 8, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
        gridTextContent: { padding: 12 },
        gridCardTitle: { fontSize: 14, fontWeight: '700', color: colors.text.body, marginBottom: 4 },
        badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
        badgeOffer: { backgroundColor: colors.market.offer.bg, borderWidth: 0 },
        badgeNeed: { backgroundColor: colors.market.need.bg, borderWidth: 0 },
        badgeText: { fontSize: 11, fontWeight: '800', color: colors.market.offer.fg, letterSpacing: 0.5 },
        price: { fontSize: 16, fontWeight: '800', color: colors.text.body },
        fab: { position: 'absolute', bottom: 32, right: 24, backgroundColor: colors.action.fab, paddingVertical: 14, paddingHorizontal: 20, borderRadius: 28, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 8, zIndex: 100 },
        compactRow: {
            flexDirection: 'row',
            backgroundColor: colors.surface.card,
            borderRadius: 14,
            paddingVertical: 10,
            paddingHorizontal: 12,
            marginBottom: 8,
            borderWidth: 1,
            borderColor: colors.border.default,
            alignItems: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.02,
            shadowRadius: 1,
            elevation: 1,
        },
        elderCompactRow: {
            borderLeftWidth: 3,
            borderLeftColor: colors.trust.star,
        },
        compactEmoji: {
            fontSize: 20,
        },
        compactTitle: {
            fontSize: 14,
            fontWeight: '800',
            color: colors.text.body,
        },
        compactAuthor: {
            fontSize: 11,
            color: colors.text.secondary,
            marginTop: 1,
        },
        compactPrice: {
            fontSize: 14,
            fontWeight: '900',
            color: colors.text.body,
        },
        compactBadge: {
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 8,
        },
        compactBadgeOffer: {
            backgroundColor: colors.market.offer.bg,
        },
        compactBadgeNeed: {
            backgroundColor: colors.market.need.bg,
        },
        compactBadgeText: {
            fontSize: 9,
            fontWeight: '800',
            letterSpacing: 0.5,
        },
        sectionHeader: {
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: 4,
            marginBottom: 2,
            paddingHorizontal: 4,
        },
        sectionHeaderText: {
            fontSize: 11,
            fontWeight: '800',
            color: colors.text.muted,
            letterSpacing: 1,
            textTransform: 'uppercase',
        },
        sectionHeaderLine: {
            flex: 1,
            height: 1,
            backgroundColor: colors.border.default,
            marginLeft: 12,
        },
        freshBanner: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : palette.orange50,
            borderRadius: 16,
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderWidth: 1,
            borderColor: theme === 'dark' ? colors.feedback.warning.border : palette.orange100,
            marginHorizontal: 16,
            marginTop: 8,
            marginBottom: 8,
            shadowColor: theme === 'dark' ? '#000' : palette.orange500,
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: theme === 'dark' ? 0.2 : 0.05,
            shadowRadius: 4,
            elevation: 1,
        },
        freshBannerTitle: {
            fontSize: 13,
            fontWeight: '900',
            color: theme === 'dark' ? colors.feedback.warning.fg : palette.orange700,
        },
        freshBannerSub: {
            fontSize: 10,
            fontWeight: '500',
            color: theme === 'dark' ? colors.text.body : palette.orange800,
            opacity: 0.8,
            marginTop: 1,
        },
        liveBadge: {
            backgroundColor: theme === 'dark' ? colors.feedback.warning.border : palette.orange100,
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme === 'dark' ? colors.feedback.warning.fg : palette.orange200,
        },
        liveBadgeText: {
            fontSize: 9,
            fontWeight: '900',
            color: theme === 'dark' ? colors.feedback.warning.fg : palette.orange600,
        },
        favPanel: {
            backgroundColor: colors.accent.tint,
            borderRadius: 16,
            padding: 16,
            borderWidth: 1,
            borderColor: colors.accent.border,
            marginHorizontal: 16,
            marginTop: 8,
            marginBottom: 8,
        },
        favPanelTitle: {
            fontSize: 11,
            fontWeight: '900',
            color: colors.accent.primary,
            letterSpacing: 1,
            marginBottom: 4,
        },
        favPanelSub: {
            fontSize: 11,
            color: colors.text.secondary,
            marginBottom: 10,
        },
        favTagsContainer: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 6,
        },
        favTag: {
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.default,
            borderRadius: 16,
            paddingVertical: 6,
            paddingHorizontal: 10,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.02,
            shadowRadius: 1,
            elevation: 1,
        },
        favTagActive: {
            backgroundColor: colors.accent.primary,
            borderColor: colors.accent.primary,
        },
        favTagText: {
            fontSize: 11,
            fontWeight: '700',
            color: colors.text.secondary,
        },
        favTagTextActive: {
            color: colors.text.inverse,
        },
        favSummaryBanner: {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.accent.tint,
            borderRadius: 16,
            paddingVertical: 10,
            paddingHorizontal: 16,
            borderWidth: 1,
            borderColor: colors.accent.border,
            marginHorizontal: 16,
            marginTop: 4,
            marginBottom: 4,
        },
        favSummaryText: {
            fontSize: 12,
            fontWeight: '700',
            color: colors.accent.primary,
            flex: 1,
        },
        favSummaryEditBadge: {
            backgroundColor: colors.accent.border,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 8,
        },
        favSummaryEditBtn: {
            fontSize: 9,
            fontWeight: '900',
            color: colors.accent.primary,
        },
        typeSegmentContainer: {
            flexDirection: 'row',
            width: '100%',
            backgroundColor: colors.surface.subtle,
            borderRadius: 12,
            padding: 3,
            marginTop: 0,
            marginBottom: 3,
        },
        segmentBtn: {
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 5,
            borderRadius: 10,
            backgroundColor: 'transparent',
        },
        segmentText: {
            fontSize: 12,
            fontWeight: '700',
            color: colors.text.secondary,
        },
        segmentTextActive: {
            color: colors.text.inverse,
            fontWeight: '800',
        },
        segmentBtnAllActive: { backgroundColor: theme === 'dark' ? colors.surface.card : palette.gray800 },
        segmentBtnFavActive: { backgroundColor: colors.accent.primary },
        segmentBtnOfferActive: { backgroundColor: colors.brand.primary },
        segmentBtnNeedActive: { backgroundColor: colors.action.fab },

        dropdownsRow: {
            flexDirection: 'row',
            width: '100%',
            justifyContent: 'space-between',
            gap: 8,
            marginTop: 2,
            marginBottom: 2,
        },
        dropdownBtn: {
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.default,
            borderRadius: 12,
            paddingVertical: 5,
            paddingHorizontal: 12,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.03,
            shadowRadius: 2,
            elevation: 1,
        },
        dropdownBtnCategoryActive: {
            backgroundColor: colors.feedback.info.bg,
            borderColor: colors.feedback.info.border,
        },
        dropdownBtnDistanceActive: {
            backgroundColor: colors.feedback.warning.bg,
            borderColor: colors.feedback.warning.border,
        },
        dropdownBtnNewMembersActive: {
            backgroundColor: colors.feedback.success.bg,
            borderColor: colors.feedback.success.border,
        },
        dropdownText: {
            fontSize: 12,
            fontWeight: '700',
            color: colors.text.secondary,
        },
        dropdownTextActive: {
            color: theme === 'dark' ? colors.text.heading : colors.text.inverse,
            fontWeight: '800',
        }
    }));

    const [trustFilter, setTrustFilter] = useState<string>('all');
    const [showTrustPicker, setShowTrustPicker] = useState(false);
    const [viewMode, setViewMode] = useState<'list' | 'grid' | 'compact'>('list');
    const [favCategories, setFavCategories] = useState<string[]>([]);
    const [isCustomizerExpanded, setIsCustomizerExpanded] = useState(true);

    // Fresh listings banner dismissal and scroll tracking states
    const [dismissedFreshCount, setDismissedFreshCount] = useState<number>(0);
    const [showFreshBannerOnScroll, setShowFreshBannerOnScroll] = useState(true);

    const [refreshing, setRefreshing] = useState(false);

    const onRefresh = async () => {
        setRefreshing(true);
        try {
            await requestSync();
            await loadPosts();
        } catch (e) {
            console.error('Pull-to-refresh failed:', e);
        } finally {
            setRefreshing(false);
        }
    };

    useEffect(() => {
        AsyncStorage.getItem('bp_fav_categories').then(val => {
            if (val) {
                const parsed = JSON.parse(val);
                setFavCategories(parsed);
                if (parsed && parsed.length > 0) {
                    setIsCustomizerExpanded(false);
                }
            }
        }).catch(() => {});

        // Load dismissed fresh postings count
        AsyncStorage.getItem('bp_dismissed_fresh_count').then(val => {
            if (val) {
                setDismissedFreshCount(parseInt(val, 10));
            }
        }).catch(() => {});
    }, []);
    const [searchQuery, setSearchQuery] = useState('');
    const [blockedUsers, setBlockedUsers] = useState<string[]>([]);
    const [posts, setPosts] = useState<any[]>([]);
    // First-run loading: getLastSyncTime() is null until the first successful sync. Until then we
    // show a loading state rather than the "no items" empty state (which reads as broken/empty).
    const [firstSyncDone, setFirstSyncDone] = useState(false);
    const [syncTimedOut, setSyncTimedOut] = useState(false);
    const [searchResults, setSearchResults] = useState<any[] | null>(null);
    const [isSearching, setIsSearching] = useState(false);
    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [categoryFilter, setCategoryFilter] = useState('all');
    const [showCategoryPicker, setShowCategoryPicker] = useState(false);
    const [radiusKm, setRadiusKm] = useState<number | null>(null);
    const [locationCenter, setLocationCenter] = useState<{lat: number, lng: number} | null>(null);
    const [showRadiusPicker, setShowRadiusPicker] = useState(false);
    
    // Deals Sheet
    const [showDealsSheet, setShowDealsSheet] = useState(false);
    const [dealsInitialTab, setDealsInitialTab] = useState<'active' | 'pending' | 'history'>('pending');
    const [myTransactions, setMyTransactions] = useState<any[]>([]);

    const pendingCount = usePendingDealsCount(identity, posts, myTransactions);

    useEffect(() => {
        loadBlockedUsers();
    }, []);

    useFocusEffect(
        React.useCallback(() => {
            loadPosts();
        }, [filter, identity?.publicKey])
    );

    const params = useLocalSearchParams<{ tab?: string, dealsTab?: string }>();

    useEffect(() => {
        if (params.tab === 'deals') {
            setShowDealsSheet(true);
            router.setParams({ tab: '' });
        }
        if (params.dealsTab) {
            setDealsInitialTab(params.dealsTab as any);
            setShowDealsSheet(true);
            router.setParams({ dealsTab: '' });
        }
    }, [params.tab, params.dealsTab]);

    useEffect(() => {
        const sub = DeviceEventEmitter.addListener('sync_data_updated', () => {
            setFirstSyncDone(true);
            setSyncTimedOut(false);
            loadPosts();
        });
        return () => sub.remove();
    }, [filter, identity?.publicKey]);

    // Decide whether the first sync has happened yet (drives the loading vs empty state).
    // If we've synced before, we're done immediately; otherwise fall back to a retry prompt
    // after ~12s so a new user on a flaky connection never sees an infinite spinner.
    useEffect(() => {
        let active = true;
        let timer: ReturnType<typeof setTimeout>;
        getLastSyncTime().then(t => {
            if (!active) return;
            if (t) { setFirstSyncDone(true); return; }
            timer = setTimeout(() => { if (active) setSyncTimedOut(true); }, 12000);
        }).catch(() => {});
        return () => { active = false; if (timer) clearTimeout(timer); };
    }, []);

    // Debounced FTS5 server search
    useEffect(() => {
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        
        const q = searchQuery.trim();
        if (!q) {
            setSearchResults(null);
            setIsSearching(false);
            return;
        }
        
        setIsSearching(true);
        searchTimerRef.current = setTimeout(async () => {
            try {
                const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                if (!anchorUrl) {
                    setSearchResults(null);
                    setIsSearching(false);
                    return;
                }
                const type = filter === 'all' ? '' : filter === 'needs' ? '&type=need' : '&type=offer';
                const cat = categoryFilter !== 'all' ? `&category=${categoryFilter}` : '';
                
                // Expand synonyms so the server's FTS5 'OR' logic can find them
                const expandedQ = expandSearchTerms(q).join(' ');
                
                const res = await fetch(`${anchorUrl}/api/marketplace/posts?q=${encodeURIComponent(expandedQ)}${type}${cat}&limit=50`);
                if (res.ok) {
                    const data = await res.json();
                    // Server returns camelCase MarketplacePost; the UI reads snake_case
                    // (matching local SQLite shape). Normalize and parse photos.
                    const parsed = (Array.isArray(data) ? data : []).map((p: any) => {
                        let photosArr = p.photos;
                        if (typeof p.photos === 'string') {
                            try { photosArr = JSON.parse(p.photos); } catch { photosArr = []; }
                        }
                        if (Array.isArray(photosArr)) {
                            photosArr = photosArr.map((url: string) => url && url.startsWith('/') ? `${anchorUrl}${url}` : url);
                        }
                        return {
                            ...p,
                            photos: photosArr,
                            author_pubkey: p.author_pubkey ?? p.authorPublicKey,
                            author_callsign: p.author_callsign ?? p.authorCallsign,
                            author_avatar: p.author_avatar ?? p.authorAvatarUrl ?? null,
                            author_energy_cycled: p.author_energy_cycled ?? p.authorEnergyCycled ?? 0,
                            authorFoundingNeeded: p.authorFoundingNeeded ?? (p.author_founding_needed === 1),
                            author_founding_needed: p.author_founding_needed ?? (p.authorFoundingNeeded ? 1 : 0),
                        };
                    });
                    setSearchResults(parsed);
                } else {
                    setSearchResults(null); // Fall back to local filtering
                }
            } catch {
                setSearchResults(null); // Fall back to local filtering
            }
            setIsSearching(false);
        }, 300);

        return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
    }, [searchQuery, filter, categoryFilter]);

    const loadPosts = async () => {
        const queryFilter = filter === 'all' ? undefined : { type: filter === 'needs' ? 'need' : 'offer' };
        try {
            const data = await getPosts(queryFilter);
            setPosts(data);
            
            if (identity) {
                const txs = await getMarketplaceTransactions(identity.publicKey);
                setMyTransactions(txs);
            }
        } catch (e) {
            console.error('Failed to query SQLite Posts', e);
        }
    };

    const loadBlockedUsers = async () => {
        try {
            const data = await SecureStore.getItemAsync('beanpool_blocked_users');
            if (data) setBlockedUsers(JSON.parse(data));
        } catch (e) {
            console.error('Failed to load local blocklist', e);
        }
    };

    const handleContentAction = (targetPubkey: string, authorName: string, postId: string) => {
        Alert.alert(
            "Post Options",
            `What would you like to do regarding this post by ${authorName}?`,
            [
                { text: "Cancel", style: "cancel" },
                { 
                    text: "Hide Post & Block User", 
                    style: "destructive",
                    onPress: async () => {
                        try {
                            const newBlocklist = [...blockedUsers, targetPubkey];
                            await SecureStore.setItemAsync('beanpool_blocked_users', JSON.stringify(newBlocklist));
                            setBlockedUsers(newBlocklist);
                            Alert.alert('Blocked', `${authorName} has been filtered from your Feed.`);
                        } catch (e) {
                            Alert.alert('Hardware Error', 'Could not write to Secure Enclave.');
                        }
                    }
                },
                {
                    text: "Report Objectionable Content",
                    style: "default",
                    onPress: async () => {
                        if (!identity) return;
                        try {
                            await reportAbuse(identity.publicKey, targetPubkey, 'Objectionable Content via Marketplace', postId);
                            Alert.alert('Report Received', 'Thank you. The community administrators will review this post shortly.');
                        } catch (e: any) {
                            Alert.alert('Report Failed', e.message || 'Could not reach server.');
                        }
                    }
                }
            ]
        );
    };

    // Use server search results when available, otherwise filter locally
    const basePosts = searchResults !== null ? searchResults : posts;

    const filteredPosts = basePosts.filter(p => {
        if (p.status !== 'active') return false;
        if (blockedUsers.includes(p.author_pubkey)) return false;
        if (categoryFilter !== 'all' && p.category !== categoryFilter) return false;
        
        // Type / For You filters
        if (filter === 'offers' && p.type !== 'offer') return false;
        if (filter === 'needs' && p.type !== 'need') return false;
        if (filter === 'for-you' && !favCategories.includes(p.category)) return false;
        
        // Trust Level filters
        if (trustFilter === 'founding' && !p.authorFoundingNeeded) return false;
        if (trustFilter === 'new' && (p.author_energy_cycled ?? 0) >= 120) return false;
        if (trustFilter === 'resident' && (p.author_energy_cycled ?? 0) < 120) return false;
        if (trustFilter === 'steward' && (p.author_energy_cycled ?? 0) < 520) return false;
        if (trustFilter === 'elder' && (p.author_energy_cycled ?? 0) < 1320) return false;

        if (radiusKm && p.lat && p.lng) {
            const centerLat = locationCenter ? locationCenter.lat : -28.5523;
            const centerLng = locationCenter ? locationCenter.lng : 153.4991;
            const dist = getDistanceInKm(centerLat, centerLng, p.lat, p.lng);
            if (dist > radiusKm) return false;
        }

        // Synonym-aware local search: expand query using synonym map
        // Works on ALL servers, even those without FTS5 deployed
        if (searchQuery.trim()) {
            const serverHasFTS = searchResults !== null && searchResults.length > 0 && 'search_keywords' in searchResults[0];
            if (!serverHasFTS) {
                const terms = expandSearchTerms(searchQuery);
                const titleStr = p.title ? p.title.toLowerCase() : '';
                const descStr = p.description ? p.description.toLowerCase() : '';
                const postText = `${titleStr} ${descStr}`;
                const matched = terms.some(term => postText.includes(term));
                if (!matched) return false;
            }
        }
        return true;
    });

    const selectedCategory = MARKETPLACE_CATEGORIES.find(c => c.id === categoryFilter);
    const selectedTrustFilter = TRUST_FILTERS.find(f => f.id === trustFilter);
    const hasActiveFilters = categoryFilter !== 'all' || radiusKm !== null || filter !== 'all' || trustFilter !== 'all';

    const freshTodayCount = posts.filter(post => {
        if (post.status !== 'active') return false;
        const postTime = new Date(post.created_at || post.createdAt).getTime();
        const diffDays = Math.floor((Date.now() - postTime) / (24 * 60 * 60 * 1000));
        return diffDays === 0;
    }).length;

    // Display banner only if fresh postings count is greater than the dismissed count and scroll visibility is active
    const shouldShowFreshBanner = freshTodayCount > 0 && freshTodayCount > dismissedFreshCount && showFreshBannerOnScroll;

    const dismissFreshBanner = async () => {
        const { LayoutAnimation } = require('react-native');
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setDismissedFreshCount(freshTodayCount);
        try {
            await AsyncStorage.setItem('bp_dismissed_fresh_count', String(freshTodayCount));
        } catch (e) {}
    };

    const onScrollHandler = (event: any) => {
        const offsetY = event.nativeEvent.contentOffset.y;
        if (offsetY > 15) {
            if (showFreshBannerOnScroll) {
                const { LayoutAnimation } = require('react-native');
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setShowFreshBannerOnScroll(false);
            }
        } else if (offsetY <= 5) {
            if (!showFreshBannerOnScroll) {
                const { LayoutAnimation } = require('react-native');
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setShowFreshBannerOnScroll(true);
            }
        }
    };

    const HeaderComponent = (
        <View>
            {/* Top row: Search + My Deals + View Toggle */}
            <View style={[styles.searchRow, { paddingHorizontal: 16 }]}>
                <View style={styles.searchWrap}>
                    <Text style={{ opacity: 0.4, fontSize: 14 }}>🔍</Text>
                    <TextInput
                        style={styles.searchInput}
                        placeholder="Search marketplace..."
                        placeholderTextColor={colors.text.muted}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        accessibilityLabel="Search marketplace"
                    />
                </View>
                <Pressable
                    onPress={() => setShowDealsSheet(true)}
                    style={styles.dealsIconBtn}
                    accessibilityRole="button"
                >
                    <Text style={{ fontSize: 18, marginBottom: -2 }}>🤝</Text>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: palette.amber700 }}>My Deals</Text>
                    {pendingCount > 0 && (
                        <View style={styles.dealsIconBadge}>
                            <Text style={{ color: colors.text.inverse, fontSize: 8, fontWeight: '900' }}>{pendingCount}</Text>
                        </View>
                    )}
                </Pressable>
                <Pressable
                    onPress={() => setViewMode(v => v === 'list' ? 'grid' : (v === 'grid' ? 'compact' : 'list'))}
                    style={styles.iconBtn}
                    accessibilityRole="button"
                    accessibilityLabel={viewMode === 'list' ? 'Grid view' : (viewMode === 'grid' ? 'Compact view' : 'List view')}
                >
                    <MaterialCommunityIcons
                        name={viewMode === 'list' ? 'view-grid-outline' : (viewMode === 'grid' ? 'view-headline' : 'view-list-outline')} 
                        size={20} 
                        color={colors.text.secondary}
                    />
                </Pressable>
            </View>

            {/* Elegant 3-Row Layout: Row 2 (Type Segmented Control) + Row 3 (Symmetrical Filter Dropdowns) */}
            <View style={{ paddingHorizontal: 16, marginTop: 0 }}>
                {/* Row 2: Full-Width Type Segmented Control */}
                <View style={styles.typeSegmentContainer}>
                    <Pressable
                        onPress={() => setFilter('all')}
                        style={[styles.segmentBtn, filter === 'all' && styles.segmentBtnAllActive]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: filter === 'all' }}
                    >
                        <Text style={[styles.segmentText, filter === 'all' && styles.segmentTextActive]}>All</Text>
                    </Pressable>
                    <Pressable
                        onPress={() => setFilter(filter === 'for-you' ? 'all' : 'for-you')}
                        style={[styles.segmentBtn, filter === 'for-you' && styles.segmentBtnFavActive]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: filter === 'for-you' }}
                    >
                        <Text style={[styles.segmentText, filter === 'for-you' && styles.segmentTextActive]}>★ For You</Text>
                    </Pressable>
                    <Pressable
                        onPress={() => setFilter(filter === 'offers' ? 'all' : 'offers')}
                        style={[styles.segmentBtn, filter === 'offers' && styles.segmentBtnOfferActive]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: filter === 'offers' }}
                    >
                        <Text style={[styles.segmentText, filter === 'offers' && styles.segmentTextActive]}>🟢 Offers</Text>
                    </Pressable>
                    <Pressable
                        onPress={() => setFilter(filter === 'needs' ? 'all' : 'needs')}
                        style={[styles.segmentBtn, filter === 'needs' && styles.segmentBtnNeedActive]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: filter === 'needs' }}
                    >
                        <Text style={[styles.segmentText, filter === 'needs' && styles.segmentTextActive]}>🟠 Needs</Text>
                    </Pressable>
                </View>

                {/* Row 3: Symmetrical Filter Dropdowns (Category, Distance, New Members) */}
                <View style={styles.dropdownsRow}>
                    {/* Category Dropdown */}
                    <Pressable
                        onPress={() => setShowCategoryPicker(true)}
                        style={[styles.dropdownBtn, categoryFilter !== 'all' && styles.dropdownBtnCategoryActive]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: categoryFilter !== 'all' }}
                    >
                        <Text style={[styles.dropdownText, categoryFilter !== 'all' && styles.dropdownTextActive]} numberOfLines={1}>
                            {selectedCategory?.emoji || '🏷️'} {categoryFilter !== 'all' ? selectedCategory?.label : 'Category'}
                        </Text>
                        {categoryFilter !== 'all' ? (
                            <Pressable
                                onPress={(e) => { e.stopPropagation(); setCategoryFilter('all'); }}
                                hitSlop={8}
                                style={{ marginLeft: 6, backgroundColor: colors.overlay.lightFill, borderRadius: 8, paddingHorizontal: 4, paddingVertical: 1 }}
                                accessibilityRole="button"
                                accessibilityLabel="Clear category filter"
                            >
                                <Text style={{ fontSize: 9, color: colors.text.inverse, fontWeight: 'bold' }}>✕</Text>
                            </Pressable>
                        ) : (
                            <Text style={{ fontSize: 8, color: colors.text.muted, marginLeft: 4 }}>▼</Text>
                        )}
                    </Pressable>

                    {/* Distance Dropdown */}
                    <Pressable
                        onPress={() => setShowRadiusPicker(true)}
                        style={[styles.dropdownBtn, radiusKm !== null && styles.dropdownBtnDistanceActive]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: radiusKm !== null }}
                    >
                        <Text style={[styles.dropdownText, radiusKm !== null && styles.dropdownTextActive]} numberOfLines={1}>
                            📍 {radiusKm ? (radiusKm < 1 ? `${Math.round(radiusKm * 1000)}m` : `${radiusKm}km`) : 'Distance'}
                        </Text>
                        {radiusKm !== null ? (
                            <Pressable
                                onPress={(e) => { e.stopPropagation(); setRadiusKm(null); setLocationCenter(null); }}
                                hitSlop={8}
                                style={{ marginLeft: 6, backgroundColor: colors.overlay.lightFill, borderRadius: 8, paddingHorizontal: 4, paddingVertical: 1 }}
                                accessibilityRole="button"
                                accessibilityLabel="Clear distance filter"
                            >
                                <Text style={{ fontSize: 9, color: colors.text.inverse, fontWeight: 'bold' }}>✕</Text>
                            </Pressable>
                        ) : (
                            <Text style={{ fontSize: 8, color: colors.text.muted, marginLeft: 4 }}>▼</Text>
                        )}
                    </Pressable>

                    {/* Trust Filter */}
                    <Pressable
                        onPress={() => setShowTrustPicker(true)}
                        style={[styles.dropdownBtn, trustFilter !== 'all' && styles.dropdownBtnNewMembersActive]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: trustFilter !== 'all' }}
                    >
                        <Text style={[styles.dropdownText, trustFilter !== 'all' && styles.dropdownTextActive]} numberOfLines={1}>
                            {selectedTrustFilter?.emoji || '🤝'} {trustFilter !== 'all' ? selectedTrustFilter?.label : 'Trust'}
                        </Text>
                        {trustFilter !== 'all' ? (
                            <Pressable
                                onPress={(e) => { e.stopPropagation(); setTrustFilter('all'); }}
                                hitSlop={8}
                                style={{ marginLeft: 6, backgroundColor: colors.overlay.lightFill, borderRadius: 8, paddingHorizontal: 4, paddingVertical: 1 }}
                                accessibilityRole="button"
                                accessibilityLabel="Clear trust filter"
                            >
                                <Text style={{ fontSize: 9, color: colors.text.inverse, fontWeight: 'bold' }}>✕</Text>
                            </Pressable>
                        ) : (
                            <Text style={{ fontSize: 8, color: colors.text.muted, marginLeft: 4 }}>▼</Text>
                        )}
                    </Pressable>
                </View>
            </View>

            {/* Interests Tag Cloud when in For You mode */}
            {filter === 'for-you' && (
                isCustomizerExpanded ? (
                    <View style={styles.favPanel}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <Text style={styles.favPanelTitle}>★ CUSTOMIZE INTERESTS</Text>
                            <Pressable
                                onPress={() => setIsCustomizerExpanded(false)}
                                style={{ backgroundColor: colors.accent.border, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}
                                accessibilityRole="button"
                            >
                                <Text style={{ fontSize: 10, fontWeight: '800', color: colors.accent.primary }}>✕ HIDE</Text>
                            </Pressable>
                        </View>
                        <Text style={styles.favPanelSub}>Select categories to prioritize in your feed:</Text>
                        <View style={styles.favTagsContainer}>
                            {MARKETPLACE_CATEGORIES.filter(c => c.id !== 'all').map(cat => {
                                const isFav = favCategories.includes(cat.id);
                                return (
                                    <Pressable
                                        key={cat.id}
                                        onPress={async () => {
                                            const updated = isFav
                                                ? favCategories.filter(c => c !== cat.id)
                                                : [...favCategories, cat.id];
                                            setFavCategories(updated);
                                            try {
                                                await AsyncStorage.setItem('bp_fav_categories', JSON.stringify(updated));
                                            } catch {}
                                        }}
                                        style={[styles.favTag, isFav && styles.favTagActive]}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected: isFav }}
                                    >
                                        <Text style={[styles.favTagText, isFav && styles.favTagTextActive]}>
                                            {cat.emoji} {cat.label} {isFav ? '★' : ''}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    </View>
                ) : (
                    <Pressable
                        onPress={() => setIsCustomizerExpanded(true)}
                        style={styles.favSummaryBanner}
                        accessibilityRole="button"
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                                <Text style={{ fontSize: 13, color: colors.accent.primary, fontWeight: 'bold' }}>★</Text>
                                <Text style={styles.favSummaryText} numberOfLines={1}>
                                    Prioritizing: {favCategories.length > 0 
                                        ? favCategories.map(id => MARKETPLACE_CATEGORIES.find(c => c.id === id)?.emoji || '').join(' ')
                                        : 'None selected yet'}
                                </Text>
                            </View>
                            <View style={styles.favSummaryEditBadge}>
                                <Text style={styles.favSummaryEditBtn}>⚙️ CUSTOMIZE</Text>
                            </View>
                        </View>
                    </Pressable>
                )
            )}

            {/* Freshness Social Proof Banner */}
            {shouldShowFreshBanner && (
                <Pressable
                    onPress={dismissFreshBanner}
                    style={({ pressed }) => [
                        styles.freshBanner,
                        pressed && { opacity: 0.7, transform: [{ scale: 0.98 }] }
                    ]}
                    accessibilityRole="button"
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 }}>
                        <Text style={{ fontSize: 20 }}>🔥</Text>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.freshBannerTitle}>
                                {freshTodayCount} fresh listing{freshTodayCount > 1 ? 's' : ''} posted today!
                            </Text>
                            <Text style={styles.freshBannerSub}>
                                Tap to dismiss • Scroll down to explore
                            </Text>
                        </View>
                    </View>
                    <View style={styles.liveBadge}>
                        <Text style={styles.liveBadgeText}>LIVE</Text>
                    </View>
                </Pressable>
            )}
        </View>
    );

    let listData: any[] = [];
    if (viewMode === 'grid') {
        listData = filteredPosts;
    } else {
        const today: any[] = [];
        const yesterday: any[] = [];
        const thisWeek: any[] = [];
        const older: any[] = [];

        const now = Date.now();
        filteredPosts.forEach(post => {
            const postTime = new Date(post.created_at || post.createdAt).getTime();
            const diffDays = Math.floor((now - postTime) / (24 * 60 * 60 * 1000));
            if (diffDays === 0) {
                today.push(post);
            } else if (diffDays === 1) {
                yesterday.push(post);
            } else if (diffDays < 7) {
                thisWeek.push(post);
            } else {
                older.push(post);
            }
        });

        if (filter === 'for-you') {
            if (filteredPosts.length > 0) {
                listData.push({ isHeader: true, title: '★ For You Feed', id: 'header-for-you' });
                listData.push(...filteredPosts);
            }
        } else {
            if (today.length > 0) {
                listData.push({ isHeader: true, title: 'Today', id: 'header-today' });
                listData.push(...today);
            }
            if (yesterday.length > 0) {
                listData.push({ isHeader: true, title: 'Yesterday', id: 'header-yesterday' });
                listData.push(...yesterday);
            }
            if (thisWeek.length > 0) {
                listData.push({ isHeader: true, title: 'This Week', id: 'header-thisweek' });
                listData.push(...thisWeek);
            }
            if (older.length > 0) {
                listData.push({ isHeader: true, title: 'Older Listings', id: 'header-older' });
                listData.push(...older);
            }
        }
    }

    const renderItem = ({ item }: { item: any }) => {
        if (item.isHeader) {
            return (
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionHeaderText}>{item.title.toUpperCase()}</Text>
                    <View style={styles.sectionHeaderLine} />
                </View>
            );
        }

        let coverImage: string | null = null;
        if (item.photos) {
            try {
                const arr = Array.isArray(item.photos) ? item.photos : JSON.parse(item.photos);
                if (arr.length > 0) coverImage = arr[0];
            } catch {}
        }

        const cardAuthor = item.author_callsign || item.author_pubkey?.slice(0, 6) || 'Unknown';
        const elderCard = isElder(item.author_energy_cycled);
        const isOwn = !!(identity?.publicKey && item.author_pubkey === identity.publicKey);
        
        const priceLabel = item.price_type === 'hourly' ? '/Hr' :
                           item.price_type === 'daily' ? '/Dy' :
                           item.price_type === 'weekly' ? '/Wk' :
                           item.price_type === 'monthly' ? '/Mo' : '';

        const catEmoji = categoryEmoji(item.category);
        const catLabel = categoryLabel(item.category);

        if (viewMode === 'grid') {
            return (
                <Pressable
                    style={[
                        styles.card,
                        styles.gridCard,
                        elderCard && styles.elderCard,
                    ]}
                    onPress={() => router.push(`/post/${item.id}`)}
                    accessibilityRole="button"
                >
                    <View style={styles.gridImageWrapper}>
                        {coverImage && typeof coverImage === 'string' && coverImage.trim() !== '' && coverImage !== 'null' && coverImage !== 'undefined' ? (
                            <Image source={{ uri: coverImage }} style={styles.gridImage} accessibilityLabel={item.title} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                        ) : (
                            <View style={[styles.gridImage, styles.gridFallback]}>
                                <Text style={styles.gridFallbackEmoji}>
                                    {catEmoji}
                                </Text>
                            </View>
                        )}
                        <View style={styles.gridPriceBadge}>
                            <CurrencyDisplay
                                amount={`${item.credits !== undefined && item.credits !== null ? item.credits : '?'}${priceLabel || ''}`}
                                style={styles.gridPriceText}
                                asView={true}
                            />
                        </View>
                        {!!item.repeatable && (
                            <View style={[styles.gridPriceBadge, { left: 8, right: undefined }]}>
                                <Text style={styles.gridPriceText}>↻ RECURRING</Text>
                            </View>
                        )}
                        {isOwn && (
                            <View style={[styles.gridPriceBadge, { left: !!item.repeatable ? 95 : 8, right: undefined, backgroundColor: '#2563eb' }]}>
                                <Text style={styles.gridPriceText}>👤 YOU</Text>
                            </View>
                        )}
                        <View style={[styles.gridTypeBadge, item.type === 'offer' ? styles.badgeOffer : styles.badgeNeed]}>
                            <Text style={[styles.badgeText, { color: item.type === 'offer' ? colors.market.offer.fg : colors.market.need.fg }]}>{item.type.toUpperCase()}</Text>
                        </View>
                    </View>
                    <View style={styles.gridTextContent}>
                        <Text style={styles.gridCardTitle} numberOfLines={1}>{item.title}</Text>
                        <PostAuthorTrust pubkey={item.author_pubkey} callsign={cardAuthor} energyCycled={item.author_energy_cycled} avatarUrl={item.author_avatar} mode="compact" isFounding={item.authorFoundingNeeded} />
                    </View>
                </Pressable>
            );
        }

        // Compact View
        if (viewMode === 'compact') {
            return (
                <Pressable accessibilityRole="button" onPress={() => router.push(`/post/${item.id}`)}>
                    <View style={[styles.compactRow, elderCard && styles.elderCompactRow]}>
                        <Text style={styles.compactEmoji}>
                            {catEmoji}
                        </Text>
                        <View style={{ flex: 1, marginLeft: 10, marginRight: 8, justifyContent: 'center' }}>
                            <Text style={styles.compactTitle} numberOfLines={1}>
                                {item.title}
                            </Text>
                            <Text style={styles.compactAuthor} numberOfLines={1}>
                                by {cardAuthor} {elderCard ? '⛰️' : ''} {isOwn ? '👤 (You)' : ''}
                            </Text>
                        </View>
                        <View style={{ alignItems: 'flex-end', justifyContent: 'center', gap: 4 }}>
                            <CurrencyDisplay
                                amount={`${item.credits !== undefined && item.credits !== null ? item.credits : '?'}${priceLabel || ''}`}
                                style={styles.compactPrice}
                                asView={true}
                            />
                            <View style={[
                                styles.compactBadge, 
                                item.type === 'offer' ? styles.compactBadgeOffer : styles.compactBadgeNeed
                            ]}>
                                <Text style={[
                                    styles.compactBadgeText, 
                                    { color: item.type === 'offer' ? colors.market.offer.fg : colors.market.need.fg }
                                ]}>
                                    {item.type.toUpperCase()}
                                </Text>
                            </View>
                        </View>
                    </View>
                </Pressable>
            );
        }

        // List View
        return (
            <Pressable accessibilityRole="button" onPress={() => router.push(`/post/${item.id}`)}>
                <View style={[styles.card, { flexDirection: 'row', padding: 0 }, elderCard && styles.elderCard]}>
                    {coverImage && typeof coverImage === 'string' && coverImage.trim() !== '' && coverImage !== 'null' && coverImage !== 'undefined' ? (
                        <Image source={{ uri: coverImage }} style={{ width: 96, height: '100%', minHeight: 96, borderTopLeftRadius: 14, borderBottomLeftRadius: 14 }} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                    ) : (
                        <View style={{ width: 96, height: '100%', minHeight: 96, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', borderTopLeftRadius: 14, borderBottomLeftRadius: 14 }}>
                            <Text style={{ fontSize: 32, opacity: 0.5 }}>
                                {catEmoji}
                            </Text>
                        </View>
                    )}
                    <View style={{ flex: 1, padding: 12, justifyContent: 'center' }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                                <View style={[styles.badge, item.type === 'offer' ? styles.badgeOffer : styles.badgeNeed, { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, margin: 0 }]}>
                                    <Text style={[styles.badgeText, { fontSize: 10, color: item.type === 'offer' ? colors.market.offer.fg : colors.market.need.fg }]}>{item.type.toUpperCase()}</Text>
                                </View>
                                {isOwn && (
                                    <View style={{ backgroundColor: '#dbeafe', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 }}>
                                        <Text style={{ fontSize: 10, fontWeight: '700', color: '#1e40af' }}>👤 YOU</Text>
                                    </View>
                                )}
                                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.text.secondary }}>
                                    {catEmoji} {catLabel}
                                </Text>
                                {!!item.repeatable && (
                                    <View style={{ backgroundColor: colors.surface.subtle, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, borderWidth: 1, borderColor: colors.border.default }}>
                                        <Text style={{ fontSize: 10, fontWeight: '700', color: colors.text.secondary }}>↻ RECURRING</Text>
                                    </View>
                                )}
                            </View>
                            <CurrencyDisplay
                                amount={`${item.credits !== undefined && item.credits !== null ? item.credits : '?'}${priceLabel || ''}`}
                                style={[styles.price, { fontSize: 16 }]}
                                asView={true}
                            />
                        </View>

                        <Text style={{ fontSize: 16, fontWeight: '900', color: colors.text.body, marginBottom: 4 }} numberOfLines={1}>
                            {item.title}
                        </Text>

                        <PostAuthorTrust pubkey={item.author_pubkey} callsign={cardAuthor} energyCycled={item.author_energy_cycled} avatarUrl={item.author_avatar} mode="full" isFounding={item.authorFoundingNeeded} />
                    </View>
                </View>
            </Pressable>
        );
    };

    return (
        <SafeAreaView style={styles.safeArea}>
            <View style={{ paddingTop: 8, paddingBottom: 0 }}>
                {HeaderComponent}
            </View>
            {showFirstOfferQuest && (
                <View style={{ marginHorizontal: 16, marginBottom: 8, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(245, 158, 11, 0.4)', backgroundColor: 'rgba(245, 158, 11, 0.10)', padding: 14 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                        <Text style={{ fontSize: 15, fontWeight: '800', color: colors.text.heading, flex: 1 }}>
                            🫘 Welcome{identity?.callsign ? `, ${identity.callsign}` : ''}! One step to unlock trading
                        </Text>
                        <Pressable onPress={dismissFirstOfferQuest} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dismiss">
                            <Text style={{ fontSize: 15, color: colors.text.secondary, fontWeight: '700', paddingLeft: 8 }}>✕</Text>
                        </Pressable>
                    </View>
                    <Text style={{ fontSize: 13.5, color: colors.text.body, lineHeight: 19, marginTop: 4 }}>
                        List one Offer — anything you can give: a skill, produce, tools, a lift. That unlocks accepting Offers and posting Needs.
                    </Text>
                    <Pressable
                        style={{ marginTop: 10, backgroundColor: palette.amber500, borderRadius: 10, paddingVertical: 10, alignItems: 'center' }}
                        onPress={() => router.push({ pathname: '/map', params: { newPost: 'true' } })}
                        accessibilityRole="button"
                    >
                        <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>➕ Post your first Offer</Text>
                    </Pressable>
                </View>
            )}
            <FlatList
                key={viewMode}
                numColumns={viewMode === 'grid' ? 2 : 1}
                data={listData}
                keyExtractor={item => item.id}
                renderItem={renderItem}
                contentContainerStyle={styles.listContent}
                columnWrapperStyle={viewMode === 'grid' ? styles.gridRow : undefined}
                showsVerticalScrollIndicator={false}
                onScroll={onScrollHandler}
                scrollEventThrottle={16}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        colors={[colors.brand.primary]}
                        tintColor={colors.brand.primary}
                    />
                }
                ListEmptyComponent={
                    (!hasActiveFilters && !firstSyncDone && !syncTimedOut) ? (
                        // First-run / initial sync — show a loader, not the empty state.
                        <View style={{ padding: 48, alignItems: 'center' }}>
                            <ActivityIndicator size="large" color={colors.brand.primary} />
                            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text.body, marginTop: 16 }}>
                                Loading the marketplace…
                            </Text>
                            <Text style={{ fontSize: 13, color: colors.text.secondary, marginTop: 4 }}>
                                Syncing with your community
                            </Text>
                        </View>
                    ) : (!hasActiveFilters && !firstSyncDone && syncTimedOut) ? (
                        // First sync hasn't landed — likely offline / node unreachable.
                        <View style={{ padding: 40, alignItems: 'center' }}>
                            <Text style={{ fontSize: 40, opacity: 0.3, marginBottom: 12 }}>📡</Text>
                            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text.body, marginBottom: 6 }}>
                                Having trouble connecting
                            </Text>
                            <Text style={{ fontSize: 13, color: colors.text.secondary, textAlign: 'center', marginBottom: 16 }}>
                                Couldn't reach your community node yet. Check your connection.
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                style={{ backgroundColor: colors.brand.primary, paddingHorizontal: 22, paddingVertical: 11, borderRadius: 12 }}
                                onPress={() => { setSyncTimedOut(false); requestSync(); setTimeout(() => setSyncTimedOut(true), 12000); }}
                            >
                                <Text style={{ fontWeight: '800', color: colors.text.inverse, fontSize: 14 }}>Retry</Text>
                            </Pressable>
                        </View>
                    ) : (
                    <View style={{ padding: 32, alignItems: 'center' }}>
                        <Text style={{ fontSize: 40, opacity: 0.3, marginBottom: 16 }}>🛒</Text>
                        <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text.body, marginBottom: 8 }}>
                            No items found
                        </Text>
                        <Text style={{ fontSize: 14, color: colors.text.secondary, textAlign: 'center', marginBottom: 20 }}>
                            {hasActiveFilters
                                ? 'Try adjusting your filters to see more results.'
                                : 'The market is quiet right now.'}
                        </Text>
                        {hasActiveFilters && (
                            <Pressable
                                accessibilityRole="button"
                                style={{ backgroundColor: colors.surface.subtle, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12, marginBottom: 12 }}
                                onPress={() => { setFilter('all'); setCategoryFilter('all'); setRadiusKm(null); setLocationCenter(null); setTrustFilter('all'); }}
                            >
                                <Text style={{ fontWeight: '700', color: palette.gray600, fontSize: 14 }}>Clear All Filters</Text>
                            </Pressable>
                        )}
                        <Pressable
                            accessibilityRole="button"
                            style={{ backgroundColor: palette.gray900, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12 }}
                            onPress={() => router.push({ pathname: '/map', params: { newPost: 'true' } })}
                        >
                            <Text style={{ fontWeight: '700', color: colors.text.inverse, fontSize: 14 }}>+ Post a Deal</Text>
                        </Pressable>
                    </View>
                    )
                }
            />
            <Pressable accessibilityRole="button" style={styles.fab} onPress={() => router.push({ pathname: '/map', params: { newPost: 'true' } })}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ color: colors.text.inverse, fontSize: 20, fontWeight: '400', marginTop: -2 }}>+</Text>
                    <Text style={{ color: colors.text.inverse, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 }}>ADD POST</Text>
                </View>
            </Pressable>

            <RadiusPickerModal
                visible={showRadiusPicker}
                initialRadius={radiusKm}
                initialLat={locationCenter?.lat}
                initialLng={locationCenter?.lng}
                onApply={(r, lat, lng) => {
                    setRadiusKm(r);
                    setLocationCenter({ lat, lng });
                    setShowRadiusPicker(false);
                }}
                onReset={() => {
                    setRadiusKm(null);
                    setLocationCenter(null);
                    setShowRadiusPicker(false);
                }}
                onCancel={() => setShowRadiusPicker(false)}
            />

            <CategoryPickerSheet
                visible={showCategoryPicker}
                selected={categoryFilter}
                onSelect={setCategoryFilter}
                onClose={() => setShowCategoryPicker(false)}
            />

            <TrustPickerSheet
                visible={showTrustPicker}
                selected={trustFilter}
                onSelect={setTrustFilter}
                onClose={() => setShowTrustPicker(false)}
            />

            <MyDealsSheet
                visible={showDealsSheet}
                identity={identity}
                onClose={() => setShowDealsSheet(false)}
                initialTab={dealsInitialTab}
            />
        </SafeAreaView>
    );
}

