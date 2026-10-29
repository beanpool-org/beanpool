import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, ErrorBoundary, useLocalSearchParams } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    COMMUNITY_CARD_WORDS as W, communityCardFacts, communityCardName, readCommunityCard, t, tn, word, type CommunityCard,
} from '@beanpool/core';
import { useStyles } from './ThemeContext';
import { useIdentity } from './IdentityContext';
import { communityOrigin } from '../utils/community-origin';
import { getCanonicalAvatar } from '../utils/canonical-profile';
import {
    sendKnock, rememberedKnocks, cancelledKnocks, rememberKnock, forgetKnock, readKnockStatus, knockCardState, knockFormProblem,
    KNOCK_MESSAGES, KNOCK_MESSAGE_CHARS, KNOCK_CALLSIGN_CHARS, type KnockCardState, type KnockStatusResult,
} from '../utils/knock';
import { knockFromNode } from '../utils/knock-address';
import { joinAnotherCommunity, joinedNudge, PROTECT_REDIRECT, HOME_REDIRECT } from '../utils/join-another-community';
import { joinedNudgeWords } from '../utils/joined-nudge-words';
import { findLineWords } from '../components/find-community-lines';
import { welcomeLineWords } from '../components/welcome/welcome-lines';
import { askNotificationPermissionOnAction } from '../utils/notification-permission';

export { ErrorBoundary };

/** The card screen's own words: word() keys, t()'d where shown. The card's are core's (COMMUNITY_CARD_WORDS). */
const CARD_SCREEN_WORDS = {
    title: word('COMMUNITY'),
    member: word("You're a member of {name}."),
    open: word('Open {name}'),
    noCommunity: word("This link doesn't name a community this app can open."),
} as const;

const TIMEOUT_MS = 15_000;

/**
 * A community's public card, read unsigned from the community itself (GET /api/community/card): nothing to sign for.
 * A link may name any server, and the card's name and host are only that server's claim: the host is always the one it
 * was read from (shown under the name), and a card that names another host loses its name, so no server reads as
 * another community, and a request to join is never sent to a server that looks like one it isn't.
 */
async function readCard(origin: string): Promise<CommunityCard | 'unreachable' | 'unreadable'> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`${origin}/api/community/card`, { signal: ctl.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return 'unreadable';
        const card = readCommunityCard(await res.json());
        if (!card) return 'unreadable';
        const host = origin.replace(/^https:\/\//, '');
        const claimed = card.host?.replace(/:443$/, '') ?? null;
        return { ...card, name: claimed && claimed !== host ? null : card.name, host };
    } catch {
        return 'unreachable';
    } finally {
        clearTimeout(timer);
    }
}

/**
 * A community's public card (front doors S15): what a stranger reads at its bare address, opened in the app by that
 * address or by the card's own Ask to join on an Android phone's browser (utils/community-card-link.ts). Member or not:
 *   - this phone's own community: "You're a member", Open it;
 *   - an account elsewhere: Ask to join, here (the request goes to the community itself, signed with the phone's key, as
 *     from Find a community: utils/knock.ts); once asked, what the community answered (waiting, a yes to join with, or
 *     ask again), as Find a community shows it; and I have an invite (People's Join Another Community, as it is: no route
 *     fills its server box, so no link can point a member's join at another server: pair-link.test.ts holds it);
 *   - an account in no community yet (waiting to be let in, slice S3): the same, but its yes goes to welcome, which joins
 *     it through the invite step so the 12 words its key has never shown come next (as Find a community's Join does);
 *   - no account yet: the first screen, for an invite (Join with an invite), the ways back (Already a member), or
 *     look around global first, join there and find it in Find a community.
 * Nothing is read but the community's public card; nothing is sent until the member taps Send.
 */
