/**
 * "Invited, not joined yet", under a group's members (Rob via Marty, 11 Nov 2026: "Invitations should show whether they
 * have been used"). Each name and when they were invited, and for a convenor who invited them; a person moves into the
 * members above when they join. A convenor sees every pending invitation, any other member the ones they made, and a
 * declined one ("Declined", dated) shows only to the member who made it. The node decides that, not this screen
 * (GET /api/groups/:id/invitations): it draws what it is given, and nothing at all when the node gives nothing or there
 * is nothing to say. A convenor or the sender can withdraw a pending one.
 *
 * Rows stack rather than overflow at 320 px with 1.3× text: the name over its line, the Withdraw button wrapping below.
 */

import { useCallback, useEffect, useState } from 'react';
import { getGroupInvitations, withdrawGroupInvitation } from '../lib/api';
import { MemberAvatar } from './MemberAvatar';
import {
    declinedInvitationLine, declinedListNote, declinedListTitle, hasInvitationsToShow, invitedListTitle, invitedName,
    moreInvitationsLine, pendingInvitationLine, withdrawWords, inCapitalsOf, type GroupInvitations, type InvitedPerson,
} from '@beanpool/core';

interface Props {
    groupId: string;
    myPubkey?: string;
    /** Changes whenever the group's page has read itself again (a join, an invitation sent), so this reads too. */
    reloadKey?: number;
    /** An invitation withdrawn here: the group around it may count or list differently. */
    onChanged?: () => void;
}

// The app's own text tokens (index.css --text-primary / --text-secondary, light and dark): the nature greys the roster's small
// lines use are 3.3:1 on white, under the 4.5:1 these words are held to (e2e/group-invited-list-shots.mjs).
const HEADING = 'text-xs font-bold tracking-wider text-text-secondary mb-2';
const LIST = 'divide-y divide-nature-200 dark:divide-nature-800/80 border border-nature-200 dark:border-nature-800 rounded-xl overflow-hidden';
const ROW = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3 bg-white dark:bg-nature-950';

export function GroupInvitedList({ groupId, myPubkey, reloadKey = 0, onChanged }: Props) {
    const [inv, setInv] = useState<GroupInvitations | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        const next = await getGroupInvitations(groupId);
        // Nothing to say, or the node won't: the list is simply not there. A read that failed keeps the one on screen.
        setInv(prev => next ?? prev);
    }, [groupId]);

    useEffect(() => { void load(); }, [load, reloadKey]);

    // A refusal is said even when the re-read leaves nothing to list: withdrawing the only open invitation just after it was
    // accepted must not look like it worked (the row would simply vanish).
    if (!hasInvitationsToShow(inv)) {
        return error ? <div className="mt-4" role="alert" data-testid="group-invited-error"><span className="text-xs text-red-600 dark:text-red-400">{error}</span></div> : null;
    }

    const withdraw = async (p: InvitedPerson) => {
        const w = withdrawWords(p);
        // The question alone: the title and the question are two sentences of the phone's alert, one confirm here.
        if (!window.confirm(w.question)) return;
        setBusy(p.memberPubkey);
        setError(null);
        try {
            // Its own request, never the member removal: if they accepted since this list was read, the node refuses
            // (409, "already joined") rather than removing a member who has just joined.
            await withdrawGroupInvitation(groupId, p.memberPubkey);
            await load();
            onChanged?.();
        } catch (err: any) {
            setError(err?.message || w.failed);
            // Refused because things moved on (they joined, or it was declined or withdrawn): read both lists again, so
            // the person shows where they now are.
            await load();
            onChanged?.();
        } finally {
            setBusy(null);
        }
    };

    const now = Date.now();
    const more = moreInvitationsLine(inv);
    return (
        <div className="mt-4 space-y-4" data-testid="group-invited-list">
            {error && <div role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</div>}
            {inv.pending.length > 0 && (
                <section aria-label={invitedListTitle(inv.pendingTotal)}>
                    <h3 className={HEADING}>{inCapitalsOf(invitedListTitle(inv.pendingTotal))}</h3>
                    <div className={LIST}>
                        {inv.pending.map(p => {
                            const w = withdrawWords(p);
                            return (
                                <div key={p.memberPubkey} className={ROW} data-testid="group-invited-row">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <MemberAvatar avatarUrl={p.avatarUrl} pubkey={p.memberPubkey} callsign={p.callsign} size={32} alt="" />
                                        <div className="min-w-0">
                                            <div className="text-sm font-bold text-text-primary truncate">{invitedName(p)}</div>
                                            <div className="text-xs text-text-secondary">{pendingInvitationLine(p, myPubkey, now)}</div>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        data-testid="group-invited-withdraw"
                                        onClick={() => withdraw(p)}
                                        disabled={busy !== null}
                                        aria-label={w.label}
                                        className="min-h-[44px] px-3 rounded-lg border border-nature-300 dark:border-nature-700 text-xs font-bold text-text-primary hover:bg-nature-100 dark:hover:bg-nature-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                                    >
                                        {w.button}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                    {more !== '' && <p className="mt-2 text-xs text-text-secondary">{more}</p>}
                </section>
            )}
            {inv.declined.length > 0 && (
                <section aria-label={declinedListTitle()}>
                    <h3 className={HEADING}>{inCapitalsOf(declinedListTitle())}</h3>
                    <p className="mb-2 text-xs text-text-secondary">{declinedListNote()}</p>
                    <div className={LIST}>
                        {inv.declined.map(d => (
                            <div key={d.memberPubkey} className={ROW} data-testid="group-declined-row">
                                <div className="flex items-center gap-3 min-w-0">
                                    <MemberAvatar avatarUrl={d.avatarUrl} pubkey={d.memberPubkey} callsign={d.callsign} size={32} alt="" />
                                    <div className="min-w-0">
                                        <div className="text-sm font-bold text-text-primary truncate">{invitedName(d)}</div>
                                        <div className="text-xs text-text-secondary">{declinedInvitationLine(d, now)}</div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}
