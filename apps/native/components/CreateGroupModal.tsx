import React, { useState } from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    TextInput,
    Pressable,
    ScrollView,
    Alert,
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles } from '../app/ThemeContext';
import { createGroupApi, type GroupCategory, type JoinPolicy, type GroupItem } from '../utils/db';
import { hapticSuccess, hapticTick } from '../utils/haptics';

interface CreateGroupModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreated: (group: GroupItem) => void;
}

const CATEGORIES: Array<{ key: GroupCategory; label: string; icon: string; desc: string }> = [
    { key: 'working_group', label: 'Working Group', icon: 'account-group', desc: 'Practical focus group coordinating tasks' },
    { key: 'project', label: 'Project Team', icon: 'hammer-wrench', desc: 'Collaborating on an initiative or venture' },
    { key: 'guild', label: 'Guild', icon: 'shield-account', desc: 'Skill sharing and craft practitioners' },
    { key: 'social', label: 'Social Circle', icon: 'coffee', desc: 'Community chats and shared interests' },
    { key: 'general', label: 'General', icon: 'forum', desc: 'Open discussion space' },
];

const JOIN_POLICIES: Array<{ key: JoinPolicy; label: string; icon: string; desc: string }> = [
    { key: 'open', label: 'Open', icon: 'door-open', desc: 'Anyone can join immediately' },
    { key: 'request_to_join', label: 'Request to Join', icon: 'account-clock', desc: 'Convenor approval required to join' },
    { key: 'invite_only', label: 'Invite Only', icon: 'lock', desc: 'Convenor must invite new members' },
];

export function CreateGroupModal({ isOpen, onClose, onCreated }: CreateGroupModalProps) {
    const { colors } = useTheme();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [category, setCategory] = useState<GroupCategory>('working_group');
    const [joinPolicy, setJoinPolicy] = useState<JoinPolicy>('open');
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
            paddingBottom: 32,
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
        infoNotice: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 10,
            backgroundColor: colors.surface.subtle,
            borderRadius: 12,
            padding: 12,
            marginBottom: 16,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        infoNoticeText: {
            flex: 1,
            fontSize: 12,
            color: colors.text.secondary,
            lineHeight: 18,
        },
        fieldLabel: {
            fontSize: 12,
            fontWeight: '800',
            color: colors.text.secondary,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 8,
            marginTop: 12,
        },
        input: {
            backgroundColor: colors.surface.subtle,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 15,
            color: colors.text.heading,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        textArea: {
            minHeight: 80,
            textAlignVertical: 'top',
        },
        optionRow: {
            gap: 8,
            marginBottom: 8,
        },
        optionCard: {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.surface.subtle,
            borderRadius: 12,
            padding: 12,
            borderWidth: 1,
            borderColor: colors.border.default,
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
            marginTop: 16,
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
                        <Text style={styles.title}>Create a Group</Text>
                        <Pressable
                            style={styles.closeBtn}
                            onPress={onClose}
                            accessibilityRole="button"
                            accessibilityLabel="Close create group modal"
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        >
                            <MaterialCommunityIcons name="close" size={22} color={colors.text.muted} />
                        </Pressable>
                    </View>

                    <ScrollView style={styles.content} keyboardShouldPersistTaps="handled">
                        <View style={styles.infoNotice}>
                            <MaterialCommunityIcons name="information-outline" size={18} color={colors.text.secondary} />
                            <Text style={styles.infoNoticeText}>
                                A group is a place to talk to some people rather than everyone. It does not hold beans and does not confer trust or voting standing.
                            </Text>
                        </View>

                        <Text style={styles.fieldLabel}>Group Name *</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="e.g. Bindarrabi Garden Crew, Solar Guild"
                            placeholderTextColor={colors.text.muted}
                            value={name}
                            onChangeText={setName}
                            maxLength={60}
                        />

                        <Text style={styles.fieldLabel}>Purpose / Description</Text>
                        <TextInput
                            style={[styles.input, styles.textArea]}
                            placeholder="What does this group discuss or coordinate?"
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
                                        accessibilityRole="button"
                                        accessibilityLabel={`${cat.label}, ${cat.desc}`}
                                        accessibilityState={{ selected }}
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
                                        accessibilityRole="button"
                                        accessibilityLabel={`${pol.label}, ${pol.desc}`}
                                        accessibilityState={{ selected }}
                                        onPress={() => {
                                            hapticTick();
                                            setJoinPolicy(pol.key);
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
                            accessibilityRole="button"
                            accessibilityLabel={submitting ? "Creating group..." : "Create Group (You become Convenor)"}
                            accessibilityState={{ disabled: !name.trim() || submitting, busy: submitting }}
                        >
                            {submitting ? (
                                <ActivityIndicator size="small" color={colors.text.inverse} />
                            ) : (
                                <Text style={styles.createBtnText}>Create Group (You become Convenor)</Text>
                            )}
                        </Pressable>
                    </ScrollView>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}
