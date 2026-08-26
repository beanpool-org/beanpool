import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Modal,
    TextInput,
    Pressable,
    ScrollView,
    KeyboardAvoidingView,
    Platform,
    ActivityIndicator,
    Alert
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles } from '../app/ThemeContext';
import { createGroupApi, type GroupItem } from '../utils/db';
import { hapticSuccess, hapticTick } from '../utils/haptics';

interface CreateGroupModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreated: (group: GroupItem) => void;
}

const CATEGORIES = [
    { key: 'working_group', label: 'Working Group', icon: 'account-group', desc: 'Grassroots collaboration team' },
    { key: 'project', label: 'Project Team', icon: 'hammer-wrench', desc: 'Dedicated to building a specific project' },
    { key: 'guild', label: 'Guild / Craft', icon: 'shield-star', desc: 'Skill sharing and craft practitioners' },
    { key: 'social', label: 'Social Circle', icon: 'coffee', desc: 'Neighbourhood & interest circle' },
    { key: 'general', label: 'General Team', icon: 'flag', desc: 'Open community group' },
];

const JOIN_POLICIES = [
    { key: 'open', label: 'Open', icon: 'door-open', desc: 'Anyone in the community can join instantly' },
    { key: 'request_to_join', label: 'Approval Required', icon: 'account-clock', desc: 'Stewards approve membership requests' },
    { key: 'invite_only', label: 'Invite Only', icon: 'email-lock', desc: 'Stewards must directly invite members' },
];

