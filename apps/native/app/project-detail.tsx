import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, Alert, ActivityIndicator, Image, Keyboard } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { pledgeToCrowdfundProjectApi, getProjectById, getMemberRatings, reportAbuse } from '../utils/db';
import { loadIdentity } from '../utils/identity';
import { CurrencyDisplay } from '../components/CurrencyDisplay';
import { colors, palette } from '../constants/colors';
import { useTheme, useStyles } from './ThemeContext';

export default function ProjectDetailScreen() {
    const params = useLocalSearchParams<{ id: string, title?: string, description?: string, goal?: string, current?: string, creator_pubkey?: string, creator_callsign?: string, photos?: string }>();
    
    const [keyboardHeight, setKeyboardHeight] = useState(0);
    const { theme, colors } = useTheme();
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.card },
        header: { position: 'absolute', top: 44, left: 16, zIndex: 10 },
        backButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.overlay.imageViewerCloseBg, justifyContent: 'center', alignItems: 'center' },
        scroll: { flex: 1 },
        heroContainer: { width: '100%', height: 280, position: 'relative' },
        heroOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlay.hero },
        content: { padding: 20, borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: colors.surface.card, marginTop: -24 },
        fundedBadge: { alignSelf: 'flex-start', backgroundColor: theme === 'dark' ? colors.brand.tint : palette.greenAlt50, borderWidth: 1, borderColor: theme === 'dark' ? colors.brand.primary : palette.emerald200, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, marginBottom: 12 },
        fundedBadgeText: { color: theme === 'dark' ? colors.brand.primary : palette.emerald700, fontSize: 11, fontWeight: 'bold', letterSpacing: 0.5 },
        title: { fontSize: 26, fontWeight: '900', color: colors.text.heading, marginBottom: 20, letterSpacing: -0.5 },
        progressCard: { backgroundColor: colors.surface.app, padding: 16, borderRadius: 12, marginBottom: 24 },
        progressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12 },
        currentAmt: { fontSize: 24, fontWeight: 'bold', color: colors.text.body },
        progressLabel: { fontSize: 14, fontWeight: 'normal', color: colors.text.secondary },
        goalAmt: { fontSize: 14, fontWeight: '600', color: colors.text.secondary },
        progressBarBg: { height: 8, backgroundColor: colors.border.default, borderRadius: 4, overflow: 'hidden' },
        progressBarFill: { height: '100%', borderRadius: 4 },
        escrowNotice: { marginTop: 12, fontSize: 13, color: colors.text.secondary, fontStyle: 'normal', lineHeight: 18 },
        section: { marginBottom: 24 },
        sectionTitle: { fontSize: 18, fontWeight: 'bold', color: colors.text.body, marginBottom: 8 },
        description: { fontSize: 15, color: colors.text.secondary, lineHeight: 24 },
        footer: { padding: 16, borderTopWidth: 1, borderTopColor: colors.surface.subtle, backgroundColor: colors.surface.card },
        inputRow: { flexDirection: 'row', marginBottom: 16, gap: 12 },
        inputContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface.app, borderRadius: 12, paddingHorizontal: 16, borderWidth: 1, borderColor: colors.border.strong },
        beanSymbol: { fontSize: 18, fontWeight: 'bold', color: colors.brand.primary, marginRight: 8 },
        amountInput: { flex: 1, height: 48, fontSize: 18, fontWeight: 'bold', color: colors.text.body },
        memoInput: { flex: 2, height: 48, backgroundColor: colors.surface.app, borderRadius: 12, paddingHorizontal: 16, fontSize: 15, color: colors.text.body, borderWidth: 1, borderColor: colors.border.strong },
        pledgeBtn: { backgroundColor: colors.brand.primary, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
        pledgeBtnText: { color: colors.text.inverse, fontWeight: '800', letterSpacing: 1, fontSize: 15 },
    }));

    useEffect(() => {
        const showSub = Keyboard.addListener('keyboardDidShow', (e) => setKeyboardHeight(e.endCoordinates.height));
        const hideSub = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
        return () => { showSub.remove(); hideSub.remove(); };
    }, []);
    
    const [pledgeAmount, setPledgeAmount] = useState('');
    const [pledgeMemo, setPledgeMemo] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [identity, setIdentity] = useState<any>(null);

    const [projectData, setProjectData] = useState<any>(null);
    const [creatorAvgRating, setCreatorAvgRating] = useState<number | null>(null);
    const [creatorRatingCount, setCreatorRatingCount] = useState<number>(0);

    const [showReportForm, setShowReportForm] = useState(false);
    const [reportReason, setReportReason] = useState('');
    const [submittingReport, setSubmittingReport] = useState(false);

    const title = params.title || 'Untitled Project';
    const description = params.description || 'No description provided.';
    const goal = Number(params.goal || 0);
    const current = Number(params.current || 0);
    const isFunded = current >= goal;
    const progress = Math.min(100, (current / (goal || 1)) * 100);
    const isCreator = identity?.publicKey === params.creator_pubkey;

    let photosArr: string[] = [];
    if (projectData?.photos) {
        try { photosArr = typeof projectData.photos === 'string' ? JSON.parse(projectData.photos) : projectData.photos; } catch {}
    } else if (params.photos) {
        try { photosArr = JSON.parse(params.photos); } catch {}
    }
    const heroUri = photosArr.length > 0 ? photosArr[0] : null;

    useEffect(() => {
        loadIdentity().then((id: any) => setIdentity(id));
        if (params.id) {
            getProjectById(params.id).then(setProjectData).catch(console.error);
        }
        
        const pubkey = params.creator_pubkey || projectData?.creator_pubkey;
        if (pubkey) {
            getMemberRatings(pubkey).then(res => {
                setCreatorAvgRating(res.average);
                setCreatorRatingCount(res.count);
            }).catch(() => {});
        }
    }, [params.id, params.creator_pubkey, projectData?.creator_pubkey]);

    const handlePledge = async () => {
        if (!pledgeAmount.trim() || isNaN(Number(pledgeAmount)) || Number(pledgeAmount) <= 0) {
            Alert.alert("Invalid Amount", "Please enter a valid amount to pledge.");
            return;
        }

        setSubmitting(true);
        try {
            await pledgeToCrowdfundProjectApi(params.id, Number(pledgeAmount), pledgeMemo.trim());
            Alert.alert("Pledge Successful! 🌱", `Thank you for supporting ${title}.`, [
                { text: "OK", onPress: () => router.back() }
            ]);
        } catch (e: any) {
            Alert.alert("Pledge Failed", e.message || "Could not complete pledge. Are you online?");
        } finally {
            setSubmitting(false);
        }
    };

    const getDaysRemaining = (deadline: string | null) => {
        if (!deadline) return null;
        const diff = new Date(deadline).getTime() - new Date().getTime();
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
        if (days < 0) return 'Expired';
        if (days === 0) return 'Ends today';
        return `${days} days left`;
    };

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style="light" />
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={64}>
                
                {/* Fixed Header overlay for back button */}
                <View style={styles.header}>
                    <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Go back">
                        <MaterialCommunityIcons name="chevron-left" size={32} color={colors.text.inverse} />
                    </Pressable>
                </View>

                <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: keyboardHeight > 0 ? keyboardHeight + 100 : 100 }} bounces={false}>
                    {/* Hero Header */}
                    <View style={styles.heroContainer}>
                        {heroUri && typeof heroUri === 'string' && heroUri.trim() !== '' && heroUri !== 'null' && heroUri !== 'undefined' ? (
                            <Image source={{ uri: heroUri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" accessibilityLabel="Project photo" />
                        ) : (
                            <View style={[StyleSheet.absoluteFillObject, { backgroundColor: colors.text.heading, alignItems: 'center', justifyContent: 'center' }]}>
                                <Text style={{ fontSize: 60, opacity: 0.3 }}>🌱</Text>
                            </View>
                        )}
                        <View style={styles.heroOverlay} />
                    </View>

                    <View style={styles.content}>
                        {isFunded && (
                            <View style={styles.fundedBadge}>
                                <Text style={styles.fundedBadgeText}>🎉 SUCCESSFULLY FUNDED</Text>
                            </View>
                        )}
                        <Text style={styles.title}>{title}</Text>
                        <Text style={{ fontSize: 15, color: colors.text.secondary, fontWeight: '500', marginBottom: 4 }}>
                            Proposed by <Text style={{ color: colors.brand.primary, fontWeight: 'bold' }}>{params.creator_callsign || projectData?.creator_callsign || 'Unknown'}</Text>
                        </Text>
                        <Text style={{ fontSize: 13, color: colors.text.secondary, marginBottom: 20 }}>
                            {creatorAvgRating !== null && creatorRatingCount > 0 
                                ? '★'.repeat(Math.round(creatorAvgRating)) + '☆'.repeat(5 - Math.round(creatorAvgRating)) + ` (${creatorAvgRating.toFixed(1)}) • ${creatorRatingCount} Reviews`
                                : '☆☆☆☆☆ No ratings yet'}
                        </Text>
                        
                        {/* Progress Section */}
                        <View style={styles.progressCard}>
                            <View style={styles.progressHeader}>
                                <View>
                                    <Text style={[styles.currentAmt, isFunded && { color: colors.brand.primary }]}>
                                        {current} <Text style={styles.progressLabel}>Beans raised</Text>
                                    </Text>
                                    <CurrencyDisplay style={styles.goalAmt} amount={`Goal: ${goal}`} />
                                </View>
                                {projectData?.deadline_at && (
                                    <Text style={{ fontSize: 13, backgroundColor: getDaysRemaining(projectData.deadline_at) === 'Expired' ? palette.red50 : palette.violet50, color: getDaysRemaining(projectData.deadline_at) === 'Expired' ? colors.feedback.danger.solid : palette.violet500, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, fontWeight: 'bold', overflow: 'hidden', borderWidth: 1, borderColor: getDaysRemaining(projectData.deadline_at) === 'Expired' ? palette.red200 : palette.violet100 }}>
                                        ⏳ {getDaysRemaining(projectData.deadline_at)}
                                    </Text>
                                )}
                            </View>
                            <View style={styles.progressBarBg}>
                                <View style={[styles.progressBarFill, { width: `${progress}%`, backgroundColor: isFunded ? colors.brand.primary : palette.amber500 }]} />
                            </View>
                            <Text style={styles.escrowNotice}>
                                {isFunded 
                                    ? "🎉 This project successfully reached its goal! Pledged funds held in trust have been securely released to the creator."
                                    : "🔒 Pledges are held securely in a Trust Wallet. Funds are only released to the creator if the goal is met. If the creator deletes this project, your Beans will be automatically refunded."}
                            </Text>
                        </View>

                        {/* About */}
                        <View style={styles.section}>
                            <Text style={styles.sectionTitle}>About the Project</Text>
                            <Text style={styles.description}>{description}</Text>
                        </View>

                        {/* Report Action */}
                        {!isCreator && (
                            <View style={{ marginTop: 24, borderTopWidth: 1, borderTopColor: colors.surface.subtle, paddingTop: 20 }}>
                                <Pressable style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }} onPress={() => setShowReportForm(!showReportForm)} accessibilityRole="button">
                                    <MaterialCommunityIcons name="shield-off-outline" size={20} color={colors.feedback.danger.solid} />
                                    <Text style={{ color: colors.feedback.danger.solid, fontSize: 15, fontWeight: '600' }}>Report Project</Text>
                                </Pressable>
                                {showReportForm && (
                                    <View style={{ marginTop: 16, backgroundColor: colors.feedback.danger.bg, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.feedback.danger.border }}>
                                        <Text style={{ fontSize: 12, fontWeight: '700', color: colors.feedback.danger.solid, marginBottom: 8, letterSpacing: 1 }}>REPORT REASON</Text>
                                        <TextInput
                                            accessibilityLabel="Report reason"
                                            style={{ backgroundColor: colors.surface.card, height: 44, borderRadius: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border.default, marginBottom: 12 }}
                                            placeholder="Why are you reporting this project?"
                                            value={reportReason}
                                            onChangeText={setReportReason}
                                        />
                                        <Pressable
                                            accessibilityRole="button"
                                            style={{ backgroundColor: reportReason ? colors.feedback.danger.solid : colors.feedback.danger.disabled, height: 44, borderRadius: 8, justifyContent: 'center', alignItems: 'center' }}
                                            disabled={!reportReason || submittingReport}
                                            onPress={async () => {
                                                const pubkey = params.creator_pubkey || projectData?.creator_pubkey;
                                                if (!identity || !pubkey) return;
                                                setSubmittingReport(true);
                                                try {
                                                    await reportAbuse(identity.publicKey, pubkey, reportReason, params.id);
                                                    setShowReportForm(false);
                                                    Alert.alert('Reported', 'This project has been flagged for review.');
                                                } catch(e:any) { Alert.alert('Error', e.message); } finally { setSubmittingReport(false); }
                                            }}
                                        >
                                            <Text style={{ color: colors.text.inverse, fontWeight: 'bold' }}>{submittingReport ? 'Reporting...' : 'Submit Report'}</Text>
                                        </Pressable>
                                    </View>
                                )}
                            </View>
                        )}
                    </View>
                </ScrollView>

                {/* Footer Pledge Bar */}
                {!isCreator && (
                    <View style={styles.footer}>
                        <View style={styles.inputRow}>
                            <View style={styles.inputContainer}>
                                <CurrencyDisplay style={styles.beanSymbol} hideAmount={true} />
                                <TextInput
                                    accessibilityLabel="Pledge amount"
                                    style={styles.amountInput}
                                    placeholder="0"
                                    placeholderTextColor={colors.text.muted}
                                    keyboardType="numeric"
                                    value={pledgeAmount}
                                    onChangeText={setPledgeAmount}
                                />
                            </View>
                            <TextInput
                                accessibilityLabel="Pledge memo"
                                style={styles.memoInput}
                                placeholder="Optional memo..."
                                placeholderTextColor={colors.text.muted}
                                value={pledgeMemo}
                                onChangeText={setPledgeMemo}
                            />
                        </View>
                        <Pressable style={styles.pledgeBtn} onPress={handlePledge} disabled={submitting} accessibilityRole="button">
                            {submitting ? (
                                <ActivityIndicator color={colors.text.inverse} />
                            ) : (
                                <Text style={styles.pledgeBtnText}>PLEDGE BEANS 🌱</Text>
                            )}
                        </Pressable>
                    </View>
                )}
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}


