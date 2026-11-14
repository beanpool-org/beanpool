/**
 * People → Invites: the invites a member has made, said in words (invites-vouching slice I1; DESIGN-invites-vouching-review-
 * fable.md §3 asks 3 and 5). Marty, 10 Nov: a bound invite showed as a bare code under "Share this cryptographic code",
 * so a second, plain invite was made for her. Now:
 *
 *   Pending (n) ›  and  Joined (n) ›   folded, closed until opened (and kept open for the session once opened), count in the row
 *   each Pending row   who it is for (the name opened from the names list on this phone, else the name of the contact it was made
 *                      for, from the private contacts list on this phone (C5), else the note, else the code), what it
 *                      carries ("200 vouch · voucher budget 1,000 · confirms them as known"), "23 days left" (red at 3 or fewer)
 *   the whole row      opens the invite: its QR and Share (the caller's, the text message)
 *   the made card      "Invite for Sam · 200 vouch · voucher budget 1,000 · 30 days left" and Share
 *   Revoke (I2)        on an open invite and the made card, asked first with the design's words (core inviteRevokeAsk); the
 *                      caller revokes it on the community (DELETE /api/invite/:code). Never on an offline ticket (inviteRevocable).
 *
 * The words are core's (invite-rows.ts), so the web says the same. A name is opened from the names list only by the caller:
 * this draws what it is handed, and says when Pending is open with a bound invite in it (`onNeedNames`) so the caller opens
 * the list (a logged read, as any open of it is). Every row is at least 48 dp tall and wraps at 320 dp with 1.3x text.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet, Alert } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import {
    formatDate, inviteCarries, inviteFolds, inviteMadeTitle, inviteRevocable, inviteRevokeAsk, inviteRevokeWords, inviteTimeLeft, inviteWho, joinedHeading,
    joinedInvites, pendingHeading, pendingInvites, t, type InviteRowSource,
} from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';
import { palette } from '../constants/colors';

/** A fold's open state: closed at first, kept for the session (core inviteFolds). */
function useFold(key: string): [boolean, () => void] {
    const [open, setOpen] = useState(() => inviteFolds.isOpen(key));
    return [open, () => { inviteFolds.set(key, !open); setOpen(!open); }];
}

const dayWords = (iso: string | null | undefined): string => {
    const d = iso ? new Date(iso) : null;
    return d && Number.isFinite(d.getTime()) ? formatDate(d, 'day-month-year') : '';
};

/** The three lines of an invite: who, what it carries, how long. */
function InviteLines({ inv, name, contactName, now, nameOnPhone }: { inv: InviteRowSource; name?: string | null; contactName?: string | null; now: number; nameOnPhone?: boolean }) {
    const styles = useStyles(makeStyles);
    const left = inviteTimeLeft(inv, now);
    return (
        <View style={styles.lines}>
            <Text style={styles.who} maxFontSizeMultiplier={1.3} numberOfLines={2} testID="invite-who">{inviteWho(inv, { name, nameOnPhone, contactName })}</Text>
            <Text style={styles.carries} maxFontSizeMultiplier={1.3} testID="invite-carries">{inviteCarries(inv)}</Text>
            {left ? <Text style={[styles.left, left.urgent && styles.leftUrgent]} maxFontSizeMultiplier={1.3} testID="invite-left">{left.text}</Text> : null}
        </View>
    );
}

/** Revoke, asked first (core inviteRevokeAsk). `onRevoke` revokes it on the community and resolves true once it is gone. */
export function RevokeInviteButton({ inv, name, onRevoke, testID = 'invite-revoke' }: {
    inv: InviteRowSource; name?: string | null; onRevoke: (inv: InviteRowSource) => Promise<boolean>; testID?: string;
}) {
    const styles = useStyles(makeStyles);
    const [busy, setBusy] = useState(false);
    const ask = () => {
        const words = inviteRevokeAsk(inv, name);
        Alert.alert(words.title, words.body, [
            { text: inviteRevokeWords.cancel(), style: 'cancel' },
            {
                text: inviteRevokeWords.revoke(), style: 'destructive', onPress: async () => {
                    setBusy(true);
                    try { await onRevoke(inv); } finally { setBusy(false); }
                },
            },
        ]);
    };
    return (
        <Pressable onPress={ask} disabled={busy} accessibilityRole="button" accessibilityState={{ busy }} style={[styles.revokeBtn, busy && { opacity: 0.6 }]} testID={testID}>
            <Text style={styles.revokeText} maxFontSizeMultiplier={1.3}>{busy ? inviteRevokeWords.revoking() : inviteRevokeWords.revoke()}</Text>
        </Pressable>
    );
}

