import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, Alert, ActivityIndicator, Image } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { createProject } from '../utils/db';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import DateTimePicker from '@react-native-community/datetimepicker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CurrencyDisplay } from '../components/CurrencyDisplay';
import { colors, palette } from '../constants/colors';
import { useTheme, useStyles } from './ThemeContext';


export default function ProposeProjectModal() {
    const { theme, colors } = useTheme();
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'flex-start' },
        headerTitle: { fontSize: 18, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 1, textTransform: 'uppercase' },
        infoBox: { flexDirection: 'row', backgroundColor: theme === 'dark' ? colors.brand.tint : palette.emerald50, padding: 16, borderRadius: 12, marginBottom: 24, borderWidth: 1, borderColor: theme === 'dark' ? colors.brand.primary : palette.emerald200 },
        infoText: { flex: 1, fontSize: 14, color: theme === 'dark' ? colors.text.body : palette.emerald800, lineHeight: 22 },
        scroll: { padding: 20 },
        field: { marginBottom: 24 },
        label: { fontSize: 11, fontWeight: 'bold', color: theme === 'dark' ? colors.text.secondary : palette.gray700, letterSpacing: 1, marginBottom: 8 },
        hint: { fontSize: 12, color: colors.text.secondary, marginTop: 6 },
        input: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, padding: 16, fontSize: 16, color: colors.text.body },
        priceInput: { fontSize: 24, fontWeight: 'bold', color: colors.brand.primary },
        textarea: { height: 160, paddingTop: 16 },
        footer: { padding: 20, borderTopWidth: 1, borderTopColor: colors.border.default, backgroundColor: colors.surface.app },
        submitBtn: { paddingVertical: 16, borderRadius: 14, alignItems: 'center', backgroundColor: colors.brand.primary, shadowColor: colors.brand.dark, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 5 },
        submitBtnText: { color: colors.text.inverse, fontSize: 15, fontWeight: 'bold', letterSpacing: 1 },
        toast: { position: 'absolute', bottom: 100, left: 20, right: 20, backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : palette.amber100, borderColor: theme === 'dark' ? colors.feedback.warning.border : palette.amber500, borderWidth: 1, padding: 12, borderRadius: 12, alignItems: 'center' },
        toastText: { color: theme === 'dark' ? colors.feedback.warning.fg : palette.amber800, fontWeight: '700', fontSize: 13 },
    }));

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

    const [maxExpiryDays, setMaxExpiryDays] = useState<number>(365);
    useEffect(() => {
        AsyncStorage.getItem('beanpool_max_expiry_days').then(val => {
            if (val) setMaxExpiryDays(Number(val));
        });
    }, []);

    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + maxExpiryDays);

    const fieldBorder = (field: string) => validationErrors.has(field) ? { borderColor: colors.feedback.danger.solid, borderWidth: 2, shadowColor: colors.feedback.danger.solid, shadowOpacity: 0.3, shadowRadius: 6 } : {};

    const handleSubmit = async () => {
        if (submittingRef.current) return;

        const errors = new Set<string>();
        if (!title.trim()) errors.add('title');
        if (!goalAmount.trim() || isNaN(Number(goalAmount)) || Number(goalAmount) <= 0) errors.add('goalAmount');
        if (!description.trim()) errors.add('description');
        if (!deadlineDate) errors.add('deadline');
        if (photos.length === 0) errors.add('photos');
        setValidationErrors(errors);
        if (errors.size > 0) {
            setValidationToast('⚠️ Please complete all required fields');
            setTimeout(() => setValidationToast(''), 3000);
            return;
        }

        let parsedDeadline = null;
        if (deadlineDate) {
            parsedDeadline = deadlineDate.toISOString();
        }

        submittingRef.current = true;
        setSubmitting(true);
        try {
            await createProject({
                title: title.trim(),
                description: description.trim(),
                goal_amount: parseInt(goalAmount, 10) || 0,
                photos,
                deadline_at: parsedDeadline
            });
            Alert.alert("Proposal Submitted", "Your community project proposal has been broadcast to the network.", [
                { text: "OK", onPress: () => router.back() }
            ]);
        } catch (e: any) {
            Alert.alert("Submission Failed", e.message || "Could not propose project.");
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
                <Text style={styles.headerTitle}>Propose Project</Text>
                <View style={{ width: 40 }} />
            </View>

            <KeyboardAvoidingView
                behavior="padding"
                keyboardVerticalOffset={64}
                style={{ flex: 1 }}
            >
                <ScrollView contentContainerStyle={styles.scroll}>
                    <View style={styles.infoBox}>
                        <MaterialCommunityIcons name="information" size={20} color={colors.brand.primary} style={{ marginRight: 8 }} />
                        <Text style={styles.infoText}>Project proposals must be voted on and approved by the community before any funds are released.</Text>
                    </View>

                    {/* Title */}
                    <View style={styles.field}>
                        <Text style={styles.label}>PROJECT TITLE</Text>
                        <TextInput
                            accessibilityLabel="Project title"
                            style={[styles.input, fieldBorder('title')]}
                            placeholder="e.g. Community Garden Tool Shed"
                            value={title}
                            onChangeText={(v) => { setTitle(v); if (validationErrors.has('title')) { const n = new Set(validationErrors); n.delete('title'); setValidationErrors(n); } }}
                            maxLength={60}
                        />
                    </View>

                    {/* Goal Amount */}
                    <View style={styles.field}>
                        <Text style={styles.label}>FUNDING GOAL (<CurrencyDisplay hideAmount={true} />)</Text>
                        <TextInput
                            accessibilityLabel="Funding goal amount"
                            style={[styles.input, styles.priceInput, fieldBorder('goalAmount')]}
                            placeholder="0"
                            keyboardType="numeric"
                            value={goalAmount}
                            onChangeText={(v) => { setGoalAmount(v); if (validationErrors.has('goalAmount')) { const n = new Set(validationErrors); n.delete('goalAmount'); setValidationErrors(n); } }}
                            maxLength={6}
                        />
                        {/* PWA states "Commons allocation limit bounds this locally". */}
                        <Text style={styles.hint}>Amount requested from the community pool.</Text>
                    </View>

                    {/* Deadline */}
                    <View style={styles.field}>
                        <Text style={styles.label}>FUNDING DEADLINE *</Text>
                        <Pressable
                            style={[styles.input, { justifyContent: 'center' }, fieldBorder('deadline')]}
                            onPress={() => setShowPicker(true)}
                            accessibilityRole="button"
                        >
                            <Text style={{ color: deadlineDate ? colors.text.heading : colors.text.muted, fontSize: 16 }}>
                                {deadlineDate ? deadlineDate.toISOString().split('T')[0] : "Select Deadline Date"}
                            </Text>
                        </Pressable>
                        {showPicker && (
                            <DateTimePicker
                                value={deadlineDate || new Date()}
                                mode="date"
                                display="default"
                                minimumDate={new Date()}
                                maximumDate={maxDate}
                                onChange={(event: any, selectedDate?: Date) => {
                                    setShowPicker(false);
                                    if (event.type === 'set' && selectedDate) {
                                        setDeadlineDate(selectedDate);
                                        if (validationErrors.has('deadline')) { const n = new Set(validationErrors); n.delete('deadline'); setValidationErrors(n); }
                                    }
                                }}
                            />
                        )}
                        <Text style={styles.hint}>If set, project will automatically expire on this date.</Text>
                    </View>

                    {/* Photos */}
                    <View style={styles.field}>
                        <Text style={styles.label}>PROJECT PHOTOS * (MIN 1, MAX 3)</Text>
                        <View style={[{ flexDirection: 'row', gap: 10, marginTop: 4, padding: 4, borderRadius: 12 }, fieldBorder('photos')]}>
                            {photos.map((uri, idx) => (
                                uri && typeof uri === 'string' && uri.trim() !== '' && uri !== 'null' && uri !== 'undefined' ? (
                                    <View key={idx} style={{ position: 'relative' }}>
                                        <Image source={{ uri }} style={{ width: 80, height: 80, borderRadius: 12, backgroundColor: colors.surface.subtle }} accessibilityLabel="Project photo" />
                                        <Pressable
                                            onPress={() => setPhotos(prev => prev.filter((_, i) => i !== idx))}
                                            style={{ position: 'absolute', top: -5, right: -5, backgroundColor: colors.feedback.danger.solid, borderRadius: 12, width: 24, height: 24, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 3 }}
                                            accessibilityRole="button"
                                            accessibilityLabel="Remove photo"
                                            accessibilityHint="Removes this photo from the project"
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
                                            mediaTypes: ImagePicker.MediaTypeOptions.Images,
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
                                                if (validationErrors.has('photos')) { const n = new Set(validationErrors); n.delete('photos'); setValidationErrors(n); }
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

                    {/* Description */}
                    <View style={styles.field}>
                        <Text style={styles.label}>PROPOSAL DETAILS</Text>
                        <TextInput
                            accessibilityLabel="Proposal details"
                            style={[styles.input, styles.textarea, fieldBorder('description')]}
                            placeholder="Describe the project, who benefits, and how the credits will be allocated..."
                            value={description}
                            onChangeText={(v) => { setDescription(v); if (validationErrors.has('description')) { const n = new Set(validationErrors); n.delete('description'); setValidationErrors(n); } }}
                            multiline
                            textAlignVertical="top"
                        />
                    </View>

                </ScrollView>

                {validationToast ? (
                    <View style={styles.toast}>
                        <Text style={styles.toastText}>{validationToast}</Text>
                    </View>
                ) : null}

                <View style={styles.footer}>
                    <Pressable style={styles.submitBtn} onPress={handleSubmit} disabled={submitting} accessibilityRole="button">
                        {submitting ? (
                            <ActivityIndicator color={colors.text.inverse} />
                        ) : (
                            <Text style={styles.submitBtnText}>SUBMIT TO NETWORK</Text>
                        )}
                    </Pressable>
                </View>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}


