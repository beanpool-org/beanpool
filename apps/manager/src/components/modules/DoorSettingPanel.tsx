import React, { useEffect, useId, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { GATED_LOOK, gatedProps, guardGated } from '../../lib/gated-control';
import { buildAdminHeaders, fetchNodeRoles, getTfaSessionToken, resolveNodeApiUrl } from '../../lib/node-client';
import type { RolesViewer } from './NodeRolesPanel';

/**
 * People & Safety → Invites & QR → "Who may invite": the door (community modes slice 1; apps/server config/door.ts).
 *
 * Two presets, each one setting of the door: **Invite** (any member invites, every community until now and the default)
 * and **Known** (only owners and admins invite, said plainly as "only admins invite"). Known's words point to the names
 * list (community modes slice 2), which opens in the app on an owner's or admin's phone and needs their key: a password
 * session here can't read it (design §4.3). The global node's door is open: anyone joins with a sign-in and nobody invites, which
 * its profile sets, so it is shown and not offered. A local community can't open its door: the node refuses it.
 *
 * Read from /api/node/config (`door`, public); a node older than the door says nothing, and nothing is shown. Saved
 * alone (`{ door }`) to /api/local/admin/node/config, by an owner (the password is an owner's): an admin sees the
 * setting and why it isn't theirs to change, and the node refuses an admin anyway. A role, never a tier.
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

/** What a switch does to what is already out there, in plain words, before it is saved. */
export function doorChangeConsequence(from: CommunityDoor, to: CommunityDoor): string {
    if (to === 'admins' && from === 'members') {
        return 'Members will stop being able to make invites or answer requests to join. Invite codes already made still work until they expire, 30 days after they were made. A paper ticket a member made on their phone will no longer let anyone in.';
    }
    return 'Every member will be able to make invites and answer requests to join again, including paper tickets made on their phones.';
}

type Status = { kind: 'saved' | 'error'; text: string };

export function DoorSettingPanel({ activeNode, viewer }: { activeNode: NodeProfile; viewer: RolesViewer }) {
    const [saved, setSaved] = useState<Door | null>(null);
    const [choice, setChoice] = useState<CommunityDoor | null>(null);
    const [saving, setSaving] = useState(false);
    // null = not known (not loaded, or the node would not say): never warn on a guess.
    const [nobodyCanAct, setNobodyCanAct] = useState<boolean | null>(null);
    const [status, setStatus] = useState<Status | null>(null);
    const ids = useId();
    const ownerOnlyId = `${ids}-owner-only`;

    // The password is an owner's (NodeRolesPanel); a key session is whatever role it holds.
    const isOwner = viewer.kind === 'password' || viewer.role === 'owner';
    const blocked = !isOwner;

    useEffect(() => {
        let mounted = true;
        setSaved(null);
        setChoice(null);
        setStatus(null);
        setNobodyCanAct(null);
        (async () => {
            try {
                const roles = await fetchNodeRoles(activeNode.url, activeNode.adminPassword, getTfaSessionToken(activeNode.id));
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
            setChoice(door === 'open' ? null : door);
        })();
        return () => { mounted = false; };
    }, [activeNode.url, activeNode.id]);

    if (!saved) return null;

    const save = async () => {
        if (!choice || blocked || saved === 'open' || choice === saved) return;
        setSaving(true);
        setStatus(null);
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/node/config'), {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ password: activeNode.adminPassword, door: choice }),
            });
            const body = await res.json().catch(() => ({})) as { error?: unknown; totpRequired?: unknown };
            if (res.ok) {
                setSaved(choice);
                setStatus({ kind: 'saved', text: choice === 'admins' ? 'Saved. Only admins invite now.' : 'Saved. Any member invites now.' });
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
                                    } ${blocked ? 'cursor-not-allowed' : ''}`}
                                >
                                    <input
                                        id={optionId}
                                        type="radio"
                                        name={`${ids}-door`}
                                        value={p.door}
                                        checked={selected}
                                        {...gatedProps(blocked, ownerOnlyId)}
                                        onClick={guardGated(blocked)}
                                        onChange={guardGated(blocked, () => { setChoice(p.door); setStatus(null); })}
                                        className={`mt-1 accent-terra-500 shrink-0 ${blocked ? GATED_LOOK : ''}`}
                                    />
                                    <span className="min-w-0">
                                        <span className="block text-sm font-bold text-white break-words">
                                            {p.name}: {p.plain}
                                            {saved === p.door && <span className="ml-2 text-[11px] font-bold text-nature-400">(now)</span>}
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

                    {choice && choice !== saved && (
                        <p id={`${ids}-consequence`} className="text-xs text-amber-200 m-0 leading-relaxed break-words">
                            {doorChangeConsequence(saved as CommunityDoor, choice)}
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
                            {...gatedProps(blocked, ownerOnlyId)}
                            onClick={guardGated(blocked, () => { void save(); })}
                            disabled={!blocked && (saving || !choice || choice === saved)}
                            aria-busy={saving}
                            className={`min-h-[48px] px-5 rounded-xl bg-terra-500 hover:bg-terra-600 text-white text-xs font-bold transition-all disabled:opacity-50 ${blocked ? GATED_LOOK : ''}`}
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
