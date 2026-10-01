/**
 * The names list, for a community's owners and admins (community modes slice 2). Logic and words: utils/names-list.ts;
 * styles: utils/names-list-style.ts; the server: apps/server/src/routes/names-list.ts.
 *
 * Opening it opens this admin's own wrap of the list's key on this phone (utils/names-list.ts openNamesList), and only a
 * wrap an admin this phone trusts signed: one the server, or anyone with its database, wrote in is refused, said here
 * plainly, and nothing is sealed under it. The first admin to open it makes the key; after an admin goes, the phone of
 * one who held it makes a new one and seals the older entries again; an admin made since waits until one who holds the
 * key taps "Share" for them. Every name is sealed here before it is sent, and opened here: the community's server keeps
 * scrambled text.
 *
 * One screen, three views in one keyboard-aware scroll (no Modal: a nested keyboard provider breaks keyboards app-wide):
 * the list, an entry's form, and the member picker. Every read the phone makes is logged on the node, so a write updates
 * the list here rather than reading it all again. Every button is at least 48dp tall and every row wraps at 320dp and
 * 1.3× text.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, Alert, Switch } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useFocusEffect, useLocalSearchParams, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useIdentity } from './IdentityContext';
import { useTheme, useStyles } from './ThemeContext';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { getAllCommunityMembers } from '../utils/db';
import { namesListStyleSpec } from '../utils/names-list-style';
import {
    NAMES_COPY as COPY, openNamesList, fetchNamesList, fetchNamesLog, installKeyFor, waitingAdmins, trustAdminKey, readNamesTrust,
    shareKeyWith, openEntries, filterEntries, sealedFor, addNamesEntry, editNamesEntry, deleteNamesEntry,
    confirmableMembers, confirmMember, secondConfirmation, revokeConfirmation, confirmationLine,
    confirmationActions, logLineText, namesListHtml, setNamesSettings,
    type NamesState, type NamesListBody, type KeyPlan, type OpenedEntry, type NamesLogLine, type CommunityMember, type NamesAdminRow,
} from '../utils/names-list';

export { ErrorBoundary };

type Mode = { kind: 'list' } | { kind: 'edit'; entry: OpenedEntry | null } | { kind: 'pick'; entry: OpenedEntry };

export default function NamesListScreen() {
    const { theme, colors } = useTheme();
    const styles = useStyles(({ colors }) => StyleSheet.create(namesListStyleSpec(colors)));
    const { identity } = useIdentity();
    const params = useLocalSearchParams<{ community?: string }>();
    const communityName = typeof params.community === 'string' && params.community.trim() ? params.community.trim() : 'This community';

    const [anchor, setAnchor] = useState<string | null>(null);
    const [state, setState] = useState<NamesState | null>(null);
    const [list, setList] = useState<NamesListBody | null>(null);
    const [keys, setKeys] = useState<Map<number, Uint8Array>>(new Map());
    const [plan, setPlan] = useState<KeyPlan | null>(null);
    const [log, setLog] = useState<NamesLogLine[]>([]);
    /** The callsigns of the admins this phone trusts for the list (not this admin): whom a refusal says to ask. */
    const [trustedNames, setTrustedNames] = useState<string[]>([]);
    const [members, setMembers] = useState<CommunityMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [mode, setMode] = useState<Mode>({ kind: 'list' });
    const [query, setQuery] = useState('');
    const [memberQuery, setMemberQuery] = useState('');
    const [name, setName] = useState('');
    const [note, setNote] = useState('');
    const [formError, setFormError] = useState<string | null>(null);
    const loadingRef = useRef(false);

    const load = useCallback(async () => {
        if (loadingRef.current || !identity) return;
        loadingRef.current = true;
        setLoading(true);
        setError(null);
        try {
            const url = await getAnchorUrl();
            if (!url) { setError('This phone isn’t connected to a community.'); return; }
            setAnchor(url);
            const opened = await openNamesList(url, identity, AsyncStorage);
            if (!opened.ok) {
                setError(opened.status === 404 ? 'This community keeps no names list.' : opened.message);
                return;
            }
            const { state: s, plan: p, keys: k, list: body, notice: said } = opened.value;
            const pin = await readNamesTrust(AsyncStorage, identity.publicKey, url);
            setTrustedNames(s.admins.filter((a) => a.pubkey !== identity.publicKey && pin?.trusted.includes(a.pubkey)).map((a) => a.callsign));
            setState(s);
            setKeys(k);
            setPlan(p);
            if (said) setNotice(said);
            if (p.kind !== 'ready' || !body) return;
            setList(body);
            const lines = await fetchNamesLog(url, identity, 30);
            if (lines.ok) setLog(lines.value.log);
            setMembers(await getAllCommunityMembers().catch(() => []));
        } finally {
            loadingRef.current = false;
            setLoading(false);
        }
    }, [identity]);

    useFocusEffect(useCallback(() => { void load(); }, [load]));

    const entries = useMemo(() => (list ? openEntries(list, keys) : []), [list, keys]);
    const shown = useMemo(() => filterEntries(entries, query), [entries, query]);
    const generation = state?.generation ?? 0;
    const currentKey = keys.get(generation);
    const callsignOf = useMemo(() => {
        const m = new Map<string, string>();
        for (const x of members) m.set(x.publicKey, x.callsign);
        for (const a of state?.admins ?? []) m.set(a.pubkey, a.callsign);
        return (pubkey: string) => (m.has(pubkey) ? `@${m.get(pubkey)}` : 'an admin');
    }, [members, state]);

    // ── actions ──────────────────────────────────────────────────────────────────────────────

    const startAgain = () => {
        if (!anchor || !identity || !state || !plan || plan.kind !== 'start_again') return;
        Alert.alert(COPY.startAgainTitle, COPY.startAgain, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Start again', style: 'destructive', onPress: async () => {
                    setBusy(true);
                    const made = await installKeyFor(anchor, identity, state, plan, AsyncStorage);
                    setBusy(false);
                    if (!made.ok) { setError(made.message); return; }
                    void load();
                },
            },
        ]);
    };

    const share = (admin: NamesAdminRow) => {
        if (!anchor || !identity || !state || !currentKey) return;
        Alert.alert(COPY.shareTitle(admin.callsign), COPY.share(admin.callsign), [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Share', onPress: async () => {
                    setBusy(true);
                    const done = await shareKeyWith(anchor, identity, state, currentKey, admin, AsyncStorage);
                    setBusy(false);
                    if (!done.ok) { setError(done.message); return; }
                    setState({ ...state, admins: state.admins.map((a) => (a.pubkey === admin.pubkey ? { ...a, holdsKey: true } : a)) });
                },
            },
        ]);
    };

    /** The admin's own choice to trust the key that made the list's new key: asked first, in plain words. */
    const trustMaker = () => {
        if (!anchor || !identity || !state || plan?.kind !== 'refused' || !plan.refusal.canTrust || !plan.refusal.maker) return;
        const maker = plan.refusal.maker;
        const callsign = plan.refusal.makerCallsign ?? 'this admin';
        Alert.alert(COPY.trustTitle(callsign), COPY.trust(callsign), [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Trust', style: 'destructive', onPress: async () => {
                    await trustAdminKey(AsyncStorage, identity, anchor, state, maker);
                    void load();
                },
            },
        ]);
    };

    const openForm = (entry: OpenedEntry | null) => {
        setName(entry?.text?.name ?? '');
        setNote(entry?.text?.note ?? '');
        setFormError(null);
        setMode({ kind: 'edit', entry });
    };

    const save = async () => {
        if (mode.kind !== 'edit' || !anchor || !identity || !currentKey || !list) return;
        const sealed = sealedFor(currentKey, generation, { name, note }, mode.entry?.id);
        if (!sealed.ok) { setFormError(sealed.error); return; }
        setBusy(true);
        const sent = mode.entry
            ? await editNamesEntry(anchor, identity, generation, sealed)
            : await addNamesEntry(anchor, identity, generation, sealed);
        setBusy(false);
        if (!sent.ok) { setFormError(sent.message); return; }
        const now = new Date().toISOString();
        const others = list.entries.filter((e) => e.id !== sealed.id);
        const before = list.entries.find((e) => e.id === sealed.id);
        setList({
            ...list,
            entries: [...others, {
                id: sealed.id, ciphertext: sealed.ciphertext, keyGeneration: generation, createdBy: before?.createdBy ?? identity.publicKey,
                createdAt: before?.createdAt ?? now, updatedBy: identity.publicKey, updatedAt: now,
            }],
        });
        setMode({ kind: 'list' });
    };

    const remove = (entry: OpenedEntry) => {
        if (!anchor || !identity || !list) return;
        if (entry.confirmation) { setFormError(COPY.deleteConfirmed); return; }
        Alert.alert('Delete this entry?', 'It goes from the list for every admin. Your paper copy, if you keep one, is yours to update.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete', style: 'destructive', onPress: async () => {
                    setBusy(true);
                    const done = await deleteNamesEntry(anchor, identity, entry.id);
                    setBusy(false);
                    if (!done.ok) { setFormError(done.message); return; }
                    setList({ ...list, entries: list.entries.filter((e) => e.id !== entry.id) });
                    setMode({ kind: 'list' });
                },
            },
        ]);
    };

    /** Confirmations come back from the node with its ids: read the list again (a read, logged). */
    const afterConfirmation = async () => {
        if (!anchor || !identity) return;
        const l = await fetchNamesList(anchor, identity);
        if (l.ok) setList(l.value);
    };

    const confirmAs = async (entry: OpenedEntry, member: CommunityMember) => {
        if (!anchor || !identity) return;
        setBusy(true);
        const done = await confirmMember(anchor, identity, member.publicKey, entry.id);
        if (done.ok) await afterConfirmation();
        setBusy(false);
        if (!done.ok) { setError(done.message); return; }
        setNotice(done.value.status === 'awaiting_second'
            ? `@${member.callsign} is confirmed by you and waits for a second admin.`
            : `@${member.callsign} is confirmed against ${entry.text?.name ?? 'the entry'}.`);
        setMode({ kind: 'list' });
    };

    const second = async (entry: OpenedEntry) => {
        if (!anchor || !identity || !entry.confirmation) return;
        setBusy(true);
        const done = await secondConfirmation(anchor, identity, entry.confirmation.id);
        if (done.ok) await afterConfirmation();
        setBusy(false);
        if (!done.ok) setError(done.message);
    };

    const revoke = (entry: OpenedEntry) => {
        if (!anchor || !identity || !entry.confirmation) return;
        const who = entry.confirmation.callsign ? `@${entry.confirmation.callsign}` : 'this member';
        Alert.alert(COPY.removedConfirmTitle, `${who} will no longer be confirmed against this entry. You can confirm them again later.`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Revoke', style: 'destructive', onPress: async () => {
                    setBusy(true);
                    const done = await revokeConfirmation(anchor, identity, entry.confirmation!.id);
                    if (done.ok) await afterConfirmation();
                    setBusy(false);
                    if (!done.ok) setError(done.message);
                },
            },
        ]);
    };

    const exportPdf = () => {
        if (!anchor || !identity) return;
        Alert.alert(COPY.exportTitle, COPY.export, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Export', onPress: async () => {
                    setBusy(true);
                    try {
                        // Fetched for the export, so the node logs it as one: the PDF is made from this answer.
                        const fresh = await fetchNamesList(anchor, identity, true);
                        if (!fresh.ok) { setError(fresh.message); return; }
                        const html = namesListHtml({ communityName, exportedBy: `@${identity.callsign}`, at: new Date(), entries: openEntries(fresh.value, keys) });
                        // Required here, not at the top: a phone built before expo-print fails this export alone, and says so below.
                        const Print = require('expo-print') as typeof import('expo-print');
                        const Sharing = require('expo-sharing') as typeof import('expo-sharing');
                        const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
                        const { uri } = await Print.printToFileAsync({ html });
                        try {
                            await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Names list' });
                        } finally {
                            // The copy this phone made for sharing goes: what was shared is the admin's to keep safe.
                            await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
                        }
                    } catch {
                        setError('The PDF couldn’t be made on this phone. Update the app and try again.');
                    } finally {
                        setBusy(false);
                    }
                },
            },
        ]);
    };

    const setTwoAdmins = async (on: boolean) => {
        if (!anchor || !identity || !state) return;
        setBusy(true);
        const done = await setNamesSettings(anchor, identity, { twoAdminsToConfirm: on });
        setBusy(false);
        if (!done.ok) { setError(done.message); return; }
        setState({ ...state, settings: { ...state.settings, twoAdminsToConfirm: done.value.twoAdminsToConfirm } });
    };

    // ── views ────────────────────────────────────────────────────────────────────────────────

    const header = (
        <View style={styles.header}>
            <Pressable
                onPress={() => (mode.kind === 'list' ? router.back() : setMode({ kind: 'list' }))}
                style={styles.backButton} accessibilityRole="button" accessibilityLabel={mode.kind === 'list' ? 'Back' : 'Back to the list'}
            >
                <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.heading} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={2} accessibilityRole="header">
                {mode.kind === 'edit' ? (mode.entry ? 'Change an entry' : 'Add a name') : mode.kind === 'pick' ? 'Confirm a member' : COPY.title}
            </Text>
        </View>
    );

    const BUTTONS = {
        primary: [styles.primaryBtn, styles.primaryBtnText], secondary: [styles.secondaryBtn, styles.secondaryBtnText],
        danger: [styles.dangerBtn, styles.dangerBtnText], small: [styles.smallBtn, styles.smallBtnText],
    } as const;
    const btn = (label: string, onPress: () => void, kind: keyof typeof BUTTONS = 'primary', hint?: string) => (
        <Pressable
            key={label}
            style={[BUTTONS[kind][0], busy && styles.disabled]}
            onPress={onPress}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy, busy }}
            {...(hint ? { accessibilityHint: hint } : {})}
        >
            <Text style={BUTTONS[kind][1]}>{label}</Text>
        </Pressable>
    );

    const statusBlocks = (
        <>
            {notice ? <View style={styles.notice} accessibilityLiveRegion="polite"><Text style={styles.noticeText}>{notice}</Text></View> : null}
            {error ? (
                <View style={styles.error} accessibilityLiveRegion="assertive">
                    <Text style={styles.errorText}>{error}</Text>
                </View>
            ) : null}
        </>
    );

    let body: React.ReactNode;
    if (loading && !state) {
        body = <ActivityIndicator color={colors.brand.primary} accessibilityLabel="Opening the names list" />;
    } else if (mode.kind === 'edit') {
        const entry = mode.entry;
        body = (
            <>
                {entry?.locked ? <View style={styles.warn}><Text style={styles.warnText}>{COPY.lockedEntry}</Text></View> : null}
                <Text style={styles.label}>NAME</Text>
                <TextInput
                    style={styles.input} value={name} onChangeText={setName} placeholder="Their real name"
                    placeholderTextColor={colors.text.muted} autoCapitalize="words" autoCorrect={false} accessibilityLabel="Their real name"
                    maxLength={200} editable={!busy}
                />
                <Text style={styles.label}>NOTE (OPTIONAL)</Text>
                <TextInput
                    style={[styles.input, styles.noteInput]} value={note} onChangeText={setNote} multiline
                    placeholder="How the community knows them" placeholderTextColor={colors.text.muted}
                    accessibilityLabel="A note: how the community knows them" maxLength={1000} editable={!busy}
                />
                <Text style={styles.hint}>A name and a short note only: no address, date of birth or ID number. Sealed on this phone before it’s sent.</Text>
                {formError ? <View style={styles.error}><Text style={styles.errorText}>{formError}</Text></View> : null}
                <View style={styles.buttonRow}>
                    {btn('Save', save, 'primary')}
                    {btn('Cancel', () => setMode({ kind: 'list' }), 'secondary')}
                </View>
                {entry ? <View style={styles.buttonRow}>{btn('Delete this entry', () => remove(entry), 'danger')}</View> : null}
            </>
        );
    } else if (mode.kind === 'pick') {
        const candidates = confirmableMembers(members, list ?? { generation, entries: [], confirmations: [] }, identity?.publicKey ?? '', state?.admins.length ?? 0)
            .filter((m) => !memberQuery.trim() || m.callsign.toLocaleLowerCase().includes(memberQuery.trim().toLocaleLowerCase()));
        body = (
            <>
                <Text style={styles.body}>Which member is {mode.entry.text?.name ?? 'this person'}? Confirm only someone you know is them.</Text>
                <TextInput
                    style={styles.search} value={memberQuery} onChangeText={setMemberQuery} placeholder="Find a member"
                    placeholderTextColor={colors.text.muted} autoCorrect={false} accessibilityLabel="Find a member by name"
                />
                {candidates.length === 0 ? <Text style={styles.hint}>Nobody here is waiting to be confirmed.</Text> : null}
                {candidates.slice(0, 100).map((m) => (
                    <Pressable
                        key={m.publicKey} style={[styles.pickRow, busy && styles.disabled]} disabled={busy}
                        onPress={() => confirmAs(mode.entry, m)} accessibilityRole="button"
                        accessibilityLabel={`Confirm @${m.callsign} as ${mode.entry.text?.name ?? 'this entry'}`}
                    >
                        <Text style={styles.pickName}>@{m.callsign}</Text>
                    </Pressable>
                ))}
            </>
        );
    } else if (plan?.kind === 'wait') {
        body = (
            <View style={styles.warn}>
                <Text style={styles.warnText}>{COPY.wait(plan.holders.map((h) => h.callsign), plan.newKeyNeeded)}</Text>
            </View>
        );
    } else if (plan?.kind === 'refused') {
        body = (
            <>
                <View style={styles.warn} accessibilityLiveRegion="polite">
                    <Text style={styles.warnText} accessibilityRole="header">{COPY.refusedTitle}</Text>
                    <Text style={styles.warnText}>{COPY.refused(plan.refusal, trustedNames)}</Text>
                </View>
                {plan.refusal.canTrust && plan.refusal.makerCallsign
                    ? <View style={styles.buttonRow}>{btn(`Trust @${plan.refusal.makerCallsign}`, trustMaker, 'danger')}</View>
                    : null}
            </>
        );
    } else if (plan?.kind === 'start_again') {
        body = (
            <>
                <View style={styles.warn}><Text style={styles.warnText}>{COPY.startAgain}</Text></View>
                <View style={styles.buttonRow}>{btn('Start a new key', startAgain, 'danger')}</View>
            </>
        );
    } else if (plan?.kind === 'ready' && state) {
        const waiting = waitingAdmins(state, identity?.publicKey ?? '');
        body = (
            <>
                {waiting.map((a) => (
                    <View key={a.pubkey} style={styles.entry}>
                        <Text style={styles.entryNote}>@{a.callsign} is an admin and is waiting for the list’s key.</Text>
                        <View style={styles.buttonRow}>{btn(`Share with @${a.callsign}`, () => share(a), 'small')}</View>
                    </View>
                ))}
                <View style={styles.buttonRow}>
                    {btn('Add a name', () => openForm(null), 'primary')}
                    {btn('Export as PDF', exportPdf, 'secondary', 'Makes a PDF of the list on this phone, to keep with your paper copy')}
                </View>
                <TextInput
                    style={styles.search} value={query} onChangeText={setQuery} placeholder="Search names and notes"
                    placeholderTextColor={colors.text.muted} autoCorrect={false} accessibilityLabel="Search names and notes"
                />
                <Text style={styles.hint}>
                    {state.counts.entries} {state.counts.entries === 1 ? 'entry' : 'entries'} · {state.counts.confirmed} confirmed
                    {state.counts.awaitingSecond ? ` · ${state.counts.awaitingSecond} waiting for a second admin` : ''}
                </Text>
                {shown.map((e) => {
                    const acts = e.confirmation ? confirmationActions(e.confirmation, identity?.publicKey ?? '') : null;
                    return (
                        <View key={e.id} style={styles.entry}>
                            {e.text ? (
                                <>
                                    <Text style={styles.entryName}>{e.text.name}</Text>
                                    {e.text.note ? <Text style={styles.entryNote}>{e.text.note}</Text> : null}
                                </>
                            ) : (
                                <Text style={styles.lockedText}>{e.locked === 'no_key' && e.generation < generation ? COPY.noKeyEntry : COPY.lockedEntry}</Text>
                            )}
                            <Text style={styles.entryMeta}>{e.confirmation ? confirmationLine(e.confirmation, callsignOf) : 'No member confirmed against it'}</Text>
                            <View style={styles.buttonRow}>
                                {btn(e.text ? 'Change' : 'Type it again', () => openForm(e), 'small')}
                                {!e.confirmation && e.text ? btn('Confirm a member', () => { setMemberQuery(''); setMode({ kind: 'pick', entry: e }); }, 'small') : null}
                                {acts?.second ? btn('Confirm as second admin', () => second(e), 'small') : null}
                                {acts?.revoke ? btn('Revoke', () => revoke(e), 'small') : null}
                            </View>
                        </View>
                    );
                })}
                {state.me.owner ? (
                    <>
                        <Text style={styles.label}>SETTINGS (OWNERS)</Text>
                        <View style={styles.switchRow}>
                            <Text style={styles.switchLabel}>{COPY.twoAdminsLabel}</Text>
                            <Switch
                                value={state.settings.twoAdminsToConfirm} onValueChange={setTwoAdmins} disabled={busy}
                                accessibilityLabel={COPY.twoAdminsLabel} accessibilityHint={COPY.twoAdminsHelp}
                            />
                        </View>
                        <Text style={styles.hint}>{COPY.twoAdminsHelp}</Text>
                    </>
                ) : null}
                <Text style={styles.hint}>{COPY.notShownToMembers}</Text>
                <Text style={styles.label}>WHO OPENED OR CHANGED THE LIST</Text>
                {log.length === 0 ? <Text style={styles.hint}>Nothing yet.</Text> : null}
                {log.map((l) => <Text key={l.id} style={styles.logLine}>{logLineText(l, callsignOf)}</Text>)}
            </>
        );
    } else {
        body = null;
    }

    return (
        <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            {header}
            <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" bottomOffset={24}>
                {mode.kind === 'list' ? <Text style={styles.body}>{COPY.who}</Text> : null}
                {statusBlocks}
                {body}
                {busy ? <ActivityIndicator color={colors.brand.primary} accessibilityLabel="Working" /> : null}
            </KeyboardAwareScrollView>
        </SafeAreaView>
    );
}
