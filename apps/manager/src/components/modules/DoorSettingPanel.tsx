import React, { useEffect, useId, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { GATED_LOOK, gatedProps, guardGated } from '../../lib/gated-control';
import { buildAdminHeaders, fetchNodeRoles, getTfaSessionToken, resolveNodeApiUrl } from '../../lib/node-client';
import type { RolesViewer } from './NodeRolesPanel';
import { nodeCredential } from '../../lib/profiles';
import { passwordField } from '../../lib/node-client';

/**
 * People & Safety → Invites & QR → "Who may invite": the door (community modes slice 1; apps/server config/door.ts).
 *
 * Two presets, each one setting of the door: **Invite** (any member invites, every community until now and the default)
 * and **Known** (only owners and admins invite, said plainly as "only admins invite"). Known's words point to the names
 * list (community modes slice 2), which opens in the app on an owner's or admin's phone and needs their key: a password
 * session here can't read it (design §4.3). The global node's door is open: anyone joins with a sign-in and nobody invites, which
 * its profile sets, so it is shown and not offered. A local community can't open its door: the node refuses it.
 *
 * Read from /api/node/config (`door`, public); a node older than the door says nothing, and nothing is shown. Saved as
 * How this community works' `join` (POST /api/local/admin/community-shape, the one place it changes: logged, the owners
 * alerted, every member told), by an owner (the password is an owner's): an admin sees the setting and why it isn't
 * theirs to change, and the node refuses an admin anyway. A role, never a tier. The page "How this community works"
 * replaces this panel (slice S4).
 *
 * While no new members are being taken (`join` is `paused`: the `invites` switch off), the door still reads members or
 * admins, and `join` set to either takes new members again (#2415 review r4360287590). So whether it is paused is read
 * from the shape (GET /api/local/admin/community-shape): a paused community says so, marks no door as the one in use and
 * says before the save that saving takes new members again. A node that won't say is offered no save: never on a guess.
 *
 * Where who can join is locked (the shape's `join.lock`: the private preview makes the door admins whatever the row says,
 * and a door set open that the ledger keeps shut), the node refuses any change, and under the preview `door` reads admins
 * while the row may say members, so a pick equal to the row would answer 200 with nothing changed (#2415 review
 * r4360594247). So a lock is said first, in the server's own words with what would unlock it, and no save is offered. And a
 * save says members were told only when the node says it told them (`told`).
 *
 * Operator manual text for this screen: packages/beanpool-guide/operators/people/members-and-invites.md.
 */

export type Door = 'open' | 'members' | 'admins';
type CommunityDoor = Exclude<Door, 'open'>;

export function readDoor(v: unknown): Door | null {
    return v === 'open' || v === 'members' || v === 'admins' ? v : null;
}

export const DOOR_PRESETS: ReadonlyArray<{ door: CommunityDoor; name: string; plain: string; detail: string }> = [
    {
        door: 'members',
        name: 'Invite',
        plain: 'any member invites',
        detail: 'Any member can make an invite, from the app or the web app, and answer a request to join. This is how every community starts.',
    },
    {
        door: 'admins',
        name: 'Known',
        plain: 'only admins invite',
        detail: 'Only owners and admins can make invites and answer requests to join. Members are told to ask an admin, and their app shows no invite to make. '
            + 'Owners and admins can also keep a names list of who the members are: it opens in the BeanPool app on their own phones, signed in with their key, not with this password.',
    },
];

/** Saving a door while new members are paused: what it starts again, in plain words, before it is saved. */
export function unpauseConsequence(to: CommunityDoor): string {
    return to === 'admins'
        ? 'New members will be taken again: only owners and admins can make invites and answer requests to join.'
        : 'New members will be taken again: every member can make invites and answer requests to join.';
}

/** What a switch does to what is already out there, in plain words, before it is saved. */
export function doorChangeConsequence(from: CommunityDoor, to: CommunityDoor): string {
    if (to === 'admins' && from === 'members') {
        return 'Members will stop being able to make invites or answer requests to join. Invite codes already made still work until they expire, 30 days after they were made. A paper ticket a member made on their phone will no longer let anyone in.';
    }
    return 'Every member will be able to make invites and answer requests to join again, including paper tickets made on their phones.';
}

type Status = { kind: 'saved' | 'error'; text: string };

/** The shape's lock on who can join, in the server's words; none where it says none. */
export type JoinLock = { why: string; unlock?: string };

export function readJoinLock(v: unknown): JoinLock | null {
    if (v === null || v === undefined) return null;
    const l = (typeof v === 'object' ? v : {}) as { why?: unknown; unlock?: unknown };
    // A lock the node names but doesn't explain still refuses: say so in plain words, never offer the save.
    const why = typeof l.why === 'string' && l.why.trim() ? l.why : 'This node takes no change to who may invite right now.';
    return typeof l.unlock === 'string' && l.unlock.trim() ? { why, unlock: l.unlock } : { why };
}

export function DoorSettingPanel({ activeNode, viewer }: { activeNode: NodeProfile; viewer: RolesViewer }) {
    const [saved, setSaved] = useState<Door | null>(null);
    // The owner's pick; until they pick, the door in use (none while paused: nobody comes in by it).
    const [picked, setPicked] = useState<CommunityDoor | null>(null);
    // Whether no new members are being taken: null = not read yet, 'unread' = the node would not say.
    const [paused, setPaused] = useState<boolean | 'unread' | null>(null);
    // Why who can join can't be changed here now, if it can't (read with `paused`, from the shape).
    const [lock, setLock] = useState<JoinLock | null>(null);
    const [saving, setSaving] = useState(false);
    // null = not known (not loaded, or the node would not say): never warn on a guess.
    const [nobodyCanAct, setNobodyCanAct] = useState<boolean | null>(null);
    const [status, setStatus] = useState<Status | null>(null);
    const ids = useId();
    const ownerOnlyId = `${ids}-owner-only`;
    const lockedId = `${ids}-locked`;

    // The password is an owner's (NodeRolesPanel); a key session is whatever role it holds.
    const isOwner = viewer.kind === 'password' || viewer.role === 'owner';
    const blocked = !isOwner;

    useEffect(() => {
        let mounted = true;
        setSaved(null);
        setPicked(null);
        setPaused(null);
        setLock(null);
        setStatus(null);
        setNobodyCanAct(null);
        (async () => {
            try {
                const roles = await fetchNodeRoles(activeNode.url, nodeCredential(activeNode), getTfaSessionToken(activeNode.id));
                if (mounted) setNobodyCanAct(!roles.some((r) => r.role === 'owner' || r.role === 'admin'));
            } catch { /* the warning is a courtesy; no answer, no warning */ }
        })();
        (async () => {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/node/config')).catch(() => null);
            if (!res || !res.ok) return;
            const cfg = await res.json().catch(() => ({}));
            const door = readDoor((cfg as { door?: unknown }).door);
            if (!mounted || !door) return;
            setSaved(door);
        })();
        (async () => {
            let join: unknown;
            let joinLock: unknown;
            try {
                const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/community-shape'), {
                    headers: buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
                });
                if (res.ok) {
                    const shapeJoin = ((await res.json()) as { settings?: { join?: { configured?: unknown; lock?: unknown } } })?.settings?.join;
                    join = shapeJoin?.configured;
                    joinLock = shapeJoin?.lock;
                }
            } catch { /* read as 'unread' below */ }
            if (!mounted) return;
            setPaused(join === 'paused' ? true : join === 'members' || join === 'admins' || join === 'open' ? false : 'unread');
            setLock(readJoinLock(joinLock));
        })();
        return () => { mounted = false; };
    }, [activeNode.url, activeNode.id]);

    if (!saved) return null;

    const choice: CommunityDoor | null = picked ?? (saved === 'open' || paused === true ? null : saved);
    // Saving takes new members again while paused, the door it had included; unread or locked, nothing is saved.
    const canSave = !!choice && saved !== 'open' && typeof paused === 'boolean' && !lock && (paused || choice !== saved);
    // Not the owner's, or locked: gated the same way, pointing at whichever reasons hold (lib/gated-control.ts).
    const gated = blocked || !!lock;
    const gatedWhy = [lock ? lockedId : '', blocked ? ownerOnlyId : ''].filter(Boolean).join(' ');

    const save = async () => {
        if (!choice || gated || !canSave) return;
        const wasPaused = paused === true;
        setSaving(true);
        setStatus(null);
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/community-shape'), {
                method: 'POST',
                headers: buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ ...passwordField(nodeCredential(activeNode)), changes: { join: choice } }),
            });
            const body = await res.json().catch(() => ({})) as { error?: unknown; totpRequired?: unknown; told?: unknown };
            if (res.ok && body.told !== 'members') {
                // Who can join always tells every member when it changes, so nobody told is nothing changed.
                setPicked(null);
                setStatus({ kind: 'error', text: 'Nothing changed: the node already had this, so nobody was told.' });
            } else if (res.ok) {
                setSaved(choice);
                setPicked(null);
                setPaused(false);
                setStatus({
                    kind: 'saved',
                    text: wasPaused
                        ? (choice === 'admins' ? 'Saved. New members are taken again: only admins invite, and every member is told.' : 'Saved. New members are taken again: any member invites, and every member is told.')
                        : (choice === 'admins' ? 'Saved. Only admins invite now, and every member is told.' : 'Saved. Any member invites now, and every member is told.'),
                });
            } else {
                setStatus({
                    kind: 'error',
                    text: body.totpRequired === true
                        ? '2FA session expired. Please re-authenticate.'
                        : typeof body.error === 'string' && body.error.trim() ? body.error : 'Not saved: the node refused.',
                });
            }
        } catch (err: unknown) {
            setStatus({ kind: 'error', text: err instanceof Error && err.message ? err.message : 'Not saved: the node could not be reached.' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <section aria-labelledby={`${ids}-title`} className="bg-nature-900/90 border border-nature-800 rounded-2xl p-4 sm:p-6 space-y-4 shadow-xl">
            <div>
                <h3 id={`${ids}-title`} className="text-base font-bold text-white m-0 break-words">🚪 Who may invite</h3>
                <p className="text-xs text-nature-400 m-0 mt-1 leading-relaxed break-words">
                    Who can bring people into this community: make an invite, or answer someone who asks to join.
                </p>
            </div>

            {saved === 'open' ? (
                <p id={`${ids}-open`} className="text-sm text-nature-200 m-0 leading-relaxed break-words">
                    <strong className="text-white">Open:</strong> anyone joins with a sign-in, and nobody makes invites here.
                    This node&apos;s profile sets that, so there is nothing to choose.
                </p>
            ) : (
                <>
                    {lock && (
                        <p id={lockedId} data-testid="door-locked" className="text-sm text-amber-200 m-0 leading-relaxed break-words">
                            <span aria-hidden="true">🔒 </span>{lock.why}
                            {lock.unlock && <span className="block text-xs text-nature-300 mt-1">{lock.unlock}</span>}
                        </p>
                    )}
                    {paused === true && (
                        <p id={`${ids}-paused`} data-testid="door-paused" className="text-sm text-amber-200 m-0 leading-relaxed break-words">
                            <strong className="text-white">Paused:</strong> no new members are being taken for now, so nobody invites and nobody can ask to join.
                            {!lock && ' Saving a choice here takes new members again, and every member is told.'}
                        </p>
                    )}
                    <fieldset className="space-y-3 m-0 p-0 border-0 min-w-0">
                        <legend className="sr-only">Who may invite</legend>
                        {DOOR_PRESETS.map((p) => {
                            const selected = choice === p.door;
                            const optionId = `${ids}-${p.door}`;
                            return (
                                <label
                                    key={p.door}
                                    htmlFor={optionId}
                                    className={`flex items-start gap-3 rounded-xl border p-3 min-h-[48px] cursor-pointer ${
                                        selected ? 'border-terra-500/60 bg-terra-500/10' : 'border-nature-800 bg-nature-950'
                                    } ${gated ? 'cursor-not-allowed' : ''}`}
                                >
                                    <input
                                        id={optionId}
                                        type="radio"
                                        name={`${ids}-door`}
                                        value={p.door}
                                        checked={selected}
                                        {...gatedProps(gated, gatedWhy)}
                                        onClick={guardGated(gated)}
                                        onChange={guardGated(gated, () => { setPicked(p.door); setStatus(null); })}
                                        className={`mt-1 accent-terra-500 shrink-0 ${gated ? GATED_LOOK : ''}`}
                                    />
                                    <span className="min-w-0">
                                        <span className="block text-sm font-bold text-white break-words">
                                            {p.name}: {p.plain}
                                            {saved === p.door && <span className="ml-2 text-[11px] font-bold text-nature-400">{paused === true ? '(before the pause)' : '(now)'}</span>}
                                        </span>
                                        <span className="block text-xs text-nature-300 mt-0.5 leading-relaxed break-words">{p.detail}</span>
                                        {p.door === 'admins' && nobodyCanAct === true && (
                                            <span role="note" data-testid="door-no-admins-warning" className="block text-xs text-amber-200 mt-1 leading-relaxed break-words">
                                                Nobody here is an owner or admin in the app yet. Give someone that role first (People &amp; Safety), or requests to join will wait with nobody to answer them.
                                            </span>
                                        )}
                                    </span>
                                </label>
                            );
                        })}
                    </fieldset>

                    {choice && paused === true && (
                        <p id={`${ids}-unpause`} className="text-xs text-amber-200 m-0 leading-relaxed break-words">
                            {unpauseConsequence(choice)}
                        </p>
                    )}
                    {choice && choice !== saved && (
                        <p id={`${ids}-consequence`} className="text-xs text-amber-200 m-0 leading-relaxed break-words">
                            {doorChangeConsequence(saved as CommunityDoor, choice)}
                        </p>
                    )}

                    {!blocked && paused === 'unread' && (
                        <p id={`${ids}-unread`} className="text-xs text-nature-400 m-0 leading-relaxed break-words">
                            Couldn&apos;t check whether new members are being taken here, and saving would take them again if they aren&apos;t, so this can&apos;t be saved yet. Reload to try again.
                        </p>
                    )}

                    {blocked && (
                        <p id={ownerOnlyId} className="text-xs text-nature-400 m-0 leading-relaxed break-words">
                            Only an owner of this community can change who may invite.
                        </p>
                    )}

                    <div className="flex flex-wrap items-center gap-3">
                        <button
                            type="button"
                            {...gatedProps(gated, gatedWhy)}
                            onClick={guardGated(gated, () => { void save(); })}
                            disabled={!gated && (saving || !canSave)}
                            aria-busy={saving}
                            className={`min-h-[48px] px-5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on text-xs font-bold transition-all disabled:opacity-50 ${gated ? GATED_LOOK : ''}`}
                        >
                            {saving ? 'Saving…' : 'Save who may invite'}
                        </button>
                        {status && (
                            <p role={status.kind === 'error' ? 'alert' : 'status'} className={`text-xs m-0 break-words ${status.kind === 'error' ? 'text-red-300' : 'text-emerald-300'}`}>
                                {status.text}
                            </p>
                        )}
                    </div>
                </>
            )}
        </section>
    );
}