export function CreateGroupModal({ isOpen, onClose, onCreated }: CreateGroupModalProps) {
    const { colors } = useTheme();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [category, setCategory] = useState<string>('working_group');
    const [joinPolicy, setJoinPolicy] = useState<'open' | 'request_to_join' | 'invite_only'>('open');
    const [submitting, setSubmitting] = useState(false);

    const styles = useStyles(({ colors }) => StyleSheet.create({
        backdrop: {
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.5)',
            justifyContent: 'flex-end',
        },
        sheet: {
            backgroundColor: colors.surface.card,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            maxHeight: '90%',
            paddingBottom: 40,
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 20,
            paddingVertical: 16,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
        },
        title: {
            fontSize: 18,
            fontWeight: '800',
            color: colors.text.heading,
        },
        closeBtn: {
            padding: 4,
        },
        content: {
            padding: 20,
        },
        fieldLabel: {
            fontSize: 12,
            fontWeight: '700',
            color: colors.text.secondary,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 8,
        },
        input: {
            backgroundColor: colors.surface.subtle,
            borderRadius: 12,
            padding: 14,
            fontSize: 15,
            color: colors.text.heading,
            borderWidth: 1,
            borderColor: colors.border.default,
            marginBottom: 16,
        },
        textArea: {
            minHeight: 80,
            textAlignVertical: 'top',
        },
        optionRow: {
            marginBottom: 16,
        },
        optionCard: {
            flexDirection: 'row',
            alignItems: 'center',
            padding: 12,
            borderRadius: 12,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
            marginBottom: 8,
        },
        optionCardActive: {
            backgroundColor: colors.brand.tint,
            borderColor: colors.brand.primary,
        },
        optionIconWrap: {
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: colors.surface.card,
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 12,
        },
        optionTextWrap: {
            flex: 1,
        },
        optionLabel: {
            fontSize: 14,
            fontWeight: '700',
            color: colors.text.heading,
        },
        optionDesc: {
            fontSize: 12,
            color: colors.text.secondary,
            marginTop: 2,
        },
        createBtn: {
            backgroundColor: colors.brand.primary,
            borderRadius: 14,
            paddingVertical: 14,
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 8,
            marginBottom: 20,
        },
        createBtnDisabled: {
            opacity: 0.6,
        },
        createBtnText: {
            color: colors.text.inverse,
            fontSize: 16,
            fontWeight: '800',
        },
    }));

    const handleSubmit = async () => {
        if (!name.trim() || name.trim().length < 2) {
            Alert.alert('Invalid Name', 'Group name must be at least 2 characters long.');
            return;
        }

        setSubmitting(true);
        try {
            const group = await createGroupApi({
                name: name.trim(),
                description: description.trim() || undefined,
                category,
                joinPolicy,
            });

            hapticSuccess();
            onCreated(group);
            setName('');
            setDescription('');
            onClose();
        } catch (e: any) {
            Alert.alert('Creation Failed', e.message || 'Failed to create group');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            visible={isOpen}
            animationType="slide"
            transparent
            onRequestClose={onClose}
        >
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                style={styles.backdrop}
            >
                <View style={styles.sheet}>
                    <View style={styles.header}>
                        <Text style={styles.title}>Create Group or Team</Text>
                        <Pressable style={styles.closeBtn} onPress={onClose}>
                            <MaterialCommunityIcons name="close" size={22} color={colors.text.muted} />
                        </Pressable>
                    </View>

                    <ScrollView style={styles.content} keyboardShouldPersistTaps="handled">
                        <Text style={styles.fieldLabel}>Group Name *</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="e.g. Solar Guild, Community Garden Team"
                            placeholderTextColor={colors.text.muted}
                            value={name}
                            onChangeText={setName}
                            maxLength={60}
                        />

                        <Text style={styles.fieldLabel}>Description</Text>
                        <TextInput
                            style={[styles.input, styles.textArea]}
                            placeholder="What does this group work on and accomplish?"
                            placeholderTextColor={colors.text.muted}
                            value={description}
                            onChangeText={setDescription}
                            multiline
                            maxLength={300}
                        />

                        <Text style={styles.fieldLabel}>Category</Text>
                        <View style={styles.optionRow}>
                            {CATEGORIES.map(cat => {
                                const selected = category === cat.key;
                                return (
                                    <Pressable
                                        key={cat.key}
                                        style={[styles.optionCard, selected && styles.optionCardActive]}
                                        onPress={() => {
                                            hapticTick();
                                            setCategory(cat.key);
                                        }}
                                    >
                                        <View style={styles.optionIconWrap}>
                                            <MaterialCommunityIcons
                                                name={cat.icon as any}
                                                size={20}
                                                color={selected ? colors.brand.primary : colors.text.secondary}
                                            />
                                        </View>
                                        <View style={styles.optionTextWrap}>
                                            <Text style={styles.optionLabel}>{cat.label}</Text>
                                            <Text style={styles.optionDesc}>{cat.desc}</Text>
                                        </View>
                                        {selected && (
                                            <MaterialCommunityIcons name="check-circle" size={20} color={colors.brand.primary} />
                                        )}
                                    </Pressable>
                                );
                            })}
                        </View>

                        <Text style={styles.fieldLabel}>Join Policy</Text>
                        <View style={styles.optionRow}>
                            {JOIN_POLICIES.map(pol => {
                                const selected = joinPolicy === pol.key;
                                return (
                                    <Pressable
                                        key={pol.key}
                                        style={[styles.optionCard, selected && styles.optionCardActive]}
                                        onPress={() => {
                                            hapticTick();
                                            setJoinPolicy(pol.key as any);
                                        }}
                                    >
                                        <View style={styles.optionIconWrap}>
                                            <MaterialCommunityIcons
                                                name={pol.icon as any}
                                                size={20}
                                                color={selected ? colors.brand.primary : colors.text.secondary}
                                            />
                                        </View>
                                        <View style={styles.optionTextWrap}>
                                            <Text style={styles.optionLabel}>{pol.label}</Text>
                                            <Text style={styles.optionDesc}>{pol.desc}</Text>
                                        </View>
                                        {selected && (
                                            <MaterialCommunityIcons name="check-circle" size={20} color={colors.brand.primary} />
                                        )}
                                    </Pressable>
                                );
                            })}
                        </View>

                        <Pressable
                            style={[styles.createBtn, (!name.trim() || submitting) && styles.createBtnDisabled]}
                            onPress={handleSubmit}
                            disabled={!name.trim() || submitting}
                        >
                            {submitting ? (
                                <ActivityIndicator size="small" color={colors.text.inverse} />
                            ) : (
                                <Text style={styles.createBtnText}>Create Group & Become Steward</Text>
                            )}
                        </Pressable>
                    </ScrollView>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}