export interface PendingInvitesProps {
    /** Every invite the member has made: the node's, and any offline tickets this phone made. */
    invites: readonly InviteRowSource[];
    now: number;
    /** Names opened from the names list on this phone, by entry id (empty where the list isn't open or holds no key of theirs). */
    names: ReadonlyMap<string, string>;
    /** Pending is open with an invite bound to a names-list entry in it: the caller opens the list so the names can be shown. */
    onNeedNames?: (need: boolean) => void;
    /** Names from the member's private contacts on this phone, by code in lower case (core contactInviteNames; C5). */
    contactNames?: ReadonlyMap<string, string>;
    /** A fold is open with an invite in it that has no note and no names-list entry: the caller opens the contacts list. */
    onNeedContacts?: (need: boolean) => void;
    /** What the QR of an open invite holds: its link. */
    qrValue: (code: string) => string;
    /** What goes under an open invite's QR: the Share button (or, where invites are only previewed, the marker that says so). */
    shareSlot: (code: string) => React.ReactNode;
    /** Revoke an open invite on the community (I2); true once it is gone, and the sheet closes. None: no Revoke (a preview). */
    onRevoke?: (inv: InviteRowSource) => Promise<boolean>;
}

export function PendingInvites({ invites, now, names, onNeedNames, contactNames, onNeedContacts, qrValue, shareSlot, onRevoke }: PendingInvitesProps) {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const [pendingOpen, togglePending] = useFold('pending');
    const [joinedOpen, toggleJoined] = useFold('joined');
    const [openCode, setOpenCode] = useState<string | null>(null);
    const pending = pendingInvites(invites, now);
    const joined = joinedInvites(invites);
    // A name is read from the list only for a fold that is open and holds an invite bound to an entry.
    const needNames = (pendingOpen && pending.some((i) => !!i.namesEntryId)) || (joinedOpen && joined.some((i) => !!i.namesEntryId));
    useEffect(() => { onNeedNames?.(needNames); }, [needNames, onNeedNames]);
    const plain = (i: InviteRowSource) => !i.namesEntryId && !i.forKnock && !i.intendedFor?.trim();
    const needContacts = (pendingOpen && pending.some(plain)) || (joinedOpen && joined.some(plain));
    useEffect(() => { onNeedContacts?.(needContacts); }, [needContacts, onNeedContacts]);
    const opened = openCode ? pending.find((i) => i.code === openCode) ?? null : null;
    const nameFor = (inv: InviteRowSource) => (inv.namesEntryId ? names.get(inv.namesEntryId) ?? null : null);
    const contactFor = (inv: InviteRowSource) => contactNames?.get(inv.code.toLowerCase()) ?? null;

    const fold = (label: string, open: boolean, toggle: () => void, testID: string) => (
        <Pressable
            onPress={toggle}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            style={styles.foldHead}
            testID={testID}
        >
            <Text style={styles.foldLabel} maxFontSizeMultiplier={1.3}>{label}</Text>
            <MaterialCommunityIcons name={open ? 'chevron-down' : 'chevron-right'} size={22} color={colors.text.secondary} />
        </Pressable>
    );

    return (
        <View style={styles.block}>
            {pending.length > 0 ? (
                <View>
                    {fold(pendingHeading(pending.length), pendingOpen, togglePending, 'invites-pending-fold')}
                    {pendingOpen ? pending.map((inv) => (
                        <Pressable
                            key={inv.code}
                            onPress={() => setOpenCode(inv.code)}
                            accessibilityRole="button"
                            style={styles.row}
                            testID="invite-pending-row"
                        >
                            <InviteLines inv={inv} name={nameFor(inv)} contactName={contactFor(inv)} now={now} />
                            <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} />
                        </Pressable>
                    )) : null}
                </View>
            ) : null}

            {joined.length > 0 ? (
                <View>
                    {fold(joinedHeading(joined.length), joinedOpen, toggleJoined, 'invites-joined-fold')}
                    {joinedOpen ? joined.map((inv) => {
                        const who = inviteWho(inv, { name: nameFor(inv), contactName: contactFor(inv) });
                        return (
                            <View key={inv.code} style={[styles.row, styles.joinedRow]} testID="invite-joined-row">
                                <View style={styles.lines}>
                                    <Text style={styles.who} maxFontSizeMultiplier={1.3} numberOfLines={2}>
                                        {inv.usedByCallsign ? `${who} · @${inv.usedByCallsign}` : who}
                                    </Text>
                                    {inv.usedAt ? <Text style={styles.carries} maxFontSizeMultiplier={1.3}>{t('Joined {date}', { date: dayWords(inv.usedAt) })}</Text> : null}
                                </View>
                            </View>
                        );
                    }) : null}
                </View>
            ) : null}

            <Modal visible={!!opened} transparent animationType="fade" onRequestClose={() => setOpenCode(null)}>
                <View style={styles.scrim}>
                    <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpenCode(null)} accessibilityRole="button" accessibilityLabel={t('Close')} />
                    {opened ? (
                        <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetBody} testID="invite-sheet">
                            <InviteLines inv={opened} name={nameFor(opened)} contactName={contactFor(opened)} now={now} />
                            <View style={styles.qrBox}>
                                <QRCode value={qrValue(opened.code)} size={180} />
                            </View>
                            <Text style={styles.code} selectable maxFontSizeMultiplier={1.3}>{opened.code}</Text>
                            {shareSlot(opened.code)}
                            {onRevoke && inviteRevocable(opened) ? (
                                <RevokeInviteButton
                                    inv={opened}
                                    name={nameFor(opened)}
                                    onRevoke={async (i) => {
                                        const gone = await onRevoke(i);
                                        if (gone) setOpenCode(null);
                                        return gone;
                                    }}
                                />
                            ) : null}
                            <Pressable onPress={() => setOpenCode(null)} accessibilityRole="button" style={styles.closeBtn} testID="invite-sheet-close">
                                <Text style={styles.closeText} maxFontSizeMultiplier={1.3}>{t('Close')}</Text>
                            </Pressable>
                        </ScrollView>
                    ) : null}
                </View>
            </Modal>
        </View>
    );
}

