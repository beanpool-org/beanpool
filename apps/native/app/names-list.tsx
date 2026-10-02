/**
 * The names list, for a community's owners and admins (community modes slice 2). Logic and words: utils/names-list.ts;
 * styles: utils/names-list-style.ts; the server: apps/server/src/routes/names-list.ts; the trust model:
 * scratch/global-node/DESIGN-names-list-trust-fable.md.
 *
 * Opening it syncs this phone's own record of the list's key history and the keys it holds (utils/names-list.ts
 * openNamesList): it takes a new key only from an admin it trusts, gives the keys only to admins it trusts (without a
 * tap, every send logged on the node), and reads or writes only when it holds the newest key the server names. When it
 * refuses, it says why and offers the one way forward: check an admin in person, put the key history back, start again,
 * make a new key nobody can hand over, or follow the server's history. Each of those asks first. Every name is
 * sealed here before it is sent, and opened here: the community's server keeps scrambled text.
 *
 * Admins trust each other by checking each other in person: both phones show their key as a QR code and 20 digits, and
 * each scans the other's (the camera in a full-screen view of its own, with no keyboard in it), or compares the digits.
 *
 * One screen, four views in one keyboard-aware scroll (no Modal around anything with a keyboard: a nested keyboard
 * provider breaks keyboards app-wide): the list, an entry's form, the member picker, and checking each other. Every read
 * the phone makes is logged on the node, so a write updates the list here rather than reading it all again. Every button
 * is at least 48dp tall and every row wraps at 320dp and 1.3× text.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, Alert, Switch, Modal } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import QRCode from 'react-native-qrcode-svg';
import { StatusBar } from 'expo-status-bar';
import { useIdentity } from './IdentityContext';
import { useTheme, useStyles } from './ThemeContext';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { getAllCommunityMembers } from '../utils/db';
import { namesListStyleSpec } from '../utils/names-list-style';
import {
    NAMES_COPY as COPY, DEVICE_NAMES_STORE as STORE, openNamesList, fetchNamesList, fetchNamesLog, checkEachOther, removeOldKey,
    putHistoryBack, makeKeyOnThisPhone, followServerHistory, sendKeysAgain, myKeyCheck, openEntries, filterEntries, saveNamesEntry,
    deleteNamesEntry, confirmableMembers, confirmMember, secondConfirmation, revokeConfirmation, confirmationLine, confirmationActions,
    logLineText, namesListHtml, setNamesSettings, planWords, newEntryId, listKeyOf, pendingRemovals,
    type NamesOpened, type OpenedEntry, type NamesLogLine, type CommunityMember, type NamesAdminRow,
} from '../utils/names-list';

export { ErrorBoundary };

/** The admin picked to check, or null for "check an admin" with nobody picked (a reinstalled phone, say). */
type Picked = { pubkey: string; callsign: string } | null;
/** `addId`: a new entry's id, chosen when its form opens and kept until the add is confirmed (a Save after a lost answer is the same add). */
type Mode = { kind: 'list' } | { kind: 'edit'; entry: OpenedEntry | null; addId?: string } | { kind: 'pick'; entry: OpenedEntry } | { kind: 'check'; picked: Picked };

