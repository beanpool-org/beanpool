/**
 * Invite people to a group from the web (groups decision 8): the phone's components/InvitePeopleSheet.tsx. Pick members
 * of this community, then one tap sends each an invitation (POST /api/groups/:id/members, action 'invite'). Offered by
 * GroupDetailModal only to whom the node lets invite (lib/group-invite.ts canInviteToGroup).
 *
 * Where the community says `membersOnDemand` the whole list is never read: a name of 2 letters or more asks the node
 * (lib/members-on-demand). Anywhere else the community's list, as the phone reads it.
 * At 320 px and 130% text: rows are 48 px targets, names truncate, the Invite button stays at the foot.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { t, tn } from '@beanpool/core';
import { inviteGroupMember } from '../lib/api';
import { useMembersOnDemand, useMemberSearch, getMembersWhole, isMembersOnDemandRefusal, MEMBERS_SEARCH_MIN_CHARS } from '../lib/members-on-demand';
import { invitableShown, sendInvitations, type InvitablePerson } from '../lib/group-invite';
import { resolveAvatarUrl } from '../lib/avatar';
import { useDialogFocus } from './dialog-focus';

interface Props {
    groupId: string;
    groupName: string;
    /** Already in the group (active, invited or asking): shown ticked and disabled. */
    existing: ReadonlySet<string>;
    myPubkey?: string | null;
    onClose: () => void;
    /** After a send, with how many went: the roster reloads. */
    onInvited?: (sent: number) => void;
}

