import React, { useState, useRef } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, ErrorBoundary } from 'expo-router';

export { ErrorBoundary };
import * as Crypto from 'expo-crypto';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { createPost } from '../utils/db';
import { useIdentity } from './IdentityContext';
import { CategoryPickerSheet } from '../components/CategoryPickerSheet';
import { PostPhotoRow } from '../components/PostPhotoRow';
import { categoryEmoji, categoryLabel } from '../constants/categories';
import { useTheme, useStyles } from './ThemeContext';
import { hapticSuccess, hapticWarning } from '../utils/haptics';
import { useNodeProfile } from '../utils/use-node-profile';
import { beansOn, showcaseMode } from '../utils/node-profile';
import { NO_BEANS_EDIT_NOTE } from '../utils/market-global';
import { LocalCommunityMark } from '../components/showcase/LocalCommunityMark';
import { LOCAL_COMMUNITY_LINES, inCapitalsOf, t, word, type WordKey } from '@beanpool/core';
import { groupPostPrice, groupPostPriceInvalid, groupPostMissingFields } from '../utils/beans-off';
import { signedRequestWords } from '../components/signed-request-lines';

const PRICE_TYPES = ['fixed', 'hourly', 'daily', 'weekly', 'monthly'] as const;
/** The price box's unit: marked here, translated where shown (the same words as an enterprise's post form). */
const PRICE_TYPE_LABEL: Record<string, WordKey> = {
    fixed: word('Total', 'price unit'), hourly: word('/hr'), daily: word('/day'), weekly: word('/wk'), monthly: word('/mo'),
};
/** Sentences marked elsewhere, translated here where they are shown. */
const LINES = { noBeansEditNote: NO_BEANS_EDIT_NOTE, price: LOCAL_COMMUNITY_LINES.price };

/** The price unit's words, "Total" for a type this screen does not list. */
function priceUnit(priceType: string): string {
    return Object.prototype.hasOwnProperty.call(PRICE_TYPE_LABEL, priceType) ? t(PRICE_TYPE_LABEL[priceType]) : t(PRICE_TYPE_LABEL.fixed);
}

