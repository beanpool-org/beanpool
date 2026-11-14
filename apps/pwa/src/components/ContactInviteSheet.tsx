/**
 * Invite from a contact, on the web (scratch/fable-design/DESIGN-private-contacts-fable.md §3.8, slice C5; the phone's twin is
 * apps/native/components/ContactInviteSheet.tsx, the words core's contacts-invite.ts):
 *
 *   Invite Dee to riverside.example
 *   One invite, for one person. It works once, for 30 days.
 *   Dee's name and number are not sent to the server.
 *   [ Share… ] (where the browser has it)  [ Email ] (when there is an address)  [ Copy ]
 *
 * A tap makes the community's ordinary invite with NO note (lib/api.ts generateInvite with the maker's key alone), keeps "this
 * code was for Dee" inside the locked list, and hands today's invite message to the member's own app. Nothing is made before
 * the tap. A browser that refuses a share or a copy once the invite has been made (Safari wants it to start inside the tap)
 * keeps the made invite: the same button again sends it at once. Copy falls back to the older copy command where there is no
 * clipboard (a community at a plain http:// address, lib/copy-chat-text.ts); a copy refused even so, with no wait before it, shows
 * the message to copy by hand. A refusal is the server's own sentence.
 *
 * Where the member can't invite, the existing words: invites off (the global community) offers its plain link; an admins-only
 * door offers the existing ask, empty, with one line more ("The admins will see the first name you type here").
 */
import { useEffect, useRef, useState } from 'react';
import {
    contactInviteLines, contactInviteTitle, contactInviteWords, contactMailtoLink, inviteAndShareLink, inviteShareText, putContact, shareAddress, t,
    withContactInvite, type Contact,
} from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import { generateInvite, myNodeRoleOnce, nodeAddress } from '../lib/api';
import { useCommunityInfo } from '../lib/features';
import {
    INVITE_WORDS, adminsOnlyRefusal, communityLinkText, invitesOffRefusal, invitesOn, mayInviteHere, onlyAdminsInvite,
    pausedRefusal, readInviteRole, type InviteRole,
} from '../lib/node-invites';
import { changeContacts } from '../lib/contacts-store';
import { copyChatText } from '../lib/copy-chat-text';
import { useDialogFocus } from './dialog-focus';
import { AskSheet } from './InviteAsks';

const BTN = 'min-h-[44px] px-4 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-900 dark:text-white font-bold cursor-pointer disabled:opacity-60';
const GO = 'min-h-[44px] px-4 rounded-xl border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold cursor-pointer disabled:opacity-60';

type How = 'share' | 'email' | 'copy';