export default function CommunityCardScreen() {
    const params = useLocalSearchParams<{ node?: string }>();
    const origin = communityOrigin(params.node);
    const { identity } = useIdentity();
    const insets = useSafeAreaInsets();
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        backIcon: { color: colors.text.inverse },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5 },
        scroll: { padding: 16 },
        card: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, padding: 16 },
        kicker: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, marginBottom: 4 },
        name: { fontSize: 22, fontWeight: '800', color: colors.text.heading, marginBottom: 8 },
        host: { fontSize: 14, color: colors.text.secondary, marginTop: -6, marginBottom: 8 },
        fact: { fontSize: 15, color: colors.text.body, lineHeight: 21 },
        chip: { alignSelf: 'flex-start', marginTop: 8, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, backgroundColor: colors.surface.subtle },
        chipText: { fontSize: 14, fontWeight: '700', color: colors.brand.primary },
        note: { fontSize: 15, color: colors.text.body, marginTop: 12, lineHeight: 21 },
        refusal: { fontSize: 15, color: colors.feedback.warning.fg, marginTop: 12, lineHeight: 21 },
        actions: { gap: 10, marginTop: 16 },
        primary: { minHeight: 48, paddingHorizontal: 18, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
        primaryText: { color: colors.text.inverse, fontSize: 16, fontWeight: '800', textAlign: 'center' },
        secondary: { minHeight: 48, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        secondaryText: { color: colors.text.body, fontSize: 16, fontWeight: '700', textAlign: 'center' },
        label: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, marginTop: 12, marginBottom: 4 },
        input: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.app, color: colors.text.heading, fontSize: 16, paddingHorizontal: 12, paddingVertical: 10 },
        multiline: { minHeight: 96, textAlignVertical: 'top' },
        counter: { fontSize: 12, color: colors.text.muted, alignSelf: 'flex-end', marginTop: 2 },
        formError: { fontSize: 14, color: colors.feedback.danger.fg, marginTop: 8, lineHeight: 20 },
    }));

    const [card, setCard] = useState<CommunityCard | 'loading' | 'unreachable' | 'unreadable'>('loading');
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (!origin) return;
        let alive = true;
        setCard('loading');
        readCard(origin).then(c => { if (alive) setCard(c); });
        return () => { alive = false; };
    }, [origin, attempt]);

    // This phone's own community; whether it has asked this one (utils/knock.ts remembers each knock), or cancelled a
    // request to it within the day; and, where it asked, what the community answered, read signed from the community
    // itself, as Find a community reads it. `asked` is null until the phone's memory is read.
    const [memberHere, setMemberHere] = useState(false);
    const [asked, setAsked] = useState<boolean | null>(null);
    const [cancelledHere, setCancelledHere] = useState(false);
    const [memberNote, setMemberNote] = useState<string | null>(null);
    useEffect(() => {
        if (!origin || !identity) return;
        let alive = true;
        AsyncStorage.getItem('beanpool_anchor_url')
            .then(anchor => { if (alive) setMemberHere(communityOrigin(anchor) === origin); })
            .catch(() => {});
        // One after the other: each forgets what has aged out of the same store.
        cancelledKnocks(identity.publicKey)
            .then(async cancelled => {
                const knocks = await rememberedKnocks(identity.publicKey);
                if (!alive) return;
                setCancelledHere(!!cancelled[origin]);
                setAsked(knocks.some(k => k.url === origin));
            })
            .catch(() => { if (alive) setAsked(false); });
        return () => { alive = false; };
    }, [origin, identity?.publicKey]);

    // The community's answer, only where this key asked it: a signed read shows a community who is asking.
    const [status, setStatus] = useState<KnockStatusResult | null>(null);
    const [statusAsk, setStatusAsk] = useState(0);
    useEffect(() => {
        if (!origin || !identity || !asked) return;
        let alive = true;
        setStatus(null);
        readKnockStatus(origin, identity)
            .then(r => { if (alive) setStatus(r); })
            .catch(() => { if (alive) setStatus({ ok: false, kind: 'unreachable', message: KNOCK_MESSAGES.unreachable }); });
        return () => { alive = false; };
    }, [origin, identity?.publicKey, asked, statusAsk]);

    // What this key's request says here, as Find a community decides it (app/find-community.tsx stateFor).
    const knock: KnockCardState = asked === null
        ? { kind: 'checking' }
        : cancelledHere && !asked
            ? { kind: 'cancelled', note: KNOCK_MESSAGES.cancelled }
            : knockCardState(true, asked, asked ? status : undefined, memberNote);

    // The request to join: as on Find a community, to the community itself, with the phone's own key.
    const [formOpen, setFormOpen] = useState(false);
    const [callsign, setCallsign] = useState((identity?.callsign ?? '').slice(0, KNOCK_CALLSIGN_CHARS));
    const [message, setMessage] = useState('');
    const [formError, setFormError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const send = async (c: CommunityCard) => {
        if (!identity || !origin) return;
        const problem = knockFormProblem({ callsign, message });
        if (problem) { setFormError(problem); return; }
        await askNotificationPermissionOnAction('knock', identity.publicKey);
        setSending(true);
        setFormError(null);
        const avatar = await getCanonicalAvatar().catch(() => null);
        // From the global community only for a member there, as Find a community says it (utils/knock-address.ts): a phone
        // waiting to be let in (S3), or one in a local community, names no community it came from.
        const anchor = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
        const guest = anchor ? await import('../utils/nodes').then(m => m.isGuestNode(anchor)).catch(() => true) : false;
        const r = await sendKnock(origin, identity, { callsign, message, avatar }, knockFromNode(anchor, guest));
        setSending(false);
        if (r.kind === 'waiting' || r.kind === 'invited') {
            await rememberKnock(identity.publicKey, { url: origin, name: c.name });
            setFormOpen(false);
            setMessage('');
            // Read what it says now: waiting, or a yes with its invite.
            setAsked(true);
            setStatusAsk(n => n + 1);
        } else if (r.kind === 'member') {
            setFormOpen(false);
            setMemberNote(r.message);
        } else {
            setFormError(r.message);
        }
    };

    // A yes: join with its invite, as from Find a community (app/find-community.tsx join).
    const [joining, setJoining] = useState(false);
    const join = async (c: CommunityCard, invite: string) => {
        if (!identity || !origin) return;
        const returnUrl = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
        if (!returnUrl) {
            // No community yet (waiting to be let in, slice S3), as Find a community's Join does: welcome joins it through
            // the invite step, so the wizard shows Your Photo and then the 12 words this key has never shown. Handed over
            // in memory, never by a link.
            (await import('../utils/waiting-to-join')).handKnockYesToWelcome({ url: origin, invite, name: c.name }, identity.publicKey);
            router.replace('/welcome');
            return;
        }
        setJoining(true);
        try {
            const joined = await joinAnotherCommunity({ targetUrl: origin, code: invite, identity, returnUrl, knownName: c.name });
            await forgetKnock(identity.publicKey, origin);
            const nudge = joinedNudgeWords(joinedNudge(joined.name), joined.name);
            Alert.alert(nudge.title, nudge.body, [
                { text: nudge.later, onPress: () => router.replace({ pathname: '/profile-setup', params: { redirect: HOME_REDIRECT } }) },
                // Only where each community keeps its own sign-in copy (a build without a key vault).
                ...(nudge.protect
                    ? [{ text: nudge.protect, onPress: () => router.replace({ pathname: '/profile-setup', params: { redirect: PROTECT_REDIRECT } }) }]
                    : []),
            ], { cancelable: false });
        } catch (e: any) {
            // The redeem's own words (the community's) as given; the phone's in the member's language.
            Alert.alert(t("Couldn't join"), e?.message ? welcomeLineWords(e.message) : t('Please try again.'));
        } finally {
            setJoining(false);
        }
    };

    const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));
    const welcome = (mode?: 'create' | 'member') => router.replace(mode ? { pathname: '/welcome', params: { mode } } : '/welcome');

    const body = () => {
        if (!origin) return <Text style={styles.note}>{t(CARD_SCREEN_WORDS.noCommunity)}</Text>;
        if (card === 'loading') return <ActivityIndicator style={{ marginTop: 24 }} />;
        if (card === 'unreachable' || card === 'unreadable') {
            return (
                <View>
                    <Text style={styles.refusal}>{card === 'unreachable' ? t(KNOCK_MESSAGES.unreachable) : t(KNOCK_MESSAGES.unreadable)}</Text>
                    <View style={styles.actions}>
                        <Pressable style={styles.secondary} onPress={() => setAttempt(n => n + 1)} accessibilityRole="button">
                            <Text style={styles.secondaryText}>{t('Try again')}</Text>
                        </Pressable>
                    </View>
                </View>
            );
        }
        const name = communityCardName(card, { t });
        const facts = communityCardFacts(card, { t, tn });
        return (
            <View style={styles.card} testID="community-card">
                <Text style={styles.kicker}>{t(W.kicker)}</Text>
                <Text style={styles.name} accessibilityRole="header" testID="community-card-name">{name}</Text>
                {/* The address it was read from, never the card's own word for it: the name is a claim. */}
                {!!card.host && name !== card.host && <Text style={styles.host} testID="community-card-host">{card.host}</Text>}
                {!!facts.members && <Text style={styles.fact} testID="community-card-members">{facts.members}</Text>}
                {!!facts.area && <Text style={styles.fact} testID="community-card-area">{facts.area}</Text>}
                <View style={styles.chip}><Text style={styles.chipText} testID="community-card-joining">{facts.joining}</Text></View>

                {memberHere ? (
                    <View>
                        <Text style={styles.note}>{t(CARD_SCREEN_WORDS.member, { name })}</Text>
                        <View style={styles.actions}>
                            <Pressable style={styles.primary} onPress={() => router.replace('/')} accessibilityRole="button" testID="community-card-open">
                                <Text style={styles.primaryText}>{t(CARD_SCREEN_WORDS.open, { name })}</Text>
                            </Pressable>
                        </View>
                    </View>
                ) : identity ? (
                    <View>
                        {knock.kind === 'checking' && <ActivityIndicator style={{ marginTop: 12, alignSelf: 'flex-start' }} testID="community-card-checking" />}
                        {'note' in knock && !!knock.note && (
                            <Text style={knock.kind === 'refused' || knock.kind === 'unreachable' ? styles.refusal : styles.note} testID="community-card-asked">
                                {findLineWords(knock.note)}
                            </Text>
                        )}
                        {knock.kind === 'unreachable' && (
                            <View style={styles.actions}>
                                <Pressable style={styles.secondary} onPress={() => setStatusAsk(n => n + 1)} accessibilityRole="button" testID="community-card-check-again">
                                    <Text style={styles.secondaryText}>{t('Check again')}</Text>
                                </Pressable>
                            </View>
                        )}
                        {knock.kind === 'invited' && (
                            <View style={styles.actions}>
                                <Pressable style={[styles.primary, joining && { opacity: 0.6 }]} onPress={() => join(card, knock.invite)} disabled={joining}
                                    accessibilityRole="button" testID="community-card-join">
                                    <Text style={styles.primaryText}>{joining ? t('Joining…') : t('Join {name}', { name })}</Text>
                                </Pressable>
                            </View>
                        )}
                        {/* Ask to join: nothing asked, no answer came, or a refusal that asking again could get past. */}
                        {card.joining === 'requests' && (knock.kind === 'ask' || (knock.kind === 'refused' && knock.canAsk)) && !formOpen && (
                            <View style={styles.actions}>
                                <Pressable style={styles.primary} onPress={() => { setFormOpen(true); setFormError(null); }} accessibilityRole="button" testID="community-card-ask">
                                    <Text style={styles.primaryText}>{t(W.ask)}</Text>
                                </Pressable>
                            </View>
                        )}
                        {formOpen && (
                            <View>
                                <Text style={styles.label}>{t('Your name')}</Text>
                                <TextInput style={styles.input} value={callsign} onChangeText={v => setCallsign(v.slice(0, KNOCK_CALLSIGN_CHARS))}
                                    maxLength={KNOCK_CALLSIGN_CHARS} autoCapitalize="words" accessibilityLabel={t('Your name')} />
                                <Text style={styles.label}>{t('A few words about yourself')}</Text>
                                <TextInput style={[styles.input, styles.multiline]} value={message} multiline
                                    onChangeText={v => setMessage(Array.from(v).slice(0, KNOCK_MESSAGE_CHARS).join(''))}
                                    placeholder={t("Where you live, what you'd like to share or learn")} accessibilityLabel={t('A few words about yourself')} />
                                <Text style={styles.counter}>{Array.from(message).length}/{KNOCK_MESSAGE_CHARS}</Text>
                                {!!formError && <Text style={styles.formError} accessibilityLiveRegion="polite">{findLineWords(formError)}</Text>}
                                <View style={styles.actions}>
                                    <Pressable style={[styles.primary, sending && { opacity: 0.6 }]} onPress={() => send(card)} disabled={sending} accessibilityRole="button">
                                        <Text style={styles.primaryText}>{sending ? t('Sending…') : t('Send')}</Text>
                                    </Pressable>
                                    <Pressable style={styles.secondary} onPress={() => { setFormOpen(false); setFormError(null); }} accessibilityRole="button">
                                        <Text style={styles.secondaryText}>{t('Cancel')}</Text>
                                    </Pressable>
                                </View>
                            </View>
                        )}
                        {!formOpen && (
                            <View style={styles.actions}>
                                <Pressable style={styles.secondary} accessibilityRole="button" testID="community-card-invite"
                                    onPress={() => router.push({ pathname: '/(tabs)/people', params: { view: 'invites' } })}>
                                    <Text style={styles.secondaryText}>{t(W.haveInvite)}</Text>
                                </Pressable>
                            </View>
                        )}
                    </View>
                ) : (
                    <View>
                        {card.joining === 'requests' && <Text style={styles.note} testID="community-card-needs-account">{t(W.askViaGlobal, { name })}</Text>}
                        <View style={styles.actions}>
                            {card.joining === 'requests' && (
                                <Pressable style={styles.primary} onPress={() => welcome()} accessibilityRole="button" testID="community-card-ask">
                                    <Text style={styles.primaryText}>{t(W.ask)}</Text>
                                </Pressable>
                            )}
                            <Pressable style={card.joining === 'requests' ? styles.secondary : styles.primary} onPress={() => welcome('create')} accessibilityRole="button" testID="community-card-invite">
                                <Text style={card.joining === 'requests' ? styles.secondaryText : styles.primaryText}>{t(W.haveInvite)}</Text>
                            </Pressable>
                            <Pressable style={styles.secondary} onPress={() => welcome('member')} accessibilityRole="button" testID="community-card-signin">
                                <Text style={styles.secondaryText}>{t(W.member)}</Text>
                            </Pressable>
                        </View>
                    </View>
                )}
            </View>
        );
    };

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style="light" />
            <View style={styles.header}>
                <Pressable onPress={leave} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Back')}>
                    <MaterialCommunityIcons name="arrow-left" size={26} color={styles.backIcon.color} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} accessibilityRole="header">{t(CARD_SCREEN_WORDS.title)}</Text>
                <View style={{ width: 48 }} />
            </View>
            <KeyboardAwareScrollView contentContainerStyle={[styles.scroll, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]} keyboardShouldPersistTaps="handled" bottomOffset={16}>
                {body()}
            </KeyboardAwareScrollView>
        </SafeAreaView>
    );
}