export default function NamesListScreen() {
    const { theme, colors } = useTheme();
    const styles = useStyles(({ colors }) => StyleSheet.create(namesListStyleSpec(colors)));
    const { identity } = useIdentity();
    const params = useLocalSearchParams<{ community?: string }>();
    const communityName = typeof params.community === 'string' && params.community.trim() ? params.community.trim() : 'This community';

    const [anchor, setAnchor] = useState<string | null>(null);
    const [opened, setOpened] = useState<NamesOpened | null>(null);
    const [log, setLog] = useState<NamesLogLine[]>([]);
    const [members, setMembers] = useState<CommunityMember[]>([]);
    const [loading, setLoading] = useState(true);
    /**
     * Round 13: the list on screen is no longer what the pin says (an action, or a reload, failed after it): null when it
     * is; else the removals the pin still stands by, by callsign. The ready list isn't offered from a stale snapshot.
     */
    const [stale, setStale] = useState<string[] | null>(null);
    const openedRef = useRef<NamesOpened | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [mode, setMode] = useState<Mode>({ kind: 'list' });
    const [query, setQuery] = useState('');
    const [memberQuery, setMemberQuery] = useState('');
    const [name, setName] = useState('');
    const [note, setNote] = useState('');
    const [formError, setFormError] = useState<string | null>(null);
    const [typedCode, setTypedCode] = useState('');
    const [checkError, setCheckError] = useState<string | null>(null);
    const [scanning, setScanning] = useState(false);
    const [showMyKey, setShowMyKey] = useState(false);
    const [permission, requestPermission] = useCameraPermissions();
    const scanLock = useRef(false); // one scan at a time: the camera reports the same code many times a second
    const loadingRef = useRef(false);
    /**
     * One thing at a time on this screen (round 12): no action starts while the list loads, and no load while an action
     * runs, so a reload never saves the pin over a Remove, a check or a new key (the module also queues every pin save).
     */
    const busyRef = useRef(false);
    const begin = (): boolean => {
        if (loadingRef.current || busyRef.current) return false;
        busyRef.current = true;
        setBusy(true);
        return true;
    };
    const finish = () => { busyRef.current = false; setBusy(false); };

    /** What an open, or an action that opens again, came back with. */
    const take = useCallback(async (url: string, result: Awaited<ReturnType<typeof openNamesList>>) => {
        if (!identity) return;
        if (!result.ok) {
            setError(result.status === 404 ? 'This community keeps no names list.' : result.message);
            // Show the state the pin is in, not the last list: a Remove whose open failed still stands.
            if (openedRef.current) setStale(await pendingRemovals(STORE, identity, url, openedRef.current.state).catch(() => []));
            return;
        }
        setStale(null);
        setOpened(result.value);
        if (result.value.notices.length) setNotice(result.value.notices.join('\n\n'));
        if (!result.value.list) return;
        const lines = await fetchNamesLog(url, identity, 30);
        if (lines.ok) setLog(lines.value.log);
        setMembers(await getAllCommunityMembers().catch(() => []));
    }, [identity]);

    const load = useCallback(async () => {
        if (loadingRef.current || busyRef.current || !identity) return;
        loadingRef.current = true;
        setLoading(true);
        setError(null);
        try {
            const url = await getAnchorUrl();
            if (!url) { setError('This phone isn’t connected to a community.'); return; }
            setAnchor(url);
            await take(url, await openNamesList(url, identity, STORE));
        } finally {
            loadingRef.current = false;
            setLoading(false);
        }
    }, [identity, take]);

    useFocusEffect(useCallback(() => { void load(); }, [load]));

    useEffect(() => { openedRef.current = opened; }, [opened]);
    const state = opened?.state ?? null;
    const plan = opened?.plan ?? null;
    const list = opened?.list ?? null;
    const entries = useMemo(() => (opened?.list ? openEntries(opened.list, opened) : []), [opened]);
    const shown = useMemo(() => filterEntries(entries, query), [entries, query]);
    const callsignOf = useMemo(() => {
        const m = new Map<string, string>();
        for (const x of members) m.set(x.publicKey, x.callsign);
        for (const [k, c] of Object.entries(state?.callsigns ?? {})) m.set(k, c);
        for (const a of state?.admins ?? []) m.set(a.pubkey, a.callsign);
        return (pubkey: string) => m.get(pubkey) ?? '';
    }, [members, state]);
    const at = (pubkey: string) => (callsignOf(pubkey) ? `@${callsignOf(pubkey)}` : 'an admin');
    const trusted = (pubkey: string) => !!opened?.pin.trusted.includes(pubkey);

    /** Runs an action that opens the list again, with the busy spinner and its refusal said. */
    const run = async (fn: (url: string) => Promise<Awaited<ReturnType<typeof openNamesList>>>) => {
        if (!anchor || !begin()) return;
        setError(null);
        try {
            await take(anchor, await fn(anchor));
        } finally {
            finish();
        }
    };

    // ── the key: each of these asks first ──────────────────────────────────────────────────────

    const ask = (title: string, message: string, confirm: string, onConfirm: () => void, destructive = true) => {
        Alert.alert(title, message, [
            { text: 'Cancel', style: 'cancel' },
            { text: confirm, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
        ]);
    };

    const startAgain = () => {
        if (!identity || !state) return;
        const words = plan?.kind === 'wait' ? (planWords(opened!) ?? '') : COPY.startAgain(state.counts?.entries ?? 0);
        ask(plan?.kind === 'wait' ? COPY.makeNewTitle : COPY.startAgainTitle, words, plan?.kind === 'wait' ? COPY.makeNewButton : COPY.startAgainButton,
            () => { void run((url) => makeKeyOnThisPhone(url, identity, STORE)); });
    };

    const putBack = () => {
        if (!identity || plan?.kind !== 'refused') return;
        ask(COPY.putBackTitle, COPY.refusedRolledBack(plan.offered?.n ?? 0, plan.newest?.n ?? 0), COPY.putBackButton,
            () => { void run((url) => putHistoryBack(url, identity, STORE)); }, false);
    };

    const removeKey = (admin: NamesAdminRow) => {
        if (!identity || !anchor) return;
        ask(COPY.removeKeyTitle(admin.callsign), COPY.removeKey(admin.callsign), COPY.removeKeyButton(admin.callsign), () => {
            void run(async (url) => {
                await removeOldKey(STORE, identity, url, admin.pubkey);
                return openNamesList(url, identity, STORE);
            });
        });
    };

    /** "Follow the server's history" (design Addendum 3): asked first; no check in person needed. */
    const follow = () => {
        if (!identity) return;
        ask(COPY.followTitle, COPY.follow, COPY.followButton, () => {
            void run((url) => followServerHistory(url, identity, STORE));
        });
    };

    const sendAgain = async (admin: NamesAdminRow) => {
        if (!identity || !anchor) return;
        if (!begin()) return;
        let done: Awaited<ReturnType<typeof sendKeysAgain>>;
        try {
            done = await sendKeysAgain(anchor, identity, STORE, admin.pubkey);
        } finally {
            finish();
        }
        if (!done.ok) { setError(done.message); return; }
        setNotice(`Sent the keys to @${admin.callsign}.`);
    };

    // ── checking each other ────────────────────────────────────────────────────────────────────

    const startCheck = (picked: Picked) => {
        setTypedCode('');
        setCheckError(null);
        setScanning(false);
        scanLock.current = false;
        setMode({ kind: 'check', picked });
    };

    /**
     * What was scanned or typed. A QR code pins the key it shows: when it isn't the key the server lists for the admin
     * picked, that is said loudly, and nothing is sent to either until the server lists the scanned key as an admin.
     */
    const finishCheck = async (text: string) => {
        if (mode.kind !== 'check' || !anchor || !identity || !state) return;
        if (!begin()) { scanLock.current = false; return; }
        const { picked } = mode;
        setScanning(false);
        const r = await checkEachOther(STORE, identity, anchor, state, text, picked).finally(finish);
        if (!r.ok) {
            const who = picked?.callsign ?? '';
            setCheckError(r.reason === 'mismatch' ? COPY.codeMismatch(who) : r.reason === 'self' ? COPY.self : r.reason === 'no_match' ? COPY.noMatch : COPY.unreadable);
            setTimeout(() => { scanLock.current = false; }, 600);
            return;
        }
        if (r.mismatch && picked) setError(COPY.mismatch(picked.callsign));
        else setNotice(COPY.matched(callsignOf(r.pinned) || picked?.callsign || ''));
        setMode({ kind: 'list' });
        void load();
    };

    const onScanned = ({ data }: BarcodeScanningResult) => {
        if (scanLock.current) return;
        scanLock.current = true;
        void finishCheck(data);
    };

    // ── entries ────────────────────────────────────────────────────────────────────────────────

    const openForm = (entry: OpenedEntry | null) => {
        setName(entry?.text?.name ?? '');
        setNote(entry?.text?.note ?? '');
        setFormError(null);
        setMode({ kind: 'edit', entry, addId: entry ? undefined : newEntryId() });
    };

    const save = async () => {
        if (mode.kind !== 'edit' || !anchor || !identity || !opened || !list) return;
        if (!begin()) return;
        let sent: Awaited<ReturnType<typeof saveNamesEntry>>;
        try {
            sent = await saveNamesEntry(anchor, identity, STORE, opened, { name, note }, mode.entry?.id, mode.addId);
        } finally {
            finish();
        }
        if (!sent.ok) {
            setFormError(sent.message);
            // Decided from the pin (round 13): a removal still standing, or the list no longer ready, means the list on
            // screen is stale.
            if (sent.code === 'still_removing' || sent.code === 'not_ready') setStale(await pendingRemovals(STORE, identity, anchor, opened.state).catch(() => []));
            return;
        }
        // Sealed under a key the list on screen doesn't show as its head: open it again.
        if (sent.value.keyId !== opened.pin.chain[opened.pin.chain.length - 1]?.id) void load();
        const base = sent.value.opened ?? opened;
        const body = base.list ?? list;
        const now = new Date().toISOString();
        const before = body.entries.find((e) => e.id === sent.value.id);
        setOpened({
            ...base,
            list: {
                ...body,
                entries: [...body.entries.filter((e) => e.id !== sent.value.id), {
                    id: sent.value.id, ciphertext: sent.value.ciphertext, keyId: sent.value.keyId, createdBy: before?.createdBy ?? identity.publicKey,
                    createdAt: before?.createdAt ?? now, updatedBy: identity.publicKey, updatedAt: now,
                }],
            },
        });
        setMode({ kind: 'list' });
    };

    const remove = (entry: OpenedEntry) => {
        if (!anchor || !identity || !opened || !list) return;
        if (entry.confirmation) { setFormError(COPY.deleteConfirmed); return; }
        Alert.alert('Delete this entry?', 'It goes from the list for every admin. Your paper copy, if you keep one, is yours to update.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete', style: 'destructive', onPress: async () => {
                    if (!begin()) return;
                    const done = await deleteNamesEntry(anchor, identity, entry.id, STORE);
                    finish();
                    if (!done.ok) { setFormError(done.message); return; }
                    setOpened({ ...opened, list: { ...list, entries: list.entries.filter((e) => e.id !== entry.id) } });
                    setMode({ kind: 'list' });
                },
            },
        ]);
    };

    /** Confirmations come back from the node with its ids: read the list again (a read, logged). */
    const afterConfirmation = async () => {
        if (!anchor || !identity || !opened) return;
        const l = await fetchNamesList(anchor, identity);
        if (l.ok) setOpened({ ...opened, list: l.value });
    };

    const confirmAs = async (entry: OpenedEntry, member: CommunityMember) => {
        if (!anchor || !identity) return;
        if (!begin()) return;
        const done = await confirmMember(anchor, identity, member.publicKey, entry.id);
        if (done.ok) await afterConfirmation();
        finish();
        if (!done.ok) { setError(done.message); return; }
        setNotice(done.value.status === 'awaiting_second'
            ? `@${member.callsign} is confirmed by you and waits for a second admin.`
            : `@${member.callsign} is confirmed against ${entry.text?.name ?? 'the entry'}.`);
        setMode({ kind: 'list' });
    };

    const second = async (entry: OpenedEntry) => {
        if (!anchor || !identity || !entry.confirmation) return;
        if (!begin()) return;
        const done = await secondConfirmation(anchor, identity, entry.confirmation.id);
        if (done.ok) await afterConfirmation();
        finish();
        if (!done.ok) setError(done.message);
    };

    const revoke = (entry: OpenedEntry) => {
        if (!anchor || !identity || !entry.confirmation) return;
        const who = entry.confirmation.callsign ? `@${entry.confirmation.callsign}` : 'this member';
        Alert.alert(COPY.removedConfirmTitle, `${who} will no longer be confirmed against this entry. You can confirm them again later.`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Revoke', style: 'destructive', onPress: async () => {
                    if (!begin()) return;
                    const done = await revokeConfirmation(anchor, identity, entry.confirmation!.id);
                    if (done.ok) await afterConfirmation();
                    finish();
                    if (!done.ok) setError(done.message);
                },
            },
        ]);
    };

    const exportPdf = () => {
        if (!anchor || !identity || !opened) return;
        Alert.alert(COPY.exportTitle, COPY.export, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Export', onPress: async () => {
                    if (!begin()) return;
                    try {
                        // Fetched for the export, so the node logs it as one: the PDF is made from this answer.
                        const fresh = await fetchNamesList(anchor, identity, true);
                        if (!fresh.ok) { setError(fresh.message); return; }
                        const html = namesListHtml({ communityName, exportedBy: `@${identity.callsign}`, at: new Date(), entries: openEntries(fresh.value, opened) });
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
                        finish();
                    }
                },
            },
        ]);
    };

    const setTwoAdmins = async (on: boolean) => {
        if (!anchor || !identity || !opened) return;
        if (!begin()) return;
        const done = await setNamesSettings(anchor, identity, { twoAdminsToConfirm: on });
        finish();
        if (!done.ok) { setError(done.message); return; }
        setOpened({ ...opened, state: { ...opened.state, settings: { ...opened.state.settings, twoAdminsToConfirm: done.value.twoAdminsToConfirm } } });
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
                {mode.kind === 'edit' ? (mode.entry ? 'Change an entry' : 'Add a name') : mode.kind === 'pick' ? 'Confirm a member'
                    : mode.kind === 'check' ? COPY.checkEachOtherTitle : COPY.title}
            </Text>
        </View>
    );

    /** Buttons are off while an action runs and while the list (re)loads. */
    const off = busy || loading;
    const BUTTONS = {
        primary: [styles.primaryBtn, styles.primaryBtnText], secondary: [styles.secondaryBtn, styles.secondaryBtnText],
        danger: [styles.dangerBtn, styles.dangerBtnText], small: [styles.smallBtn, styles.smallBtnText],
    } as const;
    const btn = (label: string, onPress: () => void, kind: keyof typeof BUTTONS = 'primary', hint?: string) => (
        <Pressable
            key={label}
            style={[BUTTONS[kind][0], off && styles.disabled]}
            onPress={onPress}
            disabled={off}
            accessibilityRole="button"
            accessibilityState={{ disabled: off, busy: off }}
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

    /** This phone's own key, for another admin to check in person: a QR code and the same key as a code. */
    const mine = identity ? myKeyCheck(identity) : null;
    /** The list key this phone adds names under, when it can: two admins checking each other compare it too. */
    const listKey = opened ? listKeyOf(opened) : null;
    const myKeyCard = mine ? (
        <View style={styles.keyCard}>
            <Text style={styles.keyCardTitle} accessibilityRole="header">{COPY.myKeyTitle}</Text>
            <Text style={styles.keyCardText}>{COPY.myKey}</Text>
            <View style={styles.qrBox}>
                <QRCode value={mine.qr} size={200} quietZone={8} backgroundColor="#ffffff" color="#000000" />
            </View>
            <Text style={styles.codeText} selectable accessibilityLabel={COPY.myCode(mine.code.split('').join(' '))}>{COPY.myCode(mine.code)}</Text>
            {listKey ? (
                <>
                    <Text style={styles.codeText} selectable>{COPY.listKey(listKey.n, listKey.code)}</Text>
                    <Text style={styles.keyCardText}>{COPY.compareListKey}</Text>
                </>
            ) : null}
        </View>
    ) : null;
    const checkSomeone = btn(COPY.checkSomeone, () => startCheck(null), 'secondary');

    let body: React.ReactNode;
    if (loading && !opened) {
        body = <ActivityIndicator color={colors.brand.primary} accessibilityLabel="Opening the names list" />;
    } else if (mode.kind === 'edit') {
        const entry = mode.entry;
        body = (
            <>
                {entry && !entry.text ? (
                    <View style={styles.warn}>
                        <Text style={styles.warnText}>{COPY.lockedEntry(entry.key?.n ?? null, callsignOf(entry.key?.maker ?? ''), entry.holders, entry.notTrusting, entry.checkedHere)}</Text>
                    </View>
                ) : null}
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
        const candidates = confirmableMembers(members, list ?? { current: null, entries: [], confirmations: [] }, identity?.publicKey ?? '', state?.admins.length ?? 0)
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
                        key={m.publicKey} style={[styles.pickRow, off && styles.disabled]} disabled={off}
                        onPress={() => confirmAs(mode.entry, m)} accessibilityRole="button"
                        accessibilityLabel={`Confirm @${m.callsign} as ${mode.entry.text?.name ?? 'this entry'}`}
                    >
                        <Text style={styles.pickName}>@{m.callsign}</Text>
                    </Pressable>
                ))}
            </>
        );
    } else if (mode.kind === 'check') {
        const who = mode.picked?.callsign ?? '';
        body = (
            <>
                <Text style={styles.body}>{COPY.checkIntro(who)}</Text>
                {myKeyCard}
                {scanning && permission && !permission.granted ? <Text style={styles.hint}>{COPY.cameraNeeded}</Text> : null}
                <View style={styles.buttonRow}>
                    {btn(COPY.scanButton, async () => {
                        setCheckError(null);
                        scanLock.current = false;
                        if (!permission?.granted) await requestPermission();
                        setScanning(true);
                    }, 'primary')}
                </View>
                <Text style={styles.label}>{COPY.codeLabel}</Text>
                <TextInput
                    style={styles.input} value={typedCode} onChangeText={setTypedCode} placeholder="0000 0000 0000 0000 0000"
                    placeholderTextColor={colors.text.muted} keyboardType="number-pad" autoCorrect={false} maxLength={30}
                    accessibilityLabel={who ? `The code on @${who}'s phone` : 'The code on the other admin’s phone'}
                />
                {checkError ? <View style={styles.error} accessibilityLiveRegion="assertive"><Text style={styles.errorText}>{checkError}</Text></View> : null}
                <View style={styles.buttonRow}>
                    {btn(COPY.compareButton, () => { void finishCheck(typedCode); }, 'primary')}
                    {btn('Cancel', () => setMode({ kind: 'list' }), 'secondary')}
                </View>
            </>
        );
    } else if (plan && plan.kind !== 'ready' && opened) {
        const words = planWords(opened);
        const maker = plan.kind === 'refused' ? plan.maker ?? null : null;
        body = (
            <>
                {words ? (
                    <View style={styles.warn} accessibilityLiveRegion="polite">
                        <Text style={styles.warnText}>{words}</Text>
                    </View>
                ) : null}
                <View style={styles.buttonRow}>
                    {plan.kind === 'refused' && plan.reason === 'untrusted_maker' && plan.canCheck && maker
                        ? btn(COPY.checkButton(callsignOf(maker)), () => startCheck({ pubkey: maker, callsign: callsignOf(maker) }), 'primary') : null}
                    {plan.kind === 'refused' && plan.reason === 'untrusted_maker' && plan.canStartAgain && opened.pin.chain.length === 0
                        ? btn(COPY.startAgainButton, startAgain, 'danger') : null}
                    {plan.kind === 'wait' && plan.canMakeNew ? btn(COPY.makeNewButton, startAgain, 'danger') : null}
                    {plan.kind === 'refused' && plan.reason === 'rolled_back' ? btn(COPY.putBackButton, putBack, 'primary') : null}
                    {plan.kind === 'refused' && plan.canFollow && (plan.reason === 'different_history' || (plan.reason === 'untrusted_maker' && opened.pin.chain.length > 0))
                        ? btn(COPY.followButton, follow, 'danger') : null}
                    {plan.kind === 'refused' && plan.reason === 'other_community' ? null : checkSomeone}
                </View>
                {myKeyCard}
            </>
        );
    } else if (plan?.kind === 'ready' && state && opened && !stale) {
        const others = state.admins.filter((a) => a.pubkey !== identity?.publicKey);
        body = (
            <>
                {others.map((a) => (
                    <View key={a.pubkey} style={styles.entry}>
                        {trusted(a.pubkey) ? (
                            <>
                                <Text style={styles.entryName}>@{a.callsign}</Text>
                                <View style={styles.buttonRow}>
                                    {btn(COPY.sendAgainButton(a.callsign), () => { void sendAgain(a); }, 'small')}
                                    {btn(COPY.removeKeyButton(a.callsign), () => removeKey(a), 'small')}
                                </View>
                            </>
                        ) : (
                            <>
                                <Text style={styles.entryNote}>{COPY.toCheck(a.callsign)}</Text>
                                {/* Remove works for any admin the server lists, checked here or not (design Addendum 2, ruling 4). */}
                                <View style={styles.buttonRow}>
                                    {btn(COPY.checkButton(a.callsign), () => startCheck({ pubkey: a.pubkey, callsign: a.callsign }), 'small')}
                                    {btn(COPY.removeKeyButton(a.callsign), () => removeKey(a), 'small')}
                                </View>
                            </>
                        )}
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
                                <Text style={styles.lockedText}>{COPY.lockedEntry(e.key?.n ?? null, callsignOf(e.key?.maker ?? ''), e.holders, e.notTrusting, e.checkedHere)}</Text>
                            )}
                            <Text style={styles.entryMeta}>{e.confirmation ? confirmationLine(e.confirmation, at) : 'No member confirmed against it'}</Text>
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
                                value={state.settings.twoAdminsToConfirm} onValueChange={setTwoAdmins} disabled={off}
                                accessibilityLabel={COPY.twoAdminsLabel} accessibilityHint={COPY.twoAdminsHelp}
                            />
                        </View>
                        <Text style={styles.hint}>{COPY.twoAdminsHelp}</Text>
                    </>
                ) : null}
                <Text style={styles.hint}>{COPY.notShownToMembers}</Text>
                <Text style={styles.label}>WHO OPENED OR CHANGED THE LIST</Text>
                {log.length === 0 ? <Text style={styles.hint}>Nothing yet.</Text> : null}
                {log.map((l) => <Text key={l.id} style={styles.logLine}>{logLineText(l, at)}</Text>)}
                <View style={styles.buttonRow}>
                    {checkSomeone}
                    {btn(showMyKey ? COPY.hideMyKey : COPY.showMyKey, () => setShowMyKey(!showMyKey), 'secondary')}
                </View>
                {showMyKey ? myKeyCard : null}
            </>
        );
    } else if (stale && opened) {
        // The list on screen is stale (round 13): say what the pin stands by, and offer to open it again.
        body = (
            <>
                <View style={styles.warn} accessibilityLiveRegion="polite">
                    <Text style={styles.warnText}>{stale.length ? COPY.stillRemoving(stale) : COPY.notReady}</Text>
                </View>
                <View style={styles.buttonRow}>{btn(COPY.openAgainButton, () => { void load(); }, 'primary')}</View>
            </>
        );
    } else if (error) {
        // The server answered nothing usable (a re-keyed account is refused, say): this phone's key can still be shown.
        body = myKeyCard;
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
                {loading && opened ? (
                    <View style={styles.notice} accessibilityLiveRegion="polite">
                        <ActivityIndicator color={colors.brand.primary} accessibilityLabel={COPY.reloading} />
                        <Text style={styles.noticeText}>{COPY.reloading}</Text>
                    </View>
                ) : null}
            </KeyboardAwareScrollView>
            {/* The scanner: full screen, a camera and one button, no text field (so no keyboard provider in a Modal). */}
            <Modal visible={scanning && !!permission?.granted} animationType="slide" onRequestClose={() => setScanning(false)}>
                <SafeAreaView style={styles.scanner} edges={['top', 'left', 'right', 'bottom']}>
                    <Text style={styles.scannerText}>{COPY.checkIntro(mode.kind === 'check' ? mode.picked?.callsign ?? '' : '')}</Text>
                    <View style={styles.camera}>
                        <CameraView style={StyleSheet.absoluteFillObject} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScanned} />
                    </View>
                    <View style={styles.buttonRow}>{btn(COPY.stopScan, () => setScanning(false), 'secondary')}</View>
                </SafeAreaView>
            </Modal>
        </SafeAreaView>
    );
}
