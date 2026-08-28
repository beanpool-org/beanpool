/**
 * PricingGuideModal — Searchable, Auto-Adjusting Community Pricing Guide (#206).
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TextInput,
    Pressable,
    FlatList,
    Modal,
    ActivityIndicator,
    Platform,
    Image,
    KeyboardAvoidingView,
} from 'react-native';
// react-native's own SafeAreaView is a no-op on Android, so the header sat under the status
// bar and the close button collided with the battery. This one applies real insets.
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, useStyles } from '../app/ThemeContext';
import { palette } from '../constants/colors';
import {
    PRICING_CATEGORIES,
    DEFAULT_PRICING_CATALOG,
    DEFAULT_PRICING_CONFIG,
    type PricingGuideItem,
    type PricingCategory,
    type PricingConfig,
} from '@beanpool/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onSelectOfferItem?: (item: PricingGuideItem, effectivePrice: number) => void;
}

export function PricingGuideModal({ isOpen, onClose, onSelectOfferItem }: Props) {
    const { theme, colors } = useTheme();

    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategory, setSelectedCategory] = useState<PricingCategory | 'all'>('all');
    const [items, setItems] = useState<PricingGuideItem[]>(DEFAULT_PRICING_CATALOG);
    const [config, setConfig] = useState<PricingConfig>(DEFAULT_PRICING_CONFIG);
    const [loading, setLoading] = useState(false);

    // Reporting state
    const [reportingItem, setReportingItem] = useState<PricingGuideItem | null>(null);
    const [reportType, setReportType] = useState<'too_high' | 'too_low' | 'other'>('too_high');
    const [reportComment, setReportComment] = useState('');
    const [reportSubmitting, setReportSubmitting] = useState(false);
    const [reportSuccess, setReportSuccess] = useState(false);

    useEffect(() => {
        if (!isOpen) return;

        let isMounted = true;
        async function fetchGuide() {
            setLoading(true);
            try {
                const anchor = (await AsyncStorage.getItem('beanpool_anchor_url')) || '';
                const nodeUrl = anchor.trim().replace(/\/+$/, '');
                if (!nodeUrl) return;

                const res = await fetch(`${nodeUrl}/api/pricing-guide`);
                if (res.ok) {
                    const data = await res.json();
                    if (isMounted) {
                        if (Array.isArray(data.items) && data.items.length > 0) {
                            setItems(data.items);
                        }
                        if (data.config) {
                            setConfig(data.config);
                        }
                    }
                }
            } catch (err) {
                console.warn('[PricingGuide] Using local catalog fallback:', err);
            } finally {
                if (isMounted) setLoading(false);
            }
        }

        fetchGuide();
        return () => { isMounted = false; };
    }, [isOpen]);

    const filteredItems = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        return items.filter((item) => {
            const matchesCategory = selectedCategory === 'all' || item.category === selectedCategory;
            if (!matchesCategory) return false;

            if (!query) return true;
            return (
                item.name.toLowerCase().includes(query) ||
                item.description.toLowerCase().includes(query) ||
                item.category.toLowerCase().includes(query)
            );
        });
    }, [items, selectedCategory, searchQuery]);

    async function handleSubmitReport() {
        if (!reportingItem) return;
        setReportSubmitting(true);

        try {
            const anchor = (await AsyncStorage.getItem('beanpool_anchor_url')) || '';
            const nodeUrl = anchor.trim().replace(/\/+$/, '');

            if (nodeUrl) {
                await fetch(`${nodeUrl}/api/pricing-guide/report`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        itemId: reportingItem.id,
                        reportType,
                        comment: reportComment.trim() || undefined,
                    }),
                });
            }

            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setReportSuccess(true);
            setTimeout(() => {
                setReportingItem(null);
                setReportSuccess(false);
                setReportComment('');
                setReportType('too_high');
            }, 1200);
        } catch (e) {
            console.error('[PricingGuide] Failed to submit report:', e);
        } finally {
            setReportSubmitting(false);
        }
    }

    const styles = useStyles(({ theme, colors }) =>
        StyleSheet.create({
            modalContainer: {
                flex: 1,
                backgroundColor: theme === 'dark' ? colors.surface.app : '#f9fafb',
            },
            header: {
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 16,
                paddingTop: Platform.OS === 'ios' ? 12 : 16,
                paddingBottom: 12,
                borderBottomWidth: 1,
                borderBottomColor: colors.border.default,
                backgroundColor: theme === 'dark' ? colors.surface.card : '#ffffff',
            },
            headerTitleWrap: {
                flex: 1,
            },
            headerTitle: {
                fontSize: 18,
                fontWeight: '800',
                color: colors.text.heading,
            },
            headerSubtitle: {
                fontSize: 12,
                color: colors.text.secondary,
                marginTop: 2,
            },
            closeBtn: {
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.grayAlt100,
                alignItems: 'center',
                justifyContent: 'center',
                marginLeft: 12,
            },
            closeBtnText: {
                fontSize: 18,
                color: colors.text.heading,
                fontWeight: '700',
            },
            searchContainer: {
                paddingHorizontal: 16,
                paddingVertical: 10,
                backgroundColor: theme === 'dark' ? colors.surface.card : '#ffffff',
                borderBottomWidth: 1,
                borderBottomColor: colors.border.default,
            },
            searchInputWrap: {
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: theme === 'dark' ? colors.surface.app : palette.grayAlt100,
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: Platform.OS === 'ios' ? 10 : 6,
            },
            searchIcon: {
                fontSize: 16,
                marginRight: 8,
            },
            searchInput: {
                flex: 1,
                fontSize: 15,
                color: colors.text.heading,
            },
            clearSearchBtn: {
                padding: 4,
            },
            clearSearchText: {
                color: colors.text.muted,
                fontSize: 14,
                fontWeight: '700',
            },
            categoriesScroll: {
                paddingHorizontal: 12,
                paddingVertical: 10,
                backgroundColor: theme === 'dark' ? colors.surface.app : '#f9fafb',
            },
            categoryChip: {
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 20,
                backgroundColor: theme === 'dark' ? colors.surface.card : '#ffffff',
                marginRight: 8,
                borderWidth: 1,
                borderColor: colors.border.default,
            },
            categoryChipActive: {
                backgroundColor: palette.emerald600,
                borderColor: palette.emerald600,
            },
            categoryChipText: {
                fontSize: 13,
                fontWeight: '600',
                color: colors.text.heading,
            },
            categoryChipTextActive: {
                color: '#ffffff',
                fontWeight: '700',
            },
            tipBanner: {
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: theme === 'dark' ? 'rgba(5, 150, 105, 0.15)' : '#ecfdf5',
                borderWidth: 1,
                borderColor: theme === 'dark' ? 'rgba(5, 150, 105, 0.3)' : '#a7f3d0',
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 9,
                marginHorizontal: 16,
                marginTop: 8,
                marginBottom: 4,
                gap: 8,
            },
            tipBannerText: {
                flex: 1,
                fontSize: 12.5,
                color: theme === 'dark' ? '#34d399' : '#065f46',
                fontWeight: '600',
                lineHeight: 17,
            },
            listContent: {
                padding: 16,
                paddingBottom: 40,
            },
            itemCard: {
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: theme === 'dark' ? colors.surface.card : '#ffffff',
                borderRadius: 16,
                padding: 14,
                marginBottom: 10,
                borderWidth: 1,
                borderColor: colors.border.default,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: theme === 'dark' ? 0.2 : 0.05,
                shadowRadius: 3,
                elevation: 2,
            },
            thumbnailWrap: {
                width: 48,
                height: 48,
                borderRadius: 12,
                backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.grayAlt100,
                alignItems: 'center',
                justifyContent: 'center',
                marginRight: 14,
                overflow: 'hidden',
            },
            thumbnailEmoji: {
                fontSize: 26,
            },
            thumbnailImage: {
                width: '100%',
                height: '100%',
            },
            itemInfo: {
                flex: 1,
                marginRight: 10,
            },
            itemTitleRow: {
                flexDirection: 'row',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 6,
                marginBottom: 3,
            },
            itemName: {
                fontSize: 15,
                fontWeight: '700',
                color: colors.text.heading,
            },
            confidenceDot: {
                width: 7,
                height: 7,
                borderRadius: 4,
            },
            itemDesc: {
                fontSize: 12,
                color: colors.text.secondary,
                lineHeight: 17,
            },
            seasonalityText: {
                fontSize: 11,
                color: palette.emerald600,
                marginTop: 3,
                fontWeight: '500',
            },
            priceCol: {
                alignItems: 'flex-end',
            },
            priceBadge: {
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: theme === 'dark' ? '#064e3b' : '#ecfdf5',
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: theme === 'dark' ? '#059669' : '#a7f3d0',
                marginBottom: 6,
            },
            priceText: {
                fontSize: 15,
                fontWeight: '900',
                color: theme === 'dark' ? '#34d399' : '#047857',
            },
            unitText: {
                fontSize: 11,
                color: colors.text.secondary,
                fontWeight: '500',
                marginLeft: 2,
            },
            trendIndicator: {
                fontSize: 11,
                fontWeight: '800',
                marginLeft: 4,
            },
            actionsRow: {
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
            },
            offerBtn: {
                backgroundColor: palette.emerald600,
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 8,
            },
            offerBtnText: {
                color: '#ffffff',
                fontSize: 11,
                fontWeight: '700',
            },
            reportBtn: {
                padding: 4,
            },
            reportBtnText: {
                fontSize: 13,
                color: colors.text.muted,
            },
            emptyWrap: {
                padding: 40,
                alignItems: 'center',
            },
            emptyText: {
                fontSize: 15,
                fontWeight: '600',
                color: colors.text.secondary,
                textAlign: 'center',
            },
            // Sheet Modal
            sheetOverlay: {
                flex: 1,
                backgroundColor: 'rgba(0,0,0,0.6)',
                justifyContent: 'flex-end',
            },
            sheetCard: {
                backgroundColor: theme === 'dark' ? '#18181b' : '#ffffff',
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                padding: 24,
                paddingBottom: Platform.OS === 'ios' ? 44 : 24,
            },
            sheetTitle: {
                fontSize: 18,
                fontWeight: '800',
                color: colors.text.heading,
                textAlign: 'center',
                marginBottom: 6,
            },
            sheetSubtitle: {
                fontSize: 13,
                color: colors.text.secondary,
                textAlign: 'center',
                marginBottom: 20,
            },
            reportOptions: {
                flexDirection: 'row',
                gap: 10,
                marginBottom: 16,
            },
            reportOptionBtn: {
                flex: 1,
                paddingVertical: 12,
                borderRadius: 12,
                alignItems: 'center',
                borderWidth: 1.5,
                borderColor: colors.border.default,
                backgroundColor: theme === 'dark' ? colors.surface.app : palette.grayAlt100,
            },
            reportOptionBtnActive: {
                borderColor: palette.emerald600,
                backgroundColor: theme === 'dark' ? '#064e3b' : '#ecfdf5',
            },
            reportOptionText: {
                fontSize: 13,
                fontWeight: '700',
                color: colors.text.heading,
            },
            reportInput: {
                backgroundColor: theme === 'dark' ? colors.surface.app : palette.grayAlt100,
                borderRadius: 12,
                padding: 12,
                fontSize: 14,
                color: colors.text.heading,
                minHeight: 70,
                textAlignVertical: 'top',
                marginBottom: 16,
            },
            sheetSubmitBtn: {
                backgroundColor: palette.emerald600,
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: 'center',
                marginBottom: 10,
            },
            sheetSubmitText: {
                color: '#ffffff',
                fontSize: 15,
                fontWeight: '700',
            },
            sheetCancelBtn: {
                paddingVertical: 10,
                alignItems: 'center',
            },
            sheetCancelText: {
                fontSize: 14,
                color: colors.text.secondary,
                fontWeight: '600',
            },
        })
    );

    function renderItem({ item }: { item: PricingGuideItem }) {
        const effectivePrice = item.priceBeans;
        const confidenceColor =
            (item.confidenceCount || 0) >= 3 ? palette.emerald500 : (item.confidenceCount || 0) >= 1 ? palette.amber500 : palette.red500;

        return (
            <Pressable
                style={({ pressed }) => [
                    styles.itemCard,
                    onSelectOfferItem && pressed && { opacity: 0.75, transform: [{ scale: 0.99 }] },
                ]}
                onPress={() => {
                    if (onSelectOfferItem) {
                        Haptics.selectionAsync();
                        onSelectOfferItem(item, effectivePrice);
                        onClose();
                    }
                }}
                disabled={!onSelectOfferItem}
                accessibilityRole={onSelectOfferItem ? 'button' : undefined}
                accessibilityLabel={onSelectOfferItem ? `Select ${item.name} for 🫘 ${effectivePrice}` : undefined}
            >
                <View style={styles.thumbnailWrap}>
                    {item.thumbnailUrl ? (
                        <Image source={{ uri: item.thumbnailUrl }} style={styles.thumbnailImage} resizeMode="cover" />
                    ) : (
                        <Text style={styles.thumbnailEmoji}>{item.emoji}</Text>
                    )}
                </View>

                <View style={styles.itemInfo}>
                    <View style={styles.itemTitleRow}>
                        <Text style={styles.itemName}>{item.name}</Text>
                        <View style={[styles.confidenceDot, { backgroundColor: confidenceColor }]} />
                    </View>
                    <Text style={styles.itemDesc} numberOfLines={2}>{item.description}</Text>
                    {config.showSeasonality && !!item.seasonalityHint && (
                        <Text style={styles.seasonalityText}>☀️ {item.seasonalityHint}</Text>
                    )}
                </View>

                <View style={styles.priceCol}>
                    <View style={styles.priceBadge}>
                        <Text style={styles.priceText}>🫘 {effectivePrice}</Text>
                        {item.unit && <Text style={styles.unitText}>/{item.unit}</Text>}
                        {item.trend === 'up' && <Text style={[styles.trendIndicator, { color: palette.emerald500 }]}>▲</Text>}
                        {item.trend === 'down' && <Text style={[styles.trendIndicator, { color: palette.red500 }]}>▼</Text>}
                    </View>

                    <View style={styles.actionsRow}>
                        {onSelectOfferItem && (
                            <View style={styles.offerBtn} pointerEvents="none">
                                <Text style={styles.offerBtnText}>Offer →</Text>
                            </View>
                        )}
                        <Pressable
                            style={styles.reportBtn}
                            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                            onPress={(e) => {
                                e?.stopPropagation?.();
                                setReportingItem(item);
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={`Report price estimate for ${item.name}`}
                        >
                            <Text style={styles.reportBtnText}>🚩</Text>
                        </Pressable>
                    </View>
                </View>
            </Pressable>
        );
    }

    return (
        <Modal visible={isOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
            <SafeAreaView style={styles.modalContainer} edges={['top', 'left', 'right', 'bottom']}>
                {/* Header */}
                <View style={styles.header}>
                    <View style={styles.headerTitleWrap}>
                        <Text style={styles.headerTitle}>💡 Community Pricing Guide</Text>
                        <Text style={styles.headerSubtitle}>
                            {items.length} items & services benchmarked
                        </Text>
                    </View>
                    <Pressable style={styles.closeBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close pricing guide">
                        <Text style={styles.closeBtnText}>✕</Text>
                    </Pressable>
                </View>

                {/* Search Bar */}
                <View style={styles.searchContainer}>
                    <View style={styles.searchInputWrap}>
                        <Text style={styles.searchIcon}>🔍</Text>
                        <TextInput
                            style={styles.searchInput}
                            placeholder="Search produce, services, trades..."
                            placeholderTextColor={colors.text.muted}
                            value={searchQuery}
                            onChangeText={setSearchQuery}
                            clearButtonMode="while-editing"
                        />
                        {searchQuery.length > 0 && Platform.OS === 'android' && (
                            <Pressable accessibilityRole="button" accessibilityLabel="Clear search" style={styles.clearSearchBtn} onPress={() => setSearchQuery('')}>
                                <Text style={styles.clearSearchText}>✕</Text>
                            </Pressable>
                        )}
                    </View>
                </View>

                {/* Horizontal Category Filter Pills */}
                <View style={{ minHeight: 56 }}>
                    <FlatList
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.categoriesScroll}
                        data={[{ id: 'all', label: 'All Items', emoji: '🌟' } as any, ...PRICING_CATEGORIES]}
                        keyExtractor={(c) => c.id}
                        renderItem={({ item: cat }) => {
                            const active = selectedCategory === cat.id;
                            return (
                                <Pressable
                                    style={[styles.categoryChip, active && styles.categoryChipActive]}
                                    onPress={() => setSelectedCategory(cat.id)}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: active }}
                                    testID={`category-chip-${cat.id}`}
                                >
                                    <Text style={[styles.categoryChipText, active && styles.categoryChipTextActive]}>
                                        {cat.emoji} {cat.label}
                                    </Text>
                                </Pressable>
                            );
                        }}
                    />
                </View>

                {/* Instructions Tip Banner */}
                <View style={styles.tipBanner}>
                    <Text style={{ fontSize: 16 }}>💡</Text>
                    <Text style={styles.tipBannerText}>
                        {onSelectOfferItem
                            ? 'Tap any item to auto-fill your offer listing with community price estimates.'
                            : 'Community estimates based on local marketplace trades and seasonal averages.'}
                    </Text>
                </View>

                {/* Main Item List */}
                {loading ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator size="large" color={palette.emerald500} />
                    </View>
                ) : (
                    <FlatList
                        data={filteredItems}
                        keyExtractor={(i) => i.id}
                        renderItem={renderItem}
                        contentContainerStyle={styles.listContent}
                        ListEmptyComponent={
                            <View style={styles.emptyWrap}>
                                <Text style={{ fontSize: 36, marginBottom: 8 }}>🔍</Text>
                                <Text style={styles.emptyText}>No items match "{searchQuery}"</Text>
                            </View>
                        }
                    />
                )}

                {/* Report Bad Price Modal */}
                <Modal visible={!!reportingItem} transparent animationType="fade" onRequestClose={() => setReportingItem(null)}>
                    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetOverlay}>
                        <View style={styles.sheetCard}>
                            {reportSuccess ? (
                                <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                                    <Text style={{ fontSize: 40, marginBottom: 10 }}>✨</Text>
                                    <Text style={styles.sheetTitle}>Report Submitted</Text>
                                    <Text style={styles.sheetSubtitle}>Thank you for helping keep community prices fair.</Text>
                                </View>
                            ) : (
                                <>
                                    <Text style={styles.sheetTitle}>🚩 Report Price: {reportingItem?.name}</Text>
                                    <Text style={styles.sheetSubtitle}>
                                        Current estimate: 🫘 {reportingItem ? reportingItem.priceBeans : ''}
                                    </Text>

                                    <View style={styles.reportOptions}>
                                        <Pressable
                                            style={[styles.reportOptionBtn, reportType === 'too_high' && styles.reportOptionBtnActive]}
                                            onPress={() => setReportType('too_high')}
                                        >
                                            <Text style={styles.reportOptionText}>📈 Too High</Text>
                                        </Pressable>
                                        <Pressable
                                            style={[styles.reportOptionBtn, reportType === 'too_low' && styles.reportOptionBtnActive]}
                                            onPress={() => setReportType('too_low')}
                                        >
                                            <Text style={styles.reportOptionText}>📉 Too Low</Text>
                                        </Pressable>
                                        <Pressable
                                            style={[styles.reportOptionBtn, reportType === 'other' && styles.reportOptionBtnActive]}
                                            onPress={() => setReportType('other')}
                                        >
                                            <Text style={styles.reportOptionText}>💬 Other</Text>
                                        </Pressable>
                                    </View>

                                    <TextInput
                                        style={styles.reportInput}
                                        placeholder="Optional: Why is this estimate wrong? (e.g. what should it cost?)"
                                        placeholderTextColor={colors.text.muted}
                                        value={reportComment}
                                        onChangeText={setReportComment}
                                        multiline
                                        maxLength={250}
                                    />

                                    <Pressable
                                        style={styles.sheetSubmitBtn}
                                        onPress={handleSubmitReport}
                                        disabled={reportSubmitting}
                                    >
                                        {reportSubmitting ? (
                                            <ActivityIndicator color="#ffffff" />
                                        ) : (
                                            <Text style={styles.sheetSubmitText}>Submit Feedback</Text>
                                        )}
                                    </Pressable>

                                    <Pressable
                                        style={styles.sheetCancelBtn}
                                        onPress={() => setReportingItem(null)}
                                        disabled={reportSubmitting}
                                    >
                                        <Text style={styles.sheetCancelText}>Cancel</Text>
                                    </Pressable>
                                </>
                            )}
                        </View>
                    </KeyboardAvoidingView>
                </Modal>
            </SafeAreaView>
        </Modal>
    );
}
