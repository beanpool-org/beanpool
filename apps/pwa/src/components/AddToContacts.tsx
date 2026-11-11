/**
 * "＋ Add to my contacts" on a member's profile (scratch/fable-design/DESIGN-private-contacts-fable.md §3.7, slice C4): a
 * text link under Message / Add friend that opens a small sheet. The member names the person (only they see the name),
 * is told the other isn't told and how this differs from Friends, and the contact is linked to the member's key as met at
 * this community. A typed name already in the list asks whether it is the same person. Nothing is sent: the change is
 * kept by lib/contacts-store.ts and saved, locked, after its wait.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CONTACTS_LIMITS, cleanContactName, formatCount, newContactId, putContact, t, type Contact, type ContactLink } from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import { nodeAddress } from '../lib/api';
import { changeContacts, openContacts, useContacts } from '../lib/contacts-store';
import { useDialogFocus } from './dialog-focus';

export function AddToContacts({ identity, pubkey, callsign }: { identity: BeanPoolIdentity; pubkey: string; callsign: string }): ReactNode {
    const snap = useContacts();
    const [open, setOpen] = useState(false);
    useEffect(() => { void openContacts(identity); }, [identity]);
    const list = snap.key === identity.publicKey.toLowerCase() ? snap.list : null;
    if (!list || snap.newer) return null;
    const key = pubkey.toLowerCase();
    const held = list.contacts.find((c) => c.links.some((l) => l.key === key));
    if (held) return <p data-testid="in-your-contacts" className="mt-3 text-xs text-nature-600 dark:text-nature-300 m-0">{t('In your contacts as {name}', { name: held.name })}</p>;
    return (
        <>
            <button type="button" data-testid="add-to-contacts" onClick={() => setOpen(true)}
                className="mt-2 min-h-[44px] bg-transparent border-none text-xs font-bold text-nature-700 dark:text-nature-200 underline cursor-pointer">
                {t('＋ Add to my contacts')}
            </button>
            {open && <AddSheet identity={identity} pubkey={key} callsign={callsign} contacts={list.contacts} onClose={() => setOpen(false)} />}
        </>
    );
}

function AddSheet({ identity, pubkey, callsign, contacts, onClose }: { identity: BeanPoolIdentity; pubkey: string; callsign: string; contacts: Contact[]; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    useDialogFocus(ref, onClose);
    const [name, setName] = useState(callsign);
    const [same, setSame] = useState<Contact | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const link: ContactLink = { key: pubkey, community: nodeAddress(), callsign, how: 'profile', at: new Date().toISOString() };
    const save = async (onto: Contact | null) => {
        if (!onto && contacts.length >= CONTACTS_LIMITS.contacts) { setProblem(t('You can keep up to {max} contacts.', { max: formatCount(CONTACTS_LIMITS.contacts) })); return; }
        setBusy(true);
        try {
            await changeContacts(identity, (l) => putContact(l, onto
                ? { ...onto, links: [...onto.links, link] }
                : { id: newContactId(), name: cleanContactName(name) || callsign, phones: [], emails: [], note: '', links: [link], invite: null }));
            onClose();
        } catch {
            setProblem(t("Couldn't save your contacts in this browser. Try again."));
        } finally {
            setBusy(false);
        }
    };
    const add = () => {
        const typed = cleanContactName(name).toLowerCase();
        const match = typed ? contacts.find((c) => c.name.toLowerCase() === typed && c.links.length < CONTACTS_LIMITS.links) : undefined;
        if (match) setSame(match);
        else void save(null);
    };
    const button = 'min-h-[44px] px-4 py-2 rounded-xl text-sm font-bold cursor-pointer border-none';
    return (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
            <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="add-contact-title" data-testid="add-to-contacts-sheet" onClick={(e) => e.stopPropagation()}
                className="w-full max-w-md rounded-2xl p-5 bg-white dark:bg-nature-900 text-nature-900 dark:text-white border border-nature-200 dark:border-nature-700 text-left">
                <h2 id="add-contact-title" className="text-base font-bold m-0 mb-3 break-words">{t('Add @{callsign} to your contacts', { callsign })}</h2>
                {same ? (
                    <>
                        <p className="text-sm m-0 mb-4">{t('{name} is already in your list. Add @{callsign} to that person?', { name: same.name, callsign })}</p>
                        <div className="flex flex-wrap gap-2">
                            <button type="button" disabled={busy} onClick={() => void save(same)} className={`${button} bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on`}>{t('Yes, same person')}</button>
                            <button type="button" disabled={busy} onClick={() => void save(null)} className={`${button} bg-nature-100 dark:bg-nature-800 text-nature-800 dark:text-nature-100`}>{t('No, a new contact')}</button>
                        </div>
                    </>
                ) : (
                    <form onSubmit={(e) => { e.preventDefault(); add(); }}>
                        <label htmlFor="add-contact-name" className="block text-sm font-semibold mb-1">{t('Name (only you see it)')}</label>
                        <input id="add-contact-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={CONTACTS_LIMITS.nameChars} autoComplete="off"
                            className="w-full min-h-[44px] px-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-950 text-nature-900 dark:text-white mb-3" />
                        <p className="text-xs text-nature-600 dark:text-nature-300 m-0 mb-4">{t("@{callsign} isn't told. This is different from Friends: a friend can see you added them.", { callsign })}</p>
                        <div className="flex flex-wrap gap-2">
                            <button type="submit" disabled={busy} className={`${button} bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on`}>{t('Add')}</button>
                            <button type="button" onClick={onClose} className={`${button} bg-nature-100 dark:bg-nature-800 text-nature-800 dark:text-nature-100`}>{t('Cancel')}</button>
                        </div>
                    </form>
                )}
                {problem && <p role="alert" className="text-xs text-red-700 dark:text-red-300 mt-3 mb-0">{problem}</p>}
            </div>
        </div>
    );
}
