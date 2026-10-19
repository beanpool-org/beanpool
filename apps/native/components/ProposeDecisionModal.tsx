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
} from '../utils/db';
import { inCapitalsOf, keeperWords, t, tn, word, type WordKey } from '@beanpool/core';
import { Sentence } from './Sentence';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onCreated: () => void;
    identity: any;
    commonsBalance: number;
    members?: Array<{ publicKey: string; callsign?: string; balance?: number }>;
    treasuries?: Array<{ publicKey: string; name: string; balance?: number; lifecycle?: string | null }>;
}

/** What a Decision can touch and do: word() keys, shown through t(). */
const TOUCH_OPTIONS: Array<{ id: DecisionTouch; label: WordKey; icon: string }> = [
    { id: 'member', label: word('Member', 'what a Decision touches'), icon: 'account-cog' },
    { id: 'pool', label: word('Commons Pool'), icon: 'bank' },
];

const EFFECTS_BY_TOUCH: Record<DecisionTouch, Array<{ id: DecisionEffect; label: WordKey; desc: WordKey }>> = {
    member: [
        { id: 'remove_member', label: word('Remove Member'), desc: word('Expulsion from this node (66% supermajority, 25% quorum, 7-day grace window)') },
        { id: 'suspend_member', label: word('Suspend Member'), desc: word('Temporary freeze of trading and messaging') },
        { id: 'unsuspend_member', label: word('Unsuspend Member'), desc: word('Restore member to active standing (simple majority)') },
        { id: 'reinstate_member', label: word('Reinstate Member'), desc: word('Cancel pending removal and restore account (simple majority)') },
        { id: 'freeze_credit', label: word('Freeze Credit'), desc: word('Lock credit floor to zero') },
        { id: 'unfreeze_credit', label: word('Unfreeze Credit'), desc: word('Restore credit floor (simple majority)') },
        { id: 'grant_voucher', label: word('Grant Voucher'), desc: word('Authorise member to vouch for newcomers') },
        { id: 'revoke_voucher', label: word('Revoke Voucher'), desc: word('Remove vouching privileges') },
        { id: 'remove_lead_keeper', label: word('Remove a lead keeper or project leader'), desc: word("Replace an enterprise's lead keeper or a project's leader") },
    ],
    pool: [
        { id: 'grant_enterprise', label: word('Give Beans to a project or enterprise'), desc: word("Pay Beans from the Commons pool straight into a project's or enterprise's account") },
        { id: 'grant_hardship', label: word('Hardship Grant'), desc: word('Direct emergency support grant from Commons pool to a member') },
        { id: 'write_off_deficit', label: word("Pay off a project's or enterprise's debt"), desc: word("The Commons pool takes on the debt of a project or enterprise that can't pay it") },
    ],
};

/**
 * The removal of a lead: a project's leader, an enterprise's lead keeper, or (none picked yet) both words. Whole
 * sentences for each, never the word glued in.
 */
