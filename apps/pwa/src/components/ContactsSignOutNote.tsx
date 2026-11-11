/**
 * Sign-out's word on the private contacts list (scratch/fable-design/DESIGN-private-contacts-fable.md §6.4, slice C4).
 * Signing out takes this browser's locked copy with it (lib/device-prefs.ts clearAccountStorage). When the community
 * doesn't hold the latest copy yet: "Your latest contacts changes aren't saved to … yet. Save now, then sign out." with
 * Save now, the save without the wait. When this community keeps no list for the member, the list is in this browser
 * alone: the footer's sentence, with Save a file. Nothing is said when nothing would be lost. Never blocks the sign-out.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { t } from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import { contactsHost, contactsSignOutCheck, heldContactsList, saveContactsFile, saveContactsNow } from '../lib/contacts-store';

export function ContactsSignOutNote({ identity }: { identity: BeanPoolIdentity }): ReactNode {
    const [state, setState] = useState<Awaited<ReturnType<typeof contactsSignOutCheck>> | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let gone = false;
        contactsSignOutCheck(identity.publicKey).then((s) => { if (!gone) setState(s); }, () => {});
        return () => { gone = true; };
    }, [identity.publicKey]);
    if (state !== 'unsaved' && state !== 'device-only') return null;
    const saveFile = async () => {
        const list = await heldContactsList(identity);
        if (list) saveContactsFile(list);
    };
    return (
        <div data-testid="contacts-sign-out" role="status" className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-100 space-y-2">
            <p className="m-0 leading-relaxed">
                {state === 'unsaved'
                    ? t("Your latest contacts changes aren't saved to {community} yet. Save now, then sign out.", { community: contactsHost() })
                    : t('Kept on this device only. Save a copy as a file to keep it safe.')}
            </p>
            <button
                type="button"
                disabled={busy}
                onClick={async () => {
                    setBusy(true);
                    try {
                        if (state === 'unsaved') {
                            await saveContactsNow(identity);
                            setState(await contactsSignOutCheck(identity.publicKey));
                        } else {
                            await saveFile();
                        }
                    } finally {
                        setBusy(false);
                    }
                }}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-nature-900 dark:bg-white text-white dark:text-nature-900 font-bold border-none cursor-pointer disabled:opacity-50"
            >
                {state === 'unsaved' ? (busy ? t('Saving...') : t('Save now')) : t('Save a file')}
            </button>
        </div>
    );
}
