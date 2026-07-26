import React, { useState, useRef } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { treasuryPostOffer, treasuryPostNeed } from '../utils/db';
import { CategoryPickerSheet } from '../components/CategoryPickerSheet';
import { categoryEmoji, categoryLabel } from '../constants/categories';
import { useTheme, useStyles } from './ThemeContext';

// Operator form to post a treasury's Offer (what the enterprise sells, e.g. a dozen eggs) or a
// Need (a tender the treasury pays for, e.g. tending the flock). Mirrors propose-project.tsx.
// The treasury id rides the params → the signed operator route; the operator signs on the
// treasury's behalf.
const PRICE_TYPES = ['fixed', 'hourly', 'daily', 'weekly', 'monthly'] as const;
const PRICE_TYPE_LABEL: Record<string, string> = { fixed: 'Total', hourly: '/hr', daily: '/day', weekly: '/wk', monthly: '/mo' };

export default function TreasuryPostScreen() {
    const params = useLocalSearchParams<{ treasury: string; mode?: string; name?: string }>();
    const isNeed = params.mode === 'need';
    const treasuryName = params.name || 'this treasury';
    const { theme, colors } = useTheme();

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'flex-start' },
        headerTitle: { fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5, textTransform: 'uppercase' },
        scroll: { padding: 20 },
        infoBox: { flexDirection: 'row', backgroundColor: colors.brand.tint, padding: 14, borderRadius: 12, marginBottom: 24, borderWidth: 1, borderColor: colors.brand.primary },
        infoText: { flex: 1, fontSize: 13, color: colors.text.body, lineHeight: 20 },
        field: { marginBottom: 22 },
        label: { fontSize: 11, fontWeight: 'bold', color: colors.text.secondary, letterSpacing: 1, marginBottom: 8 },
        hint: { fontSize: 12, color: colors.text.secondary, marginTop: 6 },
        input: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, padding: 16, fontSize: 16, color: colors.text.body },
        pickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
        pickerText: { fontSize: 16, color: colors.text.heading },
        pickerPlaceholder: { fontSize: 16, color: colors.text.muted },
        priceRow: { flexDirection: 'row', gap: 10 },
        priceInput: { flex: 1, fontSize: 24, fontWeight: 'bold', color: colors.brand.primary },
        priceTypeBtn: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 18, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12 },
        priceTypeText: { fontSize: 14, fontWeight: '700', color: colors.text.body },
        textarea: { height: 130, paddingTop: 16 },
        toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
        checkbox: { width: 26, height: 26, borderRadius: 7, borderWidth: 2, borderColor: colors.border.strong, alignItems: 'center', justifyContent: 'center' },
        checkboxOn: { backgroundColor: colors.brand.primary, borderColor: colors.brand.primary },
        toggleLabel: { fontSize: 15, color: colors.text.body, fontWeight: '600' },
        footer: { padding: 20, borderTopWidth: 1, borderTopColor: colors.border.default, backgroundColor: colors.surface.app },
        submitBtn: { paddingVertical: 16, borderRadius: 14, alignItems: 'center', backgroundColor: colors.brand.primary, shadowColor: colors.brand.dark, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 5 },
        submitBtnText: { color: colors.text.inverse, fontSize: 15, fontWeight: 'bold', letterSpacing: 1 },
        toast: { position: 'absolute', bottom: 100, left: 20, right: 20, backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border, borderWidth: 1, padding: 12, borderRadius: 12, alignItems: 'center' },
        toastText: { color: colors.feedback.warning.fg, fontWeight: '700', fontSize: 13 },
        fieldError: { borderColor: colors.feedback.danger.solid, borderWidth: 2 },
    }));

    const [title, setTitle] = useState('');
    const [category, setCategory] = useState('');
    const [credits, setCredits] = useState('');
    const [priceType, setPriceType] = useState<string>('fixed');
    const [description, setDescription] = useState('');
    const [repeatable, setRepeatable] = useState(!isNeed); // offers recur by default; needs don't
    const [showCategoryPicker, setShowCategoryPicker] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false);
    const [errors, setErrors] = useState<Set<string>>(new Set());
    const [toast, setToast] = useState('');

    const clearError = (field: string) => {
        if (errors.has(field)) { const n = new Set(errors); n.delete(field); setErrors(n); }
    };
    const fieldBorder = (field: string) => errors.has(field) ? styles.fieldError : null;

    const cyclePriceType = () => {
        const idx = PRICE_TYPES.indexOf(priceType as any);
        setPriceType(PRICE_TYPES[(idx + 1) % PRICE_TYPES.length]);
    };

    const handleSubmit = async () => {
        if (submittingRef.current) return;
        const errs = new Set<string>();
        if (!title.trim()) errs.add('title');
        if (!category) errs.add('category');
        if (!credits.trim() || isNaN(Number(credits)) || Number(credits) <= 0) errs.add('credits');
        setErrors(errs);
        if (errs.size > 0) {
            setToast('⚠️ Add a title, category and price');
            setTimeout(() => setToast(''), 3000);
            return;
        }

        submittingRef.current = true;
        setSubmitting(true);
        if (!params.treasury) {
            Alert.alert('Error', 'Missing treasury public key');
            submittingRef.current = false;
            setSubmitting(false);
            return;
        }
        const body = {
            category,
            title: title.trim(),
            description: description.trim(),
            credits: Number(credits),
            priceType,
            repeatable,
        };
        try {
            if (isNeed) {
                await treasuryPostNeed(params.treasury, body);
            } else {
                await treasuryPostOffer(params.treasury, body);
            }
            Alert.alert(
                isNeed ? 'Need posted' : 'Offer posted',
                isNeed
                    ? `${treasuryName} is now looking for help — members can bid on this tender.`
                    : `${treasuryName} is now offering "${body.title}" in the Market.`,
                [{ text: 'OK', onPress: () => router.back() }]
            );
        } catch (e: any) {
            Alert.alert(isNeed ? 'Could not post need' : 'Could not post offer', e.message || 'Something went wrong.');
        } finally {
            setSubmitting(false);
            submittingRef.current = false;
        }
    };

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Close">
                    <MaterialCommunityIcons name="close" size={26} color={colors.text.inverse} />
                </Pressable>
                <Text style={styles.headerTitle}>{isNeed ? 'Post a Need' : 'Post an Offer'}</Text>
                <View style={{ width: 40 }} />
            </View>

            <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={64} style={{ flex: 1 }}>
                <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                    <View style={styles.infoBox}>
                        <MaterialCommunityIcons name={isNeed ? 'hand-extended' : 'tag'} size={20} color={colors.brand.primary} style={{ marginRight: 10 }} />
                        <Text style={styles.infoText}>
                            {isNeed
                                ? `Posting on behalf of ${treasuryName}. Members can bid to fulfil this tender; you approve a bid and release payment when it's done — funded by the treasury's credit line.`
                                : `Posting on behalf of ${treasuryName}. This lists in the Market like any offer; income from sales lands in the treasury's balance.`}
                        </Text>
                    </View>

                    {/* Title */}
                    <View style={styles.field}>
                        <Text style={styles.label}>{isNeed ? 'WHAT DO YOU NEED?' : 'WHAT ARE YOU OFFERING?'}</Text>
                        <TextInput
                            accessibilityLabel="Title"
                            style={[styles.input, fieldBorder('title')]}
                            placeholder={isNeed ? 'e.g. Tend the community flock' : 'e.g. Dozen free-range eggs'}
                            placeholderTextColor={colors.text.muted}
                            value={title}
                            onChangeText={(v) => { setTitle(v); clearError('title'); }}
                            maxLength={60}
                        />
                    </View>

                    {/* Category */}
                    <View style={styles.field}>
                        <Text style={styles.label}>CATEGORY</Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Choose a category"
                            style={[styles.input, styles.pickerRow, fieldBorder('category')]}
                            onPress={() => setShowCategoryPicker(true)}
                        >
                            {category ? (
                                <Text style={styles.pickerText}>{categoryEmoji(category)}  {categoryLabel(category)}</Text>
                            ) : (
                                <Text style={styles.pickerPlaceholder}>Select a category</Text>
                            )}
                            <MaterialCommunityIcons name="chevron-down" size={22} color={colors.text.muted} />
                        </Pressable>
                    </View>

                    {/* Price */}
                    <View style={styles.field}>
                        <Text style={styles.label}>PRICE (🫘 BEANS)</Text>
                        <View style={styles.priceRow}>
                            <TextInput
                                accessibilityLabel="Price in Beans"
                                style={[styles.input, styles.priceInput, fieldBorder('credits')]}
                                placeholder="0"
                                placeholderTextColor={colors.text.muted}
                                keyboardType="numeric"
                                value={credits}
                                onChangeText={(v) => { setCredits(v); clearError('credits'); }}
                                maxLength={6}
                            />
                            <Pressable style={styles.priceTypeBtn} onPress={cyclePriceType} accessibilityRole="button" accessibilityLabel={`Price type: ${priceType}. Tap to change.`}>
                                <Text style={styles.priceTypeText}>{PRICE_TYPE_LABEL[priceType]}</Text>
                            </Pressable>
                        </View>
                        <Text style={styles.hint}>Tap the box on the right to switch between a fixed total and hourly/daily rates.</Text>
                    </View>

                    {/* Description */}
                    <View style={styles.field}>
                        <Text style={styles.label}>DETAILS (OPTIONAL)</Text>
                        <TextInput
                            accessibilityLabel="Details"
                            style={[styles.input, styles.textarea]}
                            placeholder={isNeed ? 'What does the work involve? Any requirements?' : 'Anything buyers should know…'}
                            placeholderTextColor={colors.text.muted}
                            value={description}
                            onChangeText={setDescription}
                            multiline
                            textAlignVertical="top"
                        />
                    </View>

                    {/* Recurring */}
                    <View style={styles.field}>
                        <Pressable style={styles.toggleRow} onPress={() => setRepeatable(!repeatable)} accessibilityRole="checkbox" accessibilityState={{ checked: repeatable }}>
                            <View style={[styles.checkbox, repeatable && styles.checkboxOn]}>
                                {repeatable && <MaterialCommunityIcons name="check" size={18} color={colors.text.inverse} />}
                            </View>
                            <Text style={styles.toggleLabel}>Recurring — stays live after each deal</Text>
                        </Pressable>
                        <Text style={styles.hint}>
                            {isNeed
                                ? 'Leave on for an ongoing tender (e.g. weekly flock-tending); off for a one-off job.'
                                : 'Leave on so the offer stays available for the next buyer (e.g. eggs every week).'}
                        </Text>
                    </View>
                </ScrollView>

                {toast ? (
                    <View style={styles.toast}><Text style={styles.toastText}>{toast}</Text></View>
                ) : null}

                <View style={styles.footer}>
                    <Pressable style={styles.submitBtn} onPress={handleSubmit} disabled={submitting} accessibilityRole="button">
                        {submitting ? (
                            <ActivityIndicator color={colors.text.inverse} />
                        ) : (
                            <Text style={styles.submitBtnText}>{isNeed ? 'POST NEED' : 'POST OFFER'}</Text>
                        )}
                    </Pressable>
                </View>
            </KeyboardAvoidingView>

            <CategoryPickerSheet
                visible={showCategoryPicker}
                selected={category}
                onSelect={(id) => { setCategory(id); clearError('category'); }}
                onClose={() => setShowCategoryPicker(false)}
            />
        </SafeAreaView>
    );
}
