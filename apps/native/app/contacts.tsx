/**
 * Contacts on the phone (scratch/fable-design/DESIGN-private-contacts-fable.md §3.6, §3.9, slice C2): the member's private
 * list, opened from Chat. The same words, order and behaviour as the web's ContactsPage (apps/pwa, slice C4): On BeanPool
 * and Not on BeanPool yet, a contact with Remove, Add by hand, the footer that says where it is kept, and ⋯: Save a copy as
 * a file, Remove everyone, How this is kept. Import (slice C3: the phone's contacts, asked at the tap, or a contacts file;
 * "Choose who to bring"; Done) is components/ContactsImport.tsx; opened as `/contacts?start=import` it starts there.
 * Invite from a row (slice C5): Invite / Invite again opens components/ContactInviteSheet.tsx; the row then reads "invited
 * 12 Nov"; once the community says the code was used, the row asks "Is this Dee?" (Yes links, No forgets the invite); Remove
 * offers "Also cancel the invite I sent" while it is still out here. No name, number or email of a contact reaches any request.
 *
 * A list on this phone that can't be opened says so; a damaged one is set aside and brought back from the copies the
 * member's communities keep, when the member asks (contacts-store.ts `setAsideDamaged`).
 */
import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, DeviceEventEmitter, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, ErrorBoundary, useLocalSearchParams, useNavigation } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
    CONTACTS_LIMITS, cleanContactName, contactInviteAsk, contactInviteAskWords, contactInviteCancelWords, contactInviteNoWords, contactInviteOut,
    contactInviteWords, contactInvitedLine, emptyContactsList, forgetContactInvite, formatCount, linkContactToInvite, newContactId, putContact,
    removeContact, removeEveryContact, t, tn, type Contact, type ContactInviteUsed, type ContactsList, type MyInviteSeen,
} from '@beanpool/core';
import { Alert } from '../utils/keyboard-alert';
import { useIdentity } from './IdentityContext';
import { useTheme, useStyles, type ThemeContextType } from './ThemeContext';
import { ContactsInfoSheet } from '../components/ContactsInfoSheet';
import { DoneScreen, ImportScreen, ReviewScreen, type ImportRead } from '../components/ContactsImport';
import { importChosen } from '../utils/contacts-import';
import { communityLabel, contactsOf, contactsWhereWords, shareContactsFile, useContacts, type ContactsView } from '../utils/use-contacts';
import { checkContactsHere, contactsKeptAt, editContacts, syncContacts } from '../utils/contacts-sync';
import { setAsideDamaged } from '../utils/contacts-store';
import { sameCommunity } from '../utils/push-pins';
import { BLOCKLIST_UPDATED_EVENT, getBlockedUsers, unblockUser } from '../utils/blocklist';
import { createConversationApi } from '../utils/db';
import { switchCommunity } from '../utils/use-communities';
import { signedRequestWords } from '../components/signed-request-lines';
// Loaded when a row's Invite is tapped: the sheet brings the clipboard and the ask, which the list itself never needs.
const ContactInviteSheet = lazy(() => import('../components/ContactInviteSheet').then((m) => ({ default: m.ContactInviteSheet })));
import { cancelContactInvite, readMyInvites } from '../utils/contact-invites';

export { ErrorBoundary };

type Screen =
    | { kind: 'list' } | { kind: 'add' } | { kind: 'contact'; id: string } | { kind: 'import' }
    | { kind: 'review'; read: ImportRead } | { kind: 'done'; added: number; fromPhone: boolean };
type Row = { kind: 'head'; title: string } | { kind: 'contact'; c: Contact };

