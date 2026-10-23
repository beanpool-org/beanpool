/**
 * The quiet-lead vote, on the group's own screen (2026-09-23).
 *
 * A group's lead convenor cannot be removed or demoted by anyone — node admins included — so a lead who has gone
 * quiet, or whose account has been suspended, leaves the group with one way out: the 30-day-silence vote. It has
 * been on the server since 2026-09-19 with nothing calling it. This is what calls it.
 *
 * What it may show is decided in utils/group-succession, from `silence`, `proposals` and `canPropose` and nothing
 * else — the server is the authority on who may propose and who may vote, and its refusal is what a member reads
 * when this guesses wrong. A healthy group sees nothing here at all, and neither does a group on a node too old
 * for the route. For the fortnight after a vote closed it shows one plain line saying how it ended — the warning
 * colour is for something that is actually happening.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, Keyboard } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles } from '../app/ThemeContext';
import {
    fetchGroupSuccession, proposeGroupSuccessionApi, voteGroupSuccessionApi, isRouteMissing,
    type GroupMemberItem,
} from '../utils/db';
import { buildSuccessionView, voteConfirmText, type GroupSuccessionData } from '../utils/group-succession';
import { inCapitalsOf, t } from '@beanpool/core';
import { hapticSuccess } from '../utils/haptics';
import { signedRequestWords } from './signed-request-lines';

interface Props {
    groupId: string;
    /** The roster the screen already holds: the picker offers the electorate out of it. */
    members: GroupMemberItem[];
    myPubkey?: string;
    /** A vote that passes moves the lead, so the screen around this has to read itself again. */
    onLeadChanged?: () => void;
}

