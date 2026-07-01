import React, { useState, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, Alert, ActivityIndicator, Platform } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { updateCrowdfundProjectApi, getProjectById, deleteCrowdfundProjectApi } from '../utils/db';
import DateTimePicker from '@react-native-community/datetimepicker';
import { CurrencyDisplay } from '../components/CurrencyDisplay';
import { colors, palette } from '../constants/colors';
import { useTheme, useStyles } from './ThemeContext';

export default function EditProjectModal() {
    const params = useLocalSearchParams<{ id: string, title?: string, description?: string, goal?: string, current?: string, photos?: string }>();
    const { theme, colors } = useTheme();
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: colors.surface.card },
        backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'flex-start' },
        headerTitle: { fontSize: 18, fontWeight: 'bold', color: colors.text.heading, letterSpacing: 1, textTransform: 'uppercase' },
        infoBox: { flexDirection: 'row', backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : palette.amber50, padding: 16, borderRadius: 12, marginBottom: 24, borderWidth: 1, borderColor: theme === 'dark' ? colors.feedback.warning.border : palette.amber100 },
        infoText: { flex: 1, fontSize: 15, color: theme === 'dark' ? colors.text.body : palette.amber800, lineHeight: 22 },
        scroll: { padding: 20 },
        field: { marginBottom: 24 },
        label: { fontSize: 11, fontWeight: 'bold', color: colors.text.secondary, letterSpacing: 1, marginBottom: 8 },
        hint: { fontSize: 12, color: colors.text.muted, marginTop: 6 },
        input: { backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 16, fontSize: 16, color: colors.text.body },
        priceInput: { fontSize: 24, fontWeight: 'bold', color: theme === 'dark' ? colors.brand.primary : palette.amber500 },
        textarea: { height: 160, paddingTop: 16 },
        footer: { padding: 20, borderTopWidth: 1, borderTopColor: colors.border.default, backgroundColor: colors.surface.card },
        submitBtn: { backgroundColor: colors.brand.primary, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
        submitBtnText: { color: colors.text.inverse, fontWeight: '800', letterSpacing: 1, fontSize: 13 },
        deleteBtn: { backgroundColor: colors.feedback.danger.solid, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
        deleteBtnText: { color: colors.text.inverse, fontWeight: '800', letterSpacing: 1, fontSize: 13 },
    }));
    
    const [title, setTitle] = useState(params.title || '');
    const [description, setDescription] = useState(params.description || '');
    const [goalAmount, setGoalAmount] = useState(params.goal || '');
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false);
    const [projectData, setProjectData] = useState<any>(null);
    const [deadlineDate, setDeadlineDate] = useState<Date | null>(null);
    const [showPicker, setShowPicker] = useState(false);

    const [maxExpiryDays, setMaxExpiryDays] = useState<number>(365);
    useEffect(() => {
        AsyncStorage.getItem('beanpool_max_expiry_days').then(val => {
            if (val) setMaxExpiryDays(Number(val));
        });
    }, []);

    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + maxExpiryDays);

    useEffect(() => {
        if (params.id) {
            getProjectById(params.id).then(p => {
                setProjectData(p);
                if (p?.deadline_at) {
                    setDeadlineDate(new Date(p.deadline_at));
                }
            }).catch(console.error);
        }
    }, [params.id]);

    const isLocked = Number(params.current || 0) > 0;

    const handleSubmit = async () => {
        if (submittingRef.current) return;
        if (!title.trim() || !goalAmount.trim()) {
            Alert.alert("Missing Fields", "Please provide a project title and requested goal amount.");
            return;
        }

        let parsedDeadline = null;
        if (deadlineDate) {
            parsedDeadline = deadlineDate.toISOString();
        }

        submittingRef.current = true;
        setSubmitting(true);
        try {
            let parsedPhotos: string[] = [];
            if (projectData?.photos) {
                parsedPhotos = typeof projectData.photos === 'string' ? JSON.parse(projectData.photos) : projectData.photos;
            } else if (params.photos) {
                try { parsedPhotos = JSON.parse(params.photos); } catch {}
            }

            await updateCrowdfundProjectApi(
                params.id,
                title.trim(),
                description.trim(),
                parsedPhotos,
                parseInt(goalAmount, 10) || 0,
                parsedDeadline
            );
            Alert.alert("Proposal Updated", "Your community project proposal has been successfully updated on the network.", [
                { text: "OK", onPress: () => router.back() }
            ]);
        } catch (e: any) {
            Alert.alert("Update Failed", e.message || "Could not update project.");
        } finally {
            setSubmitting(false);
            submittingRef.current = false;
        }
    };

    const handleDelete = async () => {
        Alert.alert(
            "Delete Project?",
            "This will permanently erase the project. Pledges currently held in a Trust Wallet will be automatically refunded to backers.",
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Delete & Refund",
                    style: "destructive",
                    onPress: async () => {
                        setSubmitting(true);
                        try {
                            await deleteCrowdfundProjectApi(params.id);
                            Alert.alert("Project Deleted", "The project has been successfully erased and any pledges held in trust have been refunded.", [
                                { text: "OK", onPress: () => router.push('/projects') }
                            ]);
                        } catch (e: any) {
                            Alert.alert("Delete Failed", e.message || "Could not delete project.");
                            setSubmitting(false);
                        }
                    }
                }
            ]
        );
    };

    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style="dark" />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Close">
                    <MaterialCommunityIcons name="close" size={28} color={colors.text.heading} />
                </Pressable>
                <Text style={styles.headerTitle}>Edit Project</Text>
                <View style={{ width: 40 }} />
            </View>

            <KeyboardAvoidingView
                behavior="padding"
                keyboardVerticalOffset={64}
                style={{ flex: 1 }}
            >
                <ScrollView contentContainerStyle={styles.scroll}>
                    {isLocked ? (
                        <View style={[styles.infoBox, { backgroundColor: palette.red100, borderColor: palette.red300 }]}>
                            <MaterialCommunityIcons name="lock" size={20} color={palette.red700} style={{ marginRight: 8 }} />
                            <Text style={[styles.infoText, { color: palette.red900 }]}>This project has already received community pledges. The funding goal is permanently locked to protect backers.</Text>
                        </View>
                    ) : (
                        <View style={styles.infoBox}>
                            <MaterialCommunityIcons name="information" size={20} color={palette.amber500} style={{ marginRight: 8 }} />
                            <Text style={styles.infoText}>You may edit the funding goal because no pledges have been made yet.</Text>
                        </View>
                    )}

                    {/* Title */}
                    <View style={styles.field}>
                        <Text style={styles.label}>PROJECT TITLE</Text>
                        <TextInput
                            accessibilityLabel="Project title"
                            style={styles.input}
                            placeholder="e.g. Community Garden Tool Shed"
                            value={title}
                            onChangeText={setTitle}
                            maxLength={60}
                        />
                    </View>

                    {/* Goal Amount */}
                    <View style={styles.field}>
                        <Text style={styles.label}>FUNDING GOAL (<CurrencyDisplay hideAmount={true} />)</Text>
                        <TextInput
                            accessibilityLabel="Funding goal amount"
                            style={[styles.input, styles.priceInput, isLocked && { backgroundColor: colors.surface.subtle, color: colors.text.muted }]}
                            placeholder="0"
                            keyboardType="numeric"
                            value={goalAmount}
                            onChangeText={setGoalAmount}
                            maxLength={6}
                            editable={!isLocked}
                        />
                        <Text style={styles.hint}>Amount requested from the community pool.</Text>
                    </View>

                    {/* Deadline */}
                    <View style={styles.field}>
                        <Text style={styles.label}>FUNDING DEADLINE (OPTIONAL)</Text>
                        {Platform.OS === 'ios' ? (
                            <View style={{ alignItems: 'flex-start', marginTop: 8 }}>
                                <DateTimePicker
                                    value={deadlineDate || new Date()}
                                    mode="date"
                                    display="default"
                                    minimumDate={new Date()}
                                    maximumDate={maxDate}
                                    onChange={(event: any, selectedDate?: Date) => {
                                        if (selectedDate) setDeadlineDate(selectedDate);
                                    }}
                                />
                            </View>
                        ) : (
                            <>
                                <Pressable
                                    style={[styles.input, { justifyContent: 'center' }]}
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
                                            }
                                        }}
                                    />
                                )}
                            </>
                        )}
                        <Text style={styles.hint}>If set, project will automatically expire on this date.</Text>
                    </View>

                    {/* Description */}
                    <View style={styles.field}>
                        <Text style={styles.label}>PROPOSAL DETAILS</Text>
                        <TextInput
                            accessibilityLabel="Proposal details"
                            style={[styles.input, styles.textarea]}
                            placeholder="Describe the project, who benefits, and how the credits will be allocated..."
                            value={description}
                            onChangeText={setDescription}
                            multiline
                            textAlignVertical="top"
                        />
                    </View>

                </ScrollView>

                <View style={[styles.footer, { flexDirection: 'column', gap: 12 }]}>
                    <Pressable style={styles.submitBtn} onPress={handleSubmit} disabled={submitting} accessibilityRole="button">
                        {submitting ? (
                            <ActivityIndicator color={colors.text.inverse} />
                        ) : (
                            <Text style={styles.submitBtnText}>SAVE CHANGES</Text>
                        )}
                    </Pressable>
                    <Pressable style={styles.deleteBtn} onPress={handleDelete} disabled={submitting} accessibilityRole="button" accessibilityHint="Permanently deletes the project and refunds pledges">
                        <Text style={styles.deleteBtnText}>DELETE PROJECT</Text>
                    </Pressable>
                </View>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}