export default function ContactsScreen() {
    const { identity } = useIdentity();
    const { colors } = useTheme();
    const view = useContacts(identity);
    // Opened from Chat's "Import contacts" (no list yet), it starts on Import, and Back from there goes back to Chat.
    const { start } = useLocalSearchParams<{ start?: string }>();
    const startedOnImport = start === 'import';
    const [screen, setScreen] = useState<Screen>(startedOnImport ? { kind: 'import' } : { kind: 'list' });
    const [info, setInfo] = useState(false);
    const [busy, setBusy] = useState(false);
    // Invite from a row (C5): the contact the sheet is open for, and the member's own invites here (to ask "Is this Dee?").
    const [inviting, setInviting] = useState<Contact | null>(null);
    const [mine, setMine] = useState<MyInviteSeen[] | null>(null);
    const [cancelToo, setCancelToo] = useState(false);
    // The community in use is asked for its copy as the screen opens (design §4.5), at most once a minute.
    useEffect(() => { if (identity) void checkContactsHere(identity); }, [identity?.publicKey]);
    const anchor = view?.anchor ?? null;
    const isHere = (c: string) => !!anchor && sameCommunity(c, anchor);
    const invitedHere = contactsOf(view).some((c) => !!c.invite && isHere(c.invite.community));
    // Read only while some contact holds an invite made here (a first invite made sets it, and so reads).
    const readMine = () => { if (identity && anchor) void readMyInvites(anchor, identity).then((m) => { if (m) setMine(m); }); };
    useEffect(() => { if (invitedHere) readMine(); }, [invitedHere, anchor, identity?.publicKey]);
    // "Add a contact" and a contact's page are this one route's own pages: Android's Back returns to the list from them, as
    // the arrow does, and iOS's swipe from the edge is off while one is open (it would close Contacts, and what was typed).
    const navigation = useNavigation();
    const onPage = screen.kind !== 'list';
    // Android's Back does what the arrow does on each page (Choose who to bring returns to Import).
    const backRef = useRef<() => void>(() => setScreen({ kind: 'list' }));
    useEffect(() => {
        navigation.setOptions({ gestureEnabled: !onPage });
        if (!onPage) return undefined;
        // Only while Contacts is the screen on top: a screen pushed over it (a notification tap, a link) gets its own Back.
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (!navigation.isFocused()) return false;
            backRef.current();
            return true;
        });
        return () => sub.remove();
    }, [navigation, onPage]);
    const styles = useStyles(makeStyles);

    const back = () => {
        if (screen.kind === 'review') setScreen({ kind: 'import' });
        else if (screen.kind === 'list' || (screen.kind === 'import' && startedOnImport && contactsOf(view).length === 0)) router.back();
        else setScreen({ kind: 'list' });
    };
    backRef.current = back;
    const header = (title: string) => (
        <View style={styles.header}>
            <Pressable style={styles.iconBtn} onPress={back} accessibilityRole="button" accessibilityLabel={t('Go back')}>
                <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.body} />
            </Pressable>
            <Text style={styles.title} numberOfLines={2} accessibilityRole="header">{title}</Text>
            <Pressable style={styles.iconBtn} onPress={() => setInfo(true)} accessibilityRole="button" accessibilityLabel={t('About your private contacts')}>
                <MaterialCommunityIcons name="information-outline" size={24} color={colors.text.body} />
            </Pressable>
        </View>
    );
    const shell = (title: string, body: React.ReactNode) => (
        <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
                {header(title)}
                {body}
            </KeyboardAvoidingView>
            <ContactsInfoSheet visible={info} onClose={() => setInfo(false)} />
        </SafeAreaView>
    );
    const change = async (fn: (l: ContactsList) => ContactsList): Promise<boolean> => {
        if (!identity) return false;
        setBusy(true);
        try {
            await editContacts(identity, fn);
            return true;
        } catch {
            Alert.alert(t("Couldn't save your contacts on this phone. Try again."));
            return false;
        } finally {
            setBusy(false);
        }
    };

    if (!view || !identity) return shell(t('Contacts'), <View style={styles.body}><Text style={styles.muted}>{t('Loading...')}</Text></View>);
    if (view.onPhone.kind === 'unreadable') {
        const damaged = view.onPhone.reason === 'damaged';
        return shell(t('Contacts'), (
            <View style={styles.body} testID="contacts-unreadable">
                <Text style={styles.text}>{damaged ? t("The contacts list on this phone can't be opened.") : t('This contacts list was saved by a newer BeanPool. Update BeanPool to open it.')}</Text>
                {damaged && <>
                    <Text style={styles.muted}>{t("Set it aside, and BeanPool brings back the copy your communities keep. If none of them keeps one, you start a new list.")}</Text>
                    <Pressable accessibilityRole="button" style={styles.go} disabled={busy} onPress={async () => {
                        setBusy(true);
                        try {
                            if (await setAsideDamaged(identity)) await syncContacts(identity);
                        } catch {
                            Alert.alert(t("Couldn't save your contacts on this phone. Try again."));
                        } finally {
                            setBusy(false);
                        }
                    }}>
                        <Text style={styles.goText}>{t('Set it aside')}</Text>
                    </Pressable>
                </>}
            </View>
        ));
    }
    const list = view.onPhone.kind === 'list' ? view.onPhone.list : null;
    const people = contactsOf(view);

    if (screen.kind === 'import') {
        return shell(t('Import contacts'), <ImportScreen full={people.length >= CONTACTS_LIMITS.contacts} onBack={back}
            onRead={(read) => setScreen({ kind: 'review', read })} onTypeOne={() => setScreen({ kind: 'add' })} />);
    }
    if (screen.kind === 'review') {
        return shell(t('Choose who to bring'), <ReviewScreen list={list ?? emptyContactsList()} read={screen.read} busy={busy}
            onImport={async (chosen) => {
                if (!identity) return;
                setBusy(true);
                try {
                    // One change for everyone chosen: the list opened once and written once (utils/contacts-import.ts).
                    const added = await importChosen(identity, chosen);
                    setScreen({ kind: 'done', added, fromPhone: screen.read.fromPhone });
                } catch {
                    Alert.alert(t("Couldn't save your contacts on this phone. Try again."));
                } finally {
                    setBusy(false);
                }
            }} />);
    }
    if (screen.kind === 'done') {
        const { off } = contactsKeptAt(view.state, view.onPhone, view.communities);
        const open = view.communities.filter((c) => !off.includes(c));
        return shell(t('Contacts'), <DoneScreen added={screen.added} fromPhone={screen.fromPhone} onDone={() => setScreen({ kind: 'list' })}
            places={open.length ? open.map((c) => communityLabel(view, c)).join(', ') : null} />);
    }

    if (screen.kind === 'add') {
        return shell(t('Add a contact'), <AddByHand busy={busy} full={people.length >= CONTACTS_LIMITS.contacts}
            onAdd={async (c) => { if (await change((l) => putContact(l, { id: newContactId(), links: [], invite: null, ...c }))) setScreen({ kind: 'list' }); }} />);
    }
    if (screen.kind === 'contact') {
        const c = people.find((x) => x.id === screen.id);
        if (!c) return shell(t('Contacts'), null);
        const out = anchor ? contactInviteOut(c, mine ?? [], isHere) : null;
        const remove = async () => {
            // Cancelled first: a cancel that fails keeps the contact, so the member can try again.
            if (out && cancelToo && anchor) {
                const r = await cancelContactInvite(anchor, identity, out);
                if (!r.ok) { Alert.alert(t('Not revoked'), r.message); return; }
            }
            if (await change((l) => removeContact(l, c.id))) { setCancelToo(false); setScreen({ kind: 'list' }); }
        };
        const lines = (label: string, values: string[]) => values.length > 0 && (
            <View style={{ marginBottom: 12 }}>
                <Text style={styles.sub}>{label}</Text>
                {values.map((v) => <Text key={v} style={styles.name} selectable>{v}</Text>)}
            </View>
        );
        return shell(c.name, (
            <View style={styles.body} testID="contact-detail">
                <View style={styles.card}>
                    {lines(t('Numbers'), c.phones)}
                    {lines(t('Emails'), c.emails)}
                    {lines(t('Note'), c.note ? [c.note] : [])}
                    {lines(t('On BeanPool'), c.links.map((l) => [l.callsign && `@${l.callsign}`, communityLabel(view, l.community)].filter(Boolean).join(' · ')))}
                </View>
                {!!out && (
                    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: cancelToo }} style={[styles.menuRow, { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }]}
                        onPress={() => setCancelToo(!cancelToo)} testID="contact-cancel-invite">
                        <MaterialCommunityIcons name={cancelToo ? 'checkbox-marked' : 'checkbox-blank-outline'} size={24} color={colors.text.body} />
                        <Text style={[styles.btnText, { flexShrink: 1 }]}>{contactInviteCancelWords.tick()}</Text>
                    </Pressable>
                )}
                <Pressable accessibilityRole="button" style={styles.btn} disabled={busy} onPress={() => Alert.alert(
                    t('Remove from contacts'),
                    t('Remove {name} from your contacts? Nobody is told. Your chats, and your friendship in {community} if you have one, stay as they are.', { name: c.name, community: view.anchor ? communityLabel(view, view.anchor) : t('your community') }),
                    [{ text: t('Cancel'), style: 'cancel' }, { text: t('Remove'), style: 'destructive', onPress: () => { void remove(); } }],
                )}>
                    <Text style={styles.btnText}>{t('Remove from contacts')}</Text>
                </Pressable>
            </View>
        ));
    }
    // "Is this Dee?": Yes links the contact to who joined, No forgets the invite (and says so). Either way it isn't asked again.
    const answer = async (c: Contact, used: ContactInviteUsed, yes: boolean) => {
        const done = await change((l) => {
            const held = l.contacts.find((x) => x.id === c.id);
            return held ? putContact(l, yes ? linkContactToInvite(held, used) : forgetContactInvite(held)) : l;
        });
        if (done && !yes) Alert.alert(contactInviteNoWords());
    };
    return shell(t('Contacts'), <>
        <ListScreen view={view} list={list} busy={busy} me={identity.publicKey}
            onOpen={(id) => setScreen({ kind: 'contact', id })} onAdd={() => setScreen({ kind: 'add' })} onImport={() => setScreen({ kind: 'import' })} onInfo={() => setInfo(true)}
            onRemoveAll={() => change((l) => removeEveryContact(l))}
            onInvite={anchor ? setInviting : null} ask={(c) => (anchor ? contactInviteAsk(c, mine ?? [], isHere) : null)} onAnswer={(c, used, yes) => void answer(c, used, yes)} />
        {inviting && anchor && (
            <Suspense fallback={null}>
                <ContactInviteSheet contact={inviting} anchor={anchor} community={communityLabel(view, anchor)} identity={identity}
                    onClose={() => setInviting(null)} />
            </Suspense>
        )}
    </>);
}

