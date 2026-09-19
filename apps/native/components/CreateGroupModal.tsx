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
} from 'react-native';
// No nested KeyboardProvider inside this <Modal>: on the emulator it left the root provider suspended after the
// sheet closed, so the chat composer stayed under the keyboard. The sheet fits the Modal's measured height
// (useModalKeyboardLift): lifted by the keyboard's height.
import { KeyboardController } from 'react-native-keyboard-controller';
import { useModalKeyboardLift } from './useModalKeyboardLift';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles } from '../app/ThemeContext';
import { createGroupApi, type GroupCategory, type JoinPolicy, type GroupItem } from '../utils/db';
import { hapticSuccess, hapticTick } from '../utils/haptics';
import { submitCreateGroup } from '../utils/create-group-submit';
import { GROUP_CATEGORY_OPTIONS, GROUP_JOIN_POLICY_OPTIONS, CREATE_GROUP_DEFAULTS, START_ENTERPRISE_BRIDGE } from '../utils/create-group-options';
import { router } from 'expo-router';

interface CreateGroupModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreated: (group: GroupItem) => void;
}

// Groups decisions 4, 11, 14: the same form, the same defaults, from Commons and from Talk
// (utils/create-group-options, unit tested). Emoji match the group's chat header.
const CATEGORIES = GROUP_CATEGORY_OPTIONS;
const JOIN_POLICIES = GROUP_JOIN_POLICY_OPTIONS;

export function CreateGroupModal({ isOpen, onClose, onCreated }: CreateGroupModalProps) {
    const { colors } = useTheme();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [category, setCategory] = useState<GroupCategory>(CREATE_GROUP_DEFAULTS.category);
    const [joinPolicy, setJoinPolicy] = useState<JoinPolicy>(CREATE_GROUP_DEFAULTS.joinPolicy);
    const [submitting, setSubmitting] = useState(false);
    const insets = useSafeAreaInsets();
    // Lifted by the keyboard's height, not a KeyboardAvoidingView: see components/useModalKeyboardLift.
    const lift = useModalKeyboardLift(insets.top + 8);


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
            // maxHeight comes from useModalKeyboardLift: 90% of the screen, or what is left above the keyboard.
            flexShrink: 1,
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 20,
            paddingVertical: 4,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
        },
        title: {
            fontSize: 18,
            fontWeight: '800',
            color: colors.text.heading,
        },
        closeBtn: {
            width: 48,
            height: 48,
            marginRight: -12,
            alignItems: 'center',
            justifyContent: 'center',
        },
        // Padding on contentContainerStyle, not the ScrollView's style: on Android, padding on the
        // ScrollView itself is not part of the scroll range, so the last 20dp could never be reached.
        content: {
            padding: 20,
            paddingBottom: 28,
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
        bridge: {
            minHeight: 48, justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12,
            borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border.strong, marginBottom: 4,
        },
        bridgeText: { fontSize: 14, color: colors.text.secondary, lineHeight: 20 },
        bridgeLink: { fontWeight: '800', color: colors.brand.primary },
        createBtn: {
            backgroundColor: colors.brand.primary,
            borderRadius: 14,
            minHeight: 56,
            paddingVertical: 10,
            paddingHorizontal: 16,
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 16,
        },
        createBtnDisabled: {
            opacity: 0.6,
        },
        createBtnText: {
            color: colors.text.inverse,
            fontSize: 16,
            fontWeight: '800',
        },
        // "Create Group (You become Convenor)" is ~370dp at 1.2x and wrapped against the button's
        // edges in a 280dp button, so the convenor note is its own smaller line.
        createBtnSubtext: {
            color: colors.text.inverse,
            fontSize: 12,
            fontWeight: '600',
            marginTop: 2,
        },
    }));

    const handleSubmit = async () => {
        // submitCreateGroup sets submitting BEFORE the keyboard dismiss and bounds that wait: inside this Modal on
        // Android 8–10 KeyboardController.dismiss() may never resolve, and an unbounded await made Create do nothing.
        // The dismiss still comes first so an Alert is not opened over a raised keyboard (phantom padding).
        await submitCreateGroup({
            name,
            dismissKeyboard: () => KeyboardController.dismiss(),
            setSubmitting,
            create: (trimmedName) => createGroupApi({
                name: trimmedName,
                description: description.trim() || undefined,
                category,
                joinPolicy,
            }),
            onCreated: (group) => {
                hapticSuccess();
                onCreated(group);
                setName('');
                setDescription('');
                setCategory(CREATE_GROUP_DEFAULTS.category);
                setJoinPolicy(CREATE_GROUP_DEFAULTS.joinPolicy);
                onClose();
            },
            onInvalidName: () => Alert.alert('Invalid Name', 'Group name must be at least 2 characters long.'),
            onError: (e: any) => Alert.alert('Creation Failed', e?.message || 'Failed to create group'),
        });
    };

    return (
        <Modal
            visible={isOpen}
            animationType="slide"
            transparent
            onRequestClose={onClose}
        >
            <View
                style={[styles.backdrop, { paddingTop: insets.top + 8 }]}
               
            >
                <View style={[styles.sheet, { paddingBottom: insets.bottom, maxHeight: lift.maxHeight, marginBottom: lift.lift }]}>
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

                    {/* flexShrink: at 320dp x 569dp with the keyboard up the sheet has ~250dp; without it the ScrollView
                        kept its content height, the sheet overflowed, and only the title showed, under the status bar. */}
                    <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
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
                                            <Text style={{ fontSize: 20 }} allowFontScaling={false}>{cat.emoji}</Text>
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

                        {/* Decision 14: the bridge to an enterprise, for people who are really running something. */}
                        <Pressable
                            style={styles.bridge}
                            accessibilityRole="link"
                            accessibilityLabel={`${START_ENTERPRISE_BRIDGE.lead} ${START_ENTERPRISE_BRIDGE.link}`}
                            onPress={async () => {
                                await Promise.race([KeyboardController.dismiss(), new Promise(r => setTimeout(r, 400))]);
                                onClose();
                                router.push(START_ENTERPRISE_BRIDGE.route);
                            }}
                        >
                            <Text style={styles.bridgeText}>{START_ENTERPRISE_BRIDGE.lead} <Text style={styles.bridgeLink}>{START_ENTERPRISE_BRIDGE.link}</Text></Text>
                        </Pressable>

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
                            accessibilityLabel={submitting ? "Creating group..." : "Create Group. You become its convenor."}
                            accessibilityState={{ disabled: !name.trim() || submitting, busy: submitting }}
                        >
                            {submitting ? (
                                <ActivityIndicator size="small" color={colors.text.inverse} />
                            ) : (
                                <>
                                    <Text style={styles.createBtnText} numberOfLines={1}>Create Group</Text>
                                    <Text style={styles.createBtnSubtext} numberOfLines={1}>You become its convenor</Text>
                                </>
                            )}
                        </Pressable>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}
