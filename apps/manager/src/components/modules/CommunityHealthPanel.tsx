import React, { useEffect, useId, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { GATED_LOOK, gatedProps, guardGated } from '../../lib/gated-control';
import { buildAdminHeaders, getTfaSessionToken, resolveNodeApiUrl, passwordField } from '../../lib/node-client';
import type { RolesViewer } from './NodeRolesPanel';
import { nodeCredential } from '../../lib/profiles';

/**
 * People & Safety → "Community health" (community modes slice 6; apps/server engine/community-health.ts).
 *
 * The community's totals, which are public by rule; the two lines that make a confirmed, consenting member an exception
 * in a known community (an owner moves them); and who opened the exceptions, when. The exceptions themselves open on an
 * admin's phone, where the names list is: this page never shows a balance of one member, and there is no export. A node
 * older than the panel answers 404, and nothing is shown.
 *
 * Operator manual text: packages/beanpool-guide/operators/people/running-a-known-community.md.
 */

type Totals = { beansInCirculation: number; sumOfCredit: number; sumOfDebt: number; membersInDebit: number; commonsPot: number; tradesThisMonth: number };
type Lines = { debtLinePct: number; quietDays: number };
type LogLine = { id: string; actorCallsign: string | null; actor: string; action?: string; subjectCallsign?: string | null; at: string };

/** What a line in the access log says the admin did: opened the exceptions, or looked at a member's balance while removing them. */
function logDid(l: LogLine): string {
    if (l.action === 'offboard_preview') return `saw ${l.subjectCallsign ? `${l.subjectCallsign}'s` : "a member's"} balance while removing them on`;
    if (l.action === 'offboard_settled') return 'removed a member and saw the balance it settled on';
    return 'opened it on';
}
export type Health = { totals: Totals; settings: Lines; known: boolean; log: LogLine[]; tradeLog: LogLine[] };
type Status = { kind: 'saved' | 'error'; text: string };

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

export function readHealth(v: unknown): Health | null {
    const o = v as Partial<Health> | null;
    const t = o?.totals as Partial<Totals> | undefined;
    const s = o?.settings as Partial<Lines> | undefined;
    if (!o || !t || !s || !num(t.sumOfCredit) || !num(t.sumOfDebt) || !num(t.membersInDebit) || !num(s.debtLinePct) || !num(s.quietDays)) return null;
    return {
        totals: {
            beansInCirculation: num(t.beansInCirculation) ? t.beansInCirculation! : 0, sumOfCredit: t.sumOfCredit!, sumOfDebt: t.sumOfDebt!,
            membersInDebit: t.membersInDebit!, commonsPot: num(t.commonsPot) ? t.commonsPot! : 0, tradesThisMonth: num(t.tradesThisMonth) ? t.tradesThisMonth! : 0,
        },
        settings: { debtLinePct: s.debtLinePct!, quietDays: s.quietDays! },
        known: o.known === true,
        log: Array.isArray(o.log) ? o.log.filter((l): l is LogLine => !!l && typeof (l as LogLine).at === 'string') : [],
        tradeLog: Array.isArray(o.tradeLog) ? o.tradeLog.filter((l): l is LogLine => !!l && typeof (l as LogLine).at === 'string') : [],
    };
}

const beans = (n: number) => `${Math.round(n).toLocaleString('en')} Beans`;

export function CommunityHealthPanel({ activeNode, viewer }: { activeNode: NodeProfile; viewer: RolesViewer }) {
    const [health, setHealth] = useState<Health | null>(null);
    const [pct, setPct] = useState('');
    const [days, setDays] = useState('');
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const ids = useId();
    const ownerOnlyId = `${ids}-owner-only`;
    const blocked = !(viewer.kind === 'password' || viewer.role === 'owner');

    useEffect(() => {
        let mounted = true;
        setHealth(null);
        setStatus(null);
        (async () => {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/community-health'), {
                headers: buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
            }).catch(() => null);
            if (!res || !res.ok) return;
            const h = readHealth(await res.json().catch(() => null));
            if (!mounted || !h) return;
            setHealth(h);
            setPct(String(h.settings.debtLinePct));
            setDays(String(h.settings.quietDays));
        })();
        return () => { mounted = false; };
    }, [activeNode.url, activeNode.id]);

    if (!health) return null;

    const pctN = /^\d{1,3}$/.test(pct) ? Number(pct) : NaN;
    const daysN = /^\d{1,4}$/.test(days) ? Number(days) : NaN;
    const problem = !(pctN >= 1 && pctN <= 100) ? 'The debt line is a whole percentage, from 1 to 100.'
        : !(daysN >= 7 && daysN <= 3650) ? 'The days without a sale are a whole number from 7 to 3,650.' : null;
    const changed = pctN !== health.settings.debtLinePct || daysN !== health.settings.quietDays;

    const save = async () => {
        if (blocked || problem || !changed) return;
        setSaving(true);
        setStatus(null);
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/community-health'), {
                method: 'POST',
                headers: buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ ...passwordField(nodeCredential(activeNode)), debtLinePct: pctN, quietDays: daysN }),
            });
            const body = await res.json().catch(() => ({})) as { error?: unknown; totpRequired?: unknown; debtLinePct?: unknown; quietDays?: unknown };
            if (res.ok && num(body.debtLinePct) && num(body.quietDays)) {
                setHealth({ ...health, settings: { debtLinePct: body.debtLinePct as number, quietDays: body.quietDays as number } });
                setStatus({ kind: 'saved', text: 'Saved. Members who join from now on agree to the new lines.' });
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

    const t = health.totals;
    const rows: Array<[string, string]> = [
        ['Beans in circulation', beans(t.beansInCirculation)],
        ['Credit held (all balances above 0)', beans(t.sumOfCredit)],
        ['Debt owed (all balances below 0)', beans(t.sumOfDebt)],
        ['Members in debit', t.membersInDebit.toLocaleString('en')],
        ['Commons pot', beans(t.commonsPot)],
        ['Trades this month', t.tradesThisMonth.toLocaleString('en')],
    ];
    const input = `w-full min-h-[48px] rounded-xl border border-nature-800 bg-nature-950 px-3 text-sm text-white ${blocked ? GATED_LOOK : ''}`;
    return (
        <section aria-labelledby={`${ids}-title`} data-testid="community-health-panel" className="bg-nature-900/90 border border-nature-800 rounded-2xl p-4 sm:p-6 space-y-4 shadow-xl">
            <div>
                <h3 id={`${ids}-title`} className="text-base font-bold text-white m-0 break-words">🌱 Community health</h3>
                <p className="text-xs text-nature-400 m-0 mt-1 leading-relaxed break-words">
                    The whole community&apos;s totals: any member may know these. Nobody&apos;s own balance or trades are shown here.
                </p>
            </div>

            <dl className="grid gap-2 sm:grid-cols-2 m-0">
                {rows.map(([label, value]) => (
                    <div key={label} className="rounded-xl border border-nature-800 bg-nature-950 p-3 min-w-0">
                        <dt className="text-xs text-nature-400 break-words">{label}</dt>
                        <dd className="m-0 text-sm font-bold text-white break-words">{value}</dd>
                    </div>
                ))}
            </dl>

            <div className="space-y-2">
                <h4 className="text-sm font-bold text-white m-0 break-words">When admins may see a member&apos;s balance</h4>
                <p className="text-xs text-nature-400 m-0 leading-relaxed break-words">
                    {health.known
                        ? 'In this known community, a confirmed member who agreed when joining shows on an admin\'s phone if they pass either line. Admins never see anyone\'s trades. Every time an admin opens that list, it is written below.'
                        : 'Only a community that confirms its members has these exceptions. Until confirmation is on, nobody\'s balance is shown to an admin.'}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                    <label htmlFor={`${ids}-pct`} className="block min-w-0">
                        <span className="block text-xs font-bold text-nature-300 mb-1">Past this % of their credit line</span>
                        <input id={`${ids}-pct`} inputMode="numeric" value={pct} readOnly={blocked}
                            onChange={(e) => { setPct(e.target.value.trim()); setStatus(null); }} className={input} />
                    </label>
                    <label htmlFor={`${ids}-days`} className="block min-w-0">
                        <span className="block text-xs font-bold text-nature-300 mb-1">In debit with no sale for (days)</span>
                        <input id={`${ids}-days`} inputMode="numeric" value={days} readOnly={blocked}
                            onChange={(e) => { setDays(e.target.value.trim()); setStatus(null); }} className={input} />
                    </label>
                </div>
                {problem && !blocked && <p role="alert" className="text-xs text-amber-200 m-0 break-words">{problem}</p>}
                {blocked && (
                    <p id={ownerOnlyId} className="text-xs text-nature-400 m-0 leading-relaxed break-words">
                        Only an owner of this community can change these lines.
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
                        {saving ? 'Saving…' : 'Save the lines'}
                    </button>
                    {status && (
                        <p role={status.kind === 'error' ? 'alert' : 'status'} className={`text-xs m-0 break-words ${status.kind === 'error' ? 'text-red-300' : 'text-emerald-300'}`}>
                            {status.text}
                        </p>
                    )}
                </div>
            </div>

            <div className="space-y-2">
                <h4 className="text-sm font-bold text-white m-0 break-words">Who looked at a member&apos;s balance</h4>
                {health.log.length === 0 ? (
                    <p data-testid="health-log-empty" className="text-xs text-nature-400 m-0 break-words">Nobody has opened it.</p>
                ) : (
                    <ul data-testid="health-log" className="m-0 p-0 list-none space-y-1">
                        {health.log.map((l) => (
                            <li key={l.id} className="text-xs text-nature-300 break-words">
                                <span className="font-bold text-white">{l.actorCallsign ?? `${l.actor.slice(0, 8)}…`}</span> {logDid(l)} {new Date(l.at).toLocaleString()}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* The looks at trades and alerts: a list of their own, so they can't push a balance look out of the one above. */}
            <div className="space-y-2">
                <h4 className="text-sm font-bold text-white m-0 break-words">Who looked at trades and alerts</h4>
                {health.tradeLog.length === 0 ? (
                    <p data-testid="health-trade-log-empty" className="text-xs text-nature-400 m-0 break-words">Nobody has looked.</p>
                ) : (
                    <ul data-testid="health-trade-log" className="m-0 p-0 list-none space-y-1">
                        {health.tradeLog.map((l) => (
                            <li key={l.id} className="text-xs text-nature-300 break-words">
                                <span className="font-bold text-white">{l.actorCallsign ?? `${l.actor.slice(0, 8)}…`}</span> {logDid(l)} {new Date(l.at).toLocaleString()}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
}