/** The screen's styles, from the central colour tokens; each part of the screen reads them itself (useStyles), never as a prop. */
const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.surface.app },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border.default },
    iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    title: { flex: 1, fontSize: 18, fontWeight: '800', color: colors.text.heading },
    body: { padding: 16, paddingBottom: 40 },
    muted: { fontSize: 14, lineHeight: 20, color: colors.text.muted, marginBottom: 12 },
    text: { fontSize: 15, lineHeight: 21, color: colors.text.body, marginBottom: 12 },
    btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
    btn: { minHeight: 44, minWidth: 44, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
    btnText: { fontSize: 15, fontWeight: '700', color: colors.text.body },
    go: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
    goText: { fontSize: 15, fontWeight: '800', color: colors.text.inverse },
    card: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 12, marginBottom: 8 },
    menuRow: { minHeight: 44, justifyContent: 'center' },
    field: { minHeight: 44, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 10, paddingHorizontal: 12, fontSize: 15, color: colors.text.body, backgroundColor: colors.surface.card, marginBottom: 12 },
    label: { fontSize: 14, fontWeight: '700', color: colors.text.body, marginBottom: 4 },
    head: { fontSize: 15, fontWeight: '800', color: colors.text.heading, marginTop: 12, marginBottom: 8 },
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 10, marginBottom: 8 },
    // Never squeezed (design §8): when the name's 160 dp and the button don't fit side by side, the button drops under it.
    rowMain: { flexGrow: 1, flexShrink: 0, flexBasis: 160, minHeight: 44, justifyContent: 'center' },
    name: { fontSize: 16, fontWeight: '700', color: colors.text.body },
    sub: { fontSize: 13, color: colors.text.muted, marginTop: 2 },
    blocked: { fontSize: 13, fontWeight: '800', color: colors.feedback.danger.fg },
    danger: { fontSize: 14, color: colors.feedback.danger.fg, marginBottom: 12 },
});

