/**
 * Contacts on the web (scratch/fable-design/DESIGN-private-contacts-fable.md §3.5, §3.6, §3.9, slice C4): the member's
 * private list, opened from Chat. The list (On BeanPool, Not on BeanPool yet, the footer that says where it is kept), a
 * contact with Remove, Add by hand, Import (the three export cards, a contacts file picked or dropped, Android Chrome's
 * own contact chooser where the browser has one), Choose who to bring, Done, and the ⋯ menu: Save a copy as a file,
 * Remove everyone, How this is kept.
 *
 * Nothing is read into the list, and nothing leaves this browser, before Import (§3.4); a file is read here, never
 * uploaded. The list is kept and saved by lib/contacts-store.ts. Invites from a row are slice C5; "Add people I've
 * chatted with and my friends" is C6; the guide page behind "More in the guide" is C7.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import {
    CONTACTS_FILE_MAX_BYTES, CONTACTS_FILE_WORDS, CONTACTS_LIMITS, cleanContactName, contactAlreadyInList, contactsFromCandidates,
    emptyContactsList, formatCount, mergeContactsLists, newContactId, putContact, readContactsFile, removeContact, removeEveryContact,
    t, timeAgo, tn, type Contact, type ContactCandidate, type ContactsList,
} from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import { nodeAddress } from '../lib/api';
import { isUserBlocked, unblockUser } from '../lib/blocklist';
import { isPhoneBrowser } from '../lib/global-entry';
import { changeContacts, contactsHost as hostOf, ContactsNewerError, openContacts, saveContactsFile as saveFile, useContacts, type ContactsWhere } from '../lib/contacts-store';
import { ContactsInfo } from '../components/ContactsInfo';
import { BoldWords } from '../components/BoldWords';
import { UsePhoneAppCard, isUsePhoneAppDismissed } from '../components/UsePhoneAppCard';

type View =
    | { kind: 'list' } | { kind: 'import' } | { kind: 'add' } | { kind: 'contact'; id: string } | { kind: 'done'; added: number; fromPhone: boolean }
    | { kind: 'review'; candidates: ContactCandidate[]; more: number; cutOff: boolean; fromPhone: boolean };

const card: CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: '12px', padding: '0.75rem 1rem', marginBottom: '0.5rem' };
const btn: CSSProperties = { minHeight: '44px', padding: '0.5rem 0.9rem', borderRadius: '10px', border: '1px solid var(--border-input)', background: 'var(--bg-hover)', color: 'var(--text-primary)', font: 'inherit', fontSize: '0.9rem', cursor: 'pointer' };
const go = 'bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on';
const goStyle: CSSProperties = { ...btn, border: 'none', background: undefined, color: undefined, fontWeight: 700 };
const muted: CSSProperties = { color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0 0 0.75rem', lineHeight: 1.45 };
const field: CSSProperties = { width: '100%', minHeight: '44px', padding: '0.5rem 0.75rem', borderRadius: '10px', border: '1px solid var(--border-input)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', font: 'inherit', marginBottom: '0.75rem', boxSizing: 'border-box' };
const PAGE = 300;

/** The footer's sentence (design §3.6): the truth about where the copies are. */
export function contactsWhereWords(where: ContactsWhere, keptAt: string | null, now = Date.now()): string {
    const places = hostOf();
    if (where === 'device-only') return t('Kept on this device only. Save a copy as a file to keep it safe.');
    if (where === 'retry') return t('Kept on this device only. BeanPool will try your communities again.');
    if (where === 'soon') return t('Kept on this device. Your latest changes go to {places} within 15 minutes.', { places });
    return keptAt
        ? t('Kept on this device and at: {places} · saved {when}', { places, when: timeAgo(Math.max(0, now - Date.parse(keptAt))) })
        : t('Kept on this device and at: {places}', { places });
}

/** The browser's own contact chooser (Android Chrome), where it has one: the member ticks who to share, no permission. */
type ContactsManager = { select(props: string[], opts: { multiple: boolean }): Promise<Array<{ name?: string[]; email?: string[]; tel?: string[] }>> };
function browserChooser(): ContactsManager | null {
    if (typeof window === 'undefined' || !('ContactsManager' in window)) return null;
    const c = (navigator as Navigator & { contacts?: ContactsManager }).contacts;
    return c && typeof c.select === 'function' ? c : null;
}

