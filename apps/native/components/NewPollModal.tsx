/**
 * NewPollModal — Modal for creating a Community Poll (apps/native).
 *
 * Implements docs/the-commons.md §3.2, §3.8:
 * - Author enters question (title), optional description.
 * - 2 to 4 options.
 * - Duration selector: 3, 7 (default), or 14 days.
 * - Rate limit awareness: 1 open poll per member, 5 per node.
 * - Franchise: active members only, credit_frozen = 0.
 */

import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Modal,
    TextInput,
    Pressable,
    ScrollView,
    Alert,
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import * as Crypto from 'expo-crypto';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useIdentity } from '../app/IdentityContext';
import { createPost } from '../utils/db';

interface NewPollModalProps {
    visible: boolean;
    onClose: () => void;
    onSuccess?: () => void;
}

export function NewPollModal({ visible, onClose, onSuccess }: NewPollModalProps) {
    const { colors, theme } = useTheme();
    const styles = useStyles(makeStyles);
    const { identity } = useIdentity();

    const [question, setQuestion] = useState('');
    const [description, setDescription] = useState('');
    const [options, setOptions] = useState<Array<{ id: string; text: string }>>([
        { id: '1', text: '' },
        { id: '2', text: '' },
    ]);
    const [durationDays, setDurationDays] = useState<3 | 7 | 14>(7);
    const [submitting, setSubmitting] = useState(false);

    const handleAddOption = () => {
        if (options.length < 4) {
            const nextId = String(Date.now() + Math.random());
            setOptions(prev => [...prev, { id: nextId, text: '' }]);
        }
    };

    const handleRemoveOption = (id: string) => {
        if (options.length > 2) {
            setOptions(prev => prev.filter(o => o.id !== id));
        }
    };

    const handleOptionChange = (text: string, id: string) => {
        setOptions(prev => prev.map(o => o.id === id ? { ...o, text } : o));
    };

    const handleCreatePoll = async () => {
        const cleanQuestion = question.trim();
        if (!cleanQuestion) {
            Alert.alert('Required Field', 'Please enter a poll question.');
            return;
        }

        const validOptions = options.map(o => o.text.trim()).filter(Boolean);
        if (validOptions.length < 2) {
            Alert.alert('Options Required', 'A poll must have at least 2 non-empty options.');
            return;
        }
        const uniqueOptions = new Set(validOptions.map(o => o.toLowerCase()));
        if (uniqueOptions.size !== validOptions.length) {
            Alert.alert('Duplicate Options', 'Each poll option must have distinct text.');
            return;
        }
        if (validOptions.length > 4) {
            Alert.alert('Too Many Options', 'A poll can have at most 4 options.');
            return;
        }

        if (!identity?.publicKey) {
            Alert.alert('Error', 'No member identity found. Please set up your profile.');
            return;
        }

        setSubmitting(true);
        try {
            const pollId = Crypto.randomUUID();
            const cleanOptionsObj = validOptions.map((text, idx) => ({
                id: `opt_${idx + 1}`,
                text,
            }));

            await createPost({
                id: pollId,
                type: 'poll',
                category: 'community',
                title: cleanQuestion,
                description: description.trim(),
                credits: 0,
                price_type: 'fixed',
                author_pubkey: identity.publicKey,
                created_at: new Date().toISOString(),
                poll_options: JSON.stringify(cleanOptionsObj),
                durationDays,
            });

            // Reset form
            setQuestion('');
            setDescription('');
            setOptions([{ id: '1', text: '' }, { id: '2', text: '' }]);
            setDurationDays(7);

            Alert.alert('Poll Created', 'Your poll has been published to the community feed!');
            onSuccess?.();
            onClose();
        } catch (err: any) {
            Alert.alert('Failed to Create Poll', err.message || 'Server rejected the poll.');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle="pageSheet"
            onRequestClose={onClose}
        >
            <KeyboardAvoidingView
                style={{ flex: 1 }}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                <View style={styles.container}>
                    {/* Header */}
                    <View style={styles.header}>
                        <Pressable
                            onPress={onClose}
                            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                            style={styles.cancelBtn}
                            accessibilityRole="button"
                            accessibilityLabel="Cancel"
                        >
                            <Text style={styles.cancelText}>Cancel</Text>
                        </Pressable>
                        <Text style={styles.headerTitle}>New Community Poll</Text>
                        <Pressable
                            onPress={handleCreatePoll}
                            disabled={submitting}
                            hitSlop={12}
                            style={[styles.postBtn, submitting && { opacity: 0.5 }]}
                            accessibilityRole="button"
                            accessibilityLabel={submitting ? "Creating poll" : "Create poll"}
                            accessibilityHint="Publishes your community poll"
                            accessibilityState={{ disabled: submitting, busy: submitting }}
                        >
                            {submitting ? (
                                <ActivityIndicator size="small" color="#fff" />
                            ) : (
                                <Text style={styles.postText}>Create</Text>
                            )}
                        </Pressable>
                    </View>

                    <ScrollView
                        style={styles.body}
                        contentContainerStyle={{ paddingBottom: 40 }}
                        keyboardShouldPersistTaps="handled"
                    >
                        {/* Notice Banner */}
                        <View style={styles.noticeBanner}>
                            <Text style={styles.noticeIcon}>🗳️</Text>
                            <View style={{ flex: 1, marginLeft: 10 }}>
                                <Text style={styles.noticeTitle}>Village Polling</Text>
                                <Text style={styles.noticeBody}>
                                    One member, one vote. Transparent and open — tallies and signed votes are visible to all members.
                                </Text>
                            </View>
                        </View>

                        {/* Question Input */}
                        <Text style={styles.label}>QUESTION *</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="e.g. Should the market move to Sunday?"
                            placeholderTextColor={colors.text.muted}
                            value={question}
                            onChangeText={setQuestion}
                            maxLength={140}
                        />

                        {/* Description (Optional) */}
                        <Text style={styles.label}>CONTEXT / NOTES (OPTIONAL)</Text>
                        <TextInput
                            style={[styles.input, styles.textArea]}
                            placeholder="Add any extra background for your neighbours..."
                            placeholderTextColor={colors.text.muted}
                            value={description}
                            onChangeText={setDescription}
                            multiline
                            numberOfLines={3}
                            maxLength={400}
                        />

                        {/* Options */}
                        <View style={styles.optionsHeaderRow}>
                            <Text style={styles.label}>OPTIONS (2–4) *</Text>
                            {options.length < 4 && (
                                <Pressable
                                    onPress={handleAddOption}
                                    style={styles.addOptionBtn}
                                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                                    accessibilityRole="button"
                                    accessibilityLabel="Add another poll option"
                                >
                                    <Text style={styles.addOptionText}>+ Add Option</Text>
                                </Pressable>
                            )}
                        </View>

                        {options.map((opt, idx) => (
                            <View key={opt.id} style={styles.optionInputRow}>
                                <Text style={styles.optionIndexBadge}>{idx + 1}</Text>
                                <TextInput
                                    style={styles.optionInput}
                                    placeholder={`Option ${idx + 1}`}
                                    placeholderTextColor={colors.text.muted}
                                    value={opt.text}
                                    onChangeText={(val) => handleOptionChange(val, opt.id)}
                                    maxLength={80}
                                />
                                {options.length > 2 && (
                                    <Pressable
                                        onPress={() => handleRemoveOption(opt.id)}
                                        style={styles.removeOptionBtn}
                                        hitSlop={8}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Remove Option ${idx + 1}`}
                                    >
                                        <Text style={styles.removeOptionText}>✕</Text>
                                    </Pressable>
                                )}
                            </View>
                        ))}

                        {/* Duration Selector */}
                        <Text style={[styles.label, { marginTop: 18 }]}>DURATION</Text>
                        <View style={styles.durationRow}>
                            {([3, 7, 14] as const).map(days => (
                                <Pressable
                                    key={days}
                                    onPress={() => setDurationDays(days)}
                                    style={[
                                        styles.durationBtn,
                                        durationDays === days && styles.durationBtnActive,
                                    ]}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: durationDays === days }}
                                    accessibilityLabel={`${days} Days duration${durationDays === days ? ', selected' : ''}`}
                                >
                                    <Text
                                        style={[
                                            styles.durationBtnText,
                                            durationDays === days && styles.durationBtnTextActive,
                                        ]}
                                    >
                                        {days} Days
                                    </Text>
                                </Pressable>
                            ))}
                        </View>
                    </ScrollView>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) =>
    StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: colors.surface.app,
        },
        header: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 14,
            borderBottomWidth: 1,
            borderBottomColor: theme === 'dark' ? '#374151' : '#e5e7eb',
        },
        headerTitle: {
            fontSize: 16,
            fontWeight: '800',
            color: colors.text.body,
        },
        cancelBtn: {
            paddingHorizontal: 10,
            paddingVertical: 10,
            minHeight: 44,
            minWidth: 44,
            justifyContent: 'center',
            alignItems: 'center',
        },
        cancelText: {
            fontSize: 15,
            color: colors.text.secondary,
        },
        postBtn: {
            backgroundColor: '#7c3aed',
            paddingHorizontal: 16,
            paddingVertical: 7,
            borderRadius: 18,
        },
        postText: {
            fontSize: 14,
            fontWeight: '800',
            color: '#fff',
        },
        body: {
            flex: 1,
            padding: 16,
        },
        noticeBanner: {
            flexDirection: 'row',
            backgroundColor: theme === 'dark' ? '#2e1065' : '#f5f3ff',
            borderColor: theme === 'dark' ? '#6d28d9' : '#ddd6fe',
            borderWidth: 1,
            borderRadius: 12,
            padding: 12,
            marginBottom: 18,
            alignItems: 'center',
        },
        noticeIcon: {
            fontSize: 24,
        },
        noticeTitle: {
            fontSize: 13,
            fontWeight: '800',
            color: theme === 'dark' ? '#ddd6fe' : '#5b21b6',
        },
        noticeBody: {
            fontSize: 12,
            color: theme === 'dark' ? '#c4b5fd' : '#6d28d9',
            marginTop: 2,
            lineHeight: 16,
        },
        label: {
            fontSize: 11,
            fontWeight: '800',
            color: colors.text.secondary,
            letterSpacing: 0.5,
            marginBottom: 6,
        },
        input: {
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: theme === 'dark' ? '#4b5563' : '#d1d5db',
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 10,
            fontSize: 15,
            color: colors.text.body,
            marginBottom: 16,
        },
        textArea: {
            minHeight: 70,
            textAlignVertical: 'top',
        },
        optionsHeaderRow: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 6,
        },
        addOptionBtn: {
            paddingVertical: 6,
            paddingHorizontal: 10,
            minHeight: 44,
            justifyContent: 'center',
            alignItems: 'center',
        },
        addOptionText: {
            fontSize: 12,
            fontWeight: '700',
            color: '#7c3aed',
        },
        optionInputRow: {
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 8,
            gap: 8,
        },
        optionIndexBadge: {
            width: 24,
            textAlign: 'center',
            fontSize: 13,
            fontWeight: '700',
            color: colors.text.secondary,
        },
        optionInput: {
            flex: 1,
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: theme === 'dark' ? '#4b5563' : '#d1d5db',
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 8,
            fontSize: 14,
            color: colors.text.body,
        },
        removeOptionBtn: {
            padding: 8,
            minHeight: 44,
            minWidth: 44,
            justifyContent: 'center',
            alignItems: 'center',
        },
        removeOptionText: {
            fontSize: 14,
            color: '#ef4444',
            fontWeight: '800',
        },
        durationRow: {
            flexDirection: 'row',
            gap: 10,
        },
        durationBtn: {
            flex: 1,
            paddingVertical: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme === 'dark' ? '#4b5563' : '#d1d5db',
            backgroundColor: colors.surface.card,
            alignItems: 'center',
        },
        durationBtnActive: {
            borderColor: '#7c3aed',
            backgroundColor: theme === 'dark' ? 'rgba(124, 58, 237, 0.2)' : '#f5f3ff',
        },
        durationBtnText: {
            fontSize: 13,
            fontWeight: '600',
            color: colors.text.secondary,
        },
        durationBtnTextActive: {
            fontWeight: '800',
            color: '#7c3aed',
        },
    });