function leadWords(lead: 'leader' | 'lead keeper' | 'either') {
    if (lead === 'leader') {
        return {
            missing: t('Missing leader'), enter: t("Please enter the leader's callsign or public key."),
            label: t('The leader to remove: callsign or public key'), placeholder: t("Enter the leader's callsign or pubkey..."),
        };
    }
    if (lead === 'lead keeper') {
        return {
            missing: t('Missing lead keeper'), enter: t("Please enter the lead keeper's callsign or public key."),
            label: t('The lead keeper to remove: callsign or public key'), placeholder: t("Enter the lead keeper's callsign or pubkey..."),
        };
    }
    return {
        missing: t('Missing lead keeper or leader'), enter: t("Please enter the lead keeper or leader's callsign or public key."),
        label: t('The lead keeper or leader to remove: callsign or public key'), placeholder: t("Enter the lead keeper or leader's callsign or pubkey..."),
    };
}

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

    // What the node records as the member's name stays as it always was; only the line shown is in the member's language.
    const targetName = selectedMember?.callsign || subject || 'Member';
    const shownName = selectedMember?.callsign || subject || t('Member');
    // The one removed is a project's leader or an enterprise's lead keeper (§3.1); until one is picked, both words.
    const pickedGroup = treasuries.find(tr => tr.publicKey === enterprisePubkey.trim());
    const lead = leadWords(pickedGroup ? (keeperWords(pickedGroup.lifecycle).lead === 'leader' ? 'leader' : 'lead keeper') : 'either');
    const poolAmount = Math.round(commonsBalance || 0);

    // §3.8, with balances private (Marty, 2026-09-28): the proposer does not see the member's balance. The community
    // records it, and any debt, when the vote opens, and shows them to everyone who can vote in it. English writes
    // "beans" for one and many, as it always has.
    const debtWriteOffLine = tn(
        poolAmount,
        "Balances are private: you can't see {name}'s. When this vote opens, the community records their balance and any debt, and shows them to everyone who can vote in it. If they are removed, a debt is charged to the Commons pool, which holds {n} beans now.",
        "Balances are private: you can't see {name}'s. When this vote opens, the community records their balance and any debt, and shows them to everyone who can vote in it. If they are removed, a debt is charged to the Commons pool, which holds {n} beans now.",
        { name: shownName },
    );

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
            flexShrink: 1,
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
            // In capitals by inCapitalsOf (the language's way), never a textTransform (the phone's).
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
            flexShrink: 1,
            textAlign: 'center',
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
            backgroundColor: colors.brand.fill,
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
            Alert.alert(t('Missing Title'), t('Please enter a clear, concise title for this decision.'));
            return;
        }
        if (!description.trim()) {
            Alert.alert(t('Missing Description'), t('Please explain the rationale and details.'));
            return;
        }

        const targetPubkey = selectedMember?.publicKey || (subject.trim().length === 64 ? subject.trim() : null);

        if (touches === 'member' && !targetPubkey) {
            Alert.alert(t('Member Not Found'), t('Please enter or select a valid member callsign or 64-character public key.'));
            return;
        }

        let params: any = {};
        if (effect === 'grant_enterprise' || effect === 'grant_hardship') {
            const amount = Number(grantAmount);
            if (!amount || amount <= 0) {
                Alert.alert(t('Invalid Amount'), t('Please specify a valid grant amount in Beans.'));
                return;
            }
            params = { amount };
        } else if (effect === 'remove_lead_keeper') {
            if (!enterprisePubkey.trim()) {
                Alert.alert(t('Missing project or enterprise'), t('Please pick the project or enterprise, or enter its public key.'));
                return;
            }
            if (!targetPubkey) {
                Alert.alert(lead.missing, lead.enter);
                return;
            }
            params = { enterprisePubkey: enterprisePubkey.trim(), leadPubkey: targetPubkey };
        } else if (effect === 'write_off_deficit') {
            if (!enterprisePubkey.trim()) {
                Alert.alert(t('Missing project or enterprise'), t('Please pick the project or enterprise, or enter its public key.'));
                return;
            }
        } else if (effect === 'remove_member') {
            // The debt and balance are the node's to record when the vote opens (decisions-engine createDecision).
            params = {
                memberName: targetName,
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
                Alert.alert(t('Decision Proposed'), t('Your community decision has been posted and 7-day voting is now open.'));
                setTitle('');
                setDescription('');
                setSubject('');
                setEnterprisePubkey('');
                setGrantAmount('');
                onCreated();
                onClose();
            } else {
                // The node's own words as it sent them (slice S4).
                Alert.alert(t('Error'), (res as any).error || t('Failed to propose decision'));
            }
        } catch (err: any) {
            Alert.alert(t('Error'), err.message || t('Failed to propose decision'));
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
                        <Text style={styles.headerTitle}>{t('Propose a Community Decision')}</Text>
                        <Pressable accessibilityRole="button" accessibilityLabel={t('Close modal')} onPress={onClose} style={styles.closeBtn}>
                            <MaterialCommunityIcons name="close" size={22} color={colors.text.secondary} />
                        </Pressable>
                    </View>

                    <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 24 }}>
                        {/* What it touches */}
                        <Text style={styles.sectionLabel}>{inCapitalsOf(t('What does this decision touch? (§3.6)'))}</Text>
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
                                        {t(opt.label)}
                                    </Text>
                                </Pressable>
                            ))}
                        </View>

                        {/* Title & Description */}
                        <Text style={styles.sectionLabel}>{inCapitalsOf(t('Title'))}</Text>
                        <TextInput
                            style={styles.input}
                            placeholder={t('e.g. Grant 200 beans to the Tool Library')}
                            placeholderTextColor={colors.text.muted}
                            value={title}
                            onChangeText={setTitle}
                        />

                        <Text style={styles.sectionLabel}>{inCapitalsOf(t('Description & Case'))}</Text>
                        <TextInput
                            style={[styles.input, styles.textArea]}
                            placeholder={t('Explain why this decision is needed, what will be done, and who is responsible.')}
                            placeholderTextColor={colors.text.muted}
                            value={description}
                            onChangeText={setDescription}
                            multiline
                            numberOfLines={3}
                        />

                        {/* Effect Selector */}
                        <Text style={styles.sectionLabel}>{inCapitalsOf(t('Select Specific Effect'))}</Text>
                        <View accessibilityRole="radiogroup" accessibilityLabel={t('Governance effect')}>
                            {EFFECTS_BY_TOUCH[touches].map(eff => (
                                <Pressable
                                    key={eff.id}
                                    accessibilityRole="radio"
                                    accessibilityState={{ checked: effect === eff.id }}
                                    style={[styles.effectCard, effect === eff.id && styles.effectCardActive]}
                                    onPress={() => setEffect(eff.id)}
                                >
                                    <Text style={[styles.effectLabel, effect === eff.id && styles.effectLabelActive]}>
                                        {t(eff.label)}
                                    </Text>
                                    <Text style={styles.effectDesc}>{t(eff.desc)}</Text>
                                </Pressable>
                            ))}
                        </View>

                        {/* Enterprise Input for remove_lead_keeper and write_off_deficit */}
                        {(effect === 'remove_lead_keeper' || effect === 'write_off_deficit') && (
                            <>
                                <Text style={styles.sectionLabel}>{inCapitalsOf(t('Project or enterprise'))}</Text>
                                {treasuries && treasuries.length > 0 && (
                                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                                        {treasuries.map(tr => (
                                            <Pressable
                                                key={tr.publicKey}
                                                accessibilityRole="button"
                                                style={[
                                                    styles.segmentBtn,
                                                    enterprisePubkey === tr.publicKey && styles.segmentBtnActive,
                                                    { paddingHorizontal: 10, paddingVertical: 6 }
                                                ]}
                                                onPress={() => setEnterprisePubkey(tr.publicKey)}
                                            >
                                                <Text style={[styles.segmentText, enterprisePubkey === tr.publicKey && styles.segmentTextActive, { fontSize: 12 }]}>
                                                    {tr.name}
                                                </Text>
                                            </Pressable>
                                        ))}
                                    </View>
                                )}
                                <TextInput
                                    style={styles.input}
                                    placeholder={t('Or enter its public key...')}
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
                                    {inCapitalsOf(effect === 'remove_lead_keeper' ? lead.label : t('Target Member Public Key or Callsign'))}
                                </Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder={effect === 'remove_lead_keeper' ? lead.placeholder : t('Enter member callsign or pubkey...')}
                                    placeholderTextColor={colors.text.muted}
                                    value={subject}
                                    onChangeText={setSubject}
                                />
                            </>
                        )}

                        {effect === 'grant_enterprise' && (
                            <>
                                <Text style={styles.sectionLabel}>{inCapitalsOf(t('Project or enterprise public key'))}</Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder={t('Enter its public key...')}
                                    placeholderTextColor={colors.text.muted}
                                    value={subject}
                                    onChangeText={setSubject}
                                />
                                <Text style={styles.sectionLabel}>{inCapitalsOf(t('Grant Amount (Beans)'))}</Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder={t('e.g. 250')}
                                    placeholderTextColor={colors.text.muted}
                                    value={grantAmount}
                                    onChangeText={setGrantAmount}
                                    keyboardType="numeric"
                                />
                            </>
                        )}

                        {effect === 'grant_hardship' && (
                            <>
                                <Text style={styles.sectionLabel}>{inCapitalsOf(t('Recipient Member Public Key'))}</Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder={t('Enter recipient pubkey...')}
                                    placeholderTextColor={colors.text.muted}
                                    value={subject}
                                    onChangeText={setSubject}
                                />
                                <Text style={styles.sectionLabel}>{inCapitalsOf(t('Hardship Amount (Beans)'))}</Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder={t('e.g. 100')}
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
                                <Text style={styles.removalWarningTitle}>{inCapitalsOf(t('Mandatory Debt Disclosure (§3.8)'))}</Text>
                                <Text style={styles.debtLineText} testID="removal-debt-write-off-line">
                                    {debtWriteOffLine}
                                </Text>
                            </View>
                        )}

                        {/* No Bond Notice (§3.2, §7) */}
                        <View style={styles.noBondNotice}>
                            <MaterialCommunityIcons name="shield-check" size={20} color={colors.brand.primary} />
                            <Text style={styles.noBondText}>
                                <Sentence
                                    text={t('{bond} Open to members with a completed trade or earned standing, and to node admins. Open for 7 days. Closes and executes automatically.')}
                                    parts={{ bond: <Text style={{ fontWeight: '700' }}>{t('No bond required.')}</Text> }}
                                />
                            </Text>
                        </View>

                        {/* Submit Button */}
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={submitting ? t('Proposing decision') : t('Submit Community Decision')}
                            accessibilityHint={t('Posts your community decision for a 7-day vote')}
                            accessibilityState={{ disabled: submitting, busy: submitting }}
                            style={styles.submitBtn}
                            onPress={handleSubmit}
                            disabled={submitting}
                        >
                            {submitting ? (
                                <ActivityIndicator color={colors.text.inverse} />
                            ) : (
                                <Text style={styles.submitBtnText}>{t('Submit Community Decision')}</Text>
                            )}
                        </Pressable>
                    </ScrollView>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}
