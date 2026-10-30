import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useTheme, useStyles } from '../app/ThemeContext';
import { MemberAvatar } from './MemberAvatar';
import type { BeanPoolIdentity } from '../utils/identity';
import {
    fetchJoinRequests, approveJoinRequest, declineJoinRequest, joinRequestAge, KNOCK_UNREACHABLE_TEXT,
    type JoinRequest,
} from '../utils/knock-inbox';
import { t, tn, word } from '@beanpool/core';

/**
 * The words of this section, in the member's language. utils/knock-inbox.ts signs its requests with the member's key and
 * stays off the words layer, so its English (wantsToJoinTitle, joinRequestMeta, WANTS_TO_JOIN_HELP) is worded again here;
 * utils/__tests__/talk-words-render.test.ts holds the two to the same English.
 */
const KNOCK_WORDS = {
    help: word('People asking to join this community. Invite makes an invite that only their key can use, and their app finds it by itself. Not now tells them nothing more than "no answer yet".'),
    unreachable: word("Couldn't reach your community. Check your connection and try again."),
} as const;

/** Under each request: when, and where they came from, two facts side by side. */
function requestMeta(r: JoinRequest): string {
    const days = joinRequestAge(r);
    // English writes one form for both; the count is 2 or more here.
    const when = days === null ? '' : days === 0 ? t('Asked today') : days === 1 ? t('Asked yesterday') : tn(days, 'Asked {n} days ago', 'Asked {n} days ago');
    const from = r.fromNode ? t('from {node}', { node: r.fromNode }) : '';
    return [when, from].filter(Boolean).join(' · ');
}

/** The community couldn't be reached: said in the member's language; the node's own words as it sent them (slice S4). */
const knockMessage = (message: string): string => (message === KNOCK_UNREACHABLE_TEXT ? t(KNOCK_WORDS.unreachable) : message);

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
    const [done, setDone] = useState<string | null>(null);
    // A refusal is said above the list, not under its row: the list read after it no longer has that row (answered,
    // lapsed, joined, key replaced, gone), or no section at all (admins only), and the words must outlive it.
    const [refusal, setRefusal] = useState<{ id: string; callsign: string; message: string } | null>(null);

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
        invite: { minHeight: 44, paddingHorizontal: 18, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
        inviteText: { color: colors.text.inverse, fontSize: 15, fontWeight: '800' },
        notNow: { minHeight: 44, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        notNowText: { color: colors.text.body, fontSize: 15, fontWeight: '700' },
        note: { fontSize: 14, color: colors.text.body, marginTop: 8, lineHeight: 20 },
        refusal: { fontSize: 14, color: colors.text.body, marginBottom: 12, lineHeight: 20 },
        refusalName: { fontWeight: '800' },
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
            setTotal(0);
            onCount?.(0);
        } else {
            setError(knockMessage(r.message));
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
            setTotal(prev => { const n = Math.max(0, prev - 1); onCount?.(n); return n; });
            setRefusal(null);
            setDone(verb === 'approve' ? t('You invited {name}. Their app will find the invite by itself.', { name: req.callsign }) : null);
            return;
        }
        // Another member got there first, or it lapsed: the community's words, then the list as it is now.
        setDone(null);
        setRefusal({ id: req.id, callsign: req.callsign, message: knockMessage(r.message) });
        load();
    };

    if (!refusal && (hidden || (requests !== null && requests.length === 0 && !error && !done))) return null;

    return (
        <View>
            <Text style={styles.header} accessibilityRole="header">{tn(total, '🚪 Wants to join ({n})', '🚪 Wants to join ({n})')}</Text>
            <Text style={styles.help}>{t(KNOCK_WORDS.help)}</Text>
            {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
            {!!done && <Text style={styles.note} accessibilityLiveRegion="polite">{done}</Text>}
            {!!refusal && (
                <Text style={styles.refusal} accessibilityLiveRegion="polite" testID={`wants-to-join-note-${refusal.id}`}>
                    <Text style={styles.refusalName}>{refusal.callsign}</Text>{' · '}{refusal.message}
                </Text>
            )}
            {hidden ? null : requests === null ? (
                <ActivityIndicator color={colors.brand.primary} style={{ marginVertical: 12 }} />
            ) : requests.map(req => (
                <View key={req.id} style={styles.card}>
                    <View style={styles.who}>
                        <MemberAvatar avatarUrl={req.avatar} pubkey={req.pubkey} callsign={req.callsign} size={44} />
                        <View style={styles.whoText}>
                            <Text style={styles.name} numberOfLines={1}>{req.callsign}</Text>
                            {!!requestMeta(req) && <Text style={styles.meta} numberOfLines={2}>{requestMeta(req)}</Text>}
                        </View>
                    </View>
                    <Text style={styles.message}>{req.message}</Text>
                    <View style={styles.actions}>
                        <Pressable
                            style={[styles.invite, busy === req.id && { opacity: 0.6 }]}
                            onPress={() => answer(req, 'approve')}
                            disabled={!!busy}
                            accessibilityRole="button"
                            accessibilityLabel={busy === req.id ? t('Inviting {name}...', { name: req.callsign }) : t('Invite {name}', { name: req.callsign })}
                            accessibilityHint={t('Approves join request from {name}', { name: req.callsign })}
                            accessibilityState={{ disabled: !!busy, busy: busy === req.id }}
                        >
                            <Text style={styles.inviteText}>{t('Invite', undefined, 'button: let them in')}</Text>
                        </Pressable>
                        <Pressable
                            style={[styles.notNow, busy === req.id && { opacity: 0.6 }]}
                            onPress={() => answer(req, 'decline')}
                            disabled={!!busy}
                            accessibilityRole="button"
                            accessibilityLabel={busy === req.id ? t('Declining {name}...', { name: req.callsign }) : t('Not now, {name}', { name: req.callsign })}
                            accessibilityHint={t('Declines join request from {name}', { name: req.callsign })}
                            accessibilityState={{ disabled: !!busy, busy: busy === req.id }}
                        >
                            <Text style={styles.notNowText}>{t('Not now')}</Text>
                        </Pressable>
                    </View>
                </View>
            ))}
            <View style={styles.divider} />
        </View>
    );
}
