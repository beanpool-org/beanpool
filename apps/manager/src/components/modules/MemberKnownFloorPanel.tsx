import React, { useCallback, useEffect, useId, useState } from 'react';
import { isHundredths } from '@beanpool/core';
import { buildAdminHeaders, resolveNodeApiUrl } from '../../lib/node-client';
import { t } from '../../lib/fresh-proof';
import { beansFigure, beansRefusalText, parseBeans } from '../../lib/beans';

/**
 * Member detail → "Known floor" (community modes slice 4; apps/server config/known-floor.ts).
 *
 * One confirmed member's known-floor line in a known community (the dial on): the community default, lowered to an
 * amount, or frozen, with controls to change it, freeze it or restore the default. Each is confirmed first and is the
 * node's POST /api/local/admin/known-floor/exception; a refusal shows in the node's words. The node takes it only from an
 * owner's or admin's own key session, and nobody sets their own.
 *
 * It reads GET /api/local/admin/known-floor/member/:pubkey: the member's credit line, never their balance, with their lines
 * in the node's known-floor log (who changed it, from what to what, when), which every admin reads here. Every figure is
 * whole hundredths of a Bean (server config/known-floor.ts knownFloorForMember: `knownFloor_c`, `creditCap_c`, the
 * exception's `amount_c`, and `knownGrant` under its old name; the log keeps each value as hundredths text, '30000' for 300
 * Beans), and a change is sent as `amount_c` (setKnownFloorException). Where the node
 * would refuse a change (`changeRefused`: a token sign-in, or the admin's own line), the controls are not
 * shown and one line says why. A node older than this, a viewer who isn't an owner or admin, or a community with the dial
 * off: nothing is shown.
 *
 * Operator manual text: packages/beanpool-guide/operators/people/running-a-known-community.md.
 */

