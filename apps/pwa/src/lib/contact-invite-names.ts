/**
 * Invites → Pending names an invite made from the member's private contacts by the name in that list, in this browser
 * (scratch/fable-design/DESIGN-private-contacts-fable.md §3.8, slice C5; core contactInviteNames; the phone's twin is
 * apps/native/utils/use-contact-invite-names.ts). The community holds no note for such an invite: the name was never sent.
 * The list is opened only while a fold that needs it is open (`need`: an invite with no note and no names-list entry in it).
 */
import { useEffect, useMemo } from 'react';
import { contactInviteNames } from '@beanpool/core';
import { nodeAddress } from './api';
import { openContacts, useContacts } from './contacts-store';
import type { BeanPoolIdentity } from './identity';

const NONE: ReadonlyMap<string, string> = new Map();

export function useContactInviteNames(identity: BeanPoolIdentity, need: boolean): ReadonlyMap<string, string> {
    const snap = useContacts();
    useEffect(() => { if (need) void openContacts(identity); }, [need, identity]);
    const key = identity.publicKey.toLowerCase();
    return useMemo(() => {
        const list = need && snap.key === key ? snap.list : null;
        if (!list?.contacts.length) return NONE;
        const here = nodeAddress();
        return contactInviteNames(list.contacts, (c) => c === here);
    }, [snap, need, key]);
}
