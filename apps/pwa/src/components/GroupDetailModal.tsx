import { useState, useEffect, useCallback } from 'react';
import {
    getGroup,
    getGroupMembers,
    joinGroup,
    removeGroupMember,
    approveGroupMember,
    setGroupMemberRole,
    handOverGroupLead,
    updateGroup,
    type Group,
    type GroupMember,
    type GroupRole,
    type JoinPolicy
} from '../lib/api';
import { resolveAvatarUrl } from '../lib/avatar';
import { buildRosterView } from '../lib/group-roster';

interface Props {
    group: Group | null;
    isOpen: boolean;
    onClose: () => void;
    myPubkey?: string;
    onMembershipChanged?: () => void;
    onPostToGroup?: (group: Group) => void;
}

export function GroupDetailModal({
    group,
    isOpen,
    onClose,
    myPubkey,
    onMembershipChanged,
    onPostToGroup
}: Props) {
    const [groupData, setGroupData] = useState<Group | null>(group);
    const [members, setMembers] = useState<GroupMember[]>([]);
    const [loading, setLoading] = useState(false);
    const [actionLoading, setActionLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadDetails = useCallback(async () => {
        if (!group?.id) return;
        setLoading(true);
        try {
            const [g, m] = await Promise.all([
                getGroup(group.id),
                getGroupMembers(group.id)
            ]);
            setGroupData(g);
            setMembers(Array.isArray(m) ? m : []);
        } catch (err: any) {
            console.warn('[GroupDetail] Failed to load:', err);
        } finally {
            setLoading(false);
        }
    }, [group?.id]);

    useEffect(() => {
        if (isOpen && group?.id) {
            setGroupData(group);
            loadDetails();
        }
    }, [isOpen, group, loadDetails]);

    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen || !groupData) return null;

    const myMembership = members.find(m => m.memberPubkey === myPubkey);
    const isConvenor = groupData.viewerRole === 'convenor' || (myMembership?.role === 'convenor' && myMembership?.status === 'active');
    const isMember = (myMembership && myMembership.status === 'active') || groupData.viewerStatus === 'active';
    const isPending = (myMembership && myMembership.status === 'pending_approval') || groupData.viewerStatus === 'pending_approval';

    const pendingMembers = members.filter(m => m.status === 'pending_approval');
    // Who leads the group, and what each row may offer (lead convenor, 2026-09-23). One source of truth, shared
    // with the native roster and with the engine that enforces it: a convenor never sees the Role select or ✕ on
    // the lead, or on another convenor.
    const roster = buildRosterView(groupData, members, myPubkey);

    const handleJoin = async () => {
        setActionLoading(true);
        setError(null);
        try {
            await joinGroup(groupData.id);
            await loadDetails();
            if (onMembershipChanged) onMembershipChanged();
        } catch (err: any) {
            setError(err.message || 'Failed to join group');
        } finally {
            setActionLoading(false);
        }
    };

    const handleHandOverLead = async (targetPubkey: string, callsign?: string) => {
        const who = callsign || 'this member';
        if (!window.confirm(
            `Make ${who} the lead convenor of ${groupData.name}? They can remove and demote convenors, and you cannot take the lead back.`
        )) return;
        setActionLoading(true);
        setError(null);
        try {
            await handOverGroupLead(groupData.id, targetPubkey);
            await loadDetails();
            if (onMembershipChanged) onMembershipChanged();
        } catch (err: any) {
            setError(err.message || 'Failed to hand the lead over');
        } finally {
            setActionLoading(false);
        }
    };

    const handleLeave = async () => {
        if (!myPubkey) return;
        // A lead cannot leave while anyone else is active: say so here rather than letting the server refuse it.
        if (roster.leaveNeedsHandOver) {
            setError(`You are the lead convenor of ${groupData.name}. Hand the lead to someone else first, then you can leave.`);
            return;
        }
        if (!window.confirm(`Are you sure you want to leave ${groupData.name}?`)) return;
        setActionLoading(true);
        setError(null);
        try {
            await removeGroupMember(groupData.id, myPubkey);
            await loadDetails();
            if (onMembershipChanged) onMembershipChanged();
        } catch (err: any) {
            setError(err.message || 'Failed to leave group');
        } finally {
            setActionLoading(false);
        }
    };

    const handleApprove = async (memberPubkey: string) => {
        setActionLoading(true);
        setError(null);
        try {
            await approveGroupMember(groupData.id, memberPubkey);
            await loadDetails();
            if (onMembershipChanged) onMembershipChanged();
        } catch (err: any) {
            setError(err.message || 'Failed to approve member');
        } finally {
            setActionLoading(false);
        }
    };

    const handleRemoveMember = async (memberPubkey: string, callsign?: string) => {
        if (!window.confirm(`Remove ${callsign || 'this member'} from ${groupData.name}?`)) return;
        setActionLoading(true);
        setError(null);
        try {
            await removeGroupMember(groupData.id, memberPubkey);
            await loadDetails();
            if (onMembershipChanged) onMembershipChanged();
        } catch (err: any) {
            setError(err.message || 'Failed to remove member');
        } finally {
            setActionLoading(false);
        }
    };

    const handleChangeRole = async (memberPubkey: string, newRole: GroupRole) => {
        setActionLoading(true);
        setError(null);
        try {
            await setGroupMemberRole(groupData.id, memberPubkey, newRole);
            await loadDetails();
            if (onMembershipChanged) onMembershipChanged();
        } catch (err: any) {
            setError(err.message || 'Failed to change member role');
        } finally {
            setActionLoading(false);
        }
    };

    const handleSetPolicy = async (policy: JoinPolicy) => {
        setActionLoading(true);
        setError(null);
        try {
            await updateGroup(groupData.id, { joinPolicy: policy });
            await loadDetails();
            if (onMembershipChanged) onMembershipChanged();
        } catch (err: any) {
            setError(err.message || 'Failed to update policy');
        } finally {
            setActionLoading(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-detail-title"
        >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className="relative bg-nature-100 dark:bg-[#0d0d0d] rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto animate-in slide-in-from-bottom-4 duration-300"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="sticky top-0 bg-nature-100/90 dark:bg-[#0d0d0d]/90 backdrop-blur-md p-4 border-b border-nature-200 dark:border-nature-800 flex items-center justify-between z-10">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xl" aria-hidden="true">👥</span>
                        <h2 id="group-detail-title" className="text-lg font-black text-nature-950 dark:text-white truncate">
                            {groupData.name}
                        </h2>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1 rounded-lg text-nature-500 hover:text-nature-900 dark:hover:text-white hover:bg-nature-200 dark:hover:bg-nature-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    {/* Tags */}
                    <div className="flex flex-wrap gap-2">
                        <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-nature-200 dark:bg-nature-800 text-nature-700 dark:text-nature-300">
                            <span aria-hidden="true">🏷️ </span>{groupData.category.replace(/_/g, ' ')}
                        </span>
                        <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-nature-200 dark:bg-nature-800 text-nature-700 dark:text-nature-300">
                            <span aria-hidden="true">🚪 </span>{groupData.joinPolicy.replace(/_/g, ' ')}
                        </span>
                        {isConvenor && (
                            <span className="px-2.5 py-1 rounded-full text-xs font-black bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700">
                                <span aria-hidden="true">🛡️ </span>{roster.viewerIsLead ? 'Lead convenor' : 'Convenor'}
                            </span>
                        )}
                    </div>

                    {/* Group info names the lead convenor. Never "owner" — that is the owner of a node. */}
                    {roster.leadCallsign && (
                        <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                            Lead convenor: <strong className="text-nature-900 dark:text-white">{roster.leadCallsign}</strong>
                            {roster.viewerIsLead ? ' (you)' : ''}. Only the lead can remove or demote a convenor, and nobody can remove the lead.
                        </p>
                    )}

                    {/* Framing statement */}
                    <div className="p-3 bg-nature-200/60 dark:bg-nature-900/60 border border-nature-300 dark:border-nature-800 rounded-xl text-xs text-nature-700 dark:text-nature-300 leading-relaxed">
                        <span aria-hidden="true">ℹ️ </span><strong>A group is a place to talk to some people rather than everyone.</strong> It does not hold beans and does not confer trust.
                    </div>

                    {error && (
                        <div className="p-3 bg-red-100 dark:bg-red-950/40 border border-red-300 dark:border-red-800 rounded-xl text-xs text-red-700 dark:text-red-300">
                            {error}
                        </div>
                    )}

                    {groupData.description && (
                        <p className="text-sm text-nature-700 dark:text-nature-300 whitespace-pre-wrap leading-relaxed">
                            {groupData.description}
                        </p>
                    )}

                    {/* Convenor Tools Section */}
                    {isConvenor && (
                        <div className="p-4 bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800/60 rounded-2xl space-y-3">
                            <h3 className="text-xs font-black uppercase tracking-wider text-emerald-800 dark:text-emerald-400">
                                <span aria-hidden="true">🛡️ </span>Convenor Tools
                            </h3>

                            {/* Set Join Policy */}
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-nature-600 dark:text-nature-400">
                                    Join Policy: <strong className="text-nature-900 dark:text-white capitalize">{groupData.joinPolicy.replace(/_/g, ' ')}</strong>
                                </span>
                                <select
                                    value={groupData.joinPolicy}
                                    onChange={(e) => handleSetPolicy(e.target.value as JoinPolicy)}
                                    disabled={actionLoading}
                                    className="px-2 py-1 bg-white dark:bg-nature-900 border border-nature-300 dark:border-nature-700 rounded-lg text-xs font-bold text-nature-900 dark:text-white"
                                >
                                    <option value="open">Open (immediate)</option>
                                    <option value="request_to_join">Request to Join (approval needed)</option>
                                    <option value="invite_only">Invite Only</option>
                                </select>
                            </div>

                            {/* Pending Join Requests */}
                            {pendingMembers.length > 0 && (
                                <div className="space-y-2 pt-2 border-t border-emerald-200 dark:border-emerald-800/40">
                                    <div className="text-xs font-bold text-nature-700 dark:text-nature-300">
                                        Pending Join Requests ({pendingMembers.length})
                                    </div>
                                    <div className="space-y-1.5">
                                        {pendingMembers.map((p) => {
                                            const resolvedAvatar = resolveAvatarUrl(p.avatarUrl);
                                            return (
                                                <div key={p.memberPubkey} className="flex items-center justify-between p-2 bg-white dark:bg-nature-900 rounded-xl border border-nature-200 dark:border-nature-800">
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        {resolvedAvatar ? (
                                                            <img src={resolvedAvatar} alt="" className="w-6 h-6 rounded-full object-cover" />
                                                        ) : (
                                                            <div className="w-6 h-6 rounded-full bg-nature-200 dark:bg-nature-700 flex items-center justify-center text-[10px] font-bold">
                                                                {(p.callsign || '?').charAt(0).toUpperCase()}
                                                            </div>
                                                        )}
                                                        <span className="text-xs font-bold text-nature-900 dark:text-white truncate">
                                                            {p.callsign || p.memberPubkey.slice(0, 10)}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-1">
                                                        <button
                                                            onClick={() => handleApprove(p.memberPubkey)}
                                                            disabled={actionLoading}
                                                            aria-label={`Approve join request from ${p.callsign || p.memberPubkey.slice(0, 10)}`}
                                                            className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[11px] font-bold transition-colors"
                                                        >
                                                            Approve
                                                        </button>
                                                        <button
                                                            onClick={() => handleRemoveMember(p.memberPubkey, p.callsign)}
                                                            disabled={actionLoading}
                                                            aria-label={`Decline join request from ${p.callsign || p.memberPubkey.slice(0, 10)}`}
                                                            className="px-2 py-1 rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 text-[11px] font-bold hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                                        >
                                                            Decline
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Member Roster */}
                    <div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-nature-600 dark:text-nature-400 mb-2">
                            Roster ({roster.rows.length || groupData.memberCount || 0})
                        </h3>

                        {loading ? (
                            <div className="py-4 text-center text-xs text-nature-500">Loading members...</div>
                        ) : (
                            <div className="divide-y divide-nature-200 dark:divide-nature-800/80 border border-nature-200 dark:border-nature-800 rounded-xl overflow-hidden">
                                {roster.rows.map((row) => {
                                    const m = row.member;
                                    const resolvedAvatar = resolveAvatarUrl(m.avatarUrl);
                                    const highlight = row.isLead || m.role === 'convenor';
                                    return (
                                        // flex-wrap and gap-y so the row stacks rather than overflowing at 320px
                                        // with 1.3× text.
                                        <div key={m.memberPubkey} className="flex flex-wrap items-center justify-between gap-y-2 p-3 bg-white dark:bg-nature-950">
                                            <div className="flex items-center gap-3 min-w-0">
                                                {resolvedAvatar ? (
                                                    <img src={resolvedAvatar} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
                                                ) : (
                                                    <div className="w-8 h-8 shrink-0 rounded-full bg-nature-200 dark:bg-nature-700 flex items-center justify-center text-xs font-bold">
                                                        {(m.callsign || '?').charAt(0).toUpperCase()}
                                                    </div>
                                                )}
                                                <div className="min-w-0">
                                                    <div className="text-sm font-bold text-nature-900 dark:text-white truncate">
                                                        {m.callsign || m.memberPubkey.slice(0, 10)} {row.isYou && <span className="text-xs text-nature-400">(You)</span>}
                                                    </div>
                                                    <div className="text-[11px] text-nature-500 dark:text-nature-400">
                                                        {row.roleLabel}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-2">
                                                <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${
                                                    highlight
                                                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-300/40'
                                                        : 'bg-nature-100 dark:bg-nature-800 text-nature-600 dark:text-nature-400'
                                                }`}>
                                                    {row.isLead ? 'Lead' : m.role}
                                                </span>

                                                {/* The Role select and ✕ only where the viewer may actually act: never
                                                    on the lead, and never on another convenor unless the viewer IS
                                                    the lead. */}
                                                {(row.canChangeRole || row.canRemove || row.canHandOverLead) && (
                                                    <div className="flex items-center gap-1">
                                                        {row.canHandOverLead && (
                                                            <button
                                                                type="button"
                                                                onClick={() => handleHandOverLead(m.memberPubkey, m.callsign)}
                                                                disabled={actionLoading}
                                                                aria-label={`Make ${m.callsign || m.memberPubkey.slice(0, 10)} the lead convenor`}
                                                                title="Make lead convenor"
                                                                className="px-1.5 py-0.5 rounded border border-nature-300 dark:border-nature-700 text-[10px] font-bold text-nature-700 dark:text-nature-300 hover:bg-nature-100 dark:hover:bg-nature-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                                            >
                                                                Make lead
                                                            </button>
                                                        )}
                                                        {row.canChangeRole && (
                                                            <select
                                                                value={m.role}
                                                                onChange={(e) => handleChangeRole(m.memberPubkey, e.target.value as GroupRole)}
                                                                disabled={actionLoading}
                                                                aria-label={`Role for ${m.callsign || m.memberPubkey.slice(0, 10)}`}
                                                                className="px-1.5 py-0.5 bg-nature-100 dark:bg-nature-900 border border-nature-300 dark:border-nature-700 rounded text-[10px] font-bold text-nature-700 dark:text-nature-300"
                                                            >
                                                                <option value="convenor">Convenor</option>
                                                                <option value="member">Member</option>
                                                                <option value="observer">Observer</option>
                                                            </select>
                                                        )}
                                                        {row.canRemove && (
                                                            <button
                                                                type="button"
                                                                onClick={() => handleRemoveMember(m.memberPubkey, m.callsign)}
                                                                disabled={actionLoading}
                                                                aria-label={`Remove ${m.callsign || m.memberPubkey.slice(0, 10)} from group`}
                                                                className="p-1 rounded text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                                                title="Remove member"
                                                            >
                                                                ✕
                                                            </button>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Action Area */}
                    <div className="pt-2 space-y-2">
                        {isMember && onPostToGroup && (
                            <button
                                type="button"
                                onClick={() => {
                                    onClose();
                                    onPostToGroup(groupData);
                                }}
                                className="w-full py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm shadow-md transition-all flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                            >
                                <span aria-hidden="true">✏️ </span>Post to {groupData.name}
                            </button>
                        )}

                        {isMember ? (
                            <button
                                type="button"
                                onClick={handleLeave}
                                disabled={actionLoading}
                                className="w-full py-2.5 px-4 rounded-xl border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 font-bold text-sm hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                            >
                                Leave Group
                            </button>
                        ) : isPending ? (
                            <div className="w-full py-2.5 px-4 rounded-xl bg-nature-200 dark:bg-nature-800 text-nature-500 dark:text-nature-400 font-bold text-sm text-center">
                                Request Pending Approval
                            </div>
                        ) : groupData.joinPolicy === 'invite_only' ? (
                            <div className="w-full py-2.5 px-4 rounded-xl bg-nature-200 dark:bg-nature-800 text-nature-500 dark:text-nature-400 font-bold text-sm text-center">
                                Invite Only
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={handleJoin}
                                disabled={actionLoading}
                                className="w-full py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm shadow-md transition-all flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                            >
                                {groupData.joinPolicy === 'request_to_join' ? 'Request to Join' : 'Join Group'}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