/** A member's exception: `amount_c` whole hundredths (null where a freeze kept none), or frozen. */
export type KnownFloorException = { amount_c: number | null; frozen: boolean };
export type KnownFloorLogLine = { id: string; actor: string; actorCallsign: string | null; action: string; oldValue: string | null; newValue: string | null; at: string };
export type ChangeRefused = 'key_session_only' | 'own_floor';
/** The member's line as the node sends it: every figure whole hundredths of a Bean. */
export type MemberKnownFloor = {
    confirmation: boolean;
    knownFloor_c: number;
    creditCap_c: number;
    confirmed: boolean;
    exception: KnownFloorException | null;
    knownGrant: number;
    log: KnownFloorLogLine[];
    changeRefused: ChangeRefused | null;
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function readLog(v: unknown): KnownFloorLogLine[] {
    if (!Array.isArray(v)) return [];
    return v.flatMap((l: Record<string, unknown> | null) => {
        if (!l || typeof l !== 'object' || typeof l.id !== 'string' || typeof l.actor !== 'string' || typeof l.action !== 'string' || typeof l.at !== 'string') return [];
        return [{ id: l.id, actor: l.actor, actorCallsign: str(l.actorCallsign), action: l.action, oldValue: str(l.oldValue), newValue: str(l.newValue), at: l.at }];
    });
}

export function readMemberKnownFloor(v: unknown): MemberKnownFloor | null {
    const o = v as Partial<MemberKnownFloor> | null;
    if (!o || typeof o.confirmation !== 'boolean' || typeof o.confirmed !== 'boolean'
        || !isHundredths(o.knownFloor_c) || !isHundredths(o.creditCap_c) || !isHundredths(o.knownGrant)) return null;
    const e = o.exception as Partial<KnownFloorException> | null | undefined;
    const exception = e && typeof e === 'object'
        ? { amount_c: isHundredths(e.amount_c) ? e.amount_c : null, frozen: e.frozen === true }
        : null;
    // A node from before the log and the refusal mark came with the line: no log, and the controls as before.
    const changeRefused = o.changeRefused === 'key_session_only' || o.changeRefused === 'own_floor' ? o.changeRefused : null;
    return { confirmation: o.confirmation, knownFloor_c: o.knownFloor_c, creditCap_c: o.creditCap_c, confirmed: o.confirmed, exception, knownGrant: o.knownGrant,
        log: readLog(o.log), changeRefused };
}

/** Why the controls aren't there, in one line: what the node would answer a change from this sign-in. */
export const CHANGE_REFUSED_TEXT: Record<ChangeRefused, string> = {
    key_session_only: "Sign in with your own key to change it: automation tokens can't.",
    own_floor: 'Another admin or the owner sets your own known floor.',
};

/**
 * "default (1,000 Beans)", "frozen", "300 Beans": one value in a log line. The log keeps an amount as whole hundredths in
 * text ('30000' is 300 Beans, server config/known-floor.ts log()), so it is read back as hundredths and said in Beans.
 */
function logValue(v: string | null, knownFloor_c: number): string {
    if (v === null || v === 'default') return `the community default (${beans(knownFloor_c)})`;
    if (v === 'frozen') return 'frozen';
    return /^\d{1,15}$/.test(v) ? beans(Number(v)) : v;
}

const LOG_VERBS: Record<string, string> = {
    exception_lowered: 'set it', exception_raised: 'raised it', exception_frozen: 'froze it', exception_unfrozen: 'unfroze it',
    exception_cleared: 'restored the default',
    badge: 'changed their badge (recognition only, no credit)',
};

/** One log line in plain words: "Ada raised it from the community default (1,000 Beans) to 2,000 Beans". */
export function describeKnownFloorLogLine(l: KnownFloorLogLine, knownFloor_c: number): string {
    const who = l.actorCallsign || (/^[0-9a-f]{64}$/.test(l.actor) ? `${l.actor.slice(0, 8)}…` : 'The node itself');
    const verb = LOG_VERBS[l.action] ?? l.action.replace(/_/g, ' ');
    return `${who} ${verb}: from ${logValue(l.oldValue, knownFloor_c)} to ${logValue(l.newValue, knownFloor_c)}`;
}

function when(at: string): string {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? at : d.toLocaleString('en', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Whole hundredths in words: 30000 → "300 Beans", 49925 → "499.25 Beans". */
const beans = (c: number) => `${beansFigure(c)} Beans`;

/** "Community default (1,000 Beans)", "Lowered to 300 Beans", "Frozen": the words the list's mark uses too. */
export function describeKnownFloorLine(exception: KnownFloorException | null, knownFloor_c: number): string {
    if (!exception) return `Community default (${beans(knownFloor_c)})`;
    if (exception.frozen) return 'Frozen';
    const amount = exception.amount_c ?? 0;
    if (amount === knownFloor_c) return `Set to ${beans(amount)}, the community default`;
    return amount < knownFloor_c ? `Lowered to ${beans(amount)}` : `Raised to ${beans(amount)}`;
}

/** `amount_c`: whole hundredths, as typed in Beans and read by parseHundredths. */
type Pending = { kind: 'amount'; amount_c: number } | { kind: 'freeze' } | { kind: 'restore' };
type Status = { kind: 'saved' | 'error'; text: string };

interface Props {
    nodeUrl: string;
    pubkey: string;
    displayName: string;
    credential?: string;
    /** After a change the node accepted: the member's exception now (null = the community default). */
    onChanged?: (pubkey: string, exception: KnownFloorException | null) => void;
}

export function MemberKnownFloorPanel({ nodeUrl, pubkey, displayName, credential, onChanged }: Props) {
    const [line, setLine] = useState<MemberKnownFloor | null>(null);
    const [amount, setAmount] = useState('');
    const [pending, setPending] = useState<Pending | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const ids = useId();

    const load = useCallback(async (): Promise<MemberKnownFloor | null> => {
        const res = await fetch(resolveNodeApiUrl(nodeUrl, `/api/local/admin/known-floor/member/${encodeURIComponent(pubkey)}`), {
            headers: buildAdminHeaders(credential),
        }).catch(() => null);
        if (!res || !res.ok) return null;
        return readMemberKnownFloor(await res.json().catch(() => null));
    }, [nodeUrl, pubkey, credential]);

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
                    {line.exception ? ` When they are, theirs is: ${describeKnownFloorLine(line.exception, line.knownFloor_c).toLowerCase()}.` : ''}
                </p>
                {!line.exception && (
                    <p className="m-0 text-nature-300 leading-relaxed break-words">
                        {t('Confirm them on the names list, in the app, and their limit grows by up to {knownFloor} Beans: your community’s known floor.', { knownFloor: beansFigure(line.knownFloor_c) })}
                    </p>
                )}
            </div>
        );
    }

    // Beans as typed, to the cent, as whole hundredths (parseHundredths): refused in its own words, never rounded.
    const typed = amount === '' ? null : parseBeans(amount);
    const amountC = typed && typed.ok ? typed.value : null;
    const amountProblem = typed === null ? null
        : !typed.ok ? beansRefusalText(typed.refusal)
            : typed.value > line.creditCap_c ? `No more than the cap (${beans(line.creditCap_c)}).` : null;

    const send = async (p: Pending) => {
        setBusy(true);
        setStatus(null);
        const body = p.kind === 'restore' ? { clear: true } : p.kind === 'freeze' ? { frozen: true } : { amount_c: p.amount_c };
        try {
            const res = await fetch(resolveNodeApiUrl(nodeUrl, '/api/local/admin/known-floor/exception'), {
                method: 'POST',
                headers: buildAdminHeaders(credential),
                body: JSON.stringify({ memberPubkey: pubkey, ...body }),
            });
            const data = await res.json().catch(() => ({})) as { error?: unknown; exception?: unknown };
            if (!res.ok) {
                setStatus({
                    kind: 'error',
                    text: typeof data.error === 'string' && data.error.trim() ? data.error : 'Not changed: the node refused.',
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
            ? `Set ${name}'s known floor to ${beans(pending.amount_c)}?${pending.amount_c > line.knownFloor_c ? ` That is more than the community's ${beans(line.knownFloor_c)}: every admin sees the raise in the changes below.` : ''}`
            : pending.kind === 'freeze'
                ? `Freeze ${name}'s known floor? Their known floor counts as 0 until you restore it.`
                : `Restore ${name} to the community default (${beans(line.knownFloor_c)})?`;

    const button = 'min-h-[48px] px-4 rounded-xl text-xs font-bold transition-all disabled:opacity-50';
    return (
        <section aria-labelledby={`${ids}-title`} data-testid="member-known-floor" className="p-3 rounded-2xl bg-nature-900/60 border border-nature-800 text-xs space-y-3">
            <div className="min-w-0">
                <p id={`${ids}-title`} className="m-0 font-bold text-white">🤝 Known floor</p>
                <p data-testid="member-known-floor-line" className="m-0 mt-1 text-sm text-white break-words">
                    {describeKnownFloorLine(line.exception, line.knownFloor_c)}
                </p>
                <p className="m-0 mt-1 text-nature-400 leading-relaxed break-words">
                    How far into debt {name} may go on being known, while they keep an offer listed. Changing it never takes Beans
                    from them: below their new line they can still receive, and spend again once they climb back.
                </p>
            </div>

            {line.changeRefused ? (
                <p data-testid="member-known-floor-refused" className="m-0 text-nature-300 leading-relaxed break-words">
                    {CHANGE_REFUSED_TEXT[line.changeRefused]}
                </p>
            ) : pending ? (
                <div className="space-y-2" data-testid="member-known-floor-confirm">
                    <p className="m-0 text-nature-200 leading-relaxed break-words">{question}</p>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => { setPending(null); setStatus(null); }} disabled={busy}
                            className={`${button} bg-nature-800 text-nature-200 hover:bg-nature-700`}>
                            Cancel
                        </button>
                        <button type="button" onClick={() => { void send(pending); }} disabled={busy} aria-busy={busy}
                            className={`${button} bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on`}>
                            {busy ? 'Saving…' : pending.kind === 'amount' ? 'Yes, set it' : pending.kind === 'freeze' ? 'Yes, freeze it' : 'Yes, restore it'}
                        </button>
                    </div>
                </div>
            ) : (
                <div className="space-y-2">
                    <label htmlFor={`${ids}-amount`} className="block min-w-0">
                        <span className="block font-bold text-nature-300 mb-1">New known floor (Beans)</span>
                        <input id={`${ids}-amount`} inputMode="decimal" value={amount} aria-describedby={`${ids}-range`}
                            onChange={(e) => { setAmount(e.target.value.trim()); setStatus(null); }}
                            className="w-full min-h-[48px] rounded-xl border border-nature-800 bg-nature-950 px-3 text-sm text-white" />
                        <span id={`${ids}-range`} className="block text-nature-400 mt-1 leading-relaxed break-words">
                            From 0 to {beans(line.creditCap_c)}. The community&apos;s is {beans(line.knownFloor_c)}.
                        </span>
                    </label>
                    {amountProblem && <p role="alert" className="m-0 text-amber-200 break-words">{amountProblem}</p>}
                    <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={amountC === null || !!amountProblem}
                            onClick={() => { if (amountC !== null) { setPending({ kind: 'amount', amount_c: amountC }); setStatus(null); } }}
                            className={`${button} bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on`}>
                            Set
                        </button>
                        {!line.exception?.frozen && (
                            <button type="button" onClick={() => { setPending({ kind: 'freeze' }); setStatus(null); }}
                                className={`${button} bg-bp-chip-danger-tint hover:opacity-90 text-bp-chip-danger-ink border border-red-700`}>
                                Freeze
                            </button>
                        )}
                        {line.exception && (
                            <button type="button" onClick={() => { setPending({ kind: 'restore' }); setStatus(null); }}
                                className={`${button} bg-bp-chip-ok-tint hover:opacity-90 text-bp-chip-ok-ink border border-emerald-800`}>
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

            {line.log.length > 0 && (
                <div data-testid="member-known-floor-log" className="min-w-0 border-t border-nature-800 pt-2">
                    <p className="m-0 font-bold text-nature-300">Changes to {name}&apos;s known floor</p>
                    <ul className="m-0 mt-1 p-0 list-none space-y-1">
                        {line.log.map((l) => (
                            <li key={l.id} className="min-w-0 text-nature-200 leading-relaxed break-words">
                                {describeKnownFloorLogLine(l, line.knownFloor_c)}
                                <span className="block text-nature-500">{when(l.at)}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    );
}
