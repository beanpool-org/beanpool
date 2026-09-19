import React, { useState, useEffect, useRef, useReducer, useCallback } from 'react';
import { StyleSheet, View, Text, FlatList, Animated, Pressable, useWindowDimensions, Platform, Alert, TextInput, ScrollView, DeviceEventEmitter, ActivityIndicator, RefreshControl } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { useFocusEffect, router, useLocalSearchParams } from 'expo-router';
import { getPosts, getMarketplaceTransactions, getBalance, fetchGroups, type GroupItem } from '../../utils/db';
import { getBlockedUsers, BLOCKLIST_UPDATED_EVENT } from '../../utils/blocklist';
import { requestSync, isPillarSyncActive, PILLAR_SYNC_ENDED } from '../../services/pillar-sync';
import { useIdentity } from '../IdentityContext';
import { RadiusPickerModal } from '../../components/RadiusPickerModal';
import { MyDealsSheet, usePendingDealsCount } from '../../components/MyDealsSheet';
import { PostAuthorTrust, isElder } from '../../components/PostAuthorTrust';
import { TrustPickerSheet, TRUST_FILTERS } from '../../components/TrustPickerSheet';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';
import { ActivityWaterfall } from '../../components/ActivityWaterfall';
import { categoryEmoji, categoryLabel } from '../../constants/categories';
import { palette } from '../../constants/colors';
import { useTheme, useStyles } from '../ThemeContext';
import { PollCard } from '../../components/PollCard';
import { NewPollModal } from '../../components/NewPollModal';
import { EventCard, EVENT_ACCENT } from '../../components/EventCard';
import { NewEventModal } from '../../components/NewEventModal';
import { NewPostTypeSheet } from '../../components/NewPostTypeSheet';
import { OwnerWordsPrompt } from '../../components/OwnerWordsPrompt';
import { PageTitle, useTabRetapScrollTop } from '../../components/PageTitle';
import { useQuickReturn, QuickReturnBlock, ActiveFilterChip } from '../../components/QuickReturn';
import { composeTargetFor } from '../../utils/compose-options';
import { EVENT_TYPES_QUERY, type EventWindow } from '../../utils/events';
import { FilterChipRow, FilterChipBar } from '../../components/FilterChipRow';
import { FilterChipButton, FilterChipPanel } from '../../components/FilterChipPicker';
import { CATEGORY_FILTER_CHIPS, categoryChipLabel, categoryPanelReducer } from '../../utils/map-filters';
import {
    MARKET_TYPE_PILLS, marketSecondRow, feedPostVisible, marketFiltersActive, marketFilterSummary, distanceChipLabel, trustChipLabel, beansChipLabel,
    type MarketTypeFilter, type MarketFilterState,
} from '../../utils/market-filters';
import { feedSections, localDaysAgo } from '../../utils/feed-sections';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SYNONYM_MAP as synonymMap } from '@beanpool/core';

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

// ⚡ Bolt: O(1) Map lookup for marketplace categories instead of repeated O(C) .find() scans
export const MARKETPLACE_CATEGORIES_BY_ID = new Map(MARKETPLACE_CATEGORIES.map(c => [c.id, c]));

const MIN_FEED_UNDER_PANEL = 48;