export function ContactInviteSheet({ contact, identity, community, onClose }: {
    contact: Contact; identity: BeanPoolIdentity; community: string; onClose: () => void;
}) {
    const dialog = useRef<HTMLDivElement | null>(null);
    useDialogFocus(dialog, onClose);
    const info = useCommunityInfo();
    const [role, setRole] = useState<InviteRole | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [asking, setAsking] = useState(false);
    // The invite once made, so a browser that refused to share or copy after the wait sends it at the next tap.
    const [made, setMade] = useState<string | null>(null);
    // What this browser would not copy at all (no clipboard and the older copy command refused): shown to copy by hand.
    const [byHand, setByHand] = useState<string | null>(null);
    const byHandBox = useRef<HTMLTextAreaElement | null>(null);
    useEffect(() => { if (byHand) byHandBox.current?.select(); }, [byHand]);
    const notCopied = (text: string) => { setByHand(text); setNote(t('Could not copy the link.')); };
    const adminsOnly = onlyAdminsInvite(info);
    useEffect(() => {
        if (!adminsOnly) return;
        let alive = true;
        void myNodeRoleOnce().then((r) => { if (alive && r !== undefined) setRole(readInviteRole(r)); });
        return () => { alive = false; };
    }, [adminsOnly]);

    const here = nodeAddress();
    const email = contact.emails[0];
    const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    const send = async (how: How, message: string): Promise<boolean> => {
        if (how === 'share') { await navigator.share({ text: message }); return true; }
        if (how === 'email') { window.open(contactMailtoLink(email!, contactInviteWords.emailSubject(), message)!, '_self'); return true; }
        // The clipboard, or the older copy command where there is none (a community at a plain http:// address).
        if (!(await copyChatText(message))) throw new Error('not copied');
        setNote(contactInviteWords.copied());
        return false;
    };
    const go = async (how: How) => {
        setBusy(true);
        setNote(null);
        setByHand(null);
        let message = made;
        // A copy refused after the wait for the invite may work at the next tap (Safari wants it inside the tap); one refused
        // with nothing to wait for won't, so it is shown to copy by hand.
        let waited = false;
        try {
            if (!message) {
                waited = true;
                let code: string;
                try {
                    const r = await generateInvite(identity.publicKey);
                    code = r.invite.code;
                } catch (e) {
                    setNote(invitesOffRefusal(e) ?? adminsOnlyRefusal(e) ?? pausedRefusal(e) ?? ((e as Error)?.message || t('The invite was not made.')));
                    return;
                }
                // Kept in the locked list only. The invite stands even if this browser couldn't save the change.
                await changeContacts(identity, (l) => {
                    const held = l.contacts.find((c) => c.id === contact.id);
                    return held ? putContact(l, withContactInvite(held, code, here)) : l;
                }).catch(() => {});
                message = inviteShareText({ name: community, link: inviteAndShareLink(here, code), code, address: shareAddress(here) });
                setMade(message);
            }
            try {
                if (await send(how, message)) onClose();
            } catch (e) {
                if ((e as { name?: string })?.name === 'AbortError') return;
                if (how === 'copy' && !waited) notCopied(message);
                else setNote(t('Your invite is ready. Tap the same button again to send it.'));
            }
        } finally {
            setBusy(false);
        }
    };

    let body;
    if (!invitesOn(info)) {
        body = <>
            <p className="m-0 text-base leading-relaxed text-nature-800 dark:text-nature-200">{t(INVITE_WORDS.offFallback)}</p>
            <div className="flex flex-wrap gap-2">
                <button type="button" className={GO} onClick={async () => {
                    const text = communityLinkText(window.location.origin);
                    if (canShare) {
                        try { await navigator.share({ text }); } catch { /* closed */ }
                        onClose();
                        return;
                    }
                    // No share sheet: copied and said so, or shown to copy by hand; the sheet stays open to say which.
                    setByHand(null);
                    if (await copyChatText(text)) setNote(contactInviteWords.copied());
                    else notCopied(text);
                }}>{t('📤 Share the link')}</button>
            </div>
        </>;
    } else if (!mayInviteHere(info, role)) {
        body = <>
            <p className="m-0 text-base leading-relaxed text-nature-800 dark:text-nature-200">{t(INVITE_WORDS.adminsOnlyFallback)}</p>
            <div className="flex flex-wrap gap-2">
                <button type="button" className={GO} onClick={() => setAsking(true)} data-testid="contact-invite-ask">{contactInviteWords.askAdmin(contact.name)}</button>
            </div>
        </>;
    } else {
        const [once, kept] = contactInviteLines(contact);
        body = <>
            <h2 id="contact-invite-title" className="m-0 text-lg font-extrabold text-nature-950 dark:text-white break-words">{contactInviteTitle(contact.name, community)}</h2>
            <p className="m-0 text-base leading-relaxed text-nature-800 dark:text-nature-200">{once}</p>
            <p className="m-0 text-base leading-relaxed text-nature-800 dark:text-nature-200">{kept}</p>
            <div className="flex flex-wrap gap-2">
                {canShare && <button type="button" className={GO} disabled={busy} onClick={() => void go('share')}>{contactInviteWords.share()}</button>}
                {!!email && !!contactMailtoLink(email, '', '') && <button type="button" className={canShare ? BTN : GO} disabled={busy} onClick={() => void go('email')}>{contactInviteWords.email()}</button>}
                <button type="button" className={BTN} disabled={busy} onClick={() => void go('copy')}>{contactInviteWords.copy()}</button>
            </div>
        </>;
    }
    return (<>
        <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="contact-invite-title" className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center" data-testid="contact-invite-sheet" onClick={onClose}>
            <div className="absolute inset-0 bg-black/50" />
            <div className="relative w-full sm:max-w-[420px] max-h-[90vh] overflow-y-auto p-4 rounded-t-2xl sm:rounded-2xl bg-oat-50 dark:bg-nature-950 flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
                {body}
                {note && <p id="contact-invite-note" role="status" className="m-0 text-base leading-snug text-nature-800 dark:text-nature-200 break-words">{note}</p>}
                {byHand && <textarea ref={byHandBox} readOnly value={byHand} rows={5} aria-labelledby="contact-invite-note" data-testid="contact-invite-by-hand" onFocus={(e) => e.currentTarget.select()}
                    className="w-full box-border p-2 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-900 dark:text-white text-base leading-snug resize-none" />}
                <button type="button" className={BTN} onClick={onClose}>{t('Close')}</button>
            </div>
        </div>
        {asking && <AskSheet line={contactInviteWords.askLine()} onClose={() => setAsking(false)} onSent={() => { setAsking(false); onClose(); }} />}
    </>);
}
