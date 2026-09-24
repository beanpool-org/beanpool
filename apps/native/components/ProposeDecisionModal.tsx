import React, { useState, useEffect, useMemo } from 'react';
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
import { palette } from '../constants/colors';
import {
    type DecisionTouch,
    type DecisionEffect,
    createDecision,
    getBalance,
} from '../utils/db';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onCreated: () => void;
    identity: any;
    commonsBalance: number;
    members?: Array<{ publicKey: string; callsign?: string; balance?: number }>;
    treasuries?: Array<{ publicKey: string; name: string; balance?: number }>;
}

const TOUCH_OPTIONS: Array<{ id: DecisionTouch; label: string; icon: string }> = [
    { id: 'member', label: 'Member', icon: 'account-cog' },
    { id: 'pool', label: 'Commons Pool', icon: 'bank' },
];

const EFFECTS_BY_TOUCH: Record<DecisionTouch, Array<{ id: DecisionEffect; label: string; desc: string }>> = {
    member: [
        { id: 'remove_member', label: 'Remove Member', desc: 'Expulsion from this node (66% supermajority, 25% quorum, 7-day grace window)' },
        { id: 'suspend_member', label: 'Suspend Member', desc: 'Temporary freeze of trading and messaging' },
        { id: 'unsuspend_member', label: 'Unsuspend Member', desc: 'Restore member to active standing (simple majority)' },
        { id: 'reinstate_member', label: 'Reinstate Member', desc: 'Cancel pending removal and restore account (simple majority)' },
        { id: 'freeze_credit', label: 'Freeze Credit', desc: 'Lock credit floor to zero' },
        { id: 'unfreeze_credit', label: 'Unfreeze Credit', desc: 'Restore credit floor (simple majority)' },
        { id: 'grant_voucher', label: 'Grant Voucher', desc: 'Authorise member to vouch for newcomers' },
        { id: 'revoke_voucher', label: 'Revoke Voucher', desc: 'Remove vouching privileges' },
        { id: 'remove_lead_keeper', label: 'Remove Lead Keeper', desc: 'Replace rogue enterprise lead keeper' },
    ],
    pool: [
        { id: 'grant_enterprise', label: 'Grant to Enterprise', desc: 'Disburse Commons funds directly to an enterprise account' },
        { id: 'grant_hardship', label: 'Hardship Grant', desc: 'Direct emergency support grant from Commons pool to a member' },
        { id: 'write_off_deficit', label: 'Write Off Deficit', desc: 'Absorb bad debt of a defaulted enterprise' },
    ],
};