function subLine(c: Pick<ContactCandidate, 'phones' | 'emails'>): string {
    return c.phones[0] ?? c.emails[0] ?? '';
}

export function ContactsPage({ identity, start = 'list', onBack, onMessage }: {
    identity: BeanPoolIdentity;
    start?: 'list' | 'import';
    onBack: () => void;
    onMessage: (pubkey: string) => void;
}): ReactNode {
    const snap = useContacts();
    const [view, setView] = useState<View>(start === 'import' ? { kind: 'import' } : { kind: 'list' });
    const [info, setInfo] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => { void openContacts(identity, true); }, [identity]);

    const list = snap.key === identity.publicKey.toLowerCase() ? snap.list : null;
    const change = async (fn: (l: ContactsList) => ContactsList): Promise<boolean> => {
        setBusy(true);
        setError(null);
        try {
            await changeContacts(identity, fn);
            return true;
        } catch (e) {
            setError(e instanceof ContactsNewerError ? t('This contacts list was saved by a newer BeanPool. Reload the page to update it.') : t("Couldn't save your contacts in this browser. Try again."));
            return false;
        } finally {
            setBusy(false);
        }
    };
    const back = (to: View = { kind: 'list' }) => { setError(null); setView(to); };

    const header = (title: string, onTap: () => void) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <button type="button" onClick={onTap} style={{ ...btn, border: 'none', background: 'none', color: 'var(--bp-accent-fill)', padding: '0 0.25rem' }}>{t('← Back')}</button>
            <h2 style={{ fontSize: '1.2rem', margin: 0, flex: 1, minWidth: 0 }}>{title}</h2>
            <button type="button" onClick={() => setInfo(true)} aria-label={t('About your private contacts')} style={{ ...btn, minWidth: '44px', borderRadius: '22px' }}>ⓘ</button>
        </div>
    );
    const alert = error && <p role="alert" style={{ ...muted, color: 'var(--danger)' }}>{error}</p>;
    const shell = (body: ReactNode) => (
        <div className="p-4 max-w-xl mx-auto w-full" data-testid="contacts-page">
            {body}
            {info && <ContactsInfo onClose={() => setInfo(false)} />}
        </div>
    );

    if (snap.newer) return shell(<>{header(t('Contacts'), onBack)}<p role="alert" style={muted}>{t('This contacts list was saved by a newer BeanPool. Reload the page to update it.')}</p></>);
    if (!list) return shell(<>{header(t('Contacts'), onBack)}<p style={muted}>{snap.phase === 'failed' ? t("Couldn't open your contacts in this browser. Reload the page.") : t('Loading...')}</p></>);

    // Opened as Import with nothing in the list yet, Back goes back to Chat.
    if (view.kind === 'import') return shell(<ImportView list={list} onBack={list.contacts.length || start !== 'import' ? () => back() : onBack} header={header} publicKey={identity.publicKey}
        onRead={(r) => setView({ kind: 'review', ...r })} onTypeOne={() => back({ kind: 'add' })} />);
    if (view.kind === 'review') return shell(<ReviewView list={list} view={view} header={header} busy={busy} alert={alert} onBack={() => back({ kind: 'import' })}
        onImport={async (chosen) => { if (await change((l) => mergeContactsLists(l, { ...emptyContactsList(), contacts: contactsFromCandidates(chosen) }))) setView({ kind: 'done', added: chosen.length, fromPhone: view.fromPhone }); }} />);
    if (view.kind === 'done') {
        const places = hostOf();
        return shell(<>
            {header(t('Contacts'), () => back())}
            <p data-testid="contacts-done" style={{ fontSize: '1rem', fontWeight: 600, lineHeight: 1.45 }}>
                {snap.where === 'device-only'
                    ? tn(view.added, '{n} contact added.', '{n} contacts added.')
                    : tn(view.added, "{n} contact added. It's locked with your key and will be kept at: {places}.", "{n} contacts added. They're locked with your key and will be kept at: {places}.", { places })}
            </p>
            {snap.where === 'device-only' && <p style={muted}>{contactsWhereWords('device-only', null)}</p>}
            {view.fromPhone && <p style={muted}>{t("BeanPool read your phone's contacts once, just now. It doesn't watch them. To bring new ones later, tap Import again.")}</p>}
            <button type="button" className={go} style={goStyle} onClick={() => back()}>{t('Done')}</button>
        </>);
    }
    if (view.kind === 'add') return shell(<AddView header={header} busy={busy} alert={alert} full={list.contacts.length >= CONTACTS_LIMITS.contacts}
        onBack={() => back()} onAdd={async (c) => { if (await change((l) => putContact(l, { id: newContactId(), links: [], invite: null, ...c }))) back(); }} />);
    if (view.kind === 'contact') {
        const c = list.contacts.find((x) => x.id === view.id);
        if (!c) return shell(<>{header(t('Contacts'), () => back())}</>);
        return shell(<ContactView contact={c} header={header} busy={busy} alert={alert} onBack={() => back()}
            onRemove={async () => { if (await change((l) => removeContact(l, c.id))) back(); }} />);
    }
    return shell(<ListView list={list} where={snap.where} keptAt={snap.keptAt} header={header} onBack={onBack} busy={busy} alert={alert}
        onOpen={(id) => back({ kind: 'contact', id })} onAdd={() => back({ kind: 'add' })} onImport={() => back({ kind: 'import' })} onInfo={() => setInfo(true)}
        onMessage={onMessage} onRemoveAll={() => change((l) => removeEveryContact(l))} />);
}

