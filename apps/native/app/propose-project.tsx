import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, Alert, ActivityIndicator, Image } from 'react-native';
import { KeyboardAvoidingView, KeyboardController, useKeyboardState } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { createEnterpriseApi } from '../utils/db';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CurrencyDisplay } from '../components/CurrencyDisplay';
import { palette } from '../constants/colors';
import { useTheme, useStyles } from './ThemeContext';

export default function ProposeProjectModal() {
    const { theme, colors } = useTheme();
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'flex-start' },
        headerTitle: { fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5, textTransform: 'uppercase' },
        infoBox: { flexDirection: 'row', backgroundColor: theme === 'dark' ? colors.brand.tint : palette.emerald50, padding: 16, borderRadius: 12, marginBottom: 20, borderWidth: 1, borderColor: theme === 'dark' ? colors.brand.primary : palette.emerald200 },
        infoText: { flex: 1, fontSize: 13, color: theme === 'dark' ? colors.text.body : palette.emerald800, lineHeight: 19 },
        scroll: { padding: 20 },
        field: { marginBottom: 20 },
        label: { fontSize: 11, fontWeight: 'bold', color: theme === 'dark' ? colors.text.secondary : palette.gray700, letterSpacing: 0.5, marginBottom: 8 },
        hint: { fontSize: 12, color: colors.text.secondary, marginTop: 6 },
        input: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, padding: 14, fontSize: 15, color: colors.text.body },
        priceInput: { fontSize: 22, fontWeight: 'bold', color: colors.brand.primary },
        textarea: { height: 120, paddingTop: 14 },
        typeSelectorRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
        typeBtn: { flex: 1, padding: 14, borderRadius: 12, borderWidth: 1.5, borderColor: colors.border.default, backgroundColor: colors.surface.card },
        typeBtnActive: { borderColor: colors.brand.primary, backgroundColor: colors.brand.tint },
        typeBtnTitle: { fontSize: 14, fontWeight: 'bold', color: colors.text.heading, marginBottom: 4 },
        typeBtnDesc: { fontSize: 11, color: colors.text.secondary, lineHeight: 15 },
        footer: { padding: 20, borderTopWidth: 1, borderTopColor: colors.border.default, backgroundColor: colors.surface.app },
        submitBtn: { paddingVertical: 16, borderRadius: 14, alignItems: 'center', backgroundColor: colors.brand.primary, shadowColor: colors.brand.dark, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 5 },
        submitBtnText: { color: colors.text.inverse, fontSize: 14, fontWeight: 'bold', letterSpacing: 0.5 },
        toast: { position: 'absolute', bottom: 100, left: 20, right: 20, backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : palette.amber100, borderColor: theme === 'dark' ? colors.feedback.warning.border : palette.amber500, borderWidth: 1, padding: 12, borderRadius: 12, alignItems: 'center' },
        toastText: { color: theme === 'dark' ? colors.feedback.warning.fg : palette.amber800, fontWeight: '700', fontSize: 13 },
    }));

    const [lifecycle, setLifecycle] = useState<'bounded' | 'ongoing'>('bounded');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [goalAmount, setGoalAmount] = useState('');
    const [deadlineDate, setDeadlineDate] = useState<Date | null>(null);
    const [showPicker, setShowPicker] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false);
    const [photos, setPhotos] = useState<string[]>([]);
    const [validationErrors, setValidationErrors] = useState<Set<string>>(new Set());
    const [validationToast, setValidationToast] = useState('');
    const keyboardVisible = useKeyboardState(s => s.isVisible);

    const [maxExpiryDays, setMaxExpiryDays] = useState<number>(365);
    useEffect(() => {
        AsyncStorage.getItem('beanpool_max_expiry_days').then(val => {
            if (val) setMaxExpiryDays(Number(val));
        });
    }, []);

    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + maxExpiryDays);

    const fieldBorder = (field: string) => validationErrors.has(field) ? { borderColor: colors.feedback.danger.solid, borderWidth: 2 } : {};

    const handleSubmit = async () => {
        if (submittingRef.current) return;
        // An Alert opened over a raised keyboard leaves phantom keyboard-height padding behind.
        await KeyboardController.dismiss();

        const errors = new Set<string>();
        if (!title.trim() || title.trim().length < 2) errors.add('title');
        if (!description.trim()) errors.add('description');
        if (lifecycle === 'bounded') {
            if (!goalAmount.trim() || isNaN(Number(goalAmount)) || Number(goalAmount) <= 0) errors.add('goalAmount');
        }
        setValidationErrors(errors);
        if (errors.size > 0) {
            setValidationToast('⚠️ Please complete all required fields');
            setTimeout(() => setValidationToast(''), 3000);
            return;
        }

        let parsedDeadline = null;
        if (lifecycle === 'bounded' && deadlineDate) {
            parsedDeadline = deadlineDate.toISOString();
        }

        submittingRef.current = true;
        setSubmitting(true);
        try {
            await createEnterpriseApi({
                name: title.trim(),
                purpose: description.trim(),
                description: description.trim(),
                lifecycle,
                goalAmount: lifecycle === 'bounded' ? (parseInt(goalAmount, 10) || 0) : null,
                deadlineAt: parsedDeadline,
                photos,
                avatar: photos.length > 0 ? photos[0] : undefined,
            });
            Alert.alert(
                "Initiative Started 🌱",
                lifecycle === 'bounded' 
                    ? "Your bounded project has been created and is now open for community backing."
                    : "Your community enterprise has been established in the Commons.",
                [{ text: "OK", onPress: () => router.back() }]
            );
        } catch (e: any) {
            Alert.alert("Creation Failed", e.message || "Could not start enterprise.");
        } finally {
            setSubmitting(false);
            submittingRef.current = false;
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style="dark" />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Close">
                    <MaterialCommunityIcons name="close" size={28} color={colors.text.inverse} />
                </Pressable>
                <Text style={styles.headerTitle}>Start an Enterprise / Project</Text>
                <View style={{ width: 40 }} />
            </View>

            {/* No keyboardVerticalOffset: this KeyboardAvoidingView measures its own frame against the
                window, so the header above it is already accounted for. The old offset of 64 added 64dp of
                dead padding above the keyboard. With the footer also showing, a 320dp phone at 1.2x font was
                left with a ~25dp strip of form and the name field out of sight. */}
            <KeyboardAvoidingView
                behavior="padding"
                style={{ flex: 1 }}
            >
                <ScrollView contentContainerStyle={styles.scroll}>
                    <View style={styles.infoBox}>
                        <MaterialCommunityIcons name="information" size={20} color={colors.brand.primary} style={{ marginRight: 8 }} />
                        <Text style={styles.infoText}>
                            Community enterprises trade, produce, and steward shared initiatives. Bounded initiatives raise beans toward specific community goals.
                        </Text>
                    </View>

                    {/* Initiative Type Selector */}
                    <View style={styles.field}>
                        <Text style={styles.label}>INITIATIVE TYPE</Text>
                        <View style={styles.typeSelectorRow}>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="Bounded Project: Has funding goal and deadline"
                                accessibilityState={{ selected: lifecycle === 'bounded' }}
                                style={[styles.typeBtn, lifecycle === 'bounded' && styles.typeBtnActive]}
                                onPress={() => setLifecycle('bounded')}
                            >
                                <Text style={styles.typeBtnTitle}>🌱 Bounded Project</Text>
                                <Text style={styles.typeBtnDesc}>Has funding goal and optional deadline</Text>
                            </Pressable>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="Ongoing Enterprise: Permanent co-op or facility"
                                accessibilityState={{ selected: lifecycle === 'ongoing' }}
                                style={[styles.typeBtn, lifecycle === 'ongoing' && styles.typeBtnActive]}
                                onPress={() => setLifecycle('ongoing')}
                            >
                                <Text style={styles.typeBtnTitle}>🏛️ Ongoing</Text>
                                <Text style={styles.typeBtnDesc}>Permanent co-op or community facility</Text>
                            </Pressable>
                        </View>
                    </View>

                    {/* Name / Title */}
                    <View style={styles.field}>
                        <Text style={styles.label}>NAME / TITLE *</Text>
                        <TextInput
                            accessibilityLabel="Enterprise name or project title"
                            style={[styles.input, fieldBorder('title')]}
                            // Short enough for one line at 320dp + 1.3x: Android wraps a long placeholder inside a
                            // one-line input and clips the second line.
                            placeholder="e.g. Community Tool Shed"
                            placeholderTextColor={colors.text.muted}
                            value={title}
                            onChangeText={(v) => { setTitle(v); if (validationErrors.has('title')) { const n = new Set(validationErrors); n.delete('title'); setValidationErrors(n); } }}
                            maxLength={60}
                        />
                    </View>

                    {/* Purpose Statement (required per docs/the-commons.md §2.1) */}
                    <View style={styles.field}>
                        <Text style={styles.label}>PURPOSE STATEMENT *</Text>
                        <TextInput
                            accessibilityLabel="Purpose statement"
                            style={[styles.input, styles.textarea, fieldBorder('description')]}
                            placeholder="State clearly what this enterprise exists to do (e.g. 'We build and maintain a communal shade house by November')."
                            placeholderTextColor={colors.text.muted}
                            value={description}
                            onChangeText={(v) => { setDescription(v); if (validationErrors.has('description')) { const n = new Set(validationErrors); n.delete('description'); setValidationErrors(n); } }}
                            multiline
                            textAlignVertical="top"
                        />
                        <Text style={styles.hint}>The purpose statement is what the community judges the initiative against.</Text>
                    </View>

                    {/* Bounded Project Fields: Goal & Deadline */}
                    {lifecycle === 'bounded' && (
                        <>
                            <View style={styles.field}>
                                <Text style={styles.label}>FUNDING GOAL (<CurrencyDisplay hideAmount={true} />) *</Text>
                                <TextInput
                                    accessibilityLabel="Funding goal amount"
                                    style={[styles.input, styles.priceInput, fieldBorder('goalAmount')]}
                                    placeholder="0"
                                    placeholderTextColor={colors.text.muted}
                                    keyboardType="numeric"
                                    value={goalAmount}
                                    onChangeText={(v) => { setGoalAmount(v); if (validationErrors.has('goalAmount')) { const n = new Set(validationErrors); n.delete('goalAmount'); setValidationErrors(n); } }}
                                    maxLength={6}
                                />
                                <Text style={styles.hint}>Pledges are held safely in the enterprise account.</Text>
                            </View>

                            <View style={styles.field}>
                                <Text style={styles.label}>FUNDING DEADLINE (OPTIONAL)</Text>
                                <Pressable
                                    style={[styles.input, { justifyContent: 'center' }]}
                                    onPress={() => setShowPicker(true)}
                                    accessibilityRole="button"
                                    accessibilityLabel={deadlineDate ? `Funding deadline: ${deadlineDate.toISOString().split('T')[0]}` : "Select funding deadline date"}
                                >
                                    <Text style={{ color: deadlineDate ? colors.text.heading : colors.text.muted, fontSize: 15 }}>
                                        {deadlineDate ? deadlineDate.toISOString().split('T')[0] : "Select Deadline Date (Optional)"}
                                    </Text>
                                </Pressable>
                                {showPicker && (
                                    <DateTimePicker
                                        value={deadlineDate || new Date()}
                                        mode="date"
                                        display="default"
                                        minimumDate={new Date()}
                                        maximumDate={maxDate}
                                        onChange={(event: DateTimePickerEvent, selectedDate?: Date) => {
                                            setShowPicker(false);
                                            if (event.type === 'set' && selectedDate) {
                                                setDeadlineDate(selectedDate);
                                            }
                                        }}
                                    />
                                )}
                                {deadlineDate && (
                                    <Pressable
                                        onPress={() => setDeadlineDate(null)}
                                        style={{ marginTop: 4 }}
                                        accessibilityRole="button"
                                        accessibilityLabel="Clear deadline"
                                    >
                                        <Text style={{ fontSize: 12, color: colors.feedback.danger.solid }}>Clear deadline</Text>
                                    </Pressable>
                                )}
                            </View>
                        </>
                    )}

                    {/* Photos / Avatar */}
                    <View style={styles.field}>
                        <Text style={styles.label}>COVER PHOTO / AVATAR (OPTIONAL)</Text>
                        <View style={{ flexDirection: 'row', gap: 10, marginTop: 4, padding: 4 }}>
                            {photos.map((uri, idx) => (
                                uri && typeof uri === 'string' && uri.trim() !== '' && uri !== 'null' && uri !== 'undefined' ? (
                                    <View key={idx} style={{ position: 'relative' }}>
                                        <Image source={{ uri }} style={{ width: 80, height: 80, borderRadius: 12, backgroundColor: colors.surface.subtle }} accessibilityLabel="Initiative photo" />
                                        <Pressable
                                            onPress={() => setPhotos(prev => prev.filter((_, i) => i !== idx))}
                                            style={{ position: 'absolute', top: -5, right: -5, backgroundColor: colors.feedback.danger.solid, borderRadius: 12, width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}
                                            accessibilityRole="button"
                                            accessibilityLabel="Remove photo"
                                        >
                                            <MaterialCommunityIcons name="close" size={16} color={colors.text.inverse} />
                                        </Pressable>
                                    </View>
                                ) : null
                            ))}
                            {photos.length < 3 && (
                                <Pressable 
                                    onPress={async () => {
                                        const res = await ImagePicker.launchImageLibraryAsync({
                                            mediaTypes: ['images'],
                                            allowsEditing: true,
                                            aspect: [16, 9],
                                            quality: 0.8,
                                            base64: false,
                                        });
                                        if (!res.canceled && res.assets[0].uri) {
                                            const manipResult = await ImageManipulator.manipulateAsync(
                                                res.assets[0].uri,
                                                [{ resize: { width: 800 } }],
                                                { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
                                            );
                                            if (manipResult.base64) {
                                                setPhotos(prev => [...prev, `data:image/jpeg;base64,${manipResult.base64}`]);
                                            }
                                        }
                                    }}
                                    style={{ width: 80, height: 80, borderRadius: 12, borderWidth: 2, borderColor: colors.border.default, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface.app }}
                                    accessibilityRole="button"
                                    accessibilityLabel="Add photo"
                                >
                                    <MaterialCommunityIcons name="image-plus" size={28} color={colors.text.muted} />
                                </Pressable>
                            )}
                        </View>
                    </View>

                </ScrollView>

                {validationToast ? (
                    <View style={styles.toast}>
                        <Text style={styles.toastText}>{validationToast}</Text>
                    </View>
                ) : null}

                {/* Hidden while typing so the form, not the button, gets the space above the keyboard.
                    Back, the keyboard's done key, or a tap elsewhere in the form closes it and brings the button back. */}
                {!keyboardVisible && (
                    <View style={styles.footer}>
                        <Pressable
                            style={styles.submitBtn}
                            onPress={handleSubmit}
                            disabled={submitting}
                            accessibilityRole="button"
                            accessibilityLabel={submitting ? "Starting enterprise..." : "Start Enterprise"}
                            accessibilityState={{ disabled: submitting, busy: submitting }}
                        >
                            {submitting ? (
                                <ActivityIndicator color={colors.text.inverse} />
                            ) : (
                                <Text style={styles.submitBtnText}>START INITIATIVE 🌱</Text>
                            )}
                        </Pressable>
                    </View>
                )}
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}