export function ProposeDecisionModal({
    isOpen,
    onClose,
    onCreated,
    identity,
    commonsBalance,
    members = [],
    treasuries = [],
}: Props) {
    const { colors } = useTheme();
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [touches, setTouches] = useState<DecisionTouch>('member');
    const [effect, setEffect] = useState<DecisionEffect>('suspend_member');
    const [subject, setSubject] = useState('');
    const [enterprisePubkey, setEnterprisePubkey] = useState('');
    const [grantAmount, setGrantAmount] = useState('');
    const [submitting, setSubmitting] = useState(false);

    // Reset effect when touch changes
    useEffect(() => {
        const available = EFFECTS_BY_TOUCH[touches];
        if (available && available.length > 0) {
            setEffect(available[0].id);
        }
    }, [touches]);

    const [fetchedBalance, setFetchedBalance] = useState<number | null>(null);

    // ⚡ Bolt: Pre-compute member map indexed by publicKey and callsign for O(1) lookups
    const membersMap = useMemo(() => {
        const map = new Map<string, typeof members[number]>();
        for (const m of members) {
            if (m.publicKey) map.set(m.publicKey, m);
            if (m.callsign) map.set(m.callsign.toLowerCase(), m);
        }
        return map;
    }, [members]);

    // Lookup selected member details for removal preview via O(1) Map lookup
    const selectedMember = useMemo(() => {
        if (!subject) return null;
        return membersMap.get(subject) || membersMap.get(subject.toLowerCase()) || null;
    }, [membersMap, subject]);

    useEffect(() => {
        if (effect !== 'remove_member' || !subject) {
            setFetchedBalance(null);
            return;
        }
        const targetPubkey = selectedMember ? selectedMember.publicKey : (subject.trim().length >= 32 ? subject.trim() : null);
        if (!targetPubkey) {
            setFetchedBalance(null);
            return;
        }
        if (selectedMember && typeof selectedMember.balance === 'number') {
            setFetchedBalance(null);
            return;
        }
        let cancelled = false;
        getBalance(targetPubkey)
            .then(bal => {
                if (!cancelled && bal && typeof bal.balance === 'number') {
                    setFetchedBalance(bal.balance);
                }
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [effect, subject, selectedMember]);

    const targetName = selectedMember?.callsign || subject || 'Member';
    const targetBalance = selectedMember?.balance ?? fetchedBalance ?? 0;
    const debtAmount = Math.abs(targetBalance < 0 ? targetBalance : 0);
    const poolAmount = Math.round(commonsBalance || 0);

    // §3.8 verbatim line:
    // "<name>'s balance is −N beans. Removing them charges that N to the Commons pool, which currently holds M."
    // Note: Unicode \u2212 minus sign
    const debtWriteOffLine = debtAmount > 0
        ? `${targetName}'s balance is \u2212${debtAmount} beans. Removing them charges that ${debtAmount} to the Commons pool, which currently holds ${poolAmount}.`
        : `${targetName} has no outstanding debt (balance: ${targetBalance} beans). Removing them incurs no write-off charge against the Commons pool (balance: ${poolAmount}).`;

    const styles = useStyles(({ colors }) => StyleSheet.create({
        overlay: {
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.65)',
            justifyContent: 'flex-end',
        },
        sheet: {
            backgroundColor: colors.surface.card,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            maxHeight: '90%',
            paddingBottom: 32,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 20,
            paddingTop: 18,
            paddingBottom: 14,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
        },
        headerTitle: {
            fontSize: 18,
            fontWeight: '800',
            color: colors.text.heading,
        },
        closeBtn: {
            padding: 4,
        },
        body: {
            paddingHorizontal: 20,
            paddingVertical: 16,
        },
        sectionLabel: {
            fontSize: 12,
            fontWeight: '700',
            textTransform: 'uppercase',
            color: colors.text.secondary,
            letterSpacing: 0.5,
            marginBottom: 8,
            marginTop: 12,
        },
        segmentRow: {
            flexDirection: 'row',
            gap: 8,
            marginBottom: 10,
        },
        segmentBtn: {
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            paddingVertical: 10,
            borderRadius: 12,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        segmentBtnActive: {
            backgroundColor: colors.brand.tint,
            borderColor: colors.brand.primary,
        },
        segmentText: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.text.secondary,
        },
        segmentTextActive: {
            color: colors.brand.primary,
        },
        input: {
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
            color: colors.text.heading,
            fontSize: 14,
            marginBottom: 8,
        },
        textArea: {
            minHeight: 70,
            textAlignVertical: 'top',
        },
        effectCard: {
            padding: 10,
            borderRadius: 10,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
            marginBottom: 6,
        },
        effectCardActive: {
            backgroundColor: colors.brand.tint,
            borderColor: colors.brand.primary,
        },
        effectLabel: {
            fontSize: 14,
            fontWeight: '700',
            color: colors.text.heading,
            marginBottom: 2,
        },
        effectLabelActive: {
            color: colors.brand.primary,
        },
        effectDesc: {
            fontSize: 12,
            color: colors.text.secondary,
            lineHeight: 16,
        },
        removalWarningBox: {
            backgroundColor: palette.red100,
            borderRadius: 12,
            padding: 14,
            marginTop: 10,
            marginBottom: 12,
            borderWidth: 1,
            borderColor: palette.red300,
        },
        removalWarningTitle: {
            fontSize: 12,
            fontWeight: '800',
            color: palette.red700,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 4,
        },
        debtLineText: {
            fontSize: 13,
            color: palette.red900,
            lineHeight: 18,
            fontWeight: '600',
        },
        noBondNotice: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            backgroundColor: colors.surface.subtle,
            borderRadius: 12,
            padding: 12,
            marginTop: 14,
            marginBottom: 16,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        noBondText: {
            fontSize: 12,
            color: colors.text.secondary,
            flex: 1,
            lineHeight: 16,
        },
        submitBtn: {
            backgroundColor: colors.brand.primary,
            borderRadius: 14,
            paddingVertical: 14,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: colors.brand.dark,
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.2,
            shadowRadius: 4,
            elevation: 3,
            marginTop: 4,
        },
        submitBtnText: {
            color: colors.text.inverse,
            fontSize: 15,
            fontWeight: '800',
            letterSpacing: 0.3,
        },
    }));

    const handleSubmit = async () => {
        if (!title.trim()) {
            Alert.alert('Missing Title', 'Please enter a clear, concise title for this decision.');
            return;
        }
        if (!description.trim()) {
            Alert.alert('Missing Description', 'Please explain the rationale and details.');
            return;
        }

        const targetPubkey = selectedMember?.publicKey || (subject.trim().length === 64 ? subject.trim() : null);

        if (touches === 'member' && !targetPubkey) {
            Alert.alert('Member Not Found', 'Please enter or select a valid member callsign or 64-character public key.');
            return;
        }

        let params: any = {};
        if (effect === 'grant_enterprise' || effect === 'grant_hardship') {
            const amount = Number(grantAmount);
            if (!amount || amount <= 0) {
                Alert.alert('Invalid Amount', 'Please specify a valid grant amount in Beans.');
                return;
            }
            params = { amount };
        } else if (effect === 'remove_lead_keeper') {
            if (!enterprisePubkey.trim()) {
                Alert.alert('Missing Enterprise', 'Please select or enter the enterprise public key.');
                return;
            }
            if (!targetPubkey) {
                Alert.alert('Missing Lead Keeper', 'Please enter the lead keeper callsign or public key to remove.');
                return;
            }
            params = { enterprisePubkey: enterprisePubkey.trim(), leadPubkey: targetPubkey };
        } else if (effect === 'write_off_deficit') {
            if (!enterprisePubkey.trim()) {
                Alert.alert('Missing Enterprise', 'Please select or enter the enterprise public key.');
                return;
            }
        } else if (effect === 'remove_member') {
            params = {
                memberName: targetName,
                debt: debtAmount,
                commonsPool: poolAmount,
            };
        }

        setSubmitting(true);
        try {
            const resolvedSubject = (effect === 'write_off_deficit' ? enterprisePubkey.trim() : (touches === 'member' ? targetPubkey : (selectedMember ? selectedMember.publicKey : (subject.trim() || null)))) || null;
            const res = await createDecision({
                authorPubkey: identity.publicKey,
                title: title.trim(),
                description: description.trim(),
                touches,
                effect,
                subject: resolvedSubject,
                params,
            });

            if (res.success) {
                Alert.alert('Decision Proposed', 'Your community decision has been posted and 7-day voting is now open.');
                setTitle('');
                setDescription('');
                setSubject('');
                setEnterprisePubkey('');
                setGrantAmount('');
                onCreated();
                onClose();
            } else {
                Alert.alert('Error', (res as any).error || 'Failed to propose decision');
            }
        } catch (err: any) {
            Alert.alert('Error', err.message || 'Failed to propose decision');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal visible={isOpen} animationType="slide" transparent onRequestClose={onClose}>
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                style={styles.overlay}
            >
                <View style={styles.sheet}>
                    <View style={styles.header}>
                        <Text style={styles.headerTitle}>Propose a Community Decision</Text>
                        <Pressable accessibilityRole="button" accessibilityLabel="Close modal" onPress={onClose} style={styles.closeBtn}>
                            <MaterialCommunityIcons name="close" size={22} color={colors.text.secondary} />
                        </Pressable>
                    </View>

                    <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 24 }}>
                        {/* What it touches */}
                        <Text style={styles.sectionLabel}>What does this decision touch? (§3.6)</Text>
                        <View style={styles.segmentRow}>
                            {TOUCH_OPTIONS.map(opt => (
                                <Pressable
                                    key={opt.id}
                                    accessibilityRole="button"
                                    style={[styles.segmentBtn, touches === opt.id && styles.segmentBtnActive]}
                                    onPress={() => setTouches(opt.id)}
                                >
                                    <MaterialCommunityIcons
                                        name={opt.icon as any}
                                        size={16}
                                        color={touches === opt.id ? colors.brand.primary : colors.text.secondary}
                                    />
                                    <Text style={[styles.segmentText, touches === opt.id && styles.segmentTextActive]}>
                                        {opt.label}
                                    </Text>
                                </Pressable>
                            ))}
                        </View>

                        {/* Title & Description */}
                        <Text style={styles.sectionLabel}>Title</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="e.g. Grant 200 beans to the Tool Library"
                            placeholderTextColor={colors.text.muted}
                            value={title}
                            onChangeText={setTitle}
                        />

                        <Text style={styles.sectionLabel}>Description & Case</Text>
                        <TextInput
                            style={[styles.input, styles.textArea]}
                            placeholder="Explain why this decision is needed, what will be done, and who is responsible."
                            placeholderTextColor={colors.text.muted}
                            value={description}
                            onChangeText={setDescription}
                            multiline
                            numberOfLines={3}
                        />

                        {/* Effect Selector */}
                        <Text style={styles.sectionLabel}>Select Specific Effect</Text>
                        <View accessibilityRole="radiogroup" accessibilityLabel="Governance effect">
                            {EFFECTS_BY_TOUCH[touches].map(eff => (
                                <Pressable
                                    key={eff.id}
                                    accessibilityRole="radio"
                                    accessibilityState={{ checked: effect === eff.id }}
                                    style={[styles.effectCard, effect === eff.id && styles.effectCardActive]}
                                    onPress={() => setEffect(eff.id)}
                                >
                                    <Text style={[styles.effectLabel, effect === eff.id && styles.effectLabelActive]}>
                                        {eff.label}
                                    </Text>
                                    <Text style={styles.effectDesc}>{eff.desc}</Text>
                                </Pressable>
                            ))}
                        </View>

                        {/* Enterprise Input for remove_lead_keeper and write_off_deficit */}
                        {(effect === 'remove_lead_keeper' || effect === 'write_off_deficit') && (
                            <>
                                <Text style={styles.sectionLabel}>Target Enterprise Public Key</Text>
                                {treasuries && treasuries.length > 0 && (
                                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                                        {treasuries.map(t => (
                                            <Pressable
                                                key={t.publicKey}
                                                accessibilityRole="button"
                                                style={[
                                                    styles.segmentBtn,
                                                    enterprisePubkey === t.publicKey && styles.segmentBtnActive,
                                                    { paddingHorizontal: 10, paddingVertical: 6 }
                                                ]}
                                                onPress={() => setEnterprisePubkey(t.publicKey)}
                                            >
                                                <Text style={[styles.segmentText, enterprisePubkey === t.publicKey && styles.segmentTextActive, { fontSize: 12 }]}>
                                                    {t.name}
                                                </Text>
                                            </Pressable>
                                        ))}
                                    </View>
                                )}
                                <TextInput
                                    style={styles.input}
                                    placeholder="Enter enterprise pubkey..."
                                    placeholderTextColor={colors.text.muted}
                                    value={enterprisePubkey}
                                    onChangeText={setEnterprisePubkey}
                                />
                            </>
                        )}

                        {/* Subject Input */}
                        {touches === 'member' && (
                            <>
                                <Text style={styles.sectionLabel}>
                                    {effect === 'remove_lead_keeper' ? 'Lead Keeper Callsign or Public Key to Remove' : 'Target Member Public Key or Callsign'}
                                </Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder={effect === 'remove_lead_keeper' ? 'Enter lead keeper callsign or pubkey...' : 'Enter member callsign or pubkey...'}
                                    placeholderTextColor={colors.text.muted}
                                    value={subject}
                                    onChangeText={setSubject}
                                />
                            </>
                        )}

                        {effect === 'grant_enterprise' && (
                            <>
                                <Text style={styles.sectionLabel}>Target Enterprise Public Key</Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder="Enter enterprise pubkey..."
                                    placeholderTextColor={colors.text.muted}
                                    value={subject}
                                    onChangeText={setSubject}
                                />
                                <Text style={styles.sectionLabel}>Grant Amount (Beans)</Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder="e.g. 250"
                                    placeholderTextColor={colors.text.muted}
                                    value={grantAmount}
                                    onChangeText={setGrantAmount}
                                    keyboardType="numeric"
                                />
                            </>
                        )}

                        {effect === 'grant_hardship' && (
                            <>
                                <Text style={styles.sectionLabel}>Recipient Member Public Key</Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder="Enter recipient pubkey..."
                                    placeholderTextColor={colors.text.muted}
                                    value={subject}
                                    onChangeText={setSubject}
                                />
                                <Text style={styles.sectionLabel}>Hardship Amount (Beans)</Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder="e.g. 100"
                                    placeholderTextColor={colors.text.muted}
                                    value={grantAmount}
                                    onChangeText={setGrantAmount}
                                    keyboardType="numeric"
                                />
                            </>
                        )}

                        {/* Removal Ballot Special §3.8 Warning Box */}
                        {effect === 'remove_member' && (
                            <View style={styles.removalWarningBox} testID="removal-debt-write-off-box">
                                <Text style={styles.removalWarningTitle}>Mandatory Debt Disclosure (§3.8)</Text>
                                <Text style={styles.debtLineText} testID="removal-debt-write-off-line">
                                    {debtWriteOffLine}
                                </Text>
                            </View>
                        )}

                        {/* No Bond Notice (§3.2, §7) */}
                        <View style={styles.noBondNotice}>
                            <MaterialCommunityIcons name="shield-check" size={20} color={colors.brand.primary} />
                            <Text style={styles.noBondText}>
                                <Text style={{ fontWeight: '700' }}>No bond required.</Text> Open to members with a completed trade or earned standing, and to node admins. Open for 7 days. Closes and executes automatically.
                            </Text>
                        </View>

                        {/* Submit Button */}
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={submitting ? "Proposing decision" : "Submit Community Decision"}
                            accessibilityHint="Posts your community decision for a 7-day vote"
                            accessibilityState={{ disabled: submitting, busy: submitting }}
                            style={styles.submitBtn}
                            onPress={handleSubmit}
                            disabled={submitting}
                        >
                            {submitting ? (
                                <ActivityIndicator color={colors.text.inverse} />
                            ) : (
                                <Text style={styles.submitBtnText}>Submit Community Decision</Text>
                            )}
                        </Pressable>
                    </ScrollView>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}
