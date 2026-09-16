import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Alert, ActivityIndicator, Image, TextInput, Modal } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { getTreasuryDetail, getBalance, treasurySweep, treasuryApprove, treasuryComplete, treasuryReject } from '../utils/db';
import { loadIdentity } from '../utils/identity';
import { useTheme, useStyles } from './ThemeContext';

// A community treasury's detail screen. Everyone sees the transparency view (balance, credit line,
// live listings, recent activity — the Commons is meant to be legible). A member holding the
// keepership of THIS enterprise additionally gets the keeper controls: post its Offer/Need and
// sweep its surplus into the shared Commons pool.
export default function TreasuryDetailScreen() {
    const params = useLocalSearchParams<{ publicKey?: string; name?: string; avatar?: string }>();
    const { theme, colors } = useTheme();

    const [detail, setDetail] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [isKeeperOfThis, setIsKeeperOfThis] = useState(false);
    const [sweepAmount, setSweepAmount] = useState('');
    const [sweeping, setSweeping] = useState(false);
    const [actionState, setActionState] = useState<{ id: string; type: 'approve' | 'reject' | 'complete' } | null>(null);
    const [hourlyDealPrompt, setHourlyDealPrompt] = useState<any | null>(null);
    const [hourlyDealHours, setHourlyDealHours] = useState('');

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: colors.surface.app },
        backButton: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, fontSize: 18, fontWeight: '800', color: colors.text.heading, letterSpacing: -0.3 },
        scroll: { padding: 16, paddingBottom: 60 },

        identityRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
        avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.surface.subtle },
        avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
        name: { fontSize: 20, fontWeight: '800', color: colors.text.heading },
        subtitle: { fontSize: 13, color: colors.text.secondary, marginTop: 2 },

        balanceCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 18, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16 },
        balanceLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
        balanceValue: { fontSize: 34, fontWeight: '900', letterSpacing: -1, marginTop: 4 },
        balancePos: { color: colors.brand.primary },
        balanceNeg: { color: colors.feedback.warning.solid },
        balanceMetaRow: { flexDirection: 'row', marginTop: 14, gap: 12 },
        metaBox: { flex: 1, backgroundColor: colors.surface.app, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: colors.border.default },
        metaLabel: { fontSize: 10, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
        metaValue: { fontSize: 16, fontWeight: '800', color: colors.text.heading, marginTop: 3 },

        sectionLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 8 },

        opPanel: { backgroundColor: colors.brand.tint, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: colors.brand.primary, marginBottom: 16 },
        opTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
        opTitle: { fontSize: 13, fontWeight: '800', color: colors.brand.primary, letterSpacing: 0.3 },
        opBtnRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
        opBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.brand.primary, paddingVertical: 12, borderRadius: 12 },
        opBtnText: { color: colors.text.inverse, fontWeight: '800', fontSize: 13 },
        sweepRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
        sweepInput: { flex: 1, height: 46, backgroundColor: colors.surface.card, borderRadius: 12, paddingHorizontal: 14, fontSize: 16, fontWeight: '700', color: colors.text.body, borderWidth: 1, borderColor: colors.border.strong },
        sweepBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.brand.primary, paddingHorizontal: 14, height: 46, borderRadius: 12, justifyContent: 'center' },
        sweepBtnDisabled: { opacity: 0.4 },
        sweepBtnText: { color: colors.brand.primary, fontWeight: '800', fontSize: 13 },
        opHint: { fontSize: 12, color: colors.brand.primary, marginTop: 10, lineHeight: 17 },

        listingCard: { backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border.default, marginBottom: 8 },
        listingTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
        typeBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
        typeBadgeOffer: { backgroundColor: colors.brand.tint },
        typeBadgeNeed: { backgroundColor: colors.surface.subtle },
        typeBadgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
        recurBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
        recurText: { fontSize: 10, color: colors.text.secondary, fontWeight: '700' },
        listingTitle: { fontSize: 15, fontWeight: '700', color: colors.text.heading, flex: 1 },
        listingPrice: { fontSize: 15, fontWeight: '800', color: colors.brand.primary },
        listingDesc: { fontSize: 13, color: colors.text.secondary, lineHeight: 18 },

        flowRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        flowIcon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
        flowMemo: { fontSize: 13, color: colors.text.body, fontWeight: '500' },
        flowTime: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
        flowAmount: { fontSize: 15, fontWeight: '800' },

        emptyNote: { fontSize: 13, color: colors.text.muted, fontStyle: 'italic', paddingVertical: 12 },
        centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    }));

    const load = useCallback(() => {
        let active = true;
        setLoading(true);
        if (params.publicKey) {
            getTreasuryDetail(params.publicKey)
                .then((d) => { if (active) { setDetail(d); setLoading(false); } })
                .catch(() => { if (active) setLoading(false); });
        } else {
            setLoading(false);
        }
        loadIdentity().then((id: any) => {
            if (id?.publicKey) {
                // #106: gate on keepership of THIS enterprise, not the coarse "is a keeper
                // of something" flag — otherwise a keeper of one enterprise sees operate
                // controls on every other one and their action 403s.
                getBalance(id.publicKey).then((b: any) => {
                    if (!active) return;
                    const mine: string[] = Array.isArray(b.keeperOf) ? b.keeperOf : [];
                    setIsKeeperOfThis(!!params.publicKey && mine.includes(params.publicKey));
                }).catch(() => {});
            }
        });
        return () => { active = false; };
    }, [params.publicKey]);

    useFocusEffect(load);

    const balance = detail?.balance ?? 0;
    const name = detail?.name || params.name || 'Community Enterprise';
    const avatar = detail?.avatar || params.avatar;

    const handleSweep = async () => {
        if (!params.publicKey) return;
        const amt = Number(sweepAmount);
        if (isNaN(amt) || amt <= 0) { Alert.alert('Enter an amount', 'Type a positive number of Beans to sweep into the Commons.'); return; }
        if (amt > balance) { Alert.alert('Not enough surplus', `This enterprise only holds ${balance} 🫘.`); return; }
        setSweeping(true);
        try {
            await treasurySweep(params.publicKey, amt);
            Alert.alert('Swept to the Commons 🌱', `${amt} 🫘 moved from ${name} into the shared Commons pool.`);
            setSweepAmount('');
            load();
        } catch (e: any) {
            Alert.alert('Sweep failed', e.message || 'Could not sweep to the Commons.');
        } finally {
            setSweeping(false);
        }
    };

    const handleApproveBid = async (txId: string) => {
        const treasuryKey = params.publicKey;
        if (!treasuryKey) return;
        setActionState({ id: txId, type: 'approve' });
        try {
            await treasuryApprove(treasuryKey, txId);
            Alert.alert('Bid Approved ✅', 'Funds locked in trust successfully.');
            load();
        } catch (e: any) {
            Alert.alert('Approve Failed', e.message || 'Could not approve bid.');
        } finally {
            setActionState(null);
        }
    };

    const handleRejectBid = (txId: string) => {
        const treasuryKey = params.publicKey;
        if (!treasuryKey) return;
        Alert.alert(
            'Decline Bid?',
            'Are you sure you want to decline this request? The member will be notified.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Decline',
                    style: 'destructive',
                    onPress: async () => {
                        setActionState({ id: txId, type: 'reject' });
                        try {
                            await treasuryReject(treasuryKey, txId);
                            Alert.alert('Bid Declined', 'The request has been declined.');
                            load();
                        } catch (e: any) {
                            Alert.alert('Decline Failed', e.message || 'Could not decline bid.');
                        } finally {
                            setActionState(null);
                        }
                    }
                }
            ]
        );
    };

    const handleCompleteDeal = (d: any) => {
        const treasuryKey = params.publicKey;
        if (!treasuryKey) return;
        if (d.price_type && d.price_type !== 'fixed') {
            setHourlyDealHours(d.hours ? String(d.hours) : '1');
            setHourlyDealPrompt(d);
            return;
        }
        Alert.alert(
            'Release Payment?',
            `Are you sure you want to release ${d.credits} 🫘 to ${d.peer_callsign || 'the member'}? This cannot be undone.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Release Payment',
                    onPress: async () => {
                        setActionState({ id: d.id, type: 'complete' });
                        try {
                            await treasuryComplete(treasuryKey, d.id);
                            Alert.alert('Payment Released ✅', 'The beans have been paid to the member.');
                            load();
                        } catch (e: any) {
                            Alert.alert('Release Failed', e.message || 'Could not release payment.');
                        } finally {
                            setActionState(null);
                        }
                    }
                }
            ]
        );
    };

    const formatTime = (t: any) => {
        try {
            const d = new Date(typeof t === 'number' ? t : String(t));
            if (isNaN(d.getTime())) return '';
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        } catch { return ''; }
    };

    const posts: any[] = detail?.posts || [];
    const flow: any[] = detail?.flow || [];
    const pendingBids: any[] = detail?.pendingBids || [];
    const activeDeals: any[] = detail?.activeDeals || [];
    const deferredClaims: any[] = detail?.deferredClaims || [];
    const pendingClaims = deferredClaims.filter((c: any) => c.status === 'pending');
    const pendingClaimsTotal = pendingClaims.reduce((sum: number, c: any) => sum + (Number(c.amount) || 0), 0);

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Go back">
                    <MaterialCommunityIcons name="chevron-left" size={30} color={colors.text.heading} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1}>{name}</Text>
            </View>

            {loading ? (
                <View style={styles.centerFill}><ActivityIndicator color={colors.brand.primary} /></View>
            ) : !detail ? (
                <View style={styles.centerFill}>
                    <Text style={styles.emptyNote}>Couldn't load this enterprise. Check your connection.</Text>
                </View>
            ) : (
                <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={64}>
                    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                        {/* Identity */}
                        <View style={styles.identityRow}>
                            {avatar ? (
                                <Image source={{ uri: avatar }} style={styles.avatar} accessibilityLabel="Enterprise avatar" />
                            ) : (
                                <View style={[styles.avatar, styles.avatarPlaceholder]}><Text style={{ fontSize: 28 }}>🏛️</Text></View>
                            )}
                            <View style={{ marginLeft: 12, flex: 1, minWidth: 0 }}>
                                <Text style={styles.name} numberOfLines={1}>{name}</Text>
                                <Text style={styles.subtitle}>Community enterprise · run by the Commons</Text>
                            </View>
                        </View>

                        {/* Balance */}
                        <View style={styles.balanceCard}>
                            <Text style={styles.balanceLabel}>Balance</Text>
                            <Text style={[styles.balanceValue, balance < 0 ? styles.balanceNeg : styles.balancePos]}>{balance} 🫘</Text>
                            <View style={styles.balanceMetaRow}>
                                <View style={styles.metaBox}>
                                    <Text style={styles.metaLabel}>Credit line</Text>
                                    <Text style={styles.metaValue}>{detail.creditLine ?? 0} 🫘</Text>
                                </View>
                                <View style={styles.metaBox}>
                                    <Text style={styles.metaLabel}>Live offers</Text>
                                    <Text style={styles.metaValue}>{detail.liveOffers ?? 0}</Text>
                                </View>
                            </View>
                            <View style={styles.balanceMetaRow}>
                                <View style={styles.metaBox}>
                                    <Text style={styles.metaLabel}>Earned surplus</Text>
                                    <Text style={styles.metaValue}>{detail.earnedSurplus ?? 0} 🫘</Text>
                                </View>
                                <View style={styles.metaBox}>
                                    <Text style={styles.metaLabel}>Capital ceiling</Text>
                                    <Text style={styles.metaValue}>{detail.workingCapitalCeiling != null ? `${detail.workingCapitalCeiling} 🫘` : 'Uncapped'}</Text>
                                </View>
                            </View>
                            {balance < 0 && (
                                <View
                                    accessible={true}
                                    accessibilityRole="alert"
                                    accessibilityLabel={`Warning: Operator eats last. This enterprise is currently in deficit with ${balance} beans. Credit buys inputs and supplies, but keepers can only be paid from profit. Keepers cannot be paid while the enterprise is in deficit.`}
                                    style={{ marginTop: 12, padding: 10, backgroundColor: colors.surface.app, borderRadius: 10, borderWidth: 1, borderColor: colors.feedback.warning.solid }}
                                >
                                    <Text style={{ fontSize: 11, color: colors.feedback.warning.solid, fontWeight: '700', lineHeight: 16 }}>
                                        ⚠️ OPERATOR EATS LAST: This enterprise is currently in deficit ({balance} 🫘). Credit buys inputs and supplies, but keepers can only be paid from profit. Keepers cannot be paid while the enterprise is in deficit.
                                    </Text>
                                </View>
                            )}
                            {pendingClaims.length > 0 && (
                                <View style={{ marginTop: 12, padding: 12, backgroundColor: colors.surface.app, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <Text style={{ fontSize: 11, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                                            Pending Wage Claims ({pendingClaims.length})
                                        </Text>
                                        <Text style={{ fontSize: 13, fontWeight: '800', color: colors.feedback.warning.solid }}>
                                            {pendingClaimsTotal} 🫘
                                        </Text>
                                    </View>
                                    <Text style={{ fontSize: 11, color: colors.text.secondary, marginTop: 4, lineHeight: 15 }}>
                                        Deferred until enterprise earns sufficient trading profit. Paid automatically from future sales.
                                    </Text>
                                </View>
                            )}
                        </View>

                        {/* Operator controls */}
                        {isKeeperOfThis && (
                            <View style={styles.opPanel}>
                                <View style={styles.opTitleRow}>
                                    <MaterialCommunityIcons name="shield-account" size={16} color={colors.brand.primary} />
                                    <Text style={styles.opTitle}>OPERATOR CONTROLS</Text>
                                </View>
                                <View style={styles.opBtnRow}>
                                    <Pressable
                                        style={styles.opBtn}
                                        accessibilityRole="button"
                                        onPress={() => router.push({ pathname: '/treasury-post', params: { treasury: params.publicKey, mode: 'offer', name } })}
                                    >
                                        <MaterialCommunityIcons name="tag-plus" size={16} color={colors.text.inverse} />
                                        <Text style={styles.opBtnText}>Post Offer</Text>
                                    </Pressable>
                                    <Pressable
                                        style={styles.opBtn}
                                        accessibilityRole="button"
                                        onPress={() => router.push({ pathname: '/treasury-post', params: { treasury: params.publicKey, mode: 'need', name } })}
                                    >
                                        <MaterialCommunityIcons name="hand-extended" size={16} color={colors.text.inverse} />
                                        <Text style={styles.opBtnText}>Post Need</Text>
                                    </Pressable>
                                </View>
                                <View style={styles.sweepRow}>
                                    <TextInput
                                        style={styles.sweepInput}
                                        placeholder="Sweep surplus…"
                                        placeholderTextColor={colors.text.muted}
                                        keyboardType="numeric"
                                        value={sweepAmount}
                                        onChangeText={setSweepAmount}
                                        accessibilityLabel="Amount to sweep to the Commons"
                                    />
                                    <Pressable
                                        style={[styles.sweepBtn, (sweeping || balance <= 0) && styles.sweepBtnDisabled]}
                                        disabled={sweeping || balance <= 0}
                                        onPress={handleSweep}
                                        accessibilityRole="button"
                                    >
                                        {sweeping ? <ActivityIndicator color={colors.brand.primary} /> : (
                                            <>
                                                <MaterialCommunityIcons name="bank-transfer-out" size={16} color={colors.brand.primary} />
                                                <Text style={styles.sweepBtnText}>To Commons</Text>
                                            </>
                                        )}
                                    </Pressable>
                                </View>

                                {pendingBids.length > 0 && (
                                    <View style={{ marginTop: 14, borderTopWidth: 1, borderTopColor: colors.brand.primary, paddingTop: 12 }}>
                                        <Text style={[styles.opTitle, { marginBottom: 8 }]}>PENDING BIDS ON NEEDS ({pendingBids.length})</Text>
                                        {pendingBids.map((b) => (
                                            <View key={b.id} style={{ backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border.default }}>
                                                <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text.heading }}>{b.post_title}</Text>
                                                <Text style={{ fontSize: 12, color: colors.text.secondary, marginTop: 2 }}>
                                                    Bid by <Text style={{ fontWeight: '700', color: colors.text.body }}>{b.peer_callsign || 'Member'}</Text> · {b.credits} 🫘
                                                </Text>
                                                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                                                    <Pressable
                                                        style={[styles.opBtn, { minHeight: 44, paddingVertical: 8, justifyContent: 'center' }]}
                                                        disabled={actionState?.id === b.id}
                                                        onPress={() => handleApproveBid(b.id)}
                                                        accessibilityRole="button"
                                                    >
                                                        {actionState?.id === b.id && actionState?.type === 'approve' ? (
                                                            <ActivityIndicator size="small" color={colors.text.inverse} />
                                                        ) : (
                                                            <Text style={styles.opBtnText}>Approve Bid ({b.credits} 🫘)</Text>
                                                        )}
                                                    </Pressable>
                                                    <Pressable
                                                        style={[styles.sweepBtn, { minHeight: 44, height: 44, paddingHorizontal: 16 }]}
                                                        disabled={actionState?.id === b.id}
                                                        onPress={() => handleRejectBid(b.id)}
                                                        accessibilityRole="button"
                                                    >
                                                        {actionState?.id === b.id && actionState?.type === 'reject' ? (
                                                            <ActivityIndicator size="small" color={colors.feedback.warning.solid} />
                                                        ) : (
                                                            <Text style={[styles.sweepBtnText, { color: colors.feedback.warning.solid }]}>Decline</Text>
                                                        )}
                                                    </Pressable>
                                                </View>
                                            </View>
                                        ))}
                                    </View>
                                )}

                                {activeDeals.length > 0 && (
                                    <View style={{ marginTop: 14, borderTopWidth: 1, borderTopColor: colors.brand.primary, paddingTop: 12 }}>
                                        <Text style={[styles.opTitle, { marginBottom: 8 }]}>ACTIVE DEALS ({activeDeals.length})</Text>
                                        {activeDeals.map((d) => (
                                            <View key={d.id} style={{ backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border.default }}>
                                                <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text.heading }}>{d.post_title}</Text>
                                                <Text style={{ fontSize: 12, color: colors.text.secondary, marginTop: 2 }}>
                                                    {d.action_required === 'fulfill' ? 'Customer' : 'Worker'}: <Text style={{ fontWeight: '700', color: colors.text.body }}>{d.peer_callsign || 'Member'}</Text> · {d.credits} 🫘 in escrow
                                                </Text>
                                                <View style={{ marginTop: 10 }}>
                                                    {d.action_required === 'fulfill' ? (
                                                        <Pressable
                                                            style={[styles.sweepBtn, { minHeight: 44, height: 44 }]}
                                                            onPress={() => router.push({ pathname: '/post/[id]', params: { id: d.post_id, txId: d.id } })}
                                                            accessibilityRole="button"
                                                        >
                                                            <Text style={[styles.sweepBtnText, { color: colors.text.secondary }]}>
                                                                Fulfill Deal · Awaiting Customer Release
                                                            </Text>
                                                        </Pressable>
                                                    ) : (
                                                        <Pressable
                                                            style={[styles.opBtn, { backgroundColor: colors.feedback.success.solid, minHeight: 44, paddingVertical: 8 }]}
                                                            disabled={actionState?.id === d.id}
                                                            onPress={() => handleCompleteDeal(d)}
                                                            accessibilityRole="button"
                                                        >
                                                            {actionState?.id === d.id && actionState?.type === 'complete' ? (
                                                                <ActivityIndicator size="small" color={colors.text.inverse} />
                                                            ) : (
                                                                <Text style={styles.opBtnText}>Release Payment ({d.credits} 🫘)</Text>
                                                            )}
                                                        </Pressable>
                                                    )}
                                                </View>
                                            </View>
                                        ))}
                                    </View>
                                )}

                                <Text style={styles.opHint}>
                                    Post the enterprise's recurring Offer (what it sells) and its Needs (tenders it pays for). Surplus can be swept into the shared Commons pool.
                                </Text>
                            </View>
                        )}

                        {/* Live listings */}
                        <Text style={styles.sectionLabel}>Listings</Text>
                        {posts.length === 0 ? (
                            <Text style={styles.emptyNote}>No live listings yet.</Text>
                        ) : posts.map((p) => (
                            <Pressable key={p.id} style={styles.listingCard} onPress={() => router.push({ pathname: '/post/[id]', params: { id: p.id } })} accessibilityRole="button">
                                <View style={styles.listingTopRow}>
                                    <View style={[styles.typeBadge, p.type === 'offer' ? styles.typeBadgeOffer : styles.typeBadgeNeed]}>
                                        <Text style={[styles.typeBadgeText, { color: p.type === 'offer' ? colors.brand.primary : colors.text.secondary }]}>{p.type}</Text>
                                    </View>
                                    {!!p.repeatable && (
                                        <View style={styles.recurBadge}>
                                            <MaterialCommunityIcons name="autorenew" size={12} color={colors.text.secondary} />
                                            <Text style={styles.recurText}>Recurring</Text>
                                        </View>
                                    )}
                                    <Text style={styles.listingTitle} numberOfLines={1}>{p.title}</Text>
                                    <Text style={styles.listingPrice}>{p.credits} 🫘</Text>
                                </View>
                                {!!p.description && <Text style={styles.listingDesc} numberOfLines={2}>{p.description}</Text>}
                            </Pressable>
                        ))}

                        {/* Recent activity */}
                        <Text style={styles.sectionLabel}>Recent activity</Text>
                        {flow.length === 0 ? (
                            <Text style={styles.emptyNote}>No transactions yet.</Text>
                        ) : flow.map((f, i) => (
                            <View key={i} style={[styles.flowRow, i === flow.length - 1 && { borderBottomWidth: 0 }]}>
                                <View style={[styles.flowIcon, { backgroundColor: f.incoming ? colors.brand.tint : colors.surface.subtle }]}>
                                    <MaterialCommunityIcons name={f.incoming ? 'arrow-down' : 'arrow-up'} size={16} color={f.incoming ? colors.brand.primary : colors.text.secondary} />
                                </View>
                                <View style={{ flex: 1, minWidth: 0 }}>
                                    <Text style={styles.flowMemo} numberOfLines={1}>{f.memo || (f.incoming ? 'Received' : 'Sent')}</Text>
                                    <Text style={styles.flowTime}>{formatTime(f.timestamp)}</Text>
                                </View>
                                <Text style={[styles.flowAmount, { color: f.incoming ? colors.brand.primary : colors.feedback.warning.solid }]}>
                                    {f.incoming ? '+' : '−'}{Math.abs(f.amount)} 🫘
                                </Text>
                            </View>
                        ))}
                    </ScrollView>
                </KeyboardAvoidingView>
            )}

            {hourlyDealPrompt && (
                <Modal visible transparent animationType="fade" onRequestClose={() => setHourlyDealPrompt(null)}>
                    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
                        <View style={{ backgroundColor: colors.surface.card, borderRadius: 16, padding: 20, width: '100%', maxWidth: 400, borderWidth: 1, borderColor: colors.border.default }}>
                            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text.heading, marginBottom: 6 }}>
                                Confirm Hours Worked
                            </Text>
                            <Text style={{ fontSize: 13, color: colors.text.secondary, marginBottom: 14 }}>
                                Enter actual hours worked for "{hourlyDealPrompt.post_title}":
                            </Text>
                            <TextInput
                                style={{ height: 44, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 10, paddingHorizontal: 12, fontSize: 15, color: colors.text.body, marginBottom: 16 }}
                                value={hourlyDealHours}
                                onChangeText={setHourlyDealHours}
                                keyboardType="numeric"
                                placeholder="e.g. 2.5"
                                placeholderTextColor={colors.text.muted}
                                autoFocus
                            />
                            <View style={{ flexDirection: 'row', gap: 10 }}>
                                <Pressable
                                    style={{ flex: 1, height: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.border.default }}
                                    onPress={() => setHourlyDealPrompt(null)}
                                    accessibilityRole="button"
                                >
                                    <Text style={{ color: colors.text.body, fontWeight: '700' }}>Cancel</Text>
                                </Pressable>
                                <Pressable
                                    style={{ flex: 1, height: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 10, backgroundColor: colors.feedback.success.solid }}
                                    accessibilityRole="button"
                                    onPress={async () => {
                                        const parsed = Number(hourlyDealHours);
                                        if (isNaN(parsed) || parsed <= 0) {
                                            Alert.alert('Invalid Hours', 'Please enter a valid positive number of hours.');
                                            return;
                                        }
                                        const deal = hourlyDealPrompt;
                                        const treasuryKey = params.publicKey;
                                        setHourlyDealPrompt(null);
                                        if (!treasuryKey) return;
                                        setActionState({ id: deal.id, type: 'complete' });
                                        try {
                                            await treasuryComplete(treasuryKey, deal.id, parsed);
                                            Alert.alert('Payment Released ✅', 'The beans have been paid to the member.');
                                            load();
                                        } catch (e: any) {
                                            Alert.alert('Release Failed', e.message || 'Could not release payment.');
                                        } finally {
                                            setActionState(null);
                                        }
                                    }}
                                >
                                    <Text style={{ color: colors.text.inverse, fontWeight: '800' }}>Release Payment</Text>
                                </Pressable>
                            </View>
                        </View>
                    </View>
                </Modal>
            )}
        </SafeAreaView>
    );
}