export default function GroupPostScreen() {
    const params = useLocalSearchParams<{ groupId?: string | string[]; groupName?: string | string[] }>();
    const groupId = Array.isArray(params.groupId) ? params.groupId[0] : params.groupId;
    const rawGroupName = Array.isArray(params.groupName) ? params.groupName[0] : params.groupName;
    // The name its members gave it, as written; the word only when the screen was opened without one.
    const groupName = rawGroupName || t('Group');
    const { identity } = useIdentity();
    const { theme, colors } = useTheme();

    const [type, setType] = useState<'offer' | 'need'>('offer');
    const [title, setTitle] = useState('');
    const [category, setCategory] = useState('general');
    const [credits, setCredits] = useState('');
    const [priceType, setPriceType] = useState<string>('fixed');
    // On a community with Beans off (the worldwide one) a post has no price: no field, and it goes up at 0 Beans.
    const nodeProfile = useNodeProfile();
    const showsBeans = beansOn(nodeProfile?.features);
    // Where Beans are a preview (the worldwide one's showcase), the note is followed by the marker's price line, as on a listing.
    const beansPreview = showcaseMode('beans', nodeProfile?.features) === 'preview';
    const [description, setDescription] = useState('');
    const [photos, setPhotos] = useState<string[]>([]);
    const [repeatable, setRepeatable] = useState(false);
    const [cashAlsoNeeded, setCashAlsoNeeded] = useState(false);
    const [showCategoryPicker, setShowCategoryPicker] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false);
    const [errors, setErrors] = useState<Set<string>>(new Set());
    const [toast, setToast] = useState('');

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
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
        headerTitle: { fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5 },
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
            backgroundColor: colors.brand.fill,
            borderColor: colors.brand.primary,
        },
        typeBtnActiveNeed: {
            backgroundColor: colors.action.fab,
            borderColor: colors.action.fab,
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
        checkboxOn: { backgroundColor: colors.brand.fill, borderColor: colors.brand.primary },
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
            backgroundColor: colors.brand.fill,
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
        if (groupPostPriceInvalid(credits, nodeProfile?.features)) errs.add('credits');
        if (photos.length === 0) errs.add('photos');
        setErrors(errs);
        if (errs.size > 0) {
            hapticWarning();
            if (errs.has('photos') && errs.size === 1) {
                Alert.alert(t('Missing Photo'), t('Add a photo first'));
            } else {
                Alert.alert(t('Missing Fields'), groupPostMissingFields(nodeProfile?.features));
            }
            return;
        }

        if (!groupId) {
            Alert.alert(t('Error'), t('Missing target group identifier'));
            return;
        }

        if (!identity?.publicKey) {
            Alert.alert(t('Authentication Required'), t('You must be logged in to create a group post.'));
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
                ...groupPostPrice(credits, priceType, nodeProfile?.features),
                photos: photos.length > 0 ? JSON.stringify(photos) : null,
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
                t('Post Created'),
                t('Your post has been shared with {name}.', { name: groupName }),
                [{ text: t('OK'), onPress: () => router.back() }]
            );
        } catch (err: any) {
            hapticWarning();
            Alert.alert(t('Error Posting'), err.message ? signedRequestWords(err.message) : t('Failed to create group post'));
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
                    accessibilityLabel={t('Back')}
                    onPress={() => router.back()}
                    style={styles.backButton}
                >
                    <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.inverse} />
                </Pressable>
                <Text style={[styles.headerTitle, { flexShrink: 1, textAlign: 'center' }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{inCapitalsOf(t('Post to Group'))}</Text>
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
                            <Text style={[styles.audienceBannerTitle, { flexShrink: 1 }]}>{t('Only {name} can see this', { name: groupName })}</Text>
                        </View>
                        <Text style={styles.audienceBannerDesc}>
                            {t('This post will be visible exclusively to active members of {name}. It will never appear in the public marketplace feed or on the public map.', { name: groupName })}
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
                            <Text style={[styles.typeBtnText, type === 'offer' && styles.typeBtnTextActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                                {t('🟢 Offer')}
                            </Text>
                        </Pressable>
                        <Pressable
                            style={[styles.typeBtn, type === 'need' && styles.typeBtnActiveNeed]}
                            onPress={() => setType('need')}
                            accessibilityRole="button"
                            accessibilityState={{ selected: type === 'need' }}
                        >
                            <Text style={[styles.typeBtnText, type === 'need' && styles.typeBtnTextActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                                {t('🟠 Need')}
                            </Text>
                        </Pressable>
                    </View>

                    {/* Title */}
                    <View style={styles.field}>
                        <Text style={styles.label}>{t('TITLE *')}</Text>
                        <TextInput
                            style={[styles.input, errors.has('title') && styles.fieldError]}
                            value={title}
                            onChangeText={(text) => { setTitle(text); clearError('title'); }}
                            // One line at 320dp + 1.3x: a longer placeholder wraps and its second line is clipped on Android.
                            placeholder={type === 'offer' ? t('e.g. Garden tools lending') : t('e.g. Help moving soil')}
                            placeholderTextColor={colors.text.muted}
                            maxLength={80}
                        />
                    </View>

                    {/* Category */}
                    <View style={styles.field}>
                        <Text style={styles.label}>{t('CATEGORY *')}</Text>
                        <Pressable
                            style={[styles.input, styles.pickerRow, errors.has('category') && styles.fieldError]}
                            onPress={() => setShowCategoryPicker(true)}
                            accessibilityRole="button"
                            accessibilityLabel={t('Category: {category}', { category: categoryLabel(category) })}
                            accessibilityHint={t('Opens category picker sheet')}
                        >
                            <Text style={[styles.pickerText, { flexShrink: 1 }]}>
                                {categoryEmoji(category)} {categoryLabel(category)}
                            </Text>
                            <MaterialCommunityIcons name="chevron-down" size={20} color={colors.text.secondary} />
                        </Pressable>
                    </View>

                    {/* Price / Credits; where there are no Beans, a note instead */}
                    {showsBeans ? (
                    <View style={styles.field}>
                        <Text style={styles.label}>{t('PRICE (BEANS) *')}</Text>
                        <View style={styles.priceRow}>
                            <TextInput
                                style={[styles.input, styles.priceInput, errors.has('credits') && styles.fieldError]}
                                value={credits}
                                onChangeText={(c) => { setCredits(c); clearError('credits'); }}
                                placeholder="0"
                                placeholderTextColor={colors.text.muted}
                                keyboardType="numeric"
                            />
                            <Pressable
                                style={styles.priceTypeBtn}
                                onPress={cyclePriceType}
                                accessibilityRole="button"
                                accessibilityLabel={t('Price unit: {unit}', { unit: priceUnit(priceType) })}
                                accessibilityHint={t('Cycles price unit')}
                            >
                                <Text style={styles.priceTypeText}>{priceUnit(priceType)}</Text>
                            </Pressable>
                        </View>
                    </View>
                    ) : (
                    <View style={styles.field}>
                        <Text style={{ color: colors.text.secondary, fontSize: 13, lineHeight: 18 }}>{t(LINES.noBeansEditNote)}</Text>
                        {beansPreview && <LocalCommunityMark variant="line" feature="beans" text={t(LINES.price)} />}
                    </View>
                    )}

                    {/* Description */}
                    <View style={styles.field}>
                        <Text style={styles.label}>{t('DESCRIPTION')}</Text>
                        <TextInput
                            style={[styles.input, styles.textarea]}
                            value={description}
                            onChangeText={setDescription}
                            placeholder={t('Add details, instructions, or notes for group members...')}
                            placeholderTextColor={colors.text.muted}
                            multiline
                            textAlignVertical="top"
                        />
                    </View>

                    {/* Photos */}
                    <View style={styles.field}>
                        <PostPhotoRow
                            photos={photos}
                            onChange={(p) => {
                                setPhotos(p);
                                if (p.length > 0) clearError('photos');
                            }}
                            testID="group-post-photos"
                            required
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
                            <Text style={styles.toggleLabel}>{t('🔁 Recurring Post')}</Text>
                            <Text style={styles.toggleHint}>{t('Stays active after trade is completed')}</Text>
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
                            <Text style={styles.toggleLabel}>{t('💸 Cash Also Needed')}</Text>
                            <Text style={styles.toggleHint}>{t('At cost for fuel or materials (agreed in chat)')}</Text>
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
                        accessibilityLabel={submitting ? t('Posting...') : t('Post to {name}', { name: groupName })}
                        accessibilityState={{ disabled: submitting, busy: submitting }}
                    >
                        {submitting ? (
                            <ActivityIndicator color={colors.text.inverse} />
                        ) : (
                            <Text style={styles.submitBtnText} numberOfLines={1}>{t('Post to {name}', { name: groupName })}</Text>
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
