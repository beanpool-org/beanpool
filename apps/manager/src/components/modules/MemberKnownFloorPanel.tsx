import React, { useCallback, useEffect, useId, useState } from 'react';
import { buildAdminHeaders, passwordField, resolveNodeApiUrl } from '../../lib/node-client';

/**
 * Member detail → "Known floor" (community modes slice 4; apps/server config/known-floor.ts).
 *
 * One confirmed member's known-floor line in a known community (the dial on): the community default, lowered to an
 * amount, or frozen, with controls to change it, freeze it or restore the default. Each is confirmed first and is the
 * node's POST /api/local/admin/known-floor/exception; a refusal shows in the node's words. The node takes it only from an
 * owner's or admin's own key session, and nobody sets their own.
 *
 * It reads GET /api/local/admin/known-floor/member/:pubkey: the member's credit line, never their balance. A node older
 * than this, a viewer who isn't an owner or admin, or a community with the dial off: nothing is shown.
 *
 * Operator manual text: packages/beanpool-guide/operators/people/running-a-known-community.md.
 */

export type KnownFloorException = { amount: number | null; frozen: boolean };
export type MemberKnownFloor = {
    confirmation: boolean;
    knownFloor: number;
    creditCap: number;
    confirmed: boolean;
    exception: KnownFloorException | null;
    knownGrant: number;
};

export function readMemberKnownFloor(v: unknown): MemberKnownFloor | null {
    const o = v as Partial<MemberKnownFloor> | null;
    if (!o || typeof o.confirmation !== 'boolean' || typeof o.confirmed !== 'boolean'
        || !Number.isInteger(o.knownFloor) || !Number.isInteger(o.creditCap) || !Number.isInteger(o.knownGrant)) return null;
    const e = o.exception as Partial<KnownFloorException> | null | undefined;
    const exception = e && typeof e === 'object'
        ? { amount: Number.isInteger(e.amount) ? e.amount! : null, frozen: e.frozen === true }
        : null;
    return { confirmation: o.confirmation, knownFloor: o.knownFloor!, creditCap: o.creditCap!, confirmed: o.confirmed, exception, knownGrant: o.knownGrant! };
}

const beans = (n: number) => `${n.toLocaleString('en')} Beans`;

/** "Community default (1,000 Beans)", "Lowered to 300 Beans", "Frozen": the words the list's mark uses too. */
export function describeKnownFloorLine(exception: KnownFloorException | null, knownFloor: number): string {
    if (!exception) return `Community default (${beans(knownFloor)})`;
    if (exception.frozen) return 'Frozen';
    const amount = exception.amount ?? 0;
    if (amount === knownFloor) return `Set to ${beans(amount)}, the community default`;
    return amount < knownFloor ? `Lowered to ${beans(amount)}` : `Raised to ${beans(amount)}`;
}

type Pending = { kind: 'amount'; amount: number } | { kind: 'freeze' } | { kind: 'restore' };
type Status = { kind: 'saved' | 'error'; text: string };

interface Props {
    nodeUrl: string;
    pubkey: string;
    displayName: string;
    adminPassword?: string;
    tfaToken?: string;
    /** After a change the node accepted: the member's exception now (null = the community default). */
    onChanged?: (pubkey: string, exception: KnownFloorException | null) => void;
}