export default function MarketScreen() {
    const { theme, colors } = useTheme();
    // At 320dp with large text the field has room for one word; the long placeholder wrapped or was cut.
    const { width: winW, fontScale } = useWindowDimensions();
    const searchPlaceholder = winW / Math.min(fontScale, 1.3) < 360 ? 'Search' : 'Search marketplace...';
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
    const [filter, setFilter] = useState<MarketTypeFilter>('all');
    
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        safeArea: { flex: 1, backgroundColor: colors.surface.app },
        listContent: { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 100 },

        // Search row
        searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
        searchTarget: { flex: 1, minHeight: 48, justifyContent: 'center' },
        searchWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface.card, borderRadius: 20, paddingHorizontal: 14, height: 40, borderWidth: 1, borderColor: colors.border.default, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1 },
        searchInput: { flex: 1, marginLeft: 8, paddingVertical: 0, fontSize: 14, color: colors.text.body, fontWeight: '500', includeFontPadding: false, textAlignVertical: 'center' },
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
        pulseCard: {
            borderWidth: 2,
            borderColor: palette.amber400,
            backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : '#fffbeb',
            shadowColor: palette.amber500,
            shadowOpacity: 0.25,
            shadowRadius: 10,
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
        filterRow: { marginBottom: 4, borderWidth: 1, borderColor: colors.border.default, borderRadius: 26, overflow: 'hidden' },
        filterGrow: { flexGrow: 1 },
        typePill: { paddingHorizontal: 8 },
    }));

    const [trustFilter, setTrustFilter] = useState<string>('all');
    const [beansOnly, setBeansOnly] = useState(false);  // #108: hide listings that also need cash
    const [showTrustPicker, setShowTrustPicker] = useState(false);
    const [viewMode, setViewMode] = useState<'list' | 'grid' | 'compact'>('list');
    const [favCategories, setFavCategories] = useState<string[]>([]);
    const [isCustomizerExpanded, setIsCustomizerExpanded] = useState(true);

    // Fresh listings banner dismissal. The banner is the list's first row, so it scrolls away with it.
    const [dismissedFreshCount, setDismissedFreshCount] = useState<number>(0);
    const listRef = useRef<FlatList>(null);

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
    // First-run loading: until posts load or a pillar sync completes THIS session, show a
    // loading state rather than the "no items" empty state (which reads as broken/empty).
    const [firstSyncDone, setFirstSyncDone] = useState(false);
    const [syncTimedOut, setSyncTimedOut] = useState(false);
    const [searchResults, setSearchResults] = useState<any[] | null>(null);
    const [isSearching, setIsSearching] = useState(false);
    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /**
     * The category chip and its panel of tiles — the map's (utils/map-filters.ts), so picking a tile applies
     * it and closes the panel in one step. The panel opens under the filter bar and pushes the list down.
     */
    const [categoryPanel, dispatchCategoryPanel] = useReducer(categoryPanelReducer, { category: 'all', open: false });
    const categoryFilter = categoryPanel.category;
    const closeCategoryPanel = () => dispatchCategoryPanel({ kind: 'dismiss' });
    // Leaving the tab closes it, so coming back to the Market shows the feed, not the panel.
    useFocusEffect(useCallback(() => () => dispatchCategoryPanel({ kind: 'dismiss' }), []));
    const [eventWindow, setEventWindow] = useState<EventWindow>('all');
    const selectType = (t: MarketTypeFilter) => {
        setFilter(t);
        // Polls and Events have no category chip, so an open panel goes with it.
        const row = marketSecondRow(t);
        if (row.kind !== 'filters' || !row.category) closeCategoryPanel();
    };
    /**
     * The open panel pushes the list down. It may grow until MIN_FEED_UNDER_PANEL of the list is left under
     * it — one touch-height strip to tap to close, and a sight of the feed they will return to; past that its
     * tiles scroll inside it.
     */
    const [screenH, setScreenH] = useState(0);
    const [filterBlockY, setFilterBlockY] = useState(0);
    const [filterRowsBottom, setFilterRowsBottom] = useState(0);
    const searchInputRef = useRef<TextInput>(null);
    const [searchFocused, setSearchFocused] = useState(false);
    /**
     * The title and the controls (search, type pills, filter row, group pills) ride away as the feed scrolls
     * down and come back on any scroll up (components/QuickReturn). They stay while in use: the category
     * panel open, or the search field focused (typing narrows the list under the keyboard).
     */
    const qr = useQuickReturn({ pinned: categoryPanel.open || searchFocused, resetKey: viewMode });
    // Tapping Market again scrolls to the top, and brings the controls with it.
    useTabRetapScrollTop(listRef, qr.show);
    // Measured with the title showing: at worst that leaves the panel a title's height shorter than it could be.
    const rowsBottom = qr.titleHeight + filterBlockY + filterRowsBottom;
    const panelMaxHeight = screenH && filterRowsBottom ? Math.max(120, screenH - rowsBottom - 6 - MIN_FEED_UNDER_PANEL) : undefined;
    const [groupFilter, setGroupFilter] = useState('all');
    const [userGroups, setUserGroups] = useState<GroupItem[]>([]);
    const [radiusKm, setRadiusKm] = useState<number | null>(null);
    const [locationCenter, setLocationCenter] = useState<{lat: number, lng: number} | null>(null);
    const [showRadiusPicker, setShowRadiusPicker] = useState(false);
    
    // Deals Sheet
    const [showDealsSheet, setShowDealsSheet] = useState(false);
    const [dealsInitialTab, setDealsInitialTab] = useState<'active' | 'pending' | 'history'>('pending');
    const [showNewPollModal, setShowNewPollModal] = useState(false);
    const [showNewEventModal, setShowNewEventModal] = useState(false);
    // For the distance on event cards. Read only when location is already allowed; the feed never prompts.
    const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);
    const [showNewPostTypePicker, setShowNewPostTypePicker] = useState(false);
    const [myTransactions, setMyTransactions] = useState<any[]>([]);

    const pendingCount = usePendingDealsCount(identity, posts, myTransactions);

    useEffect(() => {
        let cancelled = false;
        Location.getForegroundPermissionsAsync()
            .then(async ({ status }) => {
                if (status !== 'granted') return;
                const last = await Location.getLastKnownPositionAsync();
                if (!cancelled && last) setMyLocation({ lat: last.coords.latitude, lng: last.coords.longitude });
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        fetchGroups().then(groups => {
            const active = groups.filter(g => g.viewerStatus === 'active');
            setUserGroups(active);
        }).catch(console.error);
    }, [identity?.publicKey]);

    useEffect(() => {
        getBlockedUsers().then(setBlockedUsers);
        const sub = DeviceEventEmitter.addListener(BLOCKLIST_UPDATED_EVENT, (newList) => {
            setBlockedUsers(newList);
        });
        return () => sub.remove();
    }, []);

    useFocusEffect(
        React.useCallback(() => {
            loadPosts();
        }, [filter, groupFilter, identity?.publicKey])
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
        // Data changed on SOME sync path (messages, balance, or marketplace) → refresh the
        // list. This does NOT mean the marketplace itself has finished loading: a fast
        // messages/balance sync fires this too (and does so even with zero messages), so
        // flipping the loading gate here was showing a false "No items found" before the
        // marketplace posts had actually landed.
        const sub = DeviceEventEmitter.addListener('sync_data_updated', () => {
            loadPosts();
        });
        // Only a COMPLETED pillar sync fetches and writes the marketplace posts, so this is
        // the signal that dismisses the spinner. If the market is genuinely empty the list
        // stays empty and now correctly shows "No items found"; if there are posts, the
        // fast-first-paint 'sync_data_updated' above will already have rendered them.
        const doneSub = DeviceEventEmitter.addListener('pillar_sync_done', () => {
            // Load the freshly-synced posts BEFORE flipping the gate, so the empty state can
            // never flash in the window between "sync completed" and "posts rendered". If the
            // market has posts they're in state before firstSyncDone turns true; only a truly
            // empty market then shows "No items found". Only dismiss the spinner if the load
            // actually succeeded — a transient failure (e.g. DB closing mid wipe/restore) keeps
            // the spinner so the 12s fallback retries instead of flashing "No items found".
            loadPosts().then((ok) => {
                if (ok) {
                    setSyncTimedOut(false);
                    setFirstSyncDone(true);
                }
            });
        });
        return () => { sub.remove(); doneSub.remove(); };
    }, [filter, identity?.publicKey]);

    // Arm a retry fallback so a flaky connection never leaves an infinite spinner.
    // We deliberately do NOT dismiss the spinner from a stored last-sync timestamp:
    // after a recovery/restore the local posts table can be empty while that cursor
    // still exists (clearDB drops the table but not the AsyncStorage cursor), which
    // showed a false "No items found". The spinner is dismissed only when posts
    // actually load (list becomes non-empty) or a pillar sync completes this session.
    //
    // "Having trouble connecting" is a verdict, so it waits for one: after 12s it shows only if no
    // sync is queued or running, or once a sync cycle actually ends in failure. A first sync that is
    // still downloading on a slow connection keeps the loader (it used to flash the banner, then
    // the listings arrived a moment later). A real failure — offline, node down, a request timing
    // out — still ends the cycle unsuccessfully and shows the banner.
    const syncWaitElapsedRef = useRef(false);
    const syncWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const armSyncWait = React.useCallback(() => {
        syncWaitElapsedRef.current = false;
        setSyncTimedOut(false);
        if (syncWaitTimerRef.current) clearTimeout(syncWaitTimerRef.current);
        syncWaitTimerRef.current = setTimeout(() => {
            syncWaitElapsedRef.current = true;
            if (!isPillarSyncActive()) setSyncTimedOut(true);
        }, 12000);
    }, []);
    useEffect(() => {
        armSyncWait();
        const endedSub = DeviceEventEmitter.addListener(PILLAR_SYNC_ENDED, (e?: { success?: boolean }) => {
            if (syncWaitElapsedRef.current && !e?.success) setSyncTimedOut(true);
        });
        return () => {
            endedSub.remove();
            if (syncWaitTimerRef.current) clearTimeout(syncWaitTimerRef.current);
        };
    }, [armSyncWait]);

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
                // Events are opt-in on the list route; All and Events ask for them.
                const type = filter === 'all' ? `&${EVENT_TYPES_QUERY}` : filter === 'for-you' ? '' : filter === 'needs' ? '&type=need' : filter === 'polls' ? '&type=poll' : filter === 'events' ? '&type=event' : '&type=offer';
                // Only while the category chip is on screen (not under Polls or Events).
                const row = marketSecondRow(filter);
                const cat = categoryFilter !== 'all' && row.kind === 'filters' && row.category ? `&category=${categoryFilter}` : '';
                
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
                            // #108: the server returns camelCase `cashAlsoNeeded`; local SQLite rows carry
                            // snake_case 0/1. Normalise here — the same place the other mixed-casing fields
                            // are reconciled — so the beans-only filter AND the card badge both keep working
                            // while a server search is active. Guarding at each call site instead would leave
                            // the next reader to rediscover this.
                            cash_also_needed: p.cash_also_needed ?? (p.cashAlsoNeeded ? 1 : 0),
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

    const loadPosts = async (): Promise<boolean> => {
        const queryFilter: any = { includeEvents: true };
        if (filter !== 'all' && filter !== 'for-you') {
            queryFilter.type = filter === 'needs' ? 'need' : filter === 'offers' ? 'offer' : filter === 'events' ? 'event' : 'poll';
        }
        if (groupFilter !== 'all') {
            queryFilter.targetGroupId = groupFilter;
        }
        const runLoad = async () => {
            const data = await getPosts(queryFilter);
            setPosts(data);
            if (identity) {
                const txs = await getMarketplaceTransactions(identity.publicKey);
                setMyTransactions(txs);
            }
        };
        try {
            await runLoad();
            return true;
        } catch (e: any) {
            if (e?.message?.includes('closed') || String(e).includes('closed')) {
                // Database was closing or re-initializing during a wipe/restore transition.
                // Retry the WHOLE load (posts and transactions) once with a fresh connection —
                // reloading posts alone left myTransactions / the pending-deals badge stale.
                try {
                    await runLoad();
                    return true;
                } catch (retryErr) {
                    console.error('Failed to reload marketplace after DB reconnect', retryErr);
                    return false;
                }
            } else {
                console.error('Failed to query SQLite Posts', e);
                return false;
            }
        }
    };

    const loadBlockedUsers = async () => {
        const list = await getBlockedUsers();
        setBlockedUsers(list);
    };



    // Use server search results when available, otherwise filter locally
    const basePosts = searchResults !== null ? searchResults : posts;

    const filterState: MarketFilterState = {
        type: filter, category: categoryFilter, eventWindow, trust: trustFilter, beansOnly, radiusKm, center: locationCenter, groupId: groupFilter,
    };
    const secondRow = marketSecondRow(filter);
    // The second row's chips fill with the type's colour, as the map's category chip does.
    // Fill for the selected type pill, each carrying white text; the map's colours for Offers / Needs / Events.
    const typeColors: Record<MarketTypeFilter, string> = {
        all: theme === 'dark' ? palette.gray600 : palette.gray800,
        'for-you': colors.accent.primary,
        offers: '#10b981',
        needs: '#ea580c',
        events: EVENT_ACCENT,
        polls: '#7c3aed',
    };
    const filterColor = filter === 'offers' || filter === 'needs' ? typeColors[filter] : colors.brand.dark;
    const filterCtx = { blockedUsers, favCategories };

    let filteredPosts = basePosts.filter(p => {
        // Type pills, the category chip, the date chips, Distance, Trust, Beans only, groups (utils/market-filters.ts)
        if (!feedPostVisible(p, filterState, filterCtx)) return false;

        // Goods search isolation: searching marketplace keywords must not return polls unless explicitly filtered
        if (searchQuery.trim() && p.type === 'poll' && filter !== 'polls') return false;

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

    // Maintainer rule: Daily Pulse appears ONLY where marketplace has fewer than 2 listings (< 2).
    const realMemberListingsCount = posts.filter(p => {
        const isPulse = (p.author_callsign || p.authorCallsign) === 'Daily Pulse' && !p.origin_node && !p.originNode;
        return !isPulse && p.type !== 'poll' && p.type !== 'event' && p.status === 'active';
    }).length;
    if (realMemberListingsCount >= 2) {
        filteredPosts = filteredPosts.filter(p => !((p.author_callsign || p.authorCallsign) === 'Daily Pulse' && !p.origin_node && !p.originNode));
    }

    // Pin Daily Pulse to the top of the feed (local only)
    filteredPosts.sort((a, b) => {
        const isPulseA = (a.author_callsign || a.authorCallsign) === 'Daily Pulse' && !a.origin_node && !a.originNode;
        const isPulseB = (b.author_callsign || b.authorCallsign) === 'Daily Pulse' && !b.origin_node && !b.originNode;
        if (isPulseA && !isPulseB) return -1;
        if (!isPulseA && isPulseB) return 1;
        return 0;
    });

    const selectedTrustFilter = TRUST_FILTERS.find(f => f.id === trustFilter);
    const hasActiveFilters = marketFiltersActive(filterState) || searchQuery.trim().length > 0;

    // Listings posted today, by the local calendar day the TODAY heading uses; events are not listings.
    const freshTodayCount = posts.filter(post => {
        if (post.status !== 'active' || post.type === 'event') return false;
        const postTime = new Date(post.created_at || post.createdAt).getTime();
        return Number.isFinite(postTime) && localDaysAgo(postTime, Date.now()) === 0;
    }).length;

    // Display banner only if fresh postings count is greater than the dismissed count
    const shouldShowFreshBanner = freshTodayCount > 0 && freshTodayCount > dismissedFreshCount;

    const dismissFreshBanner = async () => {
        const { LayoutAnimation } = require('react-native');
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setDismissedFreshCount(freshTodayCount);
        try {
            await AsyncStorage.setItem('bp_dismissed_fresh_count', String(freshTodayCount));
        } catch (e) {}
    };

    // The block that rides over the top of the feed (components/QuickReturn): search row, type pills, filter row
    // and group pills. Everything else above the listings is the list's own header and scrolls with it.
    const controls = (
        <View style={{ paddingBottom: 2 }}>
            {/* Top row: Search + My Deals + View Toggle. The field is 40dp to look at, inside a 48dp target
                that focuses it; its text is capped at 1.3x so the placeholder is never cut top and bottom. */}
            <View style={[styles.searchRow, { paddingHorizontal: 16 }]}>
                <Pressable
                    style={styles.searchTarget}
                    onPress={() => searchInputRef.current?.focus()}
                    accessible={false}
                >
                <View style={styles.searchWrap}>
                    <Text style={{ opacity: 0.4, fontSize: 14 }} maxFontSizeMultiplier={1.3}>🔍</Text>
                    <TextInput
                        ref={searchInputRef}
                        style={styles.searchInput}
                        placeholder={searchPlaceholder}
                        placeholderTextColor={colors.text.muted}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        numberOfLines={1}
                        onFocus={() => setSearchFocused(true)}
                        onBlur={() => setSearchFocused(false)}
                        returnKeyType="search"
                        maxFontSizeMultiplier={1.3}
                        accessibilityLabel="Search marketplace"
                    />
                </View>
                </Pressable>
                <Pressable
                    onPress={() => setShowDealsSheet(true)}
                    style={styles.dealsIconBtn}
                    accessibilityRole="button"
                    accessibilityLabel={pendingCount > 0 ? `My Deals, ${pendingCount} pending` : 'My Deals'}
                    accessibilityHint="Opens your active and pending deals sheet"
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

            {/* The map's filter shape (utils/market-filters.ts): the type row, and under it one row that stays in
                the same place and changes with the type — the category chip and the feed's own filters, or the
                event date chips under Events. The category panel opens under it, full width. */}
            <View style={{ paddingHorizontal: 16, marginTop: 0 }} onLayout={e => setFilterBlockY(e.nativeEvent.layout.y)}>
                <View onLayout={e => setFilterRowsBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
                <FilterChipRow
                    chips={MARKET_TYPE_PILLS}
                    selected={filter}
                    onSelect={selectType}
                    activeColor={typeColors[filter]}
                    fill
                    // One line that scrolls sideways at 320dp + 1.3x text (wrapping cost a second 38dp line).
                    moreHint
                    // 8dp sides, not 12: the six pills fit one line on a normal phone (~338dp of 379).
                    chipStyle={styles.typePill}
                    style={styles.filterRow}
                    accessibilityLabel="Show"
                />

                {secondRow.kind === 'eventWindows' ? (
                    <FilterChipRow
                        key="eventWindows"
                        chips={secondRow.chips}
                        selected={eventWindow}
                        onSelect={setEventWindow}
                        activeColor={EVENT_ACCENT}
                        fill
                        moreHint
                        style={styles.filterRow}
                        accessibilityLabel="Filter events by date"
                    />
                ) : (
                    <FilterChipBar key="filters" fill moreHint style={styles.filterRow} accessibilityLabel="Filters">
                        {secondRow.category && (
                            <FilterChipButton
                                variant="flat"
                                label={categoryChipLabel(categoryFilter, categoryPanel.open)}
                                active={categoryFilter !== 'all'}
                                activeColor={filterColor}
                                expanded={categoryPanel.open}
                                onPress={() => dispatchCategoryPanel({ kind: 'toggle' })}
                                accessibilityLabel="Filter by category"
                                style={styles.filterGrow}
                            />
                        )}
                        {secondRow.extras.includes('distance') && (
                            <FilterChipButton
                                variant="flat"
                                label={distanceChipLabel(radiusKm)}
                                active={radiusKm !== null}
                                activeColor={filterColor}
                                onPress={() => { closeCategoryPanel(); setShowRadiusPicker(true); }}
                                accessibilityLabel="Filter by distance"
                                style={styles.filterGrow}
                            />
                        )}
                        {secondRow.extras.includes('trust') && (
                            <FilterChipButton
                                variant="flat"
                                label={trustChipLabel(selectedTrustFilter)}
                                active={trustFilter !== 'all'}
                                activeColor={filterColor}
                                onPress={() => { closeCategoryPanel(); setShowTrustPicker(true); }}
                                accessibilityLabel="Filter by trust level"
                                style={styles.filterGrow}
                            />
                        )}
                        {/* #108 Beans-only filter — a toggle, not a picker, so it needs no sheet. */}
                        {secondRow.extras.includes('beans') && (
                            <FilterChipButton
                                variant="flat"
                                label={beansChipLabel(beansOnly)}
                                active={beansOnly}
                                selected={beansOnly}
                                activeColor={filterColor}
                                onPress={() => { closeCategoryPanel(); setBeansOnly(!beansOnly); }}
                                accessibilityLabel="Show only listings that need no cash"
                                style={styles.filterGrow}
                            />
                        )}
                    </FilterChipBar>
                )}
                </View>

                {/* Row 4: Group Filter Chips (Item 10) */}
                {userGroups.length > 0 && (
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{ gap: 8, paddingVertical: 6 }}
                    >
                        <Pressable
                            onPress={() => setGroupFilter('all')}
                            style={[styles.chip, groupFilter === 'all' && styles.chipActive]}
                            accessibilityRole="button"
                            accessibilityState={{ selected: groupFilter === 'all' }}
                        >
                            <Text style={[styles.chipText, groupFilter === 'all' && styles.chipTextActive]}>
                                👥 All Groups & Public
                            </Text>
                        </Pressable>
                        {userGroups.map((g) => {
                            const isSelected = groupFilter === g.id;
                            return (
                                <Pressable
                                    key={g.id}
                                    onPress={() => setGroupFilter(isSelected ? 'all' : g.id)}
                                    style={[
                                        styles.chip,
                                        isSelected && { backgroundColor: colors.brand.primary, borderColor: colors.brand.primary }
                                    ]}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: isSelected }}
                                >
                                    <Text style={[styles.chipText, isSelected && styles.chipTextActive]}>
                                        👥 {g.name}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </ScrollView>
                )}
            </View>

        </View>
    );

    // The category tiles open over the feed from under the filter row, covering the group pills, so opening
    // them never moves the list.
    const categoryPanelOverlay = (
        <View style={{ position: 'absolute', left: 0, right: 0, top: rowsBottom, paddingHorizontal: 16 }}>
            {categoryPanel.open && secondRow.kind === 'filters' && secondRow.category && (
                <FilterChipPanel
                    chips={CATEGORY_FILTER_CHIPS}
                    selected={categoryFilter}
                    onSelect={(id) => dispatchCategoryPanel({ kind: 'pick', category: id })}
                    activeColor={filterColor}
                    panelMaxHeight={panelMaxHeight}
                    // The map's 8dp gutter, not the feed's 16: four tiles a row at 320dp + 1.3x, not three.
                    style={{ marginHorizontal: -8 }}
                />
            )}
        </View>
    );

    const filterSummary = marketFilterSummary(filterState, searchQuery, {
        trustLabel: id => TRUST_FILTERS.find(t => t.id === id)?.label,
        groupName: id => userGroups.find(g => g.id === id)?.name,
    });
    const clearAllFilters = () => {
        setSearchQuery('');
        setFilter('all');
        dispatchCategoryPanel({ kind: 'pick', category: 'all' });
        setEventWindow('all');
        setRadiusKm(null);
        setLocationCenter(null);
        setTrustFilter('all');
        setBeansOnly(false);
        setGroupFilter('all');
    };
    const showControls = () => {
        qr.show();
        // A search is what the member most likely came back to change.
        if (searchQuery.trim()) searchInputRef.current?.focus();
    };

    // Out of the list's 16dp gutter: these rows bring their own 16dp margins, as they did above the list.
    const ListHeader = (
        <View style={{ marginHorizontal: -16 }}>
            {showFirstOfferQuest && !categoryPanel.open && (
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
            {/* Interests Tag Cloud when in For You mode */}
            {filter === 'for-you' && !categoryPanel.open && (
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
                                        ? favCategories.map(id => MARKETPLACE_CATEGORIES_BY_ID.get(id)?.emoji || '').join(' ')
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

            {/* Owners only, on its own cadence, always dismissible: "Check your 12 words" (sealed-keys.md §7). */}
            {!categoryPanel.open && <OwnerWordsPrompt />}
            {/* Freshness Social Proof Banner */}
            {shouldShowFreshBanner && !categoryPanel.open && (
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
        if (filter === 'for-you') {
            if (filteredPosts.length > 0) {
                listData.push({ isHeader: true, title: '★ For You Feed', id: 'header-for-you' });
                listData.push(...filteredPosts);
            }
        } else {
            // Events under their own heading, soonest first; listings by the local day they were posted.
            for (const section of feedSections(filteredPosts)) {
                listData.push({ isHeader: true, title: section.title, id: section.id });
                listData.push(...section.posts);
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

        if (item.type === 'event') {
            return (
                <EventCard
                    post={item}
                    currentPubkey={identity?.publicKey}
                    myLocation={myLocation}
                    onRsvpChanged={() => loadPosts()}
                />
            );
        }

        if (item.type === 'poll') {
            return (
                <PollCard
                    post={item}
                    currentPubkey={identity?.publicKey}
                    onVoteSuccess={() => loadPosts()}
                />
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
        const isPulse = (item.author_callsign || item.authorCallsign) === 'Daily Pulse';
        const elderCard = !isPulse && isElder(item.author_energy_cycled);
        const isOwn = !isPulse && !!(identity?.publicKey && item.author_pubkey === identity.publicKey);
        const isGroupScope = item.audience_scope === 'group' || item.audienceScope === 'group' || !!item.target_group_id || !!item.targetGroupId;
        const groupName = item.target_group_name || item.targetGroupName || 'Group';
        const groupScopeBadgeText = isGroupScope ? `🔒 Only ${groupName} can see this` : null;

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
                        isPulse && styles.pulseCard,
                    ]}
                    disabled={isPulse}
                    onPress={isPulse ? undefined : () => router.push(`/post/${item.id}`)}
                    accessibilityRole={isPulse ? undefined : "button"}
                >
                    <View style={styles.gridImageWrapper}>
                        {coverImage && typeof coverImage === 'string' && coverImage.trim() !== '' && coverImage !== 'null' && coverImage !== 'undefined' ? (
                            <Image source={{ uri: coverImage }} style={styles.gridImage} accessibilityLabel={item.title} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                        ) : (
                            <View style={[styles.gridImage, styles.gridFallback]}>
                                <Text style={styles.gridFallbackEmoji}>
                                    {isPulse ? '🗞️' : catEmoji}
                                </Text>
                            </View>
                        )}
                        {!isPulse && (
                            <View style={styles.gridPriceBadge}>
                                <CurrencyDisplay
                                    amount={`${item.credits !== undefined && item.credits !== null ? item.credits : '?'}${priceLabel || ''}`}
                                    style={styles.gridPriceText}
                                    asView={true}
                                />
                            </View>
                        )}
                        {isPulse && (
                            <View style={[
                                styles.gridPriceBadge,
                                {
                                    left: 8,
                                    right: undefined,
                                    backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : '#fef3c7',
                                    borderColor: theme === 'dark' ? colors.feedback.warning.border : '#f59e0b',
                                    borderWidth: 1,
                                }
                            ]}>
                                <Text style={[styles.gridPriceText, { color: theme === 'dark' ? colors.feedback.warning.fg : '#92400e', fontWeight: '900' }]}>🗞️ PULSE</Text>
                            </View>
                        )}
                        {!!item.repeatable && !isPulse && (
                            <View style={[styles.gridPriceBadge, { left: 8, right: undefined }]}>
                                <Text style={styles.gridPriceText}>↻ RECURRING</Text>
                            </View>
                        )}
                        {isOwn && (
                            <View style={[styles.gridPriceBadge, { left: item.repeatable ? 95 : 8, right: undefined, backgroundColor: '#2563eb' }]}>
                                <Text style={styles.gridPriceText}>👤 YOU</Text>
                            </View>
                        )}
                        {!isPulse && (
                            <View style={[styles.gridTypeBadge, item.type === 'offer' ? styles.badgeOffer : styles.badgeNeed]}>
                                <Text style={[styles.badgeText, { color: item.type === 'offer' ? colors.market.offer.fg : colors.market.need.fg }]}>{item.type.toUpperCase()}</Text>
                            </View>
                        )}
                    </View>
                    <View style={styles.gridTextContent}>
                        <Text style={styles.gridCardTitle} numberOfLines={1}>
                            {item.cash_also_needed === 1 ? '💸 ' : ''}{item.title}
                        </Text>
                        <PostAuthorTrust pubkey={item.author_pubkey} callsign={cardAuthor} energyCycled={item.author_energy_cycled} avatarUrl={item.author_avatar} mode="compact" isFounding={item.authorFoundingNeeded} />
                        {groupScopeBadgeText && (
                            <View style={{ marginTop: 4, alignSelf: 'flex-start', backgroundColor: colors.brand.tint, borderColor: colors.brand.primary, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                                <Text style={{ fontSize: 9, fontWeight: '800', color: colors.brand.primary }} numberOfLines={1}>
                                    {groupScopeBadgeText}
                                </Text>
                            </View>
                        )}
                    </View>
                </Pressable>
            );
        }

        // Compact View
        if (viewMode === 'compact') {
            return (
                <Pressable
                    disabled={isPulse}
                    accessibilityRole={isPulse ? undefined : "button"}
                    onPress={isPulse ? undefined : () => router.push(`/post/${item.id}`)}
                >
                    <View style={[styles.compactRow, elderCard && styles.elderCompactRow, isPulse && styles.pulseCard]}>
                        <Text style={styles.compactEmoji}>
                            {catEmoji}
                        </Text>
                        <View style={{ flex: 1, marginLeft: 10, marginRight: 8, justifyContent: 'center' }}>
                            <Text style={styles.compactTitle} numberOfLines={1}>
                                {item.cash_also_needed === 1 ? '💸 ' : ''}{item.title}
                            </Text>
                            <Text style={styles.compactAuthor} numberOfLines={1}>
                                by {cardAuthor} {elderCard ? '⛰️' : ''} {isOwn ? '👤 (You)' : ''}
                            </Text>
                            {groupScopeBadgeText && (
                                <View style={{ marginTop: 2, alignSelf: 'flex-start', backgroundColor: colors.brand.tint, borderColor: colors.brand.primary, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
                                    <Text style={{ fontSize: 9, fontWeight: '800', color: colors.brand.primary }} numberOfLines={1}>
                                        {groupScopeBadgeText}
                                    </Text>
                                </View>
                            )}
                        </View>
                        <View style={{ alignItems: 'flex-end', justifyContent: 'center', gap: 4 }}>
                            {!isPulse && (
                                <CurrencyDisplay
                                    amount={`${item.credits !== undefined && item.credits !== null ? item.credits : '?'}${priceLabel || ''}`}
                                    style={styles.compactPrice}
                                    asView={true}
                                />
                            )}
                            <View style={[
                                styles.compactBadge, 
                                isPulse ? {
                                    backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : '#fef3c7',
                                    borderColor: theme === 'dark' ? colors.feedback.warning.border : '#f59e0b',
                                    borderWidth: 1,
                                } : (item.type === 'offer' ? styles.compactBadgeOffer : styles.compactBadgeNeed)
                            ]}>
                                <Text style={[
                                    styles.compactBadgeText, 
                                    {
                                        color: isPulse ? (theme === 'dark' ? colors.feedback.warning.fg : '#92400e') : (item.type === 'offer' ? colors.market.offer.fg : colors.market.need.fg),
                                        fontWeight: '800',
                                    }
                                ]}>
                                    {isPulse ? 'PULSE' : item.type.toUpperCase()}
                                </Text>
                            </View>
                        </View>
                    </View>
                </Pressable>
            );
        }

        // List View
        return (
            <Pressable
                disabled={isPulse}
                accessibilityRole={isPulse ? undefined : "button"}
                onPress={isPulse ? undefined : () => router.push(`/post/${item.id}`)}
            >
                <View style={[styles.card, { flexDirection: 'row', padding: 0 }, elderCard && styles.elderCard, isPulse && styles.pulseCard]}>
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
                                {!isPulse && (
                                    <View style={[styles.badge, item.type === 'offer' ? styles.badgeOffer : styles.badgeNeed, { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, margin: 0 }]}>
                                        <Text style={[styles.badgeText, { fontSize: 10, color: item.type === 'offer' ? colors.market.offer.fg : colors.market.need.fg }]}>{item.type.toUpperCase()}</Text>
                                    </View>
                                )}
                                {isPulse && (
                                    <View style={{
                                        backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : '#fef3c7',
                                        paddingHorizontal: 6,
                                        paddingVertical: 2,
                                        borderRadius: 8,
                                        borderWidth: 1,
                                        borderColor: theme === 'dark' ? colors.feedback.warning.border : '#f59e0b'
                                    }}>
                                        <Text style={{
                                            fontSize: 10,
                                            fontWeight: '800',
                                            color: theme === 'dark' ? colors.feedback.warning.fg : '#92400e'
                                        }}>🗞️ DAILY PULSE</Text>
                                    </View>
                                )}
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
                                {/* #108: on the card, not just the detail view */}
                                {item.cash_also_needed === 1 && (
                                    <View style={{ backgroundColor: colors.feedback.warning.bg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, borderWidth: 1, borderColor: colors.feedback.warning.border }}>
                                        <Text style={{ fontSize: 10, fontWeight: '700', color: colors.feedback.warning.fg }}>💸 CASH TOO</Text>
                                    </View>
                                )}
                                {groupScopeBadgeText && (
                                    <View style={{ backgroundColor: colors.brand.tint, borderColor: colors.brand.primary, borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 }}>
                                        <Text style={{ fontSize: 10, fontWeight: '800', color: colors.brand.primary }}>
                                            {groupScopeBadgeText}
                                        </Text>
                                    </View>
                                )}
                            </View>
                            {!isPulse && (
                                <CurrencyDisplay
                                    amount={`${item.credits !== undefined && item.credits !== null ? item.credits : '?'}${priceLabel || ''}`}
                                    style={[styles.price, { fontSize: 16 }]}
                                    asView={true}
                                />
                            )}
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
        <View style={styles.safeArea} onLayout={e => setScreenH(e.nativeEvent.layout.height)}>
            {/* The feed and, riding over its top, the controls. Clipped, so the block slides up under the tab bar. */}
            <View style={{ flex: 1, overflow: 'hidden' }}>
            <QuickReturnBlock qr={qr} title={<PageTitle title="Market" testID="page-title-market" />} below={categoryPanelOverlay}>
                {controls}
            </QuickReturnBlock>
            <Animated.FlatList
                ref={listRef}
                key={viewMode}
                numColumns={viewMode === 'grid' ? 2 : 1}
                data={listData}
                keyExtractor={(item: any) => item.id}
                renderItem={renderItem}
                ListHeaderComponent={ListHeader}
                contentContainerStyle={[styles.listContent, { paddingTop: qr.listInset }]}
                columnWrapperStyle={viewMode === 'grid' ? styles.gridRow : undefined}
                showsVerticalScrollIndicator={false}
                {...qr.listProps}
                keyboardShouldPersistTaps="handled"
                // Dragging the feed puts the keyboard away and blurs the search, which lets the controls go again.
                keyboardDismissMode="on-drag"
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        colors={[colors.brand.primary]}
                        tintColor={colors.brand.primary}
                        // Below the controls, not behind them.
                        progressViewOffset={qr.listInset}
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
                                onPress={() => { armSyncWait(); requestSync(); }}
                            >
                                <Text style={{ fontWeight: '800', color: colors.text.inverse, fontSize: 14 }}>Retry</Text>
                            </Pressable>
                        </View>
                    ) : !hasActiveFilters ? (
                        <ActivityWaterfall onCreatePostPress={() => router.push({ pathname: '/map', params: { newPost: 'true' } })} />
                    ) : (
                    <View style={{ padding: 32, alignItems: 'center' }}>
                        <Text style={{ fontSize: 40, opacity: 0.3, marginBottom: 16 }}>🛒</Text>
                        <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text.body, marginBottom: 8 }}>
                            No items found
                        </Text>
                        <Text style={{ fontSize: 14, color: colors.text.secondary, textAlign: 'center', marginBottom: 20 }}>
                            Try adjusting your filters to see more results.
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            style={{ backgroundColor: colors.surface.subtle, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12, marginBottom: 12 }}
                            onPress={() => { setFilter('all'); dispatchCategoryPanel({ kind: 'pick', category: 'all' }); setEventWindow('all'); setRadiusKm(null); setLocationCenter(null); setTrustFilter('all'); setBeansOnly(false); setGroupFilter('all'); }}
                        >
                            <Text style={{ fontWeight: '700', color: palette.gray600, fontSize: 14 }}>Clear All Filters</Text>
                        </Pressable>
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
            {/* While the category panel is open, a tap on the list closes it (and opens nothing), as a tap on
                the map does. */}
            {categoryPanel.open && (
                <Pressable
                    style={StyleSheet.absoluteFill}
                    accessibilityRole="button"
                    accessibilityLabel="Close categories"
                    onPress={closeCategoryPanel}
                />
            )}
            {qr.hidden && filterSummary && (
                <ActiveFilterChip label={filterSummary} onPress={showControls} onClear={clearAllFilters} />
            )}
            </View>
            {/* Hidden while the panel is open, as the map's buttons are: it would cover the strip of feed left. */}
            {!categoryPanel.open && (
            <Pressable accessibilityRole="button" style={styles.fab} onPress={() => setShowNewPostTypePicker(true)}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ color: colors.text.inverse, fontSize: 20, fontWeight: '400', marginTop: -2 }}>+</Text>
                    <Text style={{ color: colors.text.inverse, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 }}>ADD POST</Text>
                </View>
            </Pressable>
            )}

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

            {/* The one way to post: the same chooser the map's + opens (components/NewPostTypeSheet). */}
            <NewPostTypeSheet
                visible={showNewPostTypePicker}
                onClose={() => setShowNewPostTypePicker(false)}
                onSelect={(type) => {
                    const target = composeTargetFor(type);
                    if (target === 'poll-modal') { setShowNewPollModal(true); return; }
                    if (target === 'event-modal') { setShowNewEventModal(true); return; }
                    // The offer/need form lives on the map, so this hands the chosen type over in the
                    // deep link. It used to push a bare `newPost=true`, which dropped the choice and
                    // opened the form on Offer even when the member had picked Need.
                    router.push({ pathname: '/map', params: { newPost: type } });
                }}
            />

            <NewPollModal
                visible={showNewPollModal}
                onClose={() => setShowNewPollModal(false)}
                onSuccess={() => loadPosts()}
            />

            <NewEventModal
                visible={showNewEventModal}
                onClose={() => setShowNewEventModal(false)}
                onSuccess={() => loadPosts()}
            />
        </View>
    );
}

