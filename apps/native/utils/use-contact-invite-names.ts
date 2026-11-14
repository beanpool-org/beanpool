/**
 * People → Invites → Pending names an invite made from the member's private contacts by the name in that list, on this phone
 * (scratch/fable-design/DESIGN-private-contacts-fable.md §3.8, slice C5; core contactInviteNames). The community holds no note
 * for such an invite: the name was never sent. The list is opened only while a fold that needs it is open (`need`: an invite
 * with no note and no names-list entry is in it) and the phone keeps a list at all, as Pending opens the names list only for a
 * bound invite: opening 2,000 contacts takes most of a second on an old phone.
 */
import { useMemo } from 'react';
import { contactInviteNames } from '@beanpool/core';
import { contactsOf, useContacts, useContactsRecord } from './use-contacts';
import { sameCommunity } from './push-pins';
import type { ContactsAccount } from './contacts-store';

const NONE: ReadonlyMap<string, string> = new Map();

export function useContactInviteNames(account: ContactsAccount | null | undefined, anchor: string | null | undefined, need: boolean): ReadonlyMap<string, string> {
    const record = useContactsRecord(account);
    const view = useContacts(need && record ? account : null);
    return useMemo(() => {
        const people = contactsOf(view);
        return people.length && anchor ? contactInviteNames(people, (c) => sameCommunity(c, anchor)) : NONE;
    }, [view, anchor]);
}
