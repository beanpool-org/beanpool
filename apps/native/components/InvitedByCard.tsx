/**
 * "Invited by" and "Brought in n people ›" on a member's profile (scratch/fable-design/DESIGN-invites-vouching-review-fable.md
 * §3 ask 2, slice I3; Marty, 10 Nov 2026). The words are core's (invitedByLines), the same on the web's profile.
 *
 * The server decides who reads what (POST /api/trust/profile): every member reads the inviter, named with their role
 * word, unless the member switched it off (then only the member, owners, admins and the inviter do); `broughtIn` comes
 * only to an owner or admin, and to the member on their own profile. This card draws what it is given and asks for
 * nothing more, except the branch itself (GET /api/invite/tree?root=) when Brought in is opened.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { invitedByLines, broughtInWords, broughtInStatusWords, formatDate, t, type InvitedBy } from '@beanpool/core';
import { MemberAvatar } from './MemberAvatar';
import { useTheme, useStyles } from '../app/ThemeContext';
import { signedGet } from '../utils/db';

type Branch = { publicKey: string; callsign: string; joinedAt: string | null; status: string | null }[];

/** The first level of `root`'s branch of the invite tree, or null when the node didn't answer. */
export async function fetchBroughtIn(root: string): Promise<Branch | null> {
    try {
        const res = await signedGet(`/api/invite/tree?root=${encodeURIComponent(root)}`);
        if (!res.ok) return null;
        const body = await res.json();
        const children = Array.isArray(body) ? body[0]?.children : null;
        return Array.isArray(children)
            ? children.map((c: any) => ({ publicKey: c.publicKey, callsign: c.callsign, joinedAt: c.joinedAt ?? null, status: c.status ?? null }))
            : [];
    } catch {
        return null;
    }
}

export function InvitedByCard({ vouchedInBy, broughtIn, isSelf, targetPubkey, tierWords }: {
    vouchedInBy: InvitedBy | null | undefined;
    broughtIn?: number;
    isSelf: boolean;
    targetPubkey: string;
    tierWords: (tier: string | null) => string;
}) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        card: {
            backgroundColor: colors.surface.app, marginHorizontal: 16, marginTop: 12, padding: 14,
            borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, gap: 6,
        },
        row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
        name: { fontSize: 14, fontWeight: '700', color: colors.text.heading, flexShrink: 1 },
        sub: { fontSize: 12, color: colors.text.secondary, fontWeight: '600', marginTop: 1 },
        badge: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.brand.tint, alignItems: 'center', justifyContent: 'center' },
        branchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, minHeight: 44 },
        branchName: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
        branchSub: { fontSize: 12, color: colors.text.secondary, fontWeight: '600' },
        empty: { fontSize: 12, color: colors.text.muted, fontWeight: '600' },
    }));
    const [open, setOpen] = useState(false);
    const [branch, setBranch] = useState<Branch | null | undefined>(undefined);
    const showsBroughtIn = typeof broughtIn === 'number';
    if (!vouchedInBy && !showsBroughtIn) return null;

    const toggle = () => {
        const next = !open;
        setOpen(next);
        if (next && branch === undefined) {
            fetchBroughtIn(targetPubkey).then(setBranch);
        }
    };
    const lines = vouchedInBy ? invitedByLines(vouchedInBy, isSelf, vouchedInBy.kind === 'member' ? tierWords : undefined) : null;

    return (
        <View style={styles.card} testID="profile-invited-by">
            {vouchedInBy && lines && vouchedInBy.kind === 'member' && vouchedInBy.publicKey && (
                <Pressable
                    accessibilityRole="button"
                    style={styles.row}
                    onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: vouchedInBy.publicKey!, callsign: vouchedInBy.callsign || '' } })}
                >
                    <MemberAvatar avatarUrl={vouchedInBy.avatarUrl} pubkey={vouchedInBy.publicKey} callsign={vouchedInBy.callsign || '?'} size={32} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.name} numberOfLines={2}>{lines.title}</Text>
                        {lines.sub ? <Text style={styles.sub} numberOfLines={2}>{lines.sub}</Text> : null}
                    </View>
                    <MaterialCommunityIcons name="chevron-right" size={20} color={colors.text.secondary} />
                </Pressable>
            )}
            {vouchedInBy && lines && vouchedInBy.kind !== 'member' && (
                <View style={styles.row}>
                    <View style={styles.badge}>
                        <MaterialCommunityIcons name={vouchedInBy.kind === 'card' ? 'card-account-details-outline' : 'shield-check'} size={20} color={colors.brand.primary} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.name} numberOfLines={2}>{lines.title}</Text>
                        {lines.sub ? <Text style={styles.sub} numberOfLines={2}>{lines.sub}</Text> : null}
                    </View>
                </View>
            )}
            {showsBroughtIn && (
                <>
                    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.row} onPress={toggle} testID="profile-brought-in">
                        <View style={styles.badge}>
                            <MaterialCommunityIcons name="account-multiple-outline" size={20} color={colors.brand.primary} />
                        </View>
                        <Text style={[styles.name, { flex: 1 }]} numberOfLines={2}>{broughtInWords(broughtIn!)}</Text>
                    </Pressable>
                    {open && (branch === undefined ? (
                        <ActivityIndicator size="small" color={colors.brand.primary} />
                    ) : branch === null ? (
                        <Text style={styles.empty}>{t('Couldn’t load this list. Check your connection and try again.')}</Text>
                    ) : branch.length === 0 ? (
                        <Text style={styles.empty}>{t('Nobody yet.')}</Text>
                    ) : branch.map((p) => (
                        <Pressable
                            key={p.publicKey}
                            accessibilityRole="button"
                            style={styles.branchRow}
                            onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: p.publicKey, callsign: p.callsign || '' } })}
                        >
                            <View style={{ flex: 1, minWidth: 0 }}>
                                <Text style={styles.branchName} numberOfLines={1}>{p.callsign}</Text>
                                <Text style={styles.branchSub} numberOfLines={2}>
                                    {p.joinedAt ? `${t('Joined {date}', { date: formatDate(new Date(p.joinedAt), 'day-month-year') })} · ` : ''}{broughtInStatusWords(p.status)}
                                </Text>
                            </View>
                            <MaterialCommunityIcons name="chevron-right" size={20} color={colors.text.secondary} />
                        </Pressable>
                    )))}
                </>
            )}
        </View>
    );
}