export function MemberKnownFloorPanel({ nodeUrl, pubkey, displayName, adminPassword, tfaToken, onChanged }: Props) {
    const [line, setLine] = useState<MemberKnownFloor | null>(null);
    const [amount, setAmount] = useState('');
    const [pending, setPending] = useState<Pending | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const ids = useId();

    const load = useCallback(async (): Promise<MemberKnownFloor | null> => {
        const res = await fetch(resolveNodeApiUrl(nodeUrl, `/api/local/admin/known-floor/member/${encodeURIComponent(pubkey)}`), {
            headers: buildAdminHeaders(adminPassword, tfaToken),
        }).catch(() => null);
        if (!res || !res.ok) return null;
        return readMemberKnownFloor(await res.json().catch(() => null));
    }, [nodeUrl, pubkey, adminPassword, tfaToken]);

    useEffect(() => {
        let mounted = true;
        setLine(null);
        setPending(null);
        setStatus(null);
        void load().then((l) => { if (mounted) setLine(l); });
        return () => { mounted = false; };
    }, [load]);

    if (!line || !line.confirmation) return null;

    const name = displayName || 'this member';
    if (!line.confirmed) {
        return (
            <div data-testid="member-known-floor" className="p-3 rounded-2xl bg-nature-900/60 border border-nature-800 text-xs space-y-1">
                <p className="m-0 font-bold text-white">🤝 Known floor</p>
                <p className="m-0 text-nature-300 leading-relaxed break-words">
                    Not confirmed on the names list yet, so {name} has no known floor.
                    {line.exception ? ` When they are, theirs is: ${describeKnownFloorLine(line.exception, line.knownFloor).toLowerCase()}.` : ''}
                </p>
            </div>
        );
    }

    const amountN = /^\d{1,6}$/.test(amount) ? Number(amount) : NaN;
    const amountProblem = amount === '' ? null
        : Number.isNaN(amountN) ? 'A whole number of Beans, 0 or more.'
            : amountN > line.creditCap ? `No more than the cap (${beans(line.creditCap)}).` : null;

    const send = async (p: Pending) => {
        setBusy(true);
        setStatus(null);
        const body = p.kind === 'restore' ? { clear: true } : p.kind === 'freeze' ? { frozen: true } : { amount: p.amount };
        try {
            const res = await fetch(resolveNodeApiUrl(nodeUrl, '/api/local/admin/known-floor/exception'), {
                method: 'POST',
                headers: buildAdminHeaders(adminPassword, tfaToken),
                body: JSON.stringify({ ...passwordField(adminPassword), memberPubkey: pubkey, ...body }),
            });
            const data = await res.json().catch(() => ({})) as { error?: unknown; totpRequired?: unknown; exception?: unknown };
            if (!res.ok) {
                setStatus({
                    kind: 'error',
                    text: data.totpRequired === true ? '2FA session expired. Please re-authenticate.'
                        : typeof data.error === 'string' && data.error.trim() ? data.error : 'Not changed: the node refused.',
                });
                return;
            }
            const exception = readMemberKnownFloor({ ...line, exception: data.exception ?? null })?.exception ?? null;
            setPending(null);
            setAmount('');
            setStatus({ kind: 'saved', text: p.kind === 'restore' ? 'Back to the community default.' : p.kind === 'freeze' ? 'Frozen.' : 'Changed.' });
            onChanged?.(pubkey, exception);
            const fresh = await load();
            setLine(fresh ?? { ...line, exception });
        } catch (err: unknown) {
            setStatus({ kind: 'error', text: err instanceof Error && err.message ? err.message : 'Not changed: the node could not be reached.' });
        } finally {
            setBusy(false);
        }
    };

    const question = !pending ? null
        : pending.kind === 'amount'
            ? `Set ${name}'s known floor to ${beans(pending.amount)}?${pending.amount > line.knownFloor ? ` That is more than the community's ${beans(line.knownFloor)}: every admin sees the raise in the log.` : ''}`
            : pending.kind === 'freeze'
                ? `Freeze ${name}'s known floor? Their known floor counts as 0 until you restore it.`
                : `Restore ${name} to the community default (${beans(line.knownFloor)})?`;

    const button = 'min-h-[48px] px-4 rounded-xl text-xs font-bold transition-all disabled:opacity-50';
    return (
        <section aria-labelledby={`${ids}-title`} data-testid="member-known-floor" className="p-3 rounded-2xl bg-nature-900/60 border border-nature-800 text-xs space-y-3">
            <div className="min-w-0">
                <p id={`${ids}-title`} className="m-0 font-bold text-white">🤝 Known floor</p>
                <p data-testid="member-known-floor-line" className="m-0 mt-1 text-sm text-white break-words">
                    {describeKnownFloorLine(line.exception, line.knownFloor)}
                </p>
                <p className="m-0 mt-1 text-nature-400 leading-relaxed break-words">
                    How far into debt {name} may go on being known, while they keep an offer listed. Changing it never takes Beans
                    from them: below their new line they can still receive, and spend again once they climb back.
                </p>
            </div>

            {pending ? (
                <div className="space-y-2" data-testid="member-known-floor-confirm">
                    <p className="m-0 text-nature-200 leading-relaxed break-words">{question}</p>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => { setPending(null); setStatus(null); }} disabled={busy}
                            className={`${button} bg-nature-800 text-nature-200 hover:bg-nature-700`}>
                            Cancel
                        </button>
                        <button type="button" onClick={() => { void send(pending); }} disabled={busy} aria-busy={busy}
                            className={`${button} bg-terra-500 hover:bg-terra-600 text-white`}>
                            {busy ? 'Saving…' : pending.kind === 'amount' ? 'Yes, set it' : pending.kind === 'freeze' ? 'Yes, freeze it' : 'Yes, restore it'}
                        </button>
                    </div>
                </div>
            ) : (
                <div className="space-y-2">
                    <label htmlFor={`${ids}-amount`} className="block min-w-0">
                        <span className="block font-bold text-nature-300 mb-1">New known floor (Beans)</span>
                        <input id={`${ids}-amount`} inputMode="numeric" value={amount} aria-describedby={`${ids}-range`}
                            onChange={(e) => { setAmount(e.target.value.trim()); setStatus(null); }}
                            className="w-full min-h-[48px] rounded-xl border border-nature-800 bg-nature-950 px-3 text-sm text-white" />
                        <span id={`${ids}-range`} className="block text-nature-400 mt-1 leading-relaxed break-words">
                            From 0 to {beans(line.creditCap)}. The community&apos;s is {beans(line.knownFloor)}.
                        </span>
                    </label>
                    {amountProblem && <p role="alert" className="m-0 text-amber-200 break-words">{amountProblem}</p>}
                    <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={amount === '' || !!amountProblem}
                            onClick={() => { setPending({ kind: 'amount', amount: amountN }); setStatus(null); }}
                            className={`${button} bg-terra-500 hover:bg-terra-600 text-white`}>
                            Set
                        </button>
                        {!line.exception?.frozen && (
                            <button type="button" onClick={() => { setPending({ kind: 'freeze' }); setStatus(null); }}
                                className={`${button} bg-red-950/80 hover:bg-red-900 text-red-200 border border-red-700`}>
                                Freeze
                            </button>
                        )}
                        {line.exception && (
                            <button type="button" onClick={() => { setPending({ kind: 'restore' }); setStatus(null); }}
                                className={`${button} bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-800`}>
                                Restore the default
                            </button>
                        )}
                    </div>
                </div>
            )}

            {status && (
                <p role={status.kind === 'error' ? 'alert' : 'status'} className={`m-0 break-words ${status.kind === 'error' ? 'text-red-300' : 'text-emerald-300'}`}>
                    {status.text}
                </p>
            )}
        </section>
    );
}
