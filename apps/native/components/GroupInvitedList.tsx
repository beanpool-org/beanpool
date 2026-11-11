/**
 * "Invited, not joined yet", under a group's members (Rob via Marty, 11 Nov 2026: "Invitations should show whether they
 * have been used"). Each name and when they were invited, and for a convenor who invited them; a person moves into the
 * members above when they join. A convenor sees every pending invitation, any other member the ones they made, and a
 * declined one ("Declined", dated) shows only to the member who made it. The node decides that, not this screen
 * (GET /api/groups/:id/invitations): it draws what it is given, and nothing at all when the node gives nothing or there
 * is nothing to say. A convenor or the sender can withdraw a pending one.
 *
 * At 320 dp and 1.3× text a row is the avatar, the name over its line (up to two lines), and the Withdraw button that
 * never leaves the screen (48 dp target, its words wrap).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { useStyles } from '../app/ThemeContext';
import { MemberAvatar } from './MemberAvatar';
import { fetchGroupInvitations, withdrawGroupInvitationApi } from '../utils/db';
import { hapticSuccess } from '../utils/haptics';
import { signedRequestWords } from './signed-request-lines';
import {
    declinedInvitationLine, declinedListNote, declinedListTitle, hasInvitationsToShow, invitedListTitle, invitedName,
    moreInvitationsLine, pendingInvitationLine, withdrawWords, t, inCapitalsOf, type GroupInvitations, type InvitedPerson,
} from '@beanpool/core';

interface Props {
    groupId: string;
    myPubkey?: string;
    /** Changes whenever the group's page has read itself again (a join, an invitation sent), so this reads too. */
    reloadKey?: number;
    /** An invitation withdrawn here: the group around it may count or list differently. */
    onChanged?: () => void;
}

export function GroupInvitedList({ groupId, myPubkey, reloadKey = 0, onChanged }: Props) {
    const [inv, setInv] = useState<GroupInvitations | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        const next = await fetchGroupInvitations(groupId);
        // Nothing to say, or the node won't: the list is simply not there. A read that failed keeps the one on screen.
        setInv(prev => next ?? prev);
    }, [groupId]);

    useEffect(() => { void load(); }, [load, reloadKey]);

    const styles = useStyles(({ colors }) => StyleSheet.create({
        wrap: { marginTop: 8 },
        title: { fontSize: 12, fontWeight: '800', color: colors.text.secondary, letterSpacing: 0.5, marginTop: 16, marginBottom: 6 },
        note: { fontSize: 12, color: colors.text.muted, marginBottom: 4 },
        row: {
            flexDirection: 'row', alignItems: 'center', paddingVertical: 8,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border.default,
        },
        info: { flex: 1, minWidth: 0, marginLeft: 12, marginRight: 8 },
        name: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
        line: { fontSize: 12, color: colors.text.secondary, marginTop: 2 },
        withdraw: {
            flexShrink: 0, maxWidth: '40%', minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12,
            borderRadius: 8, borderWidth: 1, borderColor: colors.border.default,
        },
        withdrawText: { fontSize: 12, fontWeight: '700', color: colors.text.secondary, textAlign: 'center' },
        more: { fontSize: 12, color: colors.text.muted, paddingTop: 8 },
    }));

    if (!hasInvitationsToShow(inv)) return null;

    const withdraw = (p: InvitedPerson) => {
        const w = withdrawWords(p);
        Alert.alert(w.title, w.question, [
            { text: t('Cancel'), style: 'cancel' },
            {
                text: w.button,
                style: 'destructive',
                onPress: async () => {
                    setBusy(p.memberPubkey);
                    try {
                        // Its own request, never the member removal: if they accepted since this list was read, the node
                        // refuses (409, "already joined") rather than removing a member who has just joined.
                        await withdrawGroupInvitationApi(groupId, p.memberPubkey);
                        hapticSuccess();
                        await load();
                        onChanged?.();
                    } catch (e: any) {
                        Alert.alert(w.failed, e?.message ? signedRequestWords(e.message) : undefined);
                        // Refused because things moved on (they joined, or it was declined or withdrawn): read both lists
                        // again, so the person shows where they now are.
                        await load();
                        onChanged?.();
                    } finally {
                        setBusy(null);
                    }
                },
            },
        ]);
    };

    const now = Date.now();
    const more = moreInvitationsLine(inv);
    return (
        <View style={styles.wrap} testID="group-invited-list">
            {inv.pending.length > 0 && (
                <>
                    <Text style={styles.title} accessibilityRole="header">{inCapitalsOf(invitedListTitle(inv.pendingTotal))}</Text>
                    {inv.pending.map(p => {
                        const w = withdrawWords(p);
                        return (
                            <View key={p.memberPubkey} style={styles.row} testID="group-invited-row">
                                <MemberAvatar avatarUrl={p.avatarUrl} pubkey={p.memberPubkey} callsign={p.callsign || '?'} size={28} />
                                <View style={styles.info}>
                                    <Text style={styles.name} numberOfLines={1}>{invitedName(p)}</Text>
                                    <Text style={styles.line} numberOfLines={2}>{pendingInvitationLine(p, myPubkey, now)}</Text>
                                </View>
                                <Pressable
                                    style={[styles.withdraw, busy === p.memberPubkey && { opacity: 0.6 }]}
                                    accessibilityRole="button"
                                    accessibilityLabel={w.label}
                                    accessibilityState={{ disabled: busy !== null, busy: busy === p.memberPubkey }}
                                    disabled={busy !== null}
                                    onPress={() => withdraw(p)}
                                    testID="group-invited-withdraw"
                                >
                                    <Text style={styles.withdrawText} numberOfLines={2}>{w.button}</Text>
                                </Pressable>
                            </View>
                        );
                    })}
                    {more !== '' && <Text style={styles.more}>{more}</Text>}
                </>
            )}
            {inv.declined.length > 0 && (
                <>
                    <Text style={styles.title} accessibilityRole="header">{inCapitalsOf(declinedListTitle())}</Text>
                    <Text style={styles.note}>{declinedListNote()}</Text>
                    {inv.declined.map(d => (
                        <View key={d.memberPubkey} style={styles.row} testID="group-declined-row">
                            <MemberAvatar avatarUrl={d.avatarUrl} pubkey={d.memberPubkey} callsign={d.callsign || '?'} size={28} />
                            <View style={styles.info}>
                                <Text style={styles.name} numberOfLines={1}>{invitedName(d)}</Text>
                                <Text style={styles.line} numberOfLines={2}>{declinedInvitationLine(d, now)}</Text>
                            </View>
                        </View>
                    ))}
                </>
            )}
        </View>
    );
}
