import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, Alert, Linking } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { useTheme, useStyles } from './ThemeContext';
import { useIdentity } from './IdentityContext';
import { getCanonicalAvatar } from '../utils/canonical-profile';
import {
    fetchCommunities, fetchGlobalHome, watchPlace, unwatchPlace, communityLabel, communityFacts,
    type DirectoryCommunity, type PlaceWatch, type Point,
} from '../utils/community-directory';
import {
    sendKnock, readKnockStatus, rememberedKnocks, rememberKnock, forgetKnock, knockCardState, knockFormProblem,
    KNOCK_MESSAGE_CHARS, KNOCK_CALLSIGN_CHARS, type KnockStatusResult, type RememberedKnock, type KnockCardState,
} from '../utils/knock';
import { joinAnotherCommunity, joinedNudge, PROTECT_REDIRECT, HOME_REDIRECT } from '../utils/join-another-community';

export { ErrorBoundary };

const LIST_LIMIT = 20;

/**
 * Find a community near you (design §3.2–§3.5), reached from the worldwide community's Market card.
 *
 * Communities near the phone (or by name), each with "Ask to join": a knock sent to THAT community's own address,
 * signed with the member's own key (utils/knock.ts). The answers to this phone's knocks are read from those
 * communities only; an invite that comes back is joined with one tap through the ordinary invite path
 * (utils/join-another-community.ts). Nothing near? Watch the place, or start a community.
 */
