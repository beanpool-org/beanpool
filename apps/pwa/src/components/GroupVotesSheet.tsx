/**
 * Where a group's vote line lands (Home, a push) when the group's own read is refused: someone removed from an invite-only
 * group after a vote opened reads no group (404), yet stays on that vote's roll (DESIGN-group-decisions §2.6) and the node
 * takes their vote. So the votes are drawn from the group's id alone, as the phone's refused-chat screen does (#1784 review
 * B1). The group read itself stays as narrow as it was: nothing but the votes they are on is shown.
 */
import { getGroup, getGroupDecisions, type Group } from '../lib/api';
import { GroupDecisions } from './EnterpriseDecisions';
import { votesOnlyWords } from '@beanpool/core';

export type GroupLanding = { kind: 'group'; group: Group } | { kind: 'votes'; groupId: string; canVote: boolean } | { kind: 'commons' };

/** The group's info when it reads; its votes when only they do; Commons, where groups are listed, when neither does. */
export async function landOnGroup(groupId: string): Promise<GroupLanding> {
    try {
        return { kind: 'group', group: await getGroup(groupId) };
    } catch {
        // The decisions route answers anyone on one of the group's votes' rolls, and 404s (null) everyone else.
        const list = await getGroupDecisions(groupId);
        return list && list.decisions.length > 0
            ? { kind: 'votes', groupId, canVote: list.decisions.some(d => d.canVote === true) }
            : { kind: 'commons' };
    }
}

interface Props {
    groupId: string;
    /** Whether any of these votes still takes theirs: the line above says "you can still vote" only then (#1794 N8). */
    canVote: boolean;
    myPubkey: string | null;
    onClose: () => void;
}

export function GroupVotesSheet({ groupId, canVote, myPubkey, onClose }: Props) {
    return (
        <div
            className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-votes-title"
        >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className="relative bg-nature-100 dark:bg-[#0d0d0d] rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="sticky top-0 bg-nature-100/90 dark:bg-[#0d0d0d]/90 backdrop-blur-md p-4 border-b border-nature-200 dark:border-nature-800 flex items-center justify-between z-10">
                    <h2 id="group-votes-title" className="text-lg font-black text-nature-950 dark:text-white">Group votes</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="min-w-[44px] min-h-[44px] rounded-lg text-nature-500 hover:text-nature-900 dark:hover:text-white hover:bg-nature-200 dark:hover:bg-nature-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>
                <div className="p-4 space-y-3">
                    <p className="text-sm text-nature-700 dark:text-nature-300">
                        {votesOnlyWords(canVote)}
                    </p>
                    <GroupDecisions groupId={groupId} myPubkey={myPubkey} people={[]} />
                </div>
            </div>
        </div>
    );
}