export function InvitePeopleSheet({ groupId, groupName, existing, myPubkey, onClose, onInvited }: Props) {
    const membersOnDemand = useMembersOnDemand();
    // null while the list is on its way: "nobody here" is only said once the node has answered with nobody.
    const [people, setPeople] = useState<InvitablePerson[] | null>(null);
    const [query, setQuery] = useState('');
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [sending, setSending] = useState(false);
    const [failedNote, setFailedNote] = useState<string | null>(null);
    // The whole list couldn't be read: said, never "nobody else is here".
    const [listFailed, setListFailed] = useState(false);
    const search = useMemberSearch(query, membersOnDemand === true);

    useEffect(() => {
        if (membersOnDemand === null) return;
        setListFailed(false);
        if (membersOnDemand) { setPeople([]); return; }
        let alive = true;
        getMembersWhole()
            .then(rows => {
                if (!alive) return;
                setPeople((Array.isArray(rows) ? rows : [])
                    .filter((m: any) => m?.publicKey && m.status !== 'pruned')
                    .map((m: any) => ({ publicKey: m.publicKey, callsign: m.callsign || m.publicKey.slice(0, 8), avatarUrl: m.avatarUrl ?? null })));
            })
            .catch((e) => {
                // A 403 members_on_demand turns the switch on (getMembersWhole) and this runs again, searching.
                if (!alive || isMembersOnDemandRefusal(e)) return;
                setPeople([]);
                setListFailed(true);
            });
        return () => { alive = false; };
    }, [membersOnDemand]);

    // Drawn over the group's own sheet (also aria-modal): focus to the heading, Tab kept inside, Escape closes only this
    // one, and focus goes back to Invite people on close (components/dialog-focus.ts; review of #1979, N3).
    const dialog = useRef<HTMLDivElement>(null);
    useDialogFocus(dialog, onClose);

    const shown = useMemo(() => {
        const found = (search.found ?? []).map(c => ({ publicKey: c.publicKey, callsign: c.callsign, avatarUrl: c.avatarUrl ?? null }));
        return invitableShown([...(people ?? []), ...found], membersOnDemand ? '' : query, myPubkey);
    }, [people, search.found, query, myPubkey, membersOnDemand]);

    const names = useMemo(() => new Map(shown.map(p => [p.publicKey, p.callsign])), [shown]);

    const toggle = (pk: string) => {
        setPicked(prev => {
            const next = new Set(prev);
            if (next.has(pk)) next.delete(pk); else next.add(pk);
            return next;
        });
    };

    const send = async () => {
        if (!picked.size || sending) return;
        setSending(true);
        setFailedNote(null);
        const { sent, failed, refusal } = await sendInvitations([...picked], pk => inviteGroupMember(groupId, pk));
        setSending(false);
        onInvited?.(sent.length);
        if (failed.length) {
            const who = failed.map(pk => names.get(pk) || pk.slice(0, 8)).join(', ');
            // A refusal is said in the node's words (it won't pass in a moment); anything else is worth another go.
            setFailedNote(refusal
                ? t('{sent} sent. Not sent: {names}. {reason}', { sent: String(sent.length), names: who, reason: refusal })
                : t('{sent} sent. Not sent: {names}. Try again in a moment.', { sent: String(sent.length), names: who }));
            setPicked(new Set(failed));
            return;
        }
        onClose();
    };

    const count = picked.size;
    const waitingForList = people === null || (membersOnDemand === true && search.state === 'searching');
    let emptyNote: string | null = null;
    if (!waitingForList && shown.length === 0) {
        if (membersOnDemand && query.trim().length < MEMBERS_SEARCH_MIN_CHARS) emptyNote = t('Type at least 2 letters of a name to find someone.');
        else if (membersOnDemand && search.state === 'failed') emptyNote = t('The community could not be searched just now. Try again in a moment.');
        else if (!membersOnDemand && listFailed) emptyNote = t("The community's members could not be read just now. Close this and try again in a moment.");
        else if (query.trim()) emptyNote = t('Nobody here by that name.');
        else emptyNote = t('Nobody else is in this community yet.');
    }

    return (
        <div
            ref={dialog}
            className="fixed inset-0 z-[310] flex items-end sm:items-center justify-center"
            role="dialog"
            aria-modal="true"
            aria-labelledby="invite-people-title"
            data-testid="invite-people-sheet"
            // Inside the group's own sheet: a click here never reaches (and closes) the sheet underneath.
            onClick={e => { e.stopPropagation(); onClose(); }}
        >
            <div className="absolute inset-0 bg-black/60" />
            <div
                className="relative bg-nature-100 dark:bg-[#0d0d0d] rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[90vh] flex flex-col min-w-0"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center gap-2 p-4 border-b border-nature-200 dark:border-nature-800">
                    <div className="flex-1 min-w-0">
                        <h2 id="invite-people-title" tabIndex={-1} className="text-lg font-black text-nature-950 dark:text-white truncate focus:outline-none">{t('Invite people')}</h2>
                        <p className="text-xs text-nature-600 dark:text-nature-400 truncate">{t('to {group}', { group: groupName })}</p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('Close')}
                        className="shrink-0 min-w-[44px] min-h-[44px] rounded-lg text-nature-600 dark:text-nature-300 hover:bg-nature-200 dark:hover:bg-nature-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    >
                        <span aria-hidden="true">✕</span>
                    </button>
                </div>
                <div className="p-3">
                    <input
                        type="search"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        // Short enough to show whole at 320 px and 130% text (review of #1979, X4); the field's name says the rest.
                        placeholder={t('Search by name')}
                        aria-label={t('Search people in this community')}
                        className="w-full min-h-[44px] px-3 rounded-xl bg-white dark:bg-nature-900 border border-nature-300 dark:border-nature-700 text-nature-900 dark:text-white placeholder:text-nature-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    />
                </div>
                <ul className="flex-1 overflow-y-auto min-h-[120px] px-2" aria-label={t('People')}>
                    {waitingForList && <li className="p-4 text-center text-sm text-nature-600 dark:text-nature-400">{t('Loading people…')}</li>}
                    {emptyNote && <li className="p-4 text-center text-sm text-nature-600 dark:text-nature-300">{emptyNote}</li>}
                    {!waitingForList && shown.map(p => {
                        const already = existing.has(p.publicKey);
                        const on = already || picked.has(p.publicKey);
                        const avatar = p.avatarUrl ? resolveAvatarUrl(p.avatarUrl) : null;
                        return (
                            <li key={p.publicKey}>
                                <label className={`flex items-center gap-3 min-h-[48px] px-2 rounded-xl min-w-0 ${already ? 'opacity-60' : 'cursor-pointer hover:bg-nature-200 dark:hover:bg-nature-800'}`}>
                                    <input
                                        type="checkbox"
                                        checked={on}
                                        disabled={already || sending}
                                        onChange={() => toggle(p.publicKey)}
                                        className="w-5 h-5 shrink-0 accent-emerald-600"
                                    />
                                    {avatar
                                        ? <img src={avatar} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
                                        : <span aria-hidden="true" className="w-8 h-8 rounded-full bg-nature-200 dark:bg-nature-700 text-nature-800 dark:text-nature-100 flex items-center justify-center text-xs font-bold shrink-0">{(p.callsign || '?').charAt(0).toUpperCase()}</span>}
                                    <span className="flex-1 min-w-0 truncate text-sm font-semibold text-nature-900 dark:text-white">{p.callsign}</span>
                                    {already && <span className="shrink-0 text-xs text-nature-600 dark:text-nature-400">{t('In the group')}</span>}
                                </label>
                            </li>
                        );
                    })}
                </ul>
                <div className="p-3 border-t border-nature-200 dark:border-nature-800 space-y-2">
                    {failedNote && (
                        <p role="alert" data-testid="invite-partial-failure" className="m-0 p-2 rounded-lg text-xs bg-bp-chip-warn-tint text-bp-chip-warn-ink break-words">
                            {failedNote}
                        </p>
                    )}
                    <button
                        type="button"
                        onClick={send}
                        disabled={!count || sending}
                        className="w-full min-h-[48px] rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                    >
                        {sending
                            ? t('Sending…')
                            : count
                                ? tn(count, 'Invite {n} person', 'Invite {n} people')
                                : t('Pick people to invite')}
                    </button>
                </div>
            </div>
        </div>
    );
}