/** "Save a copy as a file (.vcf)", after its warning (design §3.9). */
function saveFile(list: ContactsList | null) {
    if (!list) return;
    Alert.alert(t('Save a copy as a file (.vcf)'), t('This file is not locked. Anyone who has it can read it. Keep it somewhere safe.'), [
        { text: t('Cancel'), style: 'cancel' },
        { text: t('Save'), onPress: () => { shareContactsFile(list).catch(() => Alert.alert(t("Couldn't save the file. Try again."))); } },
    ]);
}

function ListScreen({ view, list, busy, me, onOpen, onAdd, onImport, onInfo, onRemoveAll, onInvite, ask, onAnswer }: {
    view: ContactsView; list: ContactsList | null; busy: boolean; me: string;
    onOpen: (id: string) => void; onAdd: () => void; onImport: () => void; onInfo: () => void; onRemoveAll: () => Promise<boolean>;
    /** Invite from a row (C5); null where the phone is on no community of the member's. */
    onInvite: ((c: Contact) => void) | null;
    ask: (c: Contact) => ContactInviteUsed | null;
    onAnswer: (c: Contact, used: ContactInviteUsed, yes: boolean) => void;
}) {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const [q, setQ] = useState('');
    const [menu, setMenu] = useState(false);
    const [blocked, setBlocked] = useState<string[]>([]);
    const [opening, setOpening] = useState<string | null>(null);
    useEffect(() => {
        const read = () => { void getBlockedUsers().then(setBlocked).catch(() => {}); };
        read();
        const sub = DeviceEventEmitter.addListener(BLOCKLIST_UPDATED_EVENT, read);
        return () => sub.remove();
    }, []);
    const people = contactsOf(view);
    const rows = useMemo<Row[]>(() => {
        const typed = q.trim().toLowerCase();
        const shown = people
            .filter((c) => !typed || [c.name, c.note, ...c.phones, ...c.emails, ...c.links.map((l) => l.callsign)].some((s) => s.toLowerCase().includes(typed)))
            .sort((a, b) => a.name.localeCompare(b.name));
        const linked = shown.filter((c) => c.links.length > 0);
        const notYet = shown.filter((c) => c.links.length === 0);
        return [
            ...(linked.length ? [{ kind: 'head' as const, title: t('On BeanPool') }] : []), ...linked.map((c) => ({ kind: 'contact' as const, c })),
            ...(notYet.length ? [{ kind: 'head' as const, title: t('Not on BeanPool yet') }] : []), ...notYet.map((c) => ({ kind: 'contact' as const, c })),
        ];
    }, [people, q]);
    const here = (community: string) => !!view.anchor && sameCommunity(community, view.anchor);

    const message = async (key: string) => {
        if (opening) return;
        setOpening(key);
        try {
            const conv = await createConversationApi('dm', [me, key], me);
            router.push(`/chat/${conv.id}`);
        } catch (e: any) {
            // As New message says it: the node's words when it refused, else that the phone isn't connected.
            const isOffline = !e?.message || /off-grid|network|fetch failed|failed to fetch|offline|timeout|abort/i.test(e.message);
            Alert.alert(t('Error'), isOffline ? t('Connect to your community to start a chat.') : signedRequestWords(e.message));
        } finally {
            setOpening(null);
        }
    };
    const action = (c: Contact) => {
        const link = c.links.find((l) => here(l.community)) ?? c.links[0];
        if (!link) {
            if (!onInvite) return null;
            return (
                <Pressable accessibilityRole="button" style={styles.btn} disabled={busy} onPress={() => onInvite(c)}>
                    <Text style={styles.btnText}>{c.invite ? contactInviteWords.again() : contactInviteWords.invite()}</Text>
                </Pressable>
            );
        }
        if (!here(link.community)) {
            const community = communityLabel(view, link.community);
            return (
                <Pressable accessibilityRole="button" style={styles.btn} onPress={() => Alert.alert(
                    t('Open {community} ›', { community }),
                    t('{name} is in {community}. Switch to {community} to message them?', { name: c.name, community }),
                    // A switch that fails says so, in the words the Communities list uses (useCommunities.switchTo).
                    [{ text: t('Cancel'), style: 'cancel' }, { text: t('Switch'), onPress: () => {
                        switchCommunity(link.community).catch((e) => Alert.alert(t("Couldn't switch community"), e?.message || t('Please try again.')));
                    } }],
                )}>
                    <Text style={styles.btnText}>{t('Open {community} ›', { community })}</Text>
                </Pressable>
            );
        }
        if (blocked.includes(link.key)) {
            return (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={styles.blocked}>{t('Blocked')}</Text>
                    <Pressable accessibilityRole="button" style={styles.btn} onPress={() => { void unblockUser(link.key); }}>
                        <Text style={styles.btnText}>{t('Unblock')}</Text>
                    </Pressable>
                </View>
            );
        }
        return (
            <Pressable accessibilityRole="button" style={styles.go} disabled={opening !== null} onPress={() => void message(link.key)}>
                <Text style={styles.goText}>{t('Message', undefined, 'button: write to')}</Text>
            </Pressable>
        );
    };
    const subLine = (c: Contact) => {
        const link = c.links.find((l) => here(l.community)) ?? c.links[0];
        if (link) return [link.callsign && `@${link.callsign}`, communityLabel(view, link.community)].filter(Boolean).join(' · ');
        return contactInvitedLine(c) ?? c.phones[0] ?? c.emails[0] ?? '';
    };
    const askBlock = (c: Contact) => {
        const used = ask(c);
        if (!used) return null;
        const words = contactInviteAskWords(c.name, view.anchor ? communityLabel(view, view.anchor) : '', used.callsign);
        return (
            <View style={{ flexBasis: '100%', gap: 8 }} testID="contact-invite-used">
                <Text style={styles.text}>{words.question}</Text>
                <View style={styles.btnRow}>
                    <Pressable accessibilityRole="button" style={styles.go} disabled={busy} onPress={() => onAnswer(c, used, true)}><Text style={styles.goText}>{words.yes}</Text></Pressable>
                    <Pressable accessibilityRole="button" style={styles.btn} disabled={busy} onPress={() => onAnswer(c, used, false)}><Text style={styles.btnText}>{words.no}</Text></Pressable>
                </View>
            </View>
        );
    };
    const top = (
        <>
            <Text style={styles.muted}>{t("Private to you. Locked with your account's key.")}</Text>
            <View style={styles.btnRow}>
                <Pressable accessibilityRole="button" style={styles.btn} onPress={onAdd}><Text style={styles.btnText}>{t('＋ Add')}</Text></Pressable>
                <Pressable accessibilityRole="button" style={styles.btn} onPress={onImport}><Text style={styles.btnText}>{t('Import')}</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={t('More')} accessibilityState={{ expanded: menu }} style={styles.btn} onPress={() => setMenu(!menu)}>
                    <MaterialCommunityIcons name="dots-horizontal" size={22} color={colors.text.body} />
                </Pressable>
            </View>
            {menu && (
                <View style={styles.card} testID="contacts-menu">
                    <Pressable accessibilityRole="button" style={styles.menuRow} onPress={() => { setMenu(false); saveFile(list); }}><Text style={styles.btnText}>{t('Save a copy as a file (.vcf)')}</Text></Pressable>
                    {people.length > 0 && (
                        <Pressable accessibilityRole="button" style={styles.menuRow} disabled={busy} onPress={() => {
                            setMenu(false);
                            Alert.alert(t('Remove everyone'), tn(people.length, "Remove your {n} contact from every device and every community's copy? You can't undo this. Save a copy as a file first if you might want them.", "Remove all {n} contacts from every device and every community's copy? You can't undo this. Save a copy as a file first if you might want them."), [
                                { text: t('Save a file'), onPress: () => saveFile(list) },
                                { text: t('Cancel'), style: 'cancel' },
                                { text: t('Remove everyone'), style: 'destructive', onPress: () => { void onRemoveAll(); } },
                            ]);
                        }}><Text style={styles.btnText}>{t('Remove everyone')}</Text></Pressable>
                    )}
                    <Pressable accessibilityRole="button" style={styles.menuRow} onPress={() => { setMenu(false); onInfo(); }}><Text style={styles.btnText}>{t('How this is kept')}</Text></Pressable>
                </View>
            )}
            {people.length === 0 ? (
                <View style={styles.card}>
                    <Text style={styles.text}>{t('No contacts yet. Import them from this phone or a contacts file, or add someone by hand.')}</Text>
                    <View style={styles.btnRow}>
                        <Pressable accessibilityRole="button" style={styles.go} onPress={onImport}><Text style={styles.goText}>{t('Import contacts')}</Text></Pressable>
                        <Pressable accessibilityRole="button" style={styles.btn} onPress={onAdd}><Text style={styles.btnText}>{t('＋ Add')}</Text></Pressable>
                    </View>
                </View>
            ) : (
                <TextInput value={q} onChangeText={setQ} placeholder={t('Search')} placeholderTextColor={colors.text.muted} accessibilityLabel={t('Search your contacts')} style={styles.field} />
            )}
        </>
    );
    return (
        <FlatList
            data={rows}
            keyExtractor={(r) => (r.kind === 'head' ? `h:${r.title}` : r.c.id)}
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={15}
            maxToRenderPerBatch={20}
            windowSize={7}
            ListHeaderComponent={top}
            ListEmptyComponent={people.length > 0 ? <Text style={styles.muted}>{t('Nobody in your contacts matches that.')}</Text> : null}
            ListFooterComponent={people.length > 0 ? <Text style={[styles.muted, { marginTop: 12 }]} testID="contacts-where">{contactsWhereWords(view)}</Text> : null}
            renderItem={({ item }) => item.kind === 'head' ? <Text style={styles.head} accessibilityRole="header">{item.title}</Text> : (
                <View style={styles.row} testID="contact-row">
                    <Pressable accessibilityRole="button" style={styles.rowMain} onPress={() => onOpen(item.c.id)}>
                        <Text style={styles.name} numberOfLines={1}>{item.c.name}</Text>
                        {!!subLine(item.c) && <Text style={styles.sub} numberOfLines={1}>{subLine(item.c)}</Text>}
                    </Pressable>
                    {action(item.c)}
                    {askBlock(item.c)}
                </View>
            )}
        />
    );
}

