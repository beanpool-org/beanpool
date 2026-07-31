import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Alert, ActivityIndicator, Image, TextInput } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { getTreasuryDetail, getBalance, treasurySweep } from '../utils/db';
import { loadIdentity } from '../utils/identity';
import { useTheme, useStyles } from './ThemeContext';

// A community treasury's detail screen. Everyone sees the transparency view (balance, credit line,
// live listings, recent activity — the Commons is meant to be legible). A member holding the
// keepership of THIS enterprise additionally gets the keeper controls: post its Offer/Need and
// sweep its surplus into the shared Commons pool.
export default function TreasuryDetailScreen() {
    const params = useLocalSearchParams<{ publicKey: string; name?: string; avatar?: string }>();
    const { theme, colors } = useTheme();

    const [detail, setDetail] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [isKeeperOfThis, setIsKeeperOfThis] = useState(false);
    const [sweepAmount, setSweepAmount] = useState('');
    const [sweeping, setSweeping] = useState(false);

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
                    setIsKeeperOfThis(mine.includes(String(params.publicKey)));
                }).catch(() => {});
            }
        });
        return () => { active = false; };
    }, [params.publicKey]);

    useFocusEffect(load);

    const balance = detail?.balance ?? 0;
    const name = detail?.name || params.name || 'Community Treasury';
    const avatar = detail?.avatar || params.avatar;

    const handleSweep = async () => {
        const amt = Number(sweepAmount);
        if (isNaN(amt) || amt <= 0) { Alert.alert('Enter an amount', 'Type a positive number of Beans to sweep into the Commons.'); return; }
        if (amt > balance) { Alert.alert('Not enough surplus', `This treasury only holds ${balance} 🫘.`); return; }
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

    const formatTime = (t: any) => {
        try {
            const d = new Date(typeof t === 'number' ? t : String(t));
            if (isNaN(d.getTime())) return '';
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        } catch { return ''; }
    };

    const posts: any[] = detail?.posts || [];
    const flow: any[] = detail?.flow || [];

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
                    <Text style={styles.emptyNote}>Couldn't load this treasury. Check your connection.</Text>
                </View>
            ) : (
                <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={64}>
                    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                        {/* Identity */}
                        <View style={styles.identityRow}>
                            {avatar ? (
                                <Image source={{ uri: avatar }} style={styles.avatar} accessibilityLabel="Treasury avatar" />
                            ) : (
                                <View style={[styles.avatar, styles.avatarPlaceholder]}><Text style={{ fontSize: 28 }}>🏛️</Text></View>
                            )}
                            <View style={{ marginLeft: 12, flex: 1, minWidth: 0 }}>
                                <Text style={styles.name} numberOfLines={1}>{name}</Text>
                                <Text style={styles.subtitle}>Community treasury · run by the Commons</Text>
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
                                <Text style={styles.opHint}>
                                    Post the treasury's recurring Offer (what it sells) and its Needs (tenders it pays for). Surplus can be swept into the shared Commons pool.
                                </Text>
                            </View>
                        )}

                        {/* Live listings */}
                        <Text style={styles.sectionLabel}>Listings</Text>
                        {posts.length === 0 ? (
                            <Text style={styles.emptyNote}>No live listings yet.</Text>
                        ) : posts.map((p) => (
                            <View key={p.id} style={styles.listingCard}>
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
                            </View>
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
        </SafeAreaView>
    );
}