export default function FindCommunityScreen() {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const { identity } = useIdentity();
    const pubkey = identity?.publicKey ?? null;

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5, textTransform: 'uppercase' },
        scroll: { padding: 16 },
        lead: { fontSize: 15, color: colors.text.body, lineHeight: 21, marginBottom: 12 },
        sectionLabel: { fontSize: 12, fontWeight: 'bold', color: colors.text.secondary, letterSpacing: 1, marginTop: 20, marginBottom: 8, marginLeft: 4 },
        searchBox: { flexDirection: 'row', alignItems: 'center', minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, paddingLeft: 12 },
        searchInput: { flex: 1, minWidth: 0, minHeight: 48, fontSize: 16, color: colors.text.body, paddingVertical: 8, paddingHorizontal: 8 },
        pillBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', minHeight: 48, paddingHorizontal: 16, borderRadius: 24, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, marginTop: 10 },
        pillText: { fontSize: 15, fontWeight: '700', color: colors.text.body, flexShrink: 1 },
        card: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, padding: 14, marginBottom: 10 },
        name: { fontSize: 17, fontWeight: '800', color: colors.text.heading },
        facts: { fontSize: 13, color: colors.text.secondary, marginTop: 2, lineHeight: 18 },
        contact: { fontSize: 13, color: colors.brand.primary, marginTop: 4, textDecorationLine: 'underline' },
        note: { fontSize: 14, color: colors.text.body, marginTop: 8, lineHeight: 20 },
        refusal: { fontSize: 14, color: colors.feedback.warning.fg, marginTop: 8, lineHeight: 20 },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
        primary: { minHeight: 48, paddingHorizontal: 18, borderRadius: 12, backgroundColor: colors.brand.primary, alignItems: 'center', justifyContent: 'center' },
        primaryText: { color: colors.text.inverse, fontSize: 15, fontWeight: '800', textAlign: 'center' },
        secondary: { minHeight: 48, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        secondaryText: { color: colors.text.body, fontSize: 15, fontWeight: '700', textAlign: 'center' },
        label: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, marginTop: 10, marginBottom: 4 },
        input: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.app, color: colors.text.heading, fontSize: 16, paddingHorizontal: 12, paddingVertical: 10 },
        multiline: { minHeight: 96, textAlignVertical: 'top' },
        counter: { fontSize: 12, color: colors.text.muted, alignSelf: 'flex-end', marginTop: 2 },
        formError: { fontSize: 14, color: colors.feedback.danger.fg, marginTop: 8, lineHeight: 20 },
        empty: { fontSize: 15, color: colors.text.body, lineHeight: 22, paddingVertical: 12 },
        row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10 },
        rowText: { flex: 1, minWidth: 0 },
        rowTitle: { fontSize: 16, fontWeight: '600', color: colors.text.heading },
        rowSub: { fontSize: 13, color: colors.text.secondary, marginTop: 2, lineHeight: 18 },
        divider: { borderTopWidth: 1, borderTopColor: colors.border.default },
    }));

    // ── Where "near" is ─────────────────────────────────────────────────────────────────────────────────
    const [point, setPoint] = useState<Point | null>(null);
    const [locating, setLocating] = useState(false);
    const [locationNote, setLocationNote] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        // Only a location the phone already may read: this screen asks when the member taps "Use my location".
        Location.getForegroundPermissionsAsync()
            .then(async ({ status }) => {
                if (status !== 'granted') return;
                const last = await Location.getLastKnownPositionAsync();
                if (alive && last) setPoint({ lat: last.coords.latitude, lng: last.coords.longitude });
            })
            .catch(() => {});
        return () => { alive = false; };
    }, []);

    const locateMe = async () => {
        setLocating(true);
        setLocationNote(null);
        try {
            const now = await Location.getForegroundPermissionsAsync();
            let status = now.status;
            if (status !== 'granted' && now.canAskAgain) status = (await Location.requestForegroundPermissionsAsync()).status;
            if (status !== 'granted') {
                setLocationNote('Location is off for BeanPool. You can still search by name below.');
                return;
            }
            const here = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
            setPoint({ lat: here.coords.latitude, lng: here.coords.longitude });
        } catch {
            setLocationNote("Couldn't find where you are. You can still search by name below.");
        } finally {
            setLocating(false);
        }
    };

    // ── The list ────────────────────────────────────────────────────────────────────────────────────────
    const [query, setQuery] = useState('');
    const [communities, setCommunities] = useState<DirectoryCommunity[] | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const listAsk = useRef(0);

    const loadList = useCallback(async () => {
        const mine = ++listAsk.current;
        setLoading(true);
        const r = await fetchCommunities({ point, q: query.trim() || undefined, limit: LIST_LIMIT });
        if (mine !== listAsk.current) return;
        setLoading(false);
        if (r.ok) { setCommunities(r.value.communities); setListError(null); }
        else { setCommunities([]); setListError(r.message); }
    }, [point, query]);

    useEffect(() => {
        const t = setTimeout(loadList, query ? 400 : 0);
        return () => clearTimeout(t);
    }, [loadList, query]);

    // ── This phone's knocks, and their answers ──────────────────────────────────────────────────────────
    const [asked, setAsked] = useState<RememberedKnock[]>([]);
    const [statuses, setStatuses] = useState<Record<string, KnockStatusResult | null>>({});
    const [members, setMembers] = useState<Record<string, string>>({});

    const readStatus = useCallback(async (url: string) => {
        if (!identity) return;
        setStatuses(s => ({ ...s, [url]: null }));
        const r = await readKnockStatus(url, identity);
        setStatuses(s => ({ ...s, [url]: r }));
    }, [identity]);

    useEffect(() => {
        if (!pubkey) return;
        let alive = true;
        rememberedKnocks(pubkey).then(list => {
            if (!alive) return;
            setAsked(list);
            // Only the communities this key asked: a signed read shows a community who is asking.
            list.forEach(k => { readStatus(k.url); });
        });
        return () => { alive = false; };
    }, [pubkey, readStatus]);

    // ── Watches ─────────────────────────────────────────────────────────────────────────────────────────
    const [watches, setWatches] = useState<PlaceWatch[] | null>(null);
    const [watchNote, setWatchNote] = useState<string | null>(null);
    const [watchBusy, setWatchBusy] = useState(false);

    useEffect(() => {
        if (!identity) return;
        let alive = true;
        fetchGlobalHome(point, identity).then(r => {
            if (alive && r.ok) setWatches(r.value.watches);
        });
        return () => { alive = false; };
    }, [identity, point]);

    const watchHere = async () => {
        if (!identity || !point) return;
        setWatchBusy(true);
        setWatchNote(null);
        const r = await watchPlace(identity, point);
        setWatchBusy(false);
        if (r.ok) {
            setWatches(w => [...(w ?? []).filter(x => x.id !== r.value.id), r.value]);
            setWatchNote("Done. You'll be told when a community starts near here.");
        } else {
            setWatchNote(r.message);
        }
    };

    const stopWatching = async (id: string) => {
        if (!identity) return;
        const r = await unwatchPlace(identity, id);
        if (r.ok) setWatches(w => (w ?? []).filter(x => x.id !== id));
        else setWatchNote(r.message);
    };

    // ── Asking, and joining ─────────────────────────────────────────────────────────────────────────────
    const [openForm, setOpenForm] = useState<string | null>(null);
    const [callsign, setCallsign] = useState(identity?.callsign ?? '');
    const [message, setMessage] = useState('');
    const [formError, setFormError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [joining, setJoining] = useState<string | null>(null);

    useEffect(() => { if (identity?.callsign && !callsign) setCallsign(identity.callsign.slice(0, KNOCK_CALLSIGN_CHARS)); }, [identity?.callsign]);

    const send = async (c: DirectoryCommunity) => {
        if (!identity || !c.url) return;
        const problem = knockFormProblem({ callsign, message });
        if (problem) { setFormError(problem); return; }
        setSending(true);
        setFormError(null);
        const avatar = await getCanonicalAvatar().catch(() => null);
        const r = await sendKnock(c.url, identity, { callsign, message, avatar });
        setSending(false);
        switch (r.kind) {
            case 'waiting':
            case 'invited': {
                await rememberKnock(identity.publicKey, c);
                setAsked(await rememberedKnocks(identity.publicKey));
                setOpenForm(null);
                setMessage('');
                readStatus(c.url);
                return;
            }
            case 'member':
                setMembers(m => ({ ...m, [c.url!]: r.message }));
                setOpenForm(null);
                return;
            default:
                // The community's own words, exactly as it sent them.
                setFormError(r.message);
        }
    };

    const join = async (url: string, name: string | null, invite: string) => {
        if (!identity) return;
        setJoining(url);
        try {
            const returnUrl = await AsyncStorage.getItem('beanpool_anchor_url');
            const joined = await joinAnotherCommunity({ targetUrl: url, code: invite, identity, returnUrl, knownName: name });
            await forgetKnock(identity.publicKey, url);
            const nudge = joinedNudge(joined.name);
            Alert.alert(nudge.title, nudge.body, [
                { text: nudge.later, onPress: () => router.replace({ pathname: '/profile-setup', params: { redirect: HOME_REDIRECT } }) },
                { text: nudge.protect, onPress: () => router.replace({ pathname: '/profile-setup', params: { redirect: PROTECT_REDIRECT } }) },
            ], { cancelable: false });
        } catch (e: any) {
            Alert.alert("Couldn't join", e?.message || 'Please try again.');
        } finally {
            setJoining(null);
        }
    };

    const askedUrls = useMemo(() => new Set(asked.map(a => a.url)), [asked]);
    const stateFor = (url: string | null): KnockCardState =>
        knockCardState(!!url, !!url && askedUrls.has(url), url && askedUrls.has(url) ? statuses[url] : undefined, url ? members[url] : null);

    // ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────
    // A plain function, not a component: a component made inside render is a new type on every render, and its
    // text fields would lose focus at each keystroke.
    const renderKnock = (url: string | null, name: string | null, community?: DirectoryCommunity) => {
        const state = stateFor(url);
        if (state.kind === 'no_address' || state.kind === 'waiting' || state.kind === 'member') {
            return <Text style={styles.note}>{state.note}</Text>;
        }
        if (state.kind === 'checking') {
            return <ActivityIndicator style={{ marginTop: 10, alignSelf: 'flex-start' }} color={colors.brand.primary} />;
        }
        if (state.kind === 'unreachable') {
            return (
                <View>
                    <Text style={styles.refusal}>{state.note}</Text>
                    <View style={styles.actions}>
                        <Pressable style={styles.secondary} onPress={() => url && readStatus(url)} accessibilityRole="button">
                            <Text style={styles.secondaryText}>Check again</Text>
                        </Pressable>
                    </View>
                </View>
            );
        }
        if (state.kind === 'invited') {
            return (
                <View>
                    <Text style={styles.note}>{state.note}</Text>
                    <View style={styles.actions}>
                        <Pressable
                            style={[styles.primary, joining === url && { opacity: 0.6 }]}
                            onPress={() => url && join(url, name, state.invite)}
                            disabled={!!joining}
                            accessibilityRole="button"
                            accessibilityLabel={`Join ${name ?? 'this community'}`}
                        >
                            <Text style={styles.primaryText}>{joining === url ? 'Joining…' : `Join ${name ?? 'now'}`}</Text>
                        </Pressable>
                    </View>
                </View>
            );
        }
        // 'ask', or a refusal: the community's own words, and the button only where asking again could work.
        const refused = state.kind === 'refused';
        const noteView = state.note ? <Text style={refused ? styles.refusal : styles.note}>{state.note}</Text> : null;
        if (!community || (refused && !state.canAsk)) return noteView;
        if (openForm !== community.key) {
            return (
                <View>
                    {noteView}
                    <View style={styles.actions}>
                        <Pressable
                            style={styles.primary}
                            onPress={() => { setOpenForm(community.key); setFormError(null); }}
                            disabled={!identity}
                            accessibilityRole="button"
                            accessibilityLabel={`Ask to join ${communityLabel(community)}`}
                        >
                            <Text style={styles.primaryText}>Ask to join</Text>
                        </Pressable>
                    </View>
                </View>
            );
        }
        return (
            <View>
                <Text style={styles.label}>Your name</Text>
                <TextInput
                    style={styles.input}
                    value={callsign}
                    onChangeText={v => setCallsign(v.slice(0, KNOCK_CALLSIGN_CHARS))}
                    maxLength={KNOCK_CALLSIGN_CHARS}
                    autoCapitalize="words"
                    accessibilityLabel="Your name"
                />
                <Text style={styles.label}>A few words about yourself</Text>
                <TextInput
                    style={[styles.input, styles.multiline]}
                    value={message}
                    onChangeText={v => setMessage(Array.from(v).slice(0, KNOCK_MESSAGE_CHARS).join(''))}
                    multiline
                    placeholder="Where you live, what you'd like to share or learn"
                    placeholderTextColor={colors.text.muted}
                    accessibilityLabel="A few words about yourself"
                />
                <Text style={styles.counter}>{Array.from(message).length}/{KNOCK_MESSAGE_CHARS}</Text>
                {!!formError && <Text style={styles.formError} accessibilityLiveRegion="polite">{formError}</Text>}
                <View style={styles.actions}>
                    <Pressable
                        style={[styles.primary, sending && { opacity: 0.6 }]}
                        onPress={() => send(community)}
                        disabled={sending}
                        accessibilityRole="button"
                    >
                        <Text style={styles.primaryText}>{sending ? 'Sending…' : 'Send'}</Text>
                    </Pressable>
                    <Pressable style={styles.secondary} onPress={() => { setOpenForm(null); setFormError(null); }} accessibilityRole="button">
                        <Text style={styles.secondaryText}>Cancel</Text>
                    </Pressable>
                </View>
            </View>
        );
    };

    const listed = communities ?? [];
    const askedNotListed = asked.filter(a => !listed.some(c => c.url === a.url));

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style="light" />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back">
                    <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.inverse} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">Find a community</Text>
                <View style={{ width: 48 }} />
            </View>

            <KeyboardAwareScrollView
                contentContainerStyle={[styles.scroll, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
                keyboardShouldPersistTaps="handled"
                bottomOffset={16}
            >
                <Text style={styles.lead}>
                    Communities are where neighbours trade and help each other. Ask to join one near you: any member there can let you in.
                </Text>

                {asked.length > 0 && (
                    <>
                        <Text style={styles.sectionLabel}>YOUR REQUESTS TO JOIN</Text>
                        {askedNotListed.map(a => (
                            <View key={a.url} style={styles.card}>
                                <Text style={styles.name} numberOfLines={2}>{a.name ?? a.url.replace(/^https:\/\//, '')}</Text>
                                {renderKnock(a.url, a.name)}
                            </View>
                        ))}
                        {asked.length > askedNotListed.length && (
                            <Text style={styles.rowSub}>The others are in the list below.</Text>
                        )}
                    </>
                )}

                <Text style={styles.sectionLabel}>{point ? 'NEAREST FIRST' : 'COMMUNITIES'}</Text>
                <View style={styles.searchBox}>
                    <MaterialCommunityIcons name="magnify" size={20} color={colors.text.muted} />
                    <TextInput
                        style={styles.searchInput}
                        value={query}
                        onChangeText={setQuery}
                        placeholder="Search by name"
                        placeholderTextColor={colors.text.muted}
                        returnKeyType="search"
                        autoCorrect={false}
                        accessibilityLabel="Search communities by name"
                    />
                </View>
                {!point && (
                    <Pressable style={styles.pillBtn} onPress={locateMe} disabled={locating} accessibilityRole="button">
                        <MaterialCommunityIcons name="crosshairs-gps" size={20} color={colors.brand.primary} />
                        <Text style={styles.pillText}>{locating ? 'Finding you…' : 'Use my location'}</Text>
                    </Pressable>
                )}
                {!!locationNote && <Text style={styles.rowSub}>{locationNote}</Text>}

                <View style={{ marginTop: 12 }}>
                    {loading && communities === null ? (
                        <ActivityIndicator color={colors.brand.primary} style={{ marginVertical: 24 }} />
                    ) : listError ? (
                        <View>
                            <Text style={styles.empty}>{listError}</Text>
                            <Pressable style={styles.secondary} onPress={loadList} accessibilityRole="button">
                                <Text style={styles.secondaryText}>Try again</Text>
                            </Pressable>
                        </View>
                    ) : listed.length === 0 ? (
                        <Text style={styles.empty}>
                            {query.trim() ? 'No community by that name is listed.' : 'No community is listed yet.'}
                        </Text>
                    ) : listed.map(c => (
                        <View key={c.key} style={styles.card}>
                            <Text style={styles.name} numberOfLines={2}>{communityLabel(c)}</Text>
                            {!!communityFacts(c) && <Text style={styles.facts}>{communityFacts(c)}</Text>}
                            {!!c.contactEmail && (
                                <Text style={styles.contact} onPress={() => Linking.openURL(`mailto:${c.contactEmail}`).catch(() => {})} accessibilityRole="link">
                                    {c.contactEmail}
                                </Text>
                            )}
                            {renderKnock(c.url, c.name, c)}
                        </View>
                    ))}
                </View>

                <Text style={styles.sectionLabel}>NOTHING NEAR YOU?</Text>
                <View style={styles.card}>
                    <Pressable style={styles.row} onPress={() => router.push('/start-community')} accessibilityRole="button">
                        <MaterialCommunityIcons name="home-plus-outline" size={24} color={colors.brand.primary} />
                        <View style={styles.rowText}>
                            <Text style={styles.rowTitle}>Start a community</Text>
                            <Text style={styles.rowSub}>What it takes, and how to begin</Text>
                        </View>
                        <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} />
                    </Pressable>
                    <View style={[styles.row, styles.divider]}>
                        <MaterialCommunityIcons name="bell-ring-outline" size={24} color={colors.brand.primary} />
                        <View style={styles.rowText}>
                            <Text style={styles.rowTitle}>Tell me when one starts here</Text>
                            <Text style={styles.rowSub}>
                                {point ? 'Only the area (about 10 km) is kept, never where you are exactly.' : 'Use your location first, so we know where "here" is.'}
                            </Text>
                        </View>
                    </View>
                    {!!point && (
                        <Pressable style={[styles.secondary, watchBusy && { opacity: 0.6 }]} onPress={watchHere} disabled={watchBusy || !identity} accessibilityRole="button">
                            <Text style={styles.secondaryText}>{watchBusy ? 'Saving…' : 'Tell me'}</Text>
                        </Pressable>
                    )}
                    {!!watchNote && <Text style={styles.note}>{watchNote}</Text>}
                    {(watches ?? []).map(w => (
                        <View key={w.id} style={[styles.row, styles.divider]}>
                            <View style={styles.rowText}>
                                <Text style={styles.rowTitle}>Watching {w.lat.toFixed(1)}, {w.lng.toFixed(1)}</Text>
                                <Text style={styles.rowSub}>Within {w.radiusKm} km</Text>
                            </View>
                            <Pressable style={styles.secondary} onPress={() => stopWatching(w.id)} accessibilityRole="button" accessibilityLabel="Stop watching this place">
                                <Text style={styles.secondaryText}>Stop</Text>
                            </Pressable>
                        </View>
                    ))}
                </View>
            </KeyboardAwareScrollView>
        </SafeAreaView>
    );
}
