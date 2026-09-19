import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import {
    fetchNodeRoles,
    grantNodeRoleApi,
    revokeNodeRoleApi,
    getTfaSessionToken,
    type MemberItem,
    type MemberNodeRole,
    type NodeRoleRecord,
} from '../../lib/node-client';

/**
 * Owners & admins — who holds authority over this node (docs/admin-surface.md §1, the-commons.md §9.2).
 *
 * The node decides every rule: who may grant or remove which role, that the last owner stays, that suspended
 * and removed members lose their role. This screen never pre-judges any of that; it asks, and shows the node's
 * answer in the node's own words. The one thing it does read locally is who is looking, to decide whether to
 * offer the add/remove controls at all (the server refuses them to an admin anyway).
 *
 * Operator manual text for this screen: packages/beanpool-guide/operators/people/roles.md — keep the two in step.
 */

/** Who is looking at /settings: the admin password counts as owner level (admin-surface.md §2.5). */
export type RolesViewer =
    | { kind: 'password' }
    | { kind: 'key'; memberPubkey: string; role: 'owner' | 'admin' };

interface NodeRolesPanelProps {
    activeNode: NodeProfile;
    members: MemberItem[];
    viewer: RolesViewer;
    /** Called after a role changes, so the member directory's badges catch up. */
    onChanged?: () => void;
}

const ROLE_LABEL: Record<MemberNodeRole, string> = { owner: 'Owner', admin: 'Admin', moderator: 'Moderator' };
const ROLE_ICON: Record<MemberNodeRole, string> = { owner: '👑', admin: '⚡', moderator: '🛡️' };
const ROLE_ARTICLE: Record<MemberNodeRole, string> = { owner: 'an owner', admin: 'an admin', moderator: 'a moderator' };
const ROLE_BADGE: Record<MemberNodeRole, string> = {
    owner: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
    admin: 'bg-blue-500/15 border-blue-500/40 text-blue-300',
    moderator: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
};

/** What a role lets someone do, in plain words — shown before anyone is given it. */
export function grantConsequence(name: string, role: MemberNodeRole, self = false): string {
    const their = self ? 'your' : 'their';
    switch (role) {
        case 'owner':
            return `${name} will be able to open these Settings with ${their} own key and do everything here — including adding and removing owners, admins and moderators.`;
        case 'admin':
            return `${name} will be able to open these Settings with ${their} own key and run the community day to day — members, moderation, invites and backups — but not add or remove owners, admins or moderators.`;
        case 'moderator':
            return `${name} will be listed as a moderator. For now that is a label only: it does not open these Settings or give any extra powers.`;
    }
}

export function shortKey(pubkey: string): string {
    return pubkey.length > 18 ? `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}` : pubkey;
}

/** A pasted key, not a callsign: long, and no spaces. The node checks it is a real member. */
function looksLikeKey(text: string): boolean {
    return text.length >= 32 && !/\s/.test(text);
}

/** Day-precision ISO date, or 0 when the node sent none (never active, or an older node). */
function lastActiveMs(m: MemberItem): number {
    const t = typeof m.lastActiveAt === 'string' ? Date.parse(m.lastActiveAt) : NaN;
    return Number.isNaN(t) ? 0 : t;
}

/**
 * Every member the search matches, none left out: callsigns that start with the text first, then callsigns that
 * contain it, then a key that starts with it (6+ characters). Within each group, the most recently active first,
 * then by callsign. Treasuries and SYSTEM are never candidates.
 */
export function matchMembers(members: MemberItem[], query: string): MemberItem[] {
    const q = query.trim().toLowerCase();
    if (!q || looksLikeKey(query.trim())) return [];
    const ranked: { m: MemberItem; rank: number }[] = [];
    for (const m of members) {
        if (m.isTreasury || (m.callsign || '').toUpperCase() === 'SYSTEM') continue;
        const name = (m.callsign || '').toLowerCase();
        const k = (m.publicKey || m.pubkey || '').toLowerCase();
        const rank = name.startsWith(q) ? 0 : name.includes(q) ? 1 : q.length >= 6 && k.startsWith(q) ? 2 : -1;
        if (rank >= 0) ranked.push({ m, rank });
    }
    return ranked
        .sort((a, b) =>
            a.rank - b.rank
            || lastActiveMs(b.m) - lastActiveMs(a.m)
            || (a.m.callsign || '').localeCompare(b.m.callsign || ''))
        .map((r) => r.m);
}