type Header = (title: string, onTap: () => void) => ReactNode;

function ListView({ list, where, keptAt, header, onBack, onOpen, onAdd, onImport, onInfo, onMessage, onRemoveAll, busy, alert }: {
    list: ContactsList; where: ContactsWhere; keptAt: string | null; header: Header; onBack: () => void; busy: boolean; alert: ReactNode;
    onOpen: (id: string) => void; onAdd: () => void; onImport: () => void; onInfo: () => void; onMessage: (pubkey: string) => void; onRemoveAll: () => Promise<boolean>;
}) {
    const [q, setQ] = useState('');
    const [menu, setMenu] = useState<null | 'menu' | 'file' | 'removeAll'>(null);
    const [, setBlockTick] = useState(0);
    const here = nodeAddress();
    const typed = q.trim().toLowerCase();
    const shown = list.contacts
        .filter((c) => !typed || [c.name, c.note, ...c.phones, ...c.emails, ...c.links.map((l) => l.callsign)].some((s) => s.toLowerCase().includes(typed)))
        .sort((a, b) => a.name.localeCompare(b.name));
    const linked = shown.filter((c) => c.links.length > 0);
    const notYet = shown.filter((c) => c.links.length === 0);
    const row = (c: Contact, action: ReactNode, sub: string) => (
        <div key={c.id} data-testid="contact-row" style={{ ...card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
            <button type="button" onClick={() => onOpen(c.id)} style={{ flex: '1 1 10rem', minWidth: 0, minHeight: '44px', textAlign: 'left', background: 'none', border: 'none', padding: 0, color: 'var(--text-primary)', font: 'inherit', cursor: 'pointer' }}>
                <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{c.name}</span>
                {sub && <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.85rem', overflowWrap: 'anywhere' }}>{sub}</span>}
            </button>
            {action}
        </div>
    );
    const memberAction = (c: Contact) => {
        const link = c.links.find((l) => l.community === here) ?? c.links[0];
        if (link.community !== here) {
            return <a href={link.community} target="_blank" rel="noopener noreferrer" style={{ ...btn, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>{t('Open {community} ›', { community: hostOf(link.community) })}</a>;
        }
        if (isUserBlocked(link.key)) {
            return (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--danger)' }}>{t('Blocked')}</span>
                    <button type="button" style={btn} onClick={async () => { await unblockUser(link.key); setBlockTick((n) => n + 1); }}>{t('Unblock')}</button>
                </span>
            );
        }
        return <button type="button" className={go} style={goStyle} onClick={() => onMessage(link.key)}>{t('Message', undefined, 'button: write to')}</button>;
    };
    return (
        <>
            {header(t('Contacts'), onBack)}
            <p style={muted}>{t("Private to you. Locked with your account's key.")}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <button type="button" style={btn} onClick={onAdd}>{t('＋ Add')}</button>
                <button type="button" style={btn} onClick={onImport}>{t('Import')}</button>
                <button type="button" style={{ ...btn, minWidth: '44px' }} aria-expanded={menu !== null} aria-label={t('More')} onClick={() => setMenu(menu ? null : 'menu')}>⋯</button>
            </div>
            {menu === 'menu' && (
                <div data-testid="contacts-menu" style={{ ...card, display: 'grid', gap: '0.25rem' }}>
                    <button type="button" style={{ ...btn, textAlign: 'left' }} onClick={() => setMenu('file')}>{t('Save a copy as a file (.vcf)')}</button>
                    <button type="button" style={{ ...btn, textAlign: 'left' }} disabled={list.contacts.length === 0} onClick={() => setMenu('removeAll')}>{t('Remove everyone')}</button>
                    <button type="button" style={{ ...btn, textAlign: 'left' }} onClick={() => { setMenu(null); onInfo(); }}>{t('How this is kept')}</button>
                </div>
            )}
            {menu === 'file' && (
                <div role="group" style={card}>
                    <p style={{ margin: '0 0 0.75rem' }}>{t('This file is not locked. Anyone who has it can read it. Keep it somewhere safe.')}</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <button type="button" className={go} style={goStyle} onClick={() => { saveFile(list); setMenu(null); }}>{t('Save')}</button>
                        <button type="button" style={btn} onClick={() => setMenu(null)}>{t('Cancel')}</button>
                    </div>
                </div>
            )}
            {menu === 'removeAll' && (
                <div role="group" style={card}>
                    <p style={{ margin: '0 0 0.75rem' }}>{tn(list.contacts.length, "Remove your {n} contact from every device and every community's copy? You can't undo this. Save a copy as a file first if you might want them.", "Remove all {n} contacts from every device and every community's copy? You can't undo this. Save a copy as a file first if you might want them.")}</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <button type="button" style={btn} onClick={() => saveFile(list)}>{t('Save a file')}</button>
                        <button type="button" className="bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on" style={goStyle} disabled={busy} onClick={async () => { if (await onRemoveAll()) setMenu(null); }}>{t('Remove everyone')}</button>
                        <button type="button" style={btn} onClick={() => setMenu(null)}>{t('Cancel')}</button>
                    </div>
                </div>
            )}
            {alert}
            {list.contacts.length === 0 ? (
                <div style={card}>
                    <p style={{ margin: '0 0 0.75rem' }}>{t('No contacts yet. Import them from a contacts file, or add someone by hand.')}</p>
                    <button type="button" className={go} style={goStyle} onClick={onImport}>{t('Import contacts')}</button>
                </div>
            ) : (
                <>
                    <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search')} aria-label={t('Search your contacts')} style={field} />
                    {linked.length > 0 && <h3 style={{ fontSize: '0.95rem', margin: '0.5rem 0' }}>{t('On BeanPool')}</h3>}
                    {linked.map((c) => {
                        const link = c.links.find((l) => l.community === here) ?? c.links[0];
                        return row(c, memberAction(c), [link.callsign && `@${link.callsign}`, hostOf(link.community)].filter(Boolean).join(' · '));
                    })}
                    {notYet.length > 0 && <h3 style={{ fontSize: '0.95rem', margin: '0.75rem 0 0.5rem' }}>{t('Not on BeanPool yet')}</h3>}
                    {notYet.map((c) => row(c, null, subLine(c)))}
                    {shown.length === 0 && <p style={muted}>{t('Nobody in your contacts matches that.')}</p>}
                </>
            )}
            {list.contacts.length > 0 && <p data-testid="contacts-where" style={{ ...muted, marginTop: '1rem' }}>{contactsWhereWords(where, keptAt)}</p>}
        </>
    );
}

function ContactView({ contact, header, onBack, onRemove, busy, alert }: { contact: Contact; header: Header; onBack: () => void; onRemove: () => void; busy: boolean; alert: ReactNode }) {
    const [asking, setAsking] = useState(false);
    const lines = (label: string, values: string[]) => values.length > 0 && (
        <div style={{ marginBottom: '0.75rem' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{label}</div>
            {values.map((v) => <div key={v} style={{ overflowWrap: 'anywhere' }}>{v}</div>)}
        </div>
    );
    return (
        <>
            {header(contact.name, onBack)}
            <div style={card} data-testid="contact-detail">
                {lines(t('Numbers'), contact.phones)}
                {lines(t('Emails'), contact.emails)}
                {lines(t('Note'), contact.note ? [contact.note] : [])}
                {lines(t('On BeanPool'), contact.links.map((l) => [l.callsign && `@${l.callsign}`, hostOf(l.community)].filter(Boolean).join(' · ')))}
            </div>
            {alert}
            {asking ? (
                <div role="group" style={card}>
                    <p style={{ margin: '0 0 0.75rem' }}>{t('Remove {name} from your contacts? Nobody is told. Your chats, and your friendship in {community} if you have one, stay as they are.', { name: contact.name, community: hostOf() })}</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <button type="button" className="bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on" style={goStyle} disabled={busy} onClick={onRemove}>{t('Remove')}</button>
                        <button type="button" style={btn} onClick={() => setAsking(false)}>{t('Cancel')}</button>
                    </div>
                </div>
            ) : (
                <button type="button" style={btn} onClick={() => setAsking(true)}>{t('Remove from contacts')}</button>
            )}
        </>
    );
}

function AddView({ header, onBack, onAdd, busy, alert, full }: { header: Header; onBack: () => void; onAdd: (c: { name: string; phones: string[]; emails: string[]; note: string }) => void; busy: boolean; alert: ReactNode; full: boolean }) {
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [email, setEmail] = useState('');
    const [note, setNote] = useState('');
    const [missing, setMissing] = useState(false);
    const label: CSSProperties = { display: 'block', fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.3rem' };
    return (
        <>
            {header(t('Add a contact'), onBack)}
            <form onSubmit={(e) => {
                e.preventDefault();
                if (!cleanContactName(name) && !/\d/.test(phone) && !email.includes('@')) { setMissing(true); return; }
                onAdd({ name, phones: phone.trim() ? [phone] : [], emails: email.trim() ? [email.trim()] : [], note });
            }}>
                <label htmlFor="contact-name" style={label}>{t('Name')}</label>
                <input id="contact-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={CONTACTS_LIMITS.nameChars} style={field} autoComplete="off" />
                <label htmlFor="contact-phone" style={label}>{t('Phone number')}</label>
                <input id="contact-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={CONTACTS_LIMITS.phoneChars} style={field} autoComplete="off" />
                <label htmlFor="contact-email" style={label}>{t('Email')}</label>
                <input id="contact-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={CONTACTS_LIMITS.emailChars} style={field} autoComplete="off" />
                <label htmlFor="contact-note" style={label}>{t('Note')}</label>
                <textarea id="contact-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={CONTACTS_LIMITS.noteChars} rows={3} style={{ ...field, minHeight: '4.5rem' }} />
                {missing && <p role="alert" style={{ ...muted, color: 'var(--danger)' }}>{t('Type a name, a number or an email.')}</p>}
                {full && <p role="alert" style={{ ...muted, color: 'var(--danger)' }}>{t('You can keep up to {max} contacts.', { max: formatCount(CONTACTS_LIMITS.contacts) })}</p>}
                {alert}
                <button type="submit" className={go} style={goStyle} disabled={busy || full}>{t('Add')}</button>
            </form>
        </>
    );
}

function ImportView({ list, header, onBack, onRead, onTypeOne, publicKey }: {
    list: ContactsList; header: Header; onBack: () => void; publicKey: string;
    onRead: (r: { candidates: ContactCandidate[]; more: number; cutOff: boolean; fromPhone: boolean }) => void; onTypeOne: () => void;
}) {
    const [problem, setProblem] = useState<string | null>(null);
    const [over, setOver] = useState(false);
    const [phoneCard, setPhoneCard] = useState(() => isPhoneBrowser() && !isUsePhoneAppDismissed(publicKey));
    const fileInput = useRef<HTMLInputElement>(null);
    const chooser = browserChooser();
    const read = async (file: File | undefined) => {
        if (!file) return;
        setProblem(null);
        if (file.size > CONTACTS_FILE_MAX_BYTES) { setProblem(t(CONTACTS_FILE_WORDS.tooBig)); return; }
        const r = readContactsFile(new Uint8Array(await file.arrayBuffer()));
        if (!r.ok) { setProblem(t(r.words)); return; }
        if (r.candidates.length === 0) { setProblem(t(CONTACTS_FILE_WORDS.notVcard)); return; }
        onRead({ candidates: r.candidates, more: r.more, cutOff: r.cutOff, fromPhone: false });
    };
    const choose = async () => {
        setProblem(null);
        try {
            const picked = await chooser!.select(['name', 'tel', 'email'], { multiple: true });
            const candidates = picked
                .map((p) => ({ name: cleanContactName(p.name?.[0]), phones: (p.tel ?? []).slice(0, CONTACTS_LIMITS.phones), emails: (p.email ?? []).slice(0, CONTACTS_LIMITS.emails), note: '' }))
                .filter((c) => c.name || c.phones.length || c.emails.length);
            if (candidates.length) onRead({ candidates, more: 0, cutOff: false, fromPhone: true });
        } catch {
            // Closed without choosing: nothing to say.
        }
    };
    const cards: Array<[string, string]> = [
        [t('Android phone'), t('1. Open the Contacts app. 2. Look for **Export**: it is often under Organise, under Manage contacts, or in the ⋮ menu. 3. Save the file. It ends in .vcf.')],
        [t('iPhone'), t('1. Open Contacts and tap **Lists**. 2. Press and hold **All Contacts**, then tap **Export**. 3. Save it to Files. It ends in .vcf.')],
        [t('Google Contacts on a computer'), t('1. Open contacts.google.com. 2. Click **Export**. 3. Choose **vCard** and click Export.')],
    ];
    const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); void read(e.dataTransfer.files?.[0]); };
    return (
        <>
            {header(t('Import contacts'), onBack)}
            <p style={muted}>{t("A web page can't read your phone's contacts. Two steps: export them as a file, then bring the file here. WhatsApp has no export of its own: it uses your phone's contacts, so this file has them.")}</p>
            {chooser && (
                <div style={card}>
                    <button type="button" className={go} style={goStyle} onClick={() => void choose()}>{t("Choose from this phone's contacts")}</button>
                    <p style={{ ...muted, margin: '0.5rem 0 0' }}>{t('Your browser shows your contacts and you tick who to bring.')}</p>
                </div>
            )}
            <h3 style={{ fontSize: '1rem', margin: '1rem 0 0.5rem' }}>{t('1. Export your contacts as a file')}</h3>
            {cards.map(([title, steps]) => (
                <details key={title} style={card}>
                    <summary style={{ cursor: 'pointer', fontWeight: 600, minHeight: '32px' }}>{title}</summary>
                    <p style={{ margin: '0.5rem 0 0', lineHeight: 1.5 }}><BoldWords text={steps} /></p>
                </details>
            ))}
            <h3 style={{ fontSize: '1rem', margin: '1rem 0 0.5rem' }}>{t('2. Bring the file here')}</h3>
            <div data-testid="contacts-drop" onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
                style={{ ...card, borderStyle: 'dashed', borderColor: over ? 'var(--bp-accent-fill)' : 'var(--border-primary)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
                <button type="button" style={btn} onClick={() => fileInput.current?.click()}>{t('Choose a contacts file')}</button>
                <span style={{ color: 'var(--text-muted)' }}>{t('or drop it here.')}</span>
                <input ref={fileInput} type="file" accept=".vcf,.vcard,text/vcard,text/x-vcard" hidden data-testid="contacts-file" onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
            <p style={muted}>{t("The file is read in this browser. It isn't uploaded.")}</p>
            {problem && <p role="alert" style={{ ...muted, color: 'var(--danger)' }}>{problem}</p>}
            {list.contacts.length < CONTACTS_LIMITS.contacts && (
                <button type="button" onClick={onTypeOne} style={{ ...btn, border: 'none', background: 'none', color: 'var(--bp-accent-fill)', padding: 0 }}>{t('Or: Type one in ›')}</button>
            )}
            {phoneCard && (
                <div style={{ marginTop: '1rem' }}>
                    <UsePhoneAppCard publicKey={publicKey} onDismiss={() => setPhoneCard(false)} phoneLater={[t("Have the BeanPool app? There it's one tap.")]} />
                </div>
            )}
        </>
    );
}

function ReviewView({ list, view, header, onBack, onImport, busy, alert }: {
    list: ContactsList; view: Extract<View, { kind: 'review' }>; header: Header; onBack: () => void; onImport: (chosen: ContactCandidate[]) => void; busy: boolean; alert: ReactNode;
}) {
    const rows = useMemo(() => view.candidates.map((c, i) => ({
        i, c, name: cleanContactName(c.name) || subLine(c), had: contactAlreadyInList(list, c), bare: c.phones.length === 0 && c.emails.length === 0,
    })), [view.candidates, list]);
    // Everyone ticked to start with (design Q3), but people already in the list and entries with no number or email.
    const [ticked, setTicked] = useState(() => new Set(rows.filter((r) => !r.had && !r.bare).map((r) => r.i)));
    const [q, setQ] = useState('');
    const [limit, setLimit] = useState(PAGE);
    const typed = q.trim().toLowerCase();
    const matching = rows.filter((r) => !typed || [r.name, ...r.c.phones, ...r.c.emails].some((s) => s.toLowerCase().includes(typed)));
    const n = ticked.size;
    const over = list.contacts.length + n - CONTACTS_LIMITS.contacts;
    const flip = (i: number) => setTicked((s) => { const next = new Set(s); if (next.has(i)) next.delete(i); else next.add(i); return next; });
    return (
        <>
            {header(t('Choose who to bring'), onBack)}
            <p style={{ ...muted, color: 'var(--text-primary)', fontSize: '0.95rem' }}>
                {tn(rows.length, 'Found {n} contact. Nothing has left this device yet.', 'Found {n} contacts. Nothing has left this device yet.')}
            </p>
            {view.cutOff && <p style={muted}>{t('The file ended part way through a contact. That one was left out.')}</p>}
            {view.more > 0 && <p style={muted}>{tn(view.more, 'Only the first {max} were read: {n} more is in the file.', 'Only the first {max} were read: {n} more are in the file.', { max: formatCount(view.candidates.length) })}</p>}
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search')} aria-label={t('Search the contacts found')} style={field} />
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{tn(n, '{n} ticked', '{n} ticked')}</span>
                {n > 0
                    ? <button type="button" style={btn} onClick={() => setTicked(new Set())}>{t('Untick all')}</button>
                    : <button type="button" style={btn} onClick={() => setTicked(new Set(rows.filter((r) => !r.had).map((r) => r.i)))}>{t('Tick all')}</button>}
            </div>
            <div data-testid="contacts-review">
                {matching.slice(0, limit).map((r) => (
                    <label key={r.i} style={{ ...card, display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer', minHeight: '44px' }}>
                        <input type="checkbox" checked={ticked.has(r.i)} onChange={() => flip(r.i)} style={{ width: '20px', height: '20px', flexShrink: 0 }} />
                        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                            <span style={{ fontWeight: 600 }}>{r.name}</span>
                            {subLine(r.c) && <span style={{ color: 'var(--text-muted)' }}> · {subLine(r.c)}</span>}
                            {r.had && <span style={{ color: 'var(--text-muted)' }}> {t('(already in your list)')}</span>}
                            {!r.had && r.bare && <span style={{ color: 'var(--text-muted)' }}> {t('(no number or email)')}</span>}
                        </span>
                    </label>
                ))}
            </div>
            {matching.length > limit && <button type="button" style={{ ...btn, marginBottom: '0.75rem' }} onClick={() => setLimit((l) => l + PAGE)}>{t('Show more')}</button>}
            {over > 0 && <p role="alert" style={{ ...muted, color: 'var(--danger)' }}>{tn(over, 'You can keep up to {max} contacts. Untick {n} to continue.', 'You can keep up to {max} contacts. Untick {n} to continue.', { max: formatCount(CONTACTS_LIMITS.contacts) })}</p>}
            {alert}
            <div style={{ position: 'sticky', bottom: 0, background: 'var(--bg-primary)', padding: '0.5rem 0' }}>
                <button type="button" className={go} style={{ ...goStyle, width: '100%' }} disabled={busy || n === 0 || over > 0}
                    onClick={() => onImport(rows.filter((r) => ticked.has(r.i)).map((r) => r.c))}>
                    {tn(n, 'Import {n} contact', 'Import {n} contacts')}
                </button>
            </div>
        </>
    );
}