export function GroupSuccessionPanel({ groupId, members, myPubkey, onLeadChanged }: Props) {
    const { colors } = useTheme();
    const [data, setData] = useState<GroupSuccessionData | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setData(await fetchGroupSuccession(groupId));
        } catch (e) {
            // A node older than the route answers 404: show nothing, say nothing. Anything else is also not worth
            // an error about a section the group may never need.
            if (!isRouteMissing(e)) console.warn('[GroupSuccession] Could not read the lead vote:', e);
            setData(null);
        }
    }, [groupId]);

    useEffect(() => { void load(); }, [load]);

    const styles = useStyles(({ colors }) => StyleSheet.create({
        card: {
            backgroundColor: colors.feedback.warning.bg,
            borderWidth: 1,
            borderColor: colors.feedback.warning.border,
            borderRadius: 16,
            padding: 14,
            marginBottom: 16,
            gap: 8,
        },
        heading: {
            fontSize: 12,
            fontWeight: '800',
            letterSpacing: 0.5,
            color: colors.feedback.warning.fg,
        },
        // Nothing is under way: the group screen's own quiet section, not a warning.
        quietCard: {
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.default,
            borderRadius: 16,
            padding: 14,
            marginBottom: 16,
            gap: 8,
        },
        quietHeading: {
            fontSize: 12,
            fontWeight: '700',
            letterSpacing: 0.5,
            color: colors.text.muted,
        },
        body: { fontSize: 13, lineHeight: 19, color: colors.text.secondary },
        note: { fontSize: 11, lineHeight: 16, color: colors.text.muted },
        errorText: { fontSize: 12, lineHeight: 17, color: colors.feedback.danger.fg },
        inner: {
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.default,
            borderRadius: 12,
            padding: 12,
            gap: 8,
        },
        candidateLine: { fontSize: 13, fontWeight: '800', color: colors.text.heading },
        // Wraps rather than squeezing at 320dp with 1.3x text.
        buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        yesBtn: {
            flexGrow: 1, flexBasis: 110, minHeight: 48, borderRadius: 12, alignItems: 'center',
            justifyContent: 'center', paddingHorizontal: 12, backgroundColor: colors.feedback.success.solid,
        },
        yesBtnText: { fontSize: 13, fontWeight: '800', color: colors.text.inverse },
        noBtn: {
            flexGrow: 1, flexBasis: 110, minHeight: 48, borderRadius: 12, alignItems: 'center',
            justifyContent: 'center', paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border.default,
        },
        noBtnText: { fontSize: 13, fontWeight: '800', color: colors.text.secondary },
        votedPill: {
            flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
            paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10,
            backgroundColor: colors.feedback.success.bg, borderWidth: 1, borderColor: colors.feedback.success.border,
        },
        votedText: { fontSize: 12, fontWeight: '800', color: colors.feedback.success.fg, flexShrink: 1 },
        candidateRow: {
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            gap: 8, paddingVertical: 6,
        },
        candidateName: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.text.heading },
        proposeBtn: {
            minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10,
            borderWidth: 1, borderColor: colors.feedback.warning.border,
            backgroundColor: colors.feedback.warning.solid,
        },
        proposeBtnText: { fontSize: 12, fontWeight: '800', color: colors.text.onGold },
    }));

    const view = buildSuccessionView(data, members);

    const performPropose = async (candidatePubkey: string) => {
        setBusy(true);
        setError(null);
        try {
            const res = await proposeGroupSuccessionApi(groupId, candidatePubkey);
            hapticSuccess();
            await load();
            // A group whose lead is its only convenor can be one person: the proposal is the proposer's yes, and
            // that can already settle it.
            if (res?.executed && onLeadChanged) onLeadChanged();
        } catch (e: any) {
            // The server's own words. It knows who may stand and who may propose; this does not.
            setError(e?.message ? signedRequestWords(e.message) : t('Could not propose a new lead.'));
        } finally {
            setBusy(false);
        }
    };

    const confirmPropose = (m: GroupMemberItem) => {
        const question = m.memberPubkey === myPubkey
            ? t("Propose yourself as the group's new lead convenor? Proposing counts as your yes, and votes can't be changed.")
            : t("Propose {name} as the group's new lead convenor? Proposing counts as your yes, and votes can't be changed.", { name: m.callsign || m.memberPubkey.slice(0, 10) });
        // Nothing here takes typing, but the screen around it might: never leave a keyboard up under an Alert.
        Keyboard.dismiss();
        Alert.alert(
            t('Propose a new lead'),
            question,
            [
                { text: t('Cancel'), style: 'cancel' as const },
                { text: t('Propose'), onPress: () => { void performPropose(m.memberPubkey); } },
            ],
        );
    };

    const performVote = async (proposalId: string, choice: 'yes' | 'no') => {
        setBusy(true);
        setError(null);
        try {
            const res = await voteGroupSuccessionApi(groupId, proposalId, choice);
            hapticSuccess();
            await load();
            if (res?.executed && onLeadChanged) onLeadChanged();
        } catch (e: any) {
            setError(e?.message ? signedRequestWords(e.message) : t('Could not record your vote.'));
        } finally {
            setBusy(false);
        }
    };

    const confirmVote = (choice: 'yes' | 'no') => {
        const open = view.openProposal;
        if (!open) return;
        Keyboard.dismiss();
        Alert.alert(
            choice === 'yes' ? t('Vote yes') : t('Vote no'),
            voteConfirmText(choice, open.candidateCallsign),
            [
                { text: t('Cancel'), style: 'cancel' as const },
                { text: choice === 'yes' ? t('Yes') : t('No'), onPress: () => { void performVote(open.id, choice); } },
            ],
        );
    };

    if (!view.show) return null;

    // Nothing is under way: the last vote's one line, and no heading announcing a process that is over — only a
    // result the group may not have seen yet.
    if (view.outcomeOnly) {
        if (!view.outcomeLine) return null;
        return (
            <View style={styles.quietCard}>
                <Text style={styles.quietHeading}>{inCapitalsOf(t('Lead convenor', undefined, 'group role'))}</Text>
                <Text style={styles.body}>{view.outcomeLine}</Text>
            </View>
        );
    }

    const open = view.openProposal;
    const candidateName = open?.candidateCallsign || open?.candidatePubkey.slice(0, 10) || '';

    return (
        <View style={styles.card} accessibilityLabel={t('Choosing a new lead convenor')}>
            <Text style={styles.heading}>{inCapitalsOf(t('Choosing a new lead convenor'))}</Text>

            {view.silenceLine ? <Text style={styles.body}>{view.silenceLine}</Text> : null}
            {/* Who takes part: only people in the group before the lead went quiet. Anyone offered no button reads why. */}
            {view.whoVotesLine ? <Text style={styles.body}>{view.whoVotesLine}</Text> : null}

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            {open ? (
                <View style={styles.inner}>
                    <Text style={styles.candidateLine}>{t('Proposed as the new lead: {name}', { name: candidateName })}</Text>
                    {view.closingLine ? <Text style={styles.body}>{view.closingLine}</Text> : null}
                    {/* Totals only. Who voted which way is nobody's business but their own, and the server never
                        sends it: there is no voter list here to leak. */}
                    <Text style={styles.body}>{view.tallyLine}</Text>
                    <Text style={styles.note}>
                        {t('It passes if more than half of those who answer say yes. Votes are secret, and nobody sees who voted which way.')}
                    </Text>

                    {view.myVote ? (
                        <View style={styles.votedPill}>
                            <MaterialCommunityIcons name="check" size={16} color={colors.feedback.success.fg} />
                            <Text style={[styles.votedText, { flexShrink: 1 }]}>
                                {view.myVote === 'no' ? t("You voted no. Votes can't be changed.") : t("You voted yes. Votes can't be changed.")}
                            </Text>
                        </View>
                    ) : view.canVote ? (
                        <View style={styles.buttonRow}>
                            <Pressable
                                style={[styles.yesBtn, busy && { opacity: 0.6 }]}
                                disabled={busy}
                                accessibilityRole="button"
                                accessibilityLabel={t('Vote yes to make {name} the lead convenor', { name: candidateName })}
                                accessibilityState={{ disabled: busy }}
                                onPress={() => confirmVote('yes')}
                            >
                                <Text style={styles.yesBtnText}>{t('Yes')}</Text>
                            </Pressable>
                            <Pressable
                                style={[styles.noBtn, busy && { opacity: 0.6 }]}
                                disabled={busy}
                                accessibilityRole="button"
                                accessibilityLabel={t('Vote no to making {name} the lead convenor', { name: candidateName })}
                                accessibilityState={{ disabled: busy }}
                                onPress={() => confirmVote('no')}
                            >
                                <Text style={styles.noBtnText}>{t('No')}</Text>
                            </Pressable>
                        </View>
                    ) : null}
                </View>
            ) : view.canPropose ? (
                <View style={styles.inner}>
                    <Text style={styles.candidateLine}>{t('Propose a new lead')}</Text>
                    {/* One row each, rather than an Alert's handful of buttons: when the lead is a group's only
                        convenor the electorate is every member, and a list of six would hide most of them. */}
                    {view.candidates.map(m => (
                        <View key={m.memberPubkey} style={styles.candidateRow}>
                            <Text style={styles.candidateName} numberOfLines={2}>
                                {m.memberPubkey === myPubkey
                                    ? t('{name} (yourself)', { name: m.callsign || m.memberPubkey.slice(0, 10) })
                                    : (m.callsign || m.memberPubkey.slice(0, 10))}
                            </Text>
                            <Pressable
                                style={[styles.proposeBtn, busy && { opacity: 0.6 }]}
                                disabled={busy}
                                accessibilityRole="button"
                                accessibilityLabel={t('Propose {name} as the lead convenor', { name: m.callsign || m.memberPubkey.slice(0, 10) })}
                                accessibilityState={{ disabled: busy }}
                                onPress={() => confirmPropose(m)}
                            >
                                <Text style={styles.proposeBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Propose')}</Text>
                            </Pressable>
                        </View>
                    ))}
                    <Text style={styles.note}>
                        {t('Proposing counts as your yes. The vote runs for 14 days, and closes at once if the lead comes back.')}
                    </Text>
                </View>
            ) : null}

            {view.outcomeLine ? <Text style={styles.body}>{view.outcomeLine}</Text> : null}
        </View>
    );
}
