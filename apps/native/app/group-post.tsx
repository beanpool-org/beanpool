import React, { useState, useRef } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { createPost } from '../utils/db';
import { useIdentity } from './IdentityContext';
import { CategoryPickerSheet } from '../components/CategoryPickerSheet';
import { categoryEmoji, categoryLabel } from '../constants/categories';
import { useTheme, useStyles } from './ThemeContext';
import { hapticSuccess, hapticWarning } from '../utils/haptics';

const PRICE_TYPES = ['fixed', 'hourly', 'daily', 'weekly', 'monthly'] as const;
const PRICE_TYPE_LABEL: Record<string, string> = { fixed: 'Total', hourly: '/hr', daily: '/day', weekly: '/wk', monthly: '/mo' };

export default function GroupPostScreen() {
    const params = useLocalSearchParams<{ groupId?: string; groupName?: string }>();
    const groupId = params.groupId;
    const groupName = params.groupName || 'Group';
    const { identity } = useIdentity();
    const { theme, colors } = useTheme();

    const [type, setType] = useState<'offer' | 'need'>('offer');
    const [title, setTitle] = useState('');
    const [category, setCategory] = useState('general');
    const [credits, setCredits] = useState('');
    const [priceType, setPriceType] = useState<string>('fixed');
    const [description, setDescription] = useState('');
    const [repeatable, setRepeatable] = useState(false);
    const [cashAlsoNeeded, setCashAlsoNeeded] = useState(false);
    const [showCategoryPicker, setShowCategoryPicker] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false);
    const [errors, setErrors] = useState<Set<string>>(new Set());
    const [toast, setToast] = useState('');

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 14,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
            backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading,
        },
        backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'flex-start' },
        headerTitle: { fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5, textTransform: 'uppercase' },
        scroll: { padding: 20 },
        // Plain words audience banner — scope must be unmistakable before posting
        audienceBanner: {
            backgroundColor: colors.brand.tint,
            borderColor: colors.brand.primary,
            borderWidth: 2,
            borderRadius: 16,
            padding: 16,
            marginBottom: 20,
        },
        audienceBadgeRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginBottom: 6,
        },
        audienceBannerTitle: {
            fontSize: 16,
            fontWeight: '900',
            color: colors.brand.primary,
        },
        audienceBannerDesc: {
            fontSize: 13,
            color: colors.text.body,
            lineHeight: 18,
        },
        typeSelector: {
            flexDirection: 'row',
            gap: 10,
            marginBottom: 20,
        },
        typeBtn: {
            flex: 1,
            paddingVertical: 12,
            borderRadius: 12,
            alignItems: 'center',
            borderWidth: 1,
            borderColor: colors.border.default,
            backgroundColor: colors.surface.card,
        },
        typeBtnActiveOffer: {
            backgroundColor: colors.brand.primary,
            borderColor: colors.brand.primary,
        },
        typeBtnActiveNeed: {
            backgroundColor: colors.market.need.fg || '#ea580c',
            borderColor: colors.market.need.fg || '#ea580c',
        },
        typeBtnText: {
            fontSize: 14,
            fontWeight: '800',
            color: colors.text.secondary,
        },
        typeBtnTextActive: {
            color: colors.text.inverse,
        },
        field: { marginBottom: 20 },
        label: { fontSize: 11, fontWeight: 'bold', color: colors.text.secondary, letterSpacing: 1, marginBottom: 8 },
        input: {
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.strong,
            borderRadius: 12,
            padding: 14,
            fontSize: 15,
            color: colors.text.body,
        },
        pickerRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
        },
        pickerText: { fontSize: 15, color: colors.text.heading, fontWeight: '600' },
        priceRow: { flexDirection: 'row', gap: 10 },
        priceInput: { flex: 1, fontSize: 22, fontWeight: 'bold', color: colors.brand.primary },
        priceTypeBtn: {
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 16,
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.strong,
            borderRadius: 12,
        },
        priceTypeText: { fontSize: 13, fontWeight: '700', color: colors.text.body },
        textarea: { height: 110, paddingTop: 14 },
        toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
        checkbox: {
            width: 24,
            height: 24,
            borderRadius: 6,
            borderWidth: 2,
            borderColor: colors.border.strong,
            alignItems: 'center',
            justifyContent: 'center',
        },
        checkboxOn: { backgroundColor: colors.brand.primary, borderColor: colors.brand.primary },
        toggleLabel: { fontSize: 14, color: colors.text.body, fontWeight: '600' },
        toggleHint: { fontSize: 12, color: colors.text.secondary, marginTop: 2 },
        footer: {
            padding: 16,
            borderTopWidth: 1,
            borderTopColor: colors.border.default,
            backgroundColor: colors.surface.app,
        },
        submitBtn: {
            paddingVertical: 15,
            borderRadius: 14,
            alignItems: 'center',
            backgroundColor: colors.brand.primary,
            shadowColor: colors.brand.dark,
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.25,
            shadowRadius: 8,
            elevation: 5,
        },
        submitBtnText: { color: colors.text.inverse, fontSize: 15, fontWeight: 'bold', letterSpacing: 0.5 },
        fieldError: { borderColor: colors.feedback.danger.solid, borderWidth: 2 },
    }));

    const clearError = (field: string) => {
        if (errors.has(field)) {
            const n = new Set(errors);
            n.delete(field);
            setErrors(n);
        }
    };

    const cyclePriceType = () => {
        const idx = PRICE_TYPES.indexOf(priceType as any);
        setPriceType(PRICE_TYPES[(idx + 1) % PRICE_TYPES.length]);
    };

    const handleSubmit = async () => {
        if (submittingRef.current) return;
        const errs = new Set<string>();
        if (!title.trim()) errs.add('title');
        if (!category) errs.add('category');
        if (!credits.trim() || isNaN(Number(credits)) || Number(credits) < 0) errs.add('credits');
        setErrors(errs);
        if (errs.size > 0) {
            hapticWarning();
            Alert.alert('Missing Fields', 'Please provide a title, category, and price/credits.');
            return;
        }

        if (!groupId) {
            Alert.alert('Error', 'Missing target group identifier');
            return;
        }

        if (!identity?.publicKey) {
            Alert.alert('Authentication Required', 'You must be logged in to create a group post.');
            return;
        }

        submittingRef.current = true;
        setSubmitting(true);
        try {
            await createPost({
                id: Crypto.randomUUID(),
                type,
                title: title.trim(),
                description: description.trim(),
                category,
                credits: Number(credits) || 0,
                price_type: priceType,
                repeatable: repeatable ? 1 : 0,
                cash_also_needed: cashAlsoNeeded ? 1 : 0,
                author_pubkey: identity.publicKey,
                created_at: new Date().toISOString(),
                audienceScope: 'group',
                targetGroupId: groupId,
                reach: 'local',
            });
            hapticSuccess();
            Alert.alert(
                'Post Created',
                `Your post has been shared with ${groupName}.`,
                [{ text: 'OK', onPress: () => router.back() }]
            );
        } catch (err: any) {
            hapticWarning();
            Alert.alert('Error Posting', err.message || 'Failed to create group post');
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    };

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <View style={styles.header}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Back"
                    onPress={() => router.back()}
                    style={styles.backButton}
                >
                    <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.inverse} />
                </Pressable>
                <Text style={styles.headerTitle}>Post to Group</Text>
                <View style={{ width: 40 }} />
            </View>

            {/* No keyboardVerticalOffset: this screen draws its own header (no navigation header), and keyboard-controller
                already measures this view's frame, so an offset only adds that many dp of blank space above the keyboard. */}
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
                <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                    {/* Unmistakable Scope Banner */}
                    <View style={styles.audienceBanner}>
                        <View style={styles.audienceBadgeRow}>
                            <MaterialCommunityIcons name="lock" size={20} color={colors.brand.primary} />
                            <Text style={styles.audienceBannerTitle}>Only {groupName} can see this</Text>
                        </View>
                        <Text style={styles.audienceBannerDesc}>
                            This post will be visible exclusively to active members of {groupName}. It will never appear in the public marketplace feed or on the public map.
                        </Text>
                    </View>

                    {/* Offer / Need Toggle */}
                    <View style={styles.typeSelector}>
                        <Pressable
                            style={[styles.typeBtn, type === 'offer' && styles.typeBtnActiveOffer]}
                            onPress={() => setType('offer')}
                            accessibilityRole="button"
                            accessibilityState={{ selected: type === 'offer' }}
                        >
                            <Text style={[styles.typeBtnText, type === 'offer' && styles.typeBtnTextActive]}>
                                🟢 Offer
                            </Text>
                        </Pressable>
                        <Pressable
                            style={[styles.typeBtn, type === 'need' && styles.typeBtnActiveNeed]}
                            onPress={() => setType('need')}
                            accessibilityRole="button"
                            accessibilityState={{ selected: type === 'need' }}
                        >
                            <Text style={[styles.typeBtnText, type === 'need' && styles.typeBtnTextActive]}>
                                🟠 Need
                            </Text>
                        </Pressable>
                    </View>

                    {/* Title */}
                    <View style={styles.field}>
                        <Text style={styles.label}>TITLE *</Text>
                        <TextInput
                            style={[styles.input, errors.has('title') && styles.fieldError]}
                            value={title}
                            onChangeText={(t) => { setTitle(t); clearError('title'); }}
                            // One line at 320dp + 1.3x: a longer placeholder wraps and its second line is clipped on Android.
                            placeholder={type === 'offer' ? 'e.g. Garden tools lending' : 'e.g. Help moving soil'}
                            placeholderTextColor={colors.text.muted}
                            maxLength={80}
                        />
                    </View>

                    {/* Category */}
                    <View style={styles.field}>
                        <Text style={styles.label}>CATEGORY *</Text>
                        <Pressable
                            style={[styles.input, styles.pickerRow, errors.has('category') && styles.fieldError]}
                            onPress={() => setShowCategoryPicker(true)}
                        >
                            <Text style={styles.pickerText}>
                                {categoryEmoji(category)} {categoryLabel(category)}
                            </Text>
                            <MaterialCommunityIcons name="chevron-down" size={20} color={colors.text.secondary} />
                        </Pressable>
                    </View>

                    {/* Price / Credits */}
                    <View style={styles.field}>
                        <Text style={styles.label}>PRICE (BEANS) *</Text>
                        <View style={styles.priceRow}>
                            <TextInput
                                style={[styles.input, styles.priceInput, errors.has('credits') && styles.fieldError]}
                                value={credits}
                                onChangeText={(c) => { setCredits(c); clearError('credits'); }}
                                placeholder="0"
                                placeholderTextColor={colors.text.muted}
                                keyboardType="numeric"
                            />
                            <Pressable style={styles.priceTypeBtn} onPress={cyclePriceType}>
                                <Text style={styles.priceTypeText}>{PRICE_TYPE_LABEL[priceType] || 'Total'}</Text>
                            </Pressable>
                        </View>
                    </View>

                    {/* Description */}
                    <View style={styles.field}>
                        <Text style={styles.label}>DESCRIPTION</Text>
                        <TextInput
                            style={[styles.input, styles.textarea]}
                            value={description}
                            onChangeText={setDescription}
                            placeholder="Add details, instructions, or notes for group members..."
                            placeholderTextColor={colors.text.muted}
                            multiline
                            textAlignVertical="top"
                        />
                    </View>

                    {/* Repeatable Toggle */}
                    <Pressable
                        style={styles.toggleRow}
                        onPress={() => setRepeatable(!repeatable)}
                        accessibilityRole="button"
                    >
                        <View style={[styles.checkbox, repeatable && styles.checkboxOn]}>
                            {repeatable && <MaterialCommunityIcons name="check" size={16} color={colors.text.inverse} />}
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.toggleLabel}>🔁 Recurring Post</Text>
                            <Text style={styles.toggleHint}>Stays active after trade is completed</Text>
                        </View>
                    </Pressable>

                    {/* Cash Also Needed Toggle */}
                    <Pressable
                        style={[styles.toggleRow, { marginTop: 14 }]}
                        onPress={() => setCashAlsoNeeded(!cashAlsoNeeded)}
                        accessibilityRole="button"
                    >
                        <View style={[styles.checkbox, cashAlsoNeeded && styles.checkboxOn]}>
                            {cashAlsoNeeded && <MaterialCommunityIcons name="check" size={16} color={colors.text.inverse} />}
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.toggleLabel}>💸 Cash Also Needed</Text>
                            <Text style={styles.toggleHint}>At cost for fuel or materials (agreed in chat)</Text>
                        </View>
                    </Pressable>
                </ScrollView>

                {/* Inside the KeyboardAvoidingView (as on treasury-post) so the Post button rides above the keyboard
                    instead of being hidden behind it while typing. */}
                <View style={styles.footer}>
                    <Pressable
                        style={styles.submitBtn}
                        onPress={handleSubmit}
                        disabled={submitting}
                        accessibilityRole="button"
                    >
                        {submitting ? (
                            <ActivityIndicator color={colors.text.inverse} />
                        ) : (
                            <Text style={styles.submitBtnText} numberOfLines={1}>Post to {groupName}</Text>
                        )}
                    </Pressable>
                </View>
            </KeyboardAvoidingView>

            <CategoryPickerSheet
                visible={showCategoryPicker}
                onClose={() => setShowCategoryPicker(false)}
                selected={category}
                onSelect={(cat) => {
                    setCategory(cat);
                    clearError('category');
                    setShowCategoryPicker(false);
                }}
            />
        </SafeAreaView>
    );
}