function formatWhen(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

type Target = { pubkey: string; name: string; currentRole: MemberNodeRole | null };
type Notice = { kind: 'success' | 'error'; text: string };

export function NodeRolesPanel({ activeNode, members, viewer, onChanged }: NodeRolesPanelProps) {
    const [roles, setRoles] = useState<NodeRoleRecord[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [busy, setBusy] = useState(false);

    const [query, setQuery] = useState('');
    const [target, setTarget] = useState<Target | null>(null);
    const [newRole, setNewRole] = useState<MemberNodeRole>('admin');
    const [confirmingAdd, setConfirmingAdd] = useState(false);
    const [removing, setRemoving] = useState<NodeRoleRecord | null>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const noticeRef = useRef<HTMLDivElement>(null);

    const tfa = getTfaSessionToken(activeNode.id);
    const myKey = viewer.kind === 'key' ? viewer.memberPubkey : null;
    const canManage = viewer.kind === 'password' || viewer.role === 'owner';

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setRoles(await fetchNodeRoles(activeNode.url, activeNode.adminPassword, tfa));
            setLoadError(null);
        } catch (e: any) {
            setLoadError(e?.message || 'Could not load the list');
        } finally {
            setLoading(false);
        }
    }, [activeNode.url, activeNode.adminPassword, tfa]);

    useEffect(() => { void load(); }, [load]);

    // The notice sits above the list; after acting on a row far below, bring the node's answer into view.
    useEffect(() => {
        if (notice) noticeRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }, [notice]);

    const memberByKey = useMemo(() => {
        const map = new Map<string, MemberItem>();
        for (const m of members) {
            const k = m.publicKey || m.pubkey;
            if (k) map.set(k, m);
        }
        return map;
    }, [members]);

    const roleByKey = useMemo(() => new Map((roles || []).map((r) => [r.member_pubkey, r.role])), [roles]);

    const nameOf = (pubkey: string, callsign?: string | null): string =>
        callsign || memberByKey.get(pubkey)?.callsign || shortKey(pubkey);

    const grantedByText = (grantedBy: string | null): string => {
        if (!grantedBy) return 'unknown';
        if (grantedBy === 'owner:password') return 'the admin password';
        if (grantedBy === 'break-glass:enrolment') return 'a break-glass code';
        if (grantedBy === 'SYSTEM') return 'the node itself';
        return grantedBy === myKey ? 'you' : nameOf(grantedBy);
    };

    const noOwner = roles !== null && !roles.some((r) => r.role === 'owner');
    // With no owner yet the node lets any signed-in admin make the first one, so the form is offered to everyone.
    const showAdd = roles !== null && (canManage || noOwner);

    // Every match, never capped: the list scrolls inside itself, and the count says how many there are.
    const suggestions = useMemo(() => matchMembers(members, query), [members, query]);

    const pick = (pubkey: string, role: MemberNodeRole | null = null) => {
        setTarget({ pubkey, name: nameOf(pubkey), currentRole: roleByKey.get(pubkey) || null });
        if (role) setNewRole(role);
        setQuery('');
        setConfirmingAdd(false);
        setNotice(null);
    };

    const resetAdd = () => {
        setTarget(null);
        setConfirmingAdd(false);
        setQuery('');
        setNewRole('admin');
    };

    const addYourself = () => {
        if (myKey) {
            pick(myKey, 'owner');
            setConfirmingAdd(true);
        } else {
            setNewRole('owner');
            searchRef.current?.focus();
        }
    };

    const doGrant = async () => {
        if (!target) return;
        setBusy(true);
        setNotice(null);
        try {
            await grantNodeRoleApi(activeNode.url, target.pubkey, newRole, activeNode.adminPassword, tfa);
            const who = target.pubkey === myKey ? 'You are' : `${target.name} is`;
            setNotice({ kind: 'success', text: `${who} now ${ROLE_ARTICLE[newRole]}.` });
            resetAdd();
            await load();
            onChanged?.();
        } catch (e: any) {
            setNotice({ kind: 'error', text: e?.message || 'The node did not accept that.' });
            setConfirmingAdd(false);
        } finally {
            setBusy(false);
        }
    };

    const doRevoke = async () => {
        if (!removing) return;
        const name = nameOf(removing.member_pubkey, removing.callsign);
        setBusy(true);
        setNotice(null);
        try {
            await revokeNodeRoleApi(activeNode.url, removing.member_pubkey, removing.role, activeNode.adminPassword, tfa);
            setNotice({ kind: 'success', text: `${name} is no longer ${ROLE_ARTICLE[removing.role]}.` });
            setRemoving(null);
            await load();
            onChanged?.();
        } catch (e: any) {
            setNotice({ kind: 'error', text: e?.message || 'The node did not accept that.' });
            setRemoving(null);
        } finally {
            setBusy(false);
        }
    };

    const btn = 'min-h-[48px] px-4 py-2 rounded-xl text-sm font-bold border transition-all disabled:opacity-50';

    return (
        <div className="space-y-5 max-w-4xl font-sans" data-testid="node-roles-panel">
            {/* What this is */}
            <div className="p-4 sm:p-5 rounded-2xl bg-nature-900/80 border border-nature-800 space-y-2">
                <h3 className="text-base font-bold text-white m-0">Owners &amp; admins</h3>
                <p className="text-sm text-nature-300 m-0">
                    The people who run this node. <strong className="text-white">Owners</strong> can do everything here, including adding and removing
                    other owners and admins. <strong className="text-white">Admins</strong> run the community day to day. Each person holds one role at most.
                </p>
                <p className="text-xs text-nature-400 m-0">
                    The node checks every change: only an owner can add or remove owners and admins, the last owner can't be removed,
                    and anyone suspended or removed from the community loses their role.
                </p>
                {!canManage && (
                    <p className="text-xs text-amber-300 m-0" data-testid="roles-read-only">
                        You're signed in as an admin, so this list is read-only. Ask an owner to make changes.
                    </p>
                )}
            </div>

            {notice && (
                <div
                    ref={noticeRef}
                    role={notice.kind === 'error' ? 'alert' : 'status'}
                    className={`p-3 rounded-xl border text-sm flex items-start justify-between gap-3 ${
                        notice.kind === 'error'
                            ? 'bg-red-500/10 border-red-500/30 text-red-300'
                            : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    }`}
                >
                    <span>
                        {notice.kind === 'error' ? <>Not done. The node said: <strong>{notice.text}</strong></> : notice.text}
                    </span>
                    <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="min-w-[48px] min-h-[48px] -m-3 font-bold">✕</button>
                </div>
            )}

            {noOwner && (
                <div className="p-4 sm:p-5 rounded-2xl bg-amber-500/10 border border-amber-500/40 space-y-3" data-testid="no-owner-banner">
                    <p className="text-base font-bold text-amber-200 m-0">This community has no owner yet — add yourself</p>
                    <p className="text-sm text-amber-100/80 m-0">
                        {myKey
                            ? 'You are signed in with your own key, so you can make yourself the owner in one step.'
                            : 'You are signed in with the admin password. Search for your own callsign below and choose Owner.'}
                    </p>
                    <button type="button" onClick={addYourself} className={`${btn} bg-amber-500 text-black border-amber-400`}>
                        {myKey ? 'Make me the owner' : 'Find myself'}
                    </button>
                </div>
            )}

            {/* The list */}
            <div className="p-4 sm:p-5 rounded-2xl bg-nature-900/80 border border-nature-800 space-y-3">
                <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-2">
                    <h4 className="text-sm font-bold text-nature-200 uppercase tracking-wider m-0 min-w-0">
                        Current roles{roles ? ` (${roles.length})` : ''}
                    </h4>
                    <button type="button" onClick={() => void load()} disabled={loading} className={`${btn} bg-nature-800 text-nature-200 border-nature-700`}>
                        {loading ? 'Loading…' : 'Refresh'}
                    </button>
                </div>

                {loadError && (
                    <p role="alert" className="text-sm text-red-300 m-0">Couldn't load the list. The node said: <strong>{loadError}</strong></p>
                )}
                {roles && roles.length === 0 && !loadError && (
                    <p className="text-sm text-nature-400 m-0">Nobody holds a role yet.</p>
                )}

                <ul className="space-y-2 m-0 p-0 list-none">
                    {(roles || []).map((r) => {
                        const name = nameOf(r.member_pubkey, r.callsign);
                        const isMe = r.member_pubkey === myKey;
                        const isRemoving = removing?.member_pubkey === r.member_pubkey;
                        return (
                            <li key={r.member_pubkey} className="p-3 rounded-xl bg-nature-950 border border-nature-800 space-y-2" data-testid={`role-row-${r.member_pubkey}`}>
                                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-base font-bold text-white break-words min-w-0">{name}</span>
                                            {isMe && <span className="text-xs text-nature-400">(you)</span>}
                                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-bold ${ROLE_BADGE[r.role]}`}>
                                                {ROLE_ICON[r.role]} {ROLE_LABEL[r.role]}
                                            </span>
                                        </div>
                                        <div className="text-xs text-nature-400 mt-1 break-words">
                                            <span className="font-mono" title={r.member_pubkey}>{shortKey(r.member_pubkey)}</span>
                                            {' · '}added by {grantedByText(r.granted_by)} on {formatWhen(r.granted_at)}
                                        </div>
                                    </div>
                                    {canManage && !isRemoving && (
                                        <button
                                            type="button"
                                            onClick={() => { setRemoving(r); setNotice(null); }}
                                            disabled={busy}
                                            aria-label={`Remove ${name}'s ${ROLE_LABEL[r.role].toLowerCase()} role`}
                                            className={`${btn} self-start sm:self-auto bg-red-500/10 text-red-300 border-red-500/30`}
                                        >
                                            Remove
                                        </button>
                                    )}
                                </div>

                                {isRemoving && (
                                    <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 space-y-2" data-testid="remove-confirm">
                                        <p className="text-sm text-red-100 m-0">
                                            {name} will no longer be {ROLE_ARTICLE[r.role]} of this community.
                                            {r.role !== 'moderator' && ' They lose access to these Settings straight away.'}
                                            {isMe && ' This is you — you will be signed out of these Settings.'}
                                        </p>
                                        <div className="flex flex-wrap gap-2">
                                            <button type="button" onClick={() => void doRevoke()} disabled={busy} className={`${btn} bg-red-600 text-white border-red-500`}>
                                                {busy ? 'Removing…' : `Yes, remove ${ROLE_LABEL[r.role].toLowerCase()}`}
                                            </button>
                                            <button type="button" onClick={() => setRemoving(null)} disabled={busy} className={`${btn} bg-nature-800 text-nature-200 border-nature-700`}>
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </div>

            {/* Add someone */}
            {showAdd && (
                <div className="p-4 sm:p-5 rounded-2xl bg-nature-900/80 border border-nature-800 space-y-3" data-testid="add-role">
                    <h4 className="text-sm font-bold text-nature-200 uppercase tracking-wider m-0">Add someone</h4>

                    {!target ? (
                        <div className="space-y-2">
                            <label htmlFor="role-member-search" className="block text-sm text-nature-300">
                                Search by callsign, or paste their full public key
                            </label>
                            <input
                                id="role-member-search"
                                ref={searchRef}
                                type="text"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                                placeholder="e.g. Marty"
                                className="w-full min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-base text-white focus:outline-none focus:border-terra-500"
                            />
                            {looksLikeKey(query.trim()) && (
                                <button
                                    type="button"
                                    onClick={() => pick(query.trim())}
                                    className={`${btn} w-full text-left bg-nature-950 text-nature-100 border-nature-700 break-all`}
                                >
                                    Use this key{memberByKey.get(query.trim())?.callsign ? ` (${memberByKey.get(query.trim())?.callsign})` : ''}: <span className="font-mono">{shortKey(query.trim())}</span>
                                </button>
                            )}
                            {suggestions.length > 0 && (
                                <>
                                    <p className="text-sm text-nature-300 m-0" data-testid="match-count" aria-live="polite">
                                        {suggestions.length === 1
                                            ? '1 member matches.'
                                            : `${suggestions.length} members match${suggestions.length > 4 ? ': scroll the list to see them all' : ''}.`}
                                    </p>
                                    <ul
                                        className="m-0 p-1 list-none space-y-1 max-h-[22rem] overflow-y-auto overflow-x-hidden overscroll-contain rounded-xl border border-nature-800"
                                        aria-label="Matching members"
                                        data-testid="match-list"
                                    >
                                        {suggestions.map((m) => {
                                            const k = (m.publicKey || m.pubkey) as string;
                                            const held = roleByKey.get(k);
                                            const status = typeof m.status === 'string' && m.status !== 'active' ? m.status : null;
                                            return (
                                                <li key={k}>
                                                    <button
                                                        type="button"
                                                        onClick={() => pick(k)}
                                                        className={`${btn} w-full text-left flex flex-col items-start gap-0.5 bg-nature-950 text-nature-100 border-nature-800 hover:border-terra-500/50`}
                                                    >
                                                        <span className="break-words min-w-0 max-w-full">
                                                            {m.callsign || shortKey(k)}
                                                            {k === myKey && <span className="text-nature-400 font-normal"> (you)</span>}
                                                            {status && <span className="text-amber-300 font-normal"> ({status})</span>}
                                                        </span>
                                                        <span className="text-xs text-nature-400 font-normal flex flex-wrap gap-x-2">
                                                            <span className="font-mono">{shortKey(k)}</span>
                                                            {held && <span>{ROLE_ICON[held]} {ROLE_LABEL[held]}</span>}
                                                        </span>
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </>
                            )}
                            {query.trim() && !looksLikeKey(query.trim()) && suggestions.length === 0 && (
                                <p className="text-sm text-nature-400 m-0" data-testid="no-match">No one matches “{query.trim()}”. You can paste their full public key instead.</p>
                            )}
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div className="flex flex-wrap items-center gap-2 text-sm text-nature-200">
                                <span>Adding</span>
                                <strong className="text-white break-words min-w-0">{target.pubkey === myKey ? `${target.name} (you)` : target.name}</strong>
                                <span className="font-mono text-xs text-nature-400">{shortKey(target.pubkey)}</span>
                                <button type="button" onClick={resetAdd} disabled={busy} className="min-h-[48px] px-2 text-sm text-terra-400 underline">
                                    Change
                                </button>
                            </div>

                            <fieldset className="border-0 p-0 m-0 space-y-2">
                                <legend className="text-sm text-nature-300 mb-1">Role</legend>
                                <div className="flex flex-wrap gap-2">
                                    {(['owner', 'admin', 'moderator'] as MemberNodeRole[]).map((role) => (
                                        <label
                                            key={role}
                                            className={`${btn} cursor-pointer flex items-center gap-2 ${
                                                newRole === role ? ROLE_BADGE[role] : 'bg-nature-950 text-nature-300 border-nature-700'
                                            }`}
                                        >
                                            <input
                                                type="radio"
                                                name="node-role"
                                                value={role}
                                                checked={newRole === role}
                                                onChange={() => { setNewRole(role); setConfirmingAdd(false); }}
                                                className="sr-only"
                                            />
                                            {ROLE_ICON[role]} {ROLE_LABEL[role]}
                                        </label>
                                    ))}
                                </div>
                            </fieldset>

                            {!confirmingAdd ? (
                                <button type="button" onClick={() => setConfirmingAdd(true)} className={`${btn} bg-terra-500 text-white border-terra-400`}>
                                    Continue
                                </button>
                            ) : (
                                <div className="p-3 rounded-xl bg-nature-950 border border-terra-500/40 space-y-2" data-testid="add-confirm">
                                    <p className="text-sm text-nature-100 m-0">
                                        {target.pubkey === myKey ? grantConsequence('You', newRole, true) : grantConsequence(target.name, newRole)}
                                    </p>
                                    {target.currentRole && target.currentRole !== newRole && (
                                        <p className="text-sm text-amber-300 m-0">This replaces their current role ({ROLE_LABEL[target.currentRole].toLowerCase()}).</p>
                                    )}
                                    <div className="flex flex-wrap gap-2">
                                        <button type="button" onClick={() => void doGrant()} disabled={busy} className={`${btn} bg-terra-500 text-white border-terra-400`}>
                                            {busy ? 'Saving…' : `Yes, make ${target.pubkey === myKey ? 'me' : target.name} ${ROLE_ARTICLE[newRole]}`}
                                        </button>
                                        <button type="button" onClick={() => setConfirmingAdd(false)} disabled={busy} className={`${btn} bg-nature-800 text-nature-200 border-nature-700`}>
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
