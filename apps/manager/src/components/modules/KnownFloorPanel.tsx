import React, { useEffect, useId, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { GATED_LOOK, gatedProps, guardGated } from '../../lib/gated-control';
import { buildAdminHeaders, getTfaSessionToken, resolveNodeApiUrl, passwordField } from '../../lib/node-client';
import type { RolesViewer } from './NodeRolesPanel';
import { nodeCredential } from '../../lib/profiles';

/**
 * People & Safety → "The known floor" (community modes slice 4; apps/server config/known-floor.ts).
 *
 * The confirmation dial, the known floor and the cap. With the dial on, a member an admin has confirmed on the names
 * list may go into debt down to the known floor while they keep at least one offer listed. Every community starts with
 * the dial off: nothing changes until an owner turns it on. Only an owner saves; an admin sees the numbers and why they
 * aren't theirs to change. A node older than the known floor answers 404, and nothing is shown.
 *
 * Operator manual text: packages/beanpool-guide/operators/people/running-a-known-community.md.
 */

/** 40 Beans is an hour of work (PROTOCOL_CONSTANTS.REFERENCE_RATE). */
export const BEANS_PER_HOUR = 40;

/** "1,000 Beans is about 25 hours of work the community is trusting you for." */
export function hoursWording(beans: number): string {
    const hours = Math.round(beans / BEANS_PER_HOUR);
    return `${beans.toLocaleString('en')} Beans is about ${hours.toLocaleString('en')} ${hours === 1 ? 'hour' : 'hours'} of work the community is trusting you for.`;
}

type Settings = { confirmation: boolean; knownFloor: number; creditCap: number; creditCapDefault: number; creditCapMax: number };
type Status = { kind: 'saved' | 'error'; text: string };

export function readKnownFloorSettings(v: unknown): Settings | null {
    const o = v as Partial<Settings> | null;
    if (!o || typeof o.confirmation !== 'boolean' || !Number.isInteger(o.knownFloor) || !Number.isInteger(o.creditCap)) return null;
    return {
        confirmation: o.confirmation, knownFloor: o.knownFloor!, creditCap: o.creditCap!,
        creditCapDefault: Number.isInteger(o.creditCapDefault) ? o.creditCapDefault! : 2000,
        creditCapMax: Number.isInteger(o.creditCapMax) ? o.creditCapMax! : 5000,
    };
}

export function KnownFloorPanel({ activeNode, viewer }: { activeNode: NodeProfile; viewer: RolesViewer }) {
    const [saved, setSaved] = useState<Settings | null>(null);
    const [dial, setDial] = useState(false);
    const [floor, setFloor] = useState('');
    const [cap, setCap] = useState('');
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const ids = useId();
    const ownerOnlyId = `${ids}-owner-only`;
    const isOwner = viewer.kind === 'password' || viewer.role === 'owner';
    const blocked = !isOwner;

    useEffect(() => {
        let mounted = true;
        setSaved(null);
        setStatus(null);
        (async () => {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/known-floor'), {
                headers: buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
            }).catch(() => null);
            if (!res || !res.ok) return;
            const s = readKnownFloorSettings(await res.json().catch(() => null));
            if (!mounted || !s) return;
            setSaved(s);
            setDial(s.confirmation);
            setFloor(String(s.knownFloor));
            setCap(String(s.creditCap));
        })();
        return () => { mounted = false; };
    }, [activeNode.url, activeNode.id]);

    if (!saved) return null;

    const floorN = /^\d{1,6}$/.test(floor) ? Number(floor) : NaN;
    const capN = /^\d{1,6}$/.test(cap) ? Number(cap) : NaN;
    const problem = Number.isNaN(floorN) ? 'The known floor is a whole number of Beans.'
        : Number.isNaN(capN) || capN < saved.creditCapDefault || capN > saved.creditCapMax
            ? `The cap is from ${saved.creditCapDefault.toLocaleString('en')} to ${saved.creditCapMax.toLocaleString('en')} Beans.`
            : floorN > capN ? `The known floor can't be more than the cap (${capN.toLocaleString('en')} Beans).` : null;
    const changed = dial !== saved.confirmation || floorN !== saved.knownFloor || capN !== saved.creditCap;

    const save = async () => {
        if (blocked || problem || !changed) return;
        setSaving(true);
        setStatus(null);
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/known-floor'), {
                method: 'POST',
                headers: buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ ...passwordField(nodeCredential(activeNode)), confirmation: dial, knownFloor: floorN, creditCap: capN }),
            });
            const body = await res.json().catch(() => ({})) as { error?: unknown; totpRequired?: unknown };
            if (res.ok) {
                const s = readKnownFloorSettings(body);
                if (s) setSaved(s);
                setStatus({ kind: 'saved', text: 'Saved.' });
            } else {
                setStatus({
                    kind: 'error',
                    text: body.totpRequired === true ? '2FA session expired. Please re-authenticate.'
                        : typeof body.error === 'string' && body.error.trim() ? body.error : 'Not saved: the node refused.',
                });
            }
        } catch (err: unknown) {
            setStatus({ kind: 'error', text: err instanceof Error && err.message ? err.message : 'Not saved: the node could not be reached.' });
        } finally {
            setSaving(false);
        }
    };

    const input = `w-full min-h-[48px] rounded-xl border border-nature-800 bg-nature-950 px-3 text-sm text-white ${blocked ? GATED_LOOK : ''}`;
    return (
        <section aria-labelledby={`${ids}-title`} data-testid="known-floor-panel" className="bg-nature-900/90 border border-nature-800 rounded-2xl p-4 sm:p-6 space-y-4 shadow-xl">
            <div>
                <h3 id={`${ids}-title`} className="text-base font-bold text-white m-0 break-words">🤝 The known floor</h3>
                <p className="text-xs text-nature-400 m-0 mt-1 leading-relaxed break-words">
                    How far into debt a member the admins have confirmed on the names list may go, while they keep at least one offer listed.
                    Nobody else&apos;s limit changes. Lowering it never takes Beans from anyone: a member below their new limit can still
                    receive, and can spend again once they climb back.
                </p>
            </div>

            <label htmlFor={`${ids}-dial`} className={`flex items-start gap-3 rounded-xl border border-nature-800 bg-nature-950 p-3 min-h-[48px] ${blocked ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                <input
                    id={`${ids}-dial`}
                    type="checkbox"
                    checked={dial}
                    {...gatedProps(blocked, ownerOnlyId)}
                    onClick={guardGated(blocked)}
                    onChange={guardGated(blocked, () => { setDial(!dial); setStatus(null); })}
                    className={`mt-1 accent-terra-500 shrink-0 ${blocked ? GATED_LOOK : ''}`}
                />
                <span className="min-w-0 text-sm text-white break-words">
                    Confirmed members get the known floor
                    <span className="block text-xs text-nature-300 mt-0.5 leading-relaxed">
                        Turned on, nobody loses anything: every member keeps the limit they have, and the known floor adds to it once an admin confirms them.
                    </span>
                </span>
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
                <label htmlFor={`${ids}-floor`} className="block min-w-0">
                    <span className="block text-xs font-bold text-nature-300 mb-1">Known floor (Beans)</span>
                    <input id={`${ids}-floor`} inputMode="numeric" value={floor} readOnly={blocked} aria-describedby={`${ids}-hours`}
                        onChange={(e) => { setFloor(e.target.value.trim()); setStatus(null); }} className={input} />
                    <span id={`${ids}-hours`} data-testid="known-floor-hours" className="block text-xs text-nature-400 mt-1 leading-relaxed break-words">
                        {Number.isNaN(floorN) ? '' : hoursWording(floorN)}
                    </span>
                </label>
                <label htmlFor={`${ids}-cap`} className="block min-w-0">
                    <span className="block text-xs font-bold text-nature-300 mb-1">Cap: the most anyone may owe (Beans)</span>
                    <input id={`${ids}-cap`} inputMode="numeric" value={cap} readOnly={blocked}
                        onChange={(e) => { setCap(e.target.value.trim()); setStatus(null); }} className={input} />
                    <span className="block text-xs text-nature-400 mt-1 leading-relaxed break-words">
                        From {saved.creditCapDefault.toLocaleString('en')} to {saved.creditCapMax.toLocaleString('en')}. Earned trust grows a member&apos;s limit up to it.
                    </span>
                </label>
            </div>

            {problem && !blocked && <p role="alert" className="text-xs text-amber-200 m-0 break-words">{problem}</p>}
            {blocked && (
                <p id={ownerOnlyId} className="text-xs text-nature-400 m-0 leading-relaxed break-words">
                    Only an owner of this community can change the known floor or the cap.
                </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    {...gatedProps(blocked, ownerOnlyId)}
                    onClick={guardGated(blocked, () => { void save(); })}
                    disabled={!blocked && (saving || !!problem || !changed)}
                    aria-busy={saving}
                    className={`min-h-[48px] px-5 rounded-xl bg-terra-500 hover:bg-terra-600 text-white text-xs font-bold transition-all disabled:opacity-50 ${blocked ? GATED_LOOK : ''}`}
                >
                    {saving ? 'Saving…' : 'Save the known floor'}
                </button>
                {status && (
                    <p role={status.kind === 'error' ? 'alert' : 'status'} className={`text-xs m-0 break-words ${status.kind === 'error' ? 'text-red-300' : 'text-emerald-300'}`}>
                        {status.text}
                    </p>
                )}
            </div>
        </section>
    );
}