function AddByHand({ busy, full, onAdd }: { busy: boolean; full: boolean; onAdd: (c: { name: string; phones: string[]; emails: string[]; note: string }) => void }) {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [email, setEmail] = useState('');
    const [note, setNote] = useState('');
    const [missing, setMissing] = useState(false);
    const field = (label: string, value: string, set: (v: string) => void, max: number, more: Partial<React.ComponentProps<typeof TextInput>> = {}) => (
        <>
            <Text style={styles.label}>{label}</Text>
            <TextInput value={value} onChangeText={set} maxLength={max} accessibilityLabel={label} placeholderTextColor={colors.text.muted} style={styles.field} autoCorrect={false} {...more} />
        </>
    );
    return (
        <FlatList data={[]} renderItem={null} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body} ListHeaderComponent={<>
            {field(t('Name'), name, setName, CONTACTS_LIMITS.nameChars)}
            {field(t('Phone number'), phone, setPhone, CONTACTS_LIMITS.phoneChars, { keyboardType: 'phone-pad' })}
            {field(t('Email'), email, setEmail, CONTACTS_LIMITS.emailChars, { keyboardType: 'email-address', autoCapitalize: 'none' })}
            {field(t('Note'), note, setNote, CONTACTS_LIMITS.noteChars, { multiline: true, style: [styles.field, { minHeight: 88, paddingTop: 10, textAlignVertical: 'top' }] })}
            {missing && <Text style={styles.danger} accessibilityRole="alert">{t('Type a name, a number or an email.')}</Text>}
            {full && <Text style={styles.danger} accessibilityRole="alert">{t('You can keep up to {max} contacts.', { max: formatCount(CONTACTS_LIMITS.contacts) })}</Text>}
            <Pressable accessibilityRole="button" style={styles.go} disabled={busy || full} onPress={() => {
                if (!cleanContactName(name) && !/\d/.test(phone) && !email.includes('@')) { setMissing(true); return; }
                onAdd({ name, phones: phone.trim() ? [phone] : [], emails: email.trim() ? [email.trim()] : [], note });
            }}>
                <Text style={styles.goText}>{t('Add')}</Text>
            </Pressable>
        </>} />
    );
}