export interface InviteMadeCardProps {
    /** Who it is for: the name typed (sealed in the names list) or the note; none for an invite with neither. */
    who: string | null;
    invite: InviteRowSource;
    now: number;
    qrValue: string;
    shareSlot: React.ReactNode;
    /** Revoke it on the community (I2); none in a preview. */
    onRevoke?: (inv: InviteRowSource) => Promise<boolean>;
}

/** After Generate: who the invite is for, what it carries, how long it lasts, its QR, Share and Revoke. */
export function InviteMadeCard({ who, invite, now, qrValue, shareSlot, onRevoke }: InviteMadeCardProps) {
    const styles = useStyles(makeStyles);
    const left = inviteTimeLeft(invite, now);
    return (
        <View style={styles.madeCard} testID="invite-made-card">
            <Text style={styles.madeTitle} maxFontSizeMultiplier={1.3}>{inviteMadeTitle(who)}</Text>
            <Text style={styles.carries} maxFontSizeMultiplier={1.3} testID="invite-made-carries">{inviteCarries(invite)}</Text>
            {left ? <Text style={styles.carries} maxFontSizeMultiplier={1.3} testID="invite-made-left">{left.text}</Text> : null}
            <View style={styles.qrBox}>
                <QRCode value={qrValue} size={180} />
            </View>
            {shareSlot}
            {onRevoke && inviteRevocable(invite) ? <RevokeInviteButton inv={invite} name={invite.namesEntryId ? who : null} onRevoke={onRevoke} testID="invite-made-revoke" /> : null}
        </View>
    );
}

const makeStyles = ({ theme, colors }: { theme: string; colors: any }) => StyleSheet.create({
    block: { marginTop: 24 },
    foldHead: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, paddingVertical: 6, marginBottom: 4,
    },
    foldLabel: { flexShrink: 1, fontSize: 14, fontWeight: '800', color: colors.text.heading, letterSpacing: 0.5 },
    row: {
        flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, padding: 14, marginBottom: 10, borderRadius: 14, borderWidth: 1,
        borderColor: colors.border.default, backgroundColor: colors.surface.card,
    },
    joinedRow: { opacity: 0.85 },
    lines: { flex: 1, minWidth: 0, gap: 2 },
    who: { fontSize: 15, fontWeight: '700', color: colors.text.heading },
    carries: { fontSize: 13, lineHeight: 18, color: colors.text.secondary },
    left: { fontSize: 12, fontWeight: '700', color: colors.text.secondary },
    leftUrgent: { color: colors.feedback.danger.fg },
    scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 16 },
    sheet: { maxHeight: '90%', backgroundColor: colors.surface.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border.default },
    sheetBody: { padding: 16, alignItems: 'stretch', gap: 12 },
    qrBox: { alignSelf: 'center', backgroundColor: colors.surface.card, padding: 16, borderRadius: 12 },
    code: { fontSize: 13, fontFamily: 'monospace', fontWeight: '600', color: colors.text.heading, textAlign: 'center' },
    closeBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.border.strong },
    closeText: { fontSize: 15, fontWeight: '700', color: colors.text.body },
    revokeBtn: {
        minHeight: 48, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderRadius: 10, borderWidth: 1,
        borderColor: colors.feedback.danger.fg,
    },
    revokeText: { fontSize: 15, fontWeight: '700', color: colors.feedback.danger.fg, textAlign: 'center' },
    madeCard: {
        backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.green50, borderWidth: 2, borderColor: colors.brand.primary, borderRadius: 16,
        padding: 20, alignItems: 'center', marginBottom: 24, gap: 6,
    },
    madeTitle: { fontSize: 16, fontWeight: '800', color: colors.text.heading, textAlign: 'center' },
});
