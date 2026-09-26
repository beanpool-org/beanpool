import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useTheme, useStyles } from '../app/ThemeContext';
import { MemberAvatar } from './MemberAvatar';
import type { BeanPoolIdentity } from '../utils/identity';
import {
    fetchJoinRequests, approveJoinRequest, declineJoinRequest, wantsToJoinTitle, joinRequestMeta, WANTS_TO_JOIN_HELP,
    type JoinRequest,
} from '../utils/knock-inbox';

/**
 * "Wants to join (n)" (design §3.3): people asking to join this (local) community, for any member to answer. Hidden
 * where the community takes no requests. `onCount` tells People how many are waiting, for its Invites pill.
 */
export function WantsToJoin({ anchorUrl, identity, onCount }: {
    anchorUrl: string; identity: BeanPoolIdentity; onCount?: (n: number) => void;
}) {
    const { colors } = useTheme();
    const [requests, setRequests] = useState<JoinRequest[] | null>(null);
    const [total, setTotal] = useState(0);
    const [hidden, setHidden] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [notes, setNotes] = useState<Record<string, string>>({});
    const [done, setDone] = useState<string | null>(null);

    const styles = useStyles(({ colors }) => StyleSheet.create({
        header: { fontSize: 20, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
        help: { fontSize: 13, color: colors.text.secondary, marginBottom: 12, lineHeight: 18 },
        card: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, borderRadius: 14, padding: 14, marginBottom: 10 },
        who: { flexDirection: 'row', alignItems: 'center', gap: 12 },
        whoText: { flex: 1, minWidth: 0 },
        name: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
        meta: { fontSize: 12, color: colors.text.muted, marginTop: 2 },
        message: { fontSize: 14, color: colors.text.body, lineHeight: 20, marginTop: 10 },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
        invite: { minHeight: 44, paddingHorizontal: 18, borderRadius: 12, backgroundColor: colors.brand.primary, alignItems: 'center', justifyContent: 'center' },
        inviteText: { color: colors.text.inverse, fontSize: 15, fontWeight: '800' },
        notNow: { minHeight: 44, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        notNowText: { color: colors.text.body, fontSize: 15, fontWeight: '700' },
        note: { fontSize: 14, color: colors.text.body, marginTop: 8, lineHeight: 20 },
        error: { fontSize: 14, color: colors.feedback.warning.fg, marginBottom: 12, lineHeight: 20 },
        divider: { height: 1, backgroundColor: colors.border.default, marginVertical: 24 },
    }));

    const load = useCallback(async () => {
        const r = await fetchJoinRequests(anchorUrl, identity);
        if (r.ok) {
            setRequests(r.knocks);
            setTotal(r.total);
            setHidden(false);
            setError(null);
            onCount?.(r.total);
        } else if (r.kind === 'hidden') {
            setHidden(true);
            onCount?.(0);
        } else {
            setError(r.message);
        }
    }, [anchorUrl, identity, onCount]);

    useEffect(() => { load(); }, [load]);

    const answer = async (req: JoinRequest, verb: 'approve' | 'decline') => {
        setBusy(req.id);
        const r = verb === 'approve'
            ? await approveJoinRequest(anchorUrl, identity, req.id)
            : await declineJoinRequest(anchorUrl, identity, req.id);
        setBusy(null);
        if (r.ok) {
            setRequests(list => (list ?? []).filter(k => k.id !== req.id));
            setTotal(t => { const n = Math.max(0, t - 1); onCount?.(n); return n; });
            setNotes(n => ({ ...n, [req.id]: '' }));
            setDone(verb === 'approve' ? `You invited ${req.callsign}. Their app will find the invite by itself.` : null);
            return;
        }
        // Another member got there first, or it lapsed: the community's words, then the list as it is now.
        setNotes(n => ({ ...n, [req.id]: r.message }));
        load();
    };

    if (hidden || (requests !== null && requests.length === 0 && !error && !done)) return null;

    return (
        <View>
            <Text style={styles.header} accessibilityRole="header">🚪 {wantsToJoinTitle(total)}</Text>
            <Text style={styles.help}>{WANTS_TO_JOIN_HELP}</Text>
            {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
            {!!done && <Text style={styles.note} accessibilityLiveRegion="polite">{done}</Text>}
            {requests === null ? (
                <ActivityIndicator color={colors.brand.primary} style={{ marginVertical: 12 }} />
            ) : requests.map(req => (
                <View key={req.id} style={styles.card}>
                    <View style={styles.who}>
                        <MemberAvatar avatarUrl={req.avatar} pubkey={req.pubkey} callsign={req.callsign} size={44} />
                        <View style={styles.whoText}>
                            <Text style={styles.name} numberOfLines={1}>{req.callsign}</Text>
                            {!!joinRequestMeta(req) && <Text style={styles.meta} numberOfLines={2}>{joinRequestMeta(req)}</Text>}
                        </View>
                    </View>
                    <Text style={styles.message}>{req.message}</Text>
                    {!!notes[req.id] && <Text style={styles.note}>{notes[req.id]}</Text>}
                    <View style={styles.actions}>
                        <Pressable
                            style={[styles.invite, busy === req.id && { opacity: 0.6 }]}
                            onPress={() => answer(req, 'approve')}
                            disabled={!!busy}
                            accessibilityRole="button"
                            accessibilityLabel={`Invite ${req.callsign}`}
                        >
                            <Text style={styles.inviteText}>Invite</Text>
                        </Pressable>
                        <Pressable
                            style={[styles.notNow, busy === req.id && { opacity: 0.6 }]}
                            onPress={() => answer(req, 'decline')}
                            disabled={!!busy}
                            accessibilityRole="button"
                            accessibilityLabel={`Not now, ${req.callsign}`}
                        >
                            <Text style={styles.notNowText}>Not now</Text>
                        </Pressable>
                    </View>
                </View>
            ))}
            <View style={styles.divider} />
        </View>
    );
}
