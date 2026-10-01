import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    fetchBurst,
    fetchBurstDigest,
    hideBurstPosts,
    removeBurstAccounts,
    undoBurstHide,
    type Burst,
    type BurstAccount,
    type BurstDigest,
} from '../../lib/node-client';

/**
 * Clean-up by burst (server: engine/burst-cleanup.ts), on the global community: from one account, the others that joined
 * from the same connection within a day of it, to hide all their posts (which can be undone) or, for owners and admins,
 * remove them together. The node never says anything about the connection itself, and neither does this screen.
 *
 * The guard against taking out a real crowd (a carrier's shared address can put real people in one burst): the list
 * shows each account's standing; accounts that are established or hold a role start unticked; the confirmation restates
 * how many and their standing, and a removal asks for the number to be typed. The node holds the same line: it acts on
 * exactly the accounts sent, and refuses an established one unless told.
 */

export interface BurstCredentials {
    adminPassword?: string;
    tfaToken?: string;
}

function when(iso: string): string {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? '' : t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const accounts = (n: number) => (n === 1 ? '1 account' : `${n} accounts`);
const posts = (n: number) => (n === 1 ? '1 post' : `${n} posts`);
const byWhom = (by: string) => (by === 'moderator' ? 'a moderator' : by === 'admin' ? 'an admin' : 'an owner');
const btn = 'min-h-[48px] px-4 rounded-xl text-sm font-bold transition-colors disabled:opacity-50';

/** Ticked to start with: still here, no role, not established. */
const startsTicked = (a: BurstAccount) => a.status !== 'removed' && !a.holdsRole && !a.established;
const tickable = (a: BurstAccount) => a.status !== 'removed' && !a.holdsRole;

export interface BurstPanelProps extends BurstCredentials {
    nodeUrl: string;
    /** The account the burst is opened from. */
    anchor: string;
    /** Owners and admins: offer to remove the accounts too. */
    canRemove: boolean;
    onClose: () => void;
    /** After an action, so the digest and the reports can load again. */
    onChanged?: () => void;
}

export function BurstPanel({ nodeUrl, anchor, canRemove, adminPassword, tfaToken, onClose, onChanged }: BurstPanelProps) {
    const [burst, setBurst] = useState<Burst | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [ticked, setTicked] = useState<Set<string>>(new Set());
    const [confirming, setConfirming] = useState<'hide' | 'remove' | null>(null);
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<string | null>(null);
    const panel = useRef<HTMLElement>(null);

    // Opened from a report further down the page: bring it into view.
    useEffect(() => { panel.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); }, [anchor]);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const b = await fetchBurst(nodeUrl, anchor, adminPassword, tfaToken);
            setBurst(b);
            setTicked(new Set([b.account, ...b.others].filter(startsTicked).map(a => a.publicKey)));
        } catch (e: unknown) {
            setBurst(null);
            setError(e instanceof Error ? e.message : 'Could not load the accounts');
        } finally {
            setLoading(false);
        }
    }, [nodeUrl, anchor, adminPassword, tfaToken]);

    useEffect(() => { void load(); }, [load]);

    const all = useMemo(() => (burst ? [burst.account, ...burst.others] : []), [burst]);
    const chosen = all.filter(a => ticked.has(a.publicKey));
    const established = chosen.filter(a => a.established);
    const standings = chosen.map(a => a.standing);
    const range = standings.length === 0 ? '' : Math.min(...standings) === Math.max(...standings)
        ? `${Math.min(...standings)}` : `${Math.min(...standings)} to ${Math.max(...standings)}`;

    const toggle = (pk: string) => setTicked(prev => {
        const next = new Set(prev);
        if (next.has(pk)) next.delete(pk); else next.add(pk);
        return next;
    });

    const act = async (kind: 'hide' | 'remove') => {
        setBusy(true);
        setError(null);
        const members = chosen.map(a => a.publicKey);
        try {
            if (kind === 'hide') {
                const r = await hideBurstPosts(nodeUrl, anchor, members, established.length > 0, adminPassword, tfaToken);
                setDone(`Hid ${posts(r.action.posts)} of ${accounts(r.action.accounts)}. You can undo it from the list at the top.`);
            } else {
                const r = await removeBurstAccounts(nodeUrl, anchor, members, established.length > 0, adminPassword, tfaToken);
                setDone(`Removed ${accounts(r.removed)}.${r.failed.length ? ` ${accounts(r.failed.length)} could not be removed: ${r.failed[0].error}` : ''}`);
            }
            setConfirming(null);
            setTyped('');
            onChanged?.();
            await load();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'That did not work');
            setConfirming(null);
        } finally {
            setBusy(false);
        }
    };

    const name = burst?.account.callsign || 'this account';

    return (
        <section ref={panel} aria-label="Accounts that joined together" data-testid="burst-panel"
            className="p-4 rounded-2xl bg-nature-900/80 border border-amber-700/60 space-y-3 break-words">
            <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-bold text-white m-0 flex-1 min-w-0">
                    Joined from the same connection within a day{burst ? ` as ${name}` : ''}
                </h2>
                <button type="button" onClick={onClose} className={`${btn} bg-nature-800 hover:bg-nature-700 text-nature-100`}>Close</button>
            </div>

            {loading && !burst && <p role="status" className="text-sm text-nature-400 m-0">Loading…</p>}
            {error && <p role="alert" className="text-sm font-semibold text-red-300 m-0">{error}</p>}
            {done && <p role="status" className="text-sm font-semibold text-emerald-300 m-0">{done}</p>}

            {burst && !burst.joinedThroughDoor && (
                <p className="text-sm text-nature-300 m-0">{name} did not join through the open door, so no other accounts are linked to them.</p>
            )}

            {burst && burst.joinedThroughDoor && (
                <>
                    <p className="text-sm text-nature-300 m-0">
                        {burst.others.length === 0
                            ? `No other account still here joined from the same connection within a day as ${name}.`
                            : `${accounts(burst.others.length)} joined from the same connection within a day as ${name}.`}
                        {burst.removedAlready > 0 ? ` ${burst.removedAlready} more ${burst.removedAlready === 1 ? 'was' : 'were'} removed already.` : ''}
                        {' '}A shared connection can be a household, a meetup or a phone network: check each one before you act.
                    </p>
                    <ul className="list-none p-0 m-0 space-y-2">
                        {all.map((a, i) => (
                            <li key={a.publicKey} data-testid="burst-account"
                                className="flex items-start gap-3 p-3 rounded-xl bg-nature-950 border border-nature-800">
                                <input
                                    type="checkbox"
                                    className="mt-1 h-6 w-6 shrink-0"
                                    aria-label={`Include ${a.callsign || 'this account'}`}
                                    checked={ticked.has(a.publicKey)}
                                    disabled={!tickable(a) || busy}
                                    onChange={() => toggle(a.publicKey)}
                                />
                                <div className="min-w-0 flex-1 space-y-1">
                                    <p className="text-sm font-bold text-white m-0">
                                        {a.callsign || 'A member'}{i === 0 ? ' (this account)' : ''}
                                        {a.status === 'suspended' ? ' · suspended' : a.status === 'removed' ? ' · removed' : ''}
                                    </p>
                                    <p className="text-xs text-nature-300 m-0">
                                        Joined {when(a.joinedAt)} · standing {a.standing} ({a.standingParts.weeks} weeks, {a.standingParts.keptPosts} kept posts, {a.standingParts.dealPartners} deals)
                                    </p>
                                    <p className="text-xs text-nature-400 m-0">
                                        {posts(a.postsUp)} up · {a.postsHidden} hidden{a.openReports > 0 ? ` · ${a.openReports} open ${a.openReports === 1 ? 'report' : 'reports'}` : ''}
                                    </p>
                                    {(a.established || a.holdsRole) && (
                                        <p className="text-xs font-semibold text-amber-300 m-0">
                                            {a.holdsRole ? 'Holds a role here: never included.' : `Established (standing ${burst.establishedStanding} or more): left out unless you tick them.`}
                                        </p>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>

                    {!confirming && (
                        <div className="space-y-2">
                            <p className="text-sm text-nature-200 m-0" data-testid="burst-summary">
                                {chosen.length === 0 ? 'No account ticked.' : `${accounts(chosen.length)} ticked, standing ${range}${established.length ? `, ${established.length} established` : ''}.`}
                            </p>
                            <div className="flex flex-wrap gap-2">
                                <button type="button" disabled={busy || chosen.length === 0} onClick={() => setConfirming('hide')}
                                    className={`${btn} bg-amber-700 hover:bg-amber-600 text-white`}>
                                    Hide their posts
                                </button>
                                {canRemove && (
                                    <button type="button" disabled={busy || chosen.length === 0} onClick={() => { setTyped(''); setConfirming('remove'); }}
                                        className={`${btn} bg-red-900/80 hover:bg-red-800 border border-red-700 text-white`}>
                                        Remove them
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {confirming && (
                        <div role="group" aria-label="Confirm" className="space-y-3 p-3 rounded-xl bg-nature-950 border border-nature-700">
                            <p className="text-sm font-semibold text-white m-0" data-testid="burst-confirm">
                                {confirming === 'hide'
                                    ? `Hide every post of ${accounts(chosen.length)}, standing ${range}?`
                                    : `Remove ${accounts(chosen.length)}, standing ${range}, for good?`}
                                {established.length > 0
                                    ? ` ${established.length === 1 ? 'One is' : `${established.length} are`} established: ${established.map(a => `${a.callsign || 'a member'} (${a.standing})`).join(', ')}.`
                                    : ''}
                            </p>
                            <p className="text-xs text-nature-300 m-0">
                                {confirming === 'hide'
                                    ? 'Nobody but them and the moderators sees those posts until you undo it. Each of them is told their posts are hidden for review, never why or by whom.'
                                    : 'Each is removed as removing one member removes them: their posts come down, their key stops working, and the sign-in they joined with can\'t join again. This can\'t be undone.'}
                            </p>
                            {confirming === 'remove' && (
                                <label className="block text-sm font-semibold text-nature-200">
                                    Type {chosen.length} to confirm
                                    <input
                                        inputMode="numeric"
                                        value={typed}
                                        onChange={(e) => setTyped(e.target.value)}
                                        className="mt-1 block w-full min-h-[48px] bg-nature-900 border border-nature-700 rounded-xl px-3 text-sm text-white"
                                    />
                                </label>
                            )}
                            <div className="flex flex-wrap gap-2">
                                <button type="button"
                                    disabled={busy || (confirming === 'remove' && typed.trim() !== String(chosen.length))}
                                    onClick={() => void act(confirming)}
                                    className={`${btn} ${confirming === 'hide' ? 'bg-amber-700 hover:bg-amber-600' : 'bg-red-700 hover:bg-red-600'} text-white`}>
                                    {busy ? 'Working…' : confirming === 'hide' ? `Hide the posts of ${accounts(chosen.length)}` : `Remove ${accounts(chosen.length)}`}
                                </button>
                                <button type="button" disabled={busy} onClick={() => setConfirming(null)}
                                    className={`${btn} bg-nature-800 hover:bg-nature-700 text-nature-100`}>
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}

export interface BurstDigestCardProps extends BurstCredentials {
    nodeUrl: string;
    /** Open a burst from this account. */
    onOpen: (pubkey: string) => void;
    /** Changes when something was done elsewhere, so the digest loads again. */
    reloadKey?: number;
    /** Told whether this node has bursts at all (its door labels joins), so the reports offer to open one only there. */
    onAvailability?: (available: boolean) => void;
}

/**
 * One line per recent burst big enough to notice, and one per action taken lately, with the undo for a hide. Nothing at
 * all on a node with no open door, or with nothing to say.
 */
export function BurstDigestCard({ nodeUrl, adminPassword, tfaToken, onOpen, reloadKey = 0, onAvailability }: BurstDigestCardProps) {
    const [digest, setDigest] = useState<BurstDigest | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const d = await fetchBurstDigest(nodeUrl, adminPassword, tfaToken);
            setDigest(d);
            setError(null);
            onAvailability?.(d !== null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Could not load the accounts that joined together');
        }
    }, [nodeUrl, adminPassword, tfaToken, onAvailability]);

    useEffect(() => { void load(); }, [load, reloadKey]);

    const undo = async (id: string) => {
        setBusy(id);
        setError(null);
        try {
            const r = await undoBurstHide(nodeUrl, id, adminPassword, tfaToken);
            setNote(`${posts(r.restored)} back.${r.keptHidden ? ` ${r.keptHidden === 1 ? '1 post stays' : `${r.keptHidden} posts stay`} hidden, because reports would hide ${r.keptHidden === 1 ? 'it' : 'them'} now.` : ''}`);
            await load();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'That did not work');
        } finally {
            setBusy(null);
        }
    };

    if (error && !digest) return <p role="alert" className="text-sm font-semibold text-red-300 m-0">{error}</p>;
    if (!digest || (digest.bursts.length === 0 && digest.actions.length === 0)) return null;

    return (
        <section aria-label="Accounts that joined together lately" data-testid="burst-digest"
            className="p-4 rounded-2xl bg-nature-900/80 border border-nature-800 space-y-3 break-words">
            <h2 className="text-base font-bold text-white m-0">Accounts that joined together</h2>
            {error && <p role="alert" className="text-sm font-semibold text-red-300 m-0">{error}</p>}
            {note && <p role="status" className="text-sm font-semibold text-emerald-300 m-0">{note}</p>}
            {digest.bursts.length > 0 && (
                <ul className="list-none p-0 m-0 space-y-2">
                    {digest.bursts.map((b, i) => (
                        <li key={`${b.firstJoinAt}-${i}`} data-testid="burst-line" className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-nature-950 border border-nature-800">
                            <p className="text-sm text-nature-100 m-0 flex-1 min-w-0">
                                {accounts(b.accounts)} joined from the same connection within a day, from {when(b.firstJoinAt)}.
                                {b.reported ? ` ${b.reported} reported.` : ''}
                                {b.postsHidden ? ` ${posts(b.postsHidden)} hidden.` : ''}
                                {b.removed ? ` ${b.removed} removed.` : ''}
                            </p>
                            {b.open && (
                                <button type="button" onClick={() => onOpen(b.open!.publicKey)} className={`${btn} bg-nature-800 hover:bg-nature-700 text-white`}>
                                    See them
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {digest.actions.length > 0 && (
                <ul className="list-none p-0 m-0 space-y-2">
                    {digest.actions.map(a => (
                        <li key={a.id} data-testid="burst-action" className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-nature-950 border border-nature-800">
                            <p className="text-sm text-nature-200 m-0 flex-1 min-w-0">
                                {a.kind === 'hide' ? `Hid ${posts(a.posts)} of ${accounts(a.accounts)}` : `Removed ${accounts(a.accounts)}`}
                                {a.account?.callsign ? ` that joined with ${a.account.callsign}` : ''}, by {byWhom(a.by)}, {when(a.at)}.
                                {a.undoneAt ? ` Undone ${when(a.undoneAt)}.` : ''}
                            </p>
                            {a.kind === 'hide' && !a.undoneAt && (
                                <button type="button" disabled={busy !== null} onClick={() => void undo(a.id)}
                                    className={`${btn} bg-nature-800 hover:bg-nature-700 text-white`}>
                                    {busy === a.id ? 'Undoing…' : 'Undo'}
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
