/**
 * "Who looked at credit" in the web app's Settings (DESIGN-credit-list-amend-fable.md §5.2), for owners and admins only: the
 * log of looks, grouped by looker and day ("@jane · 12 Nov · looked at 30 people ›"), opening to the names of that day.
 * Every owner and admin reads it; a voucher cannot and a member has no route. Reading it is not itself logged: it shows no
 * balance.
 *
 * Where it lives, and why not the node's own Settings page: the log's route (`GET /api/credit/looks`) answers only a request
 * signed with the member's own key, and refuses a Settings key session or an automation token with 401 (routes/credit-sight.ts
 * `signer`). This web app signs every request with the member's key, so the list is read here. The same log, for one member,
 * is the "Looked at by" line on their credit card (CreditCard.tsx).
 *
 * A plain member's Settings makes no request to the log: the node's role answer decides first. The list lives in this
 * component's state; nothing goes to browser storage.
 */
import { useEffect, useState } from 'react';
import { t, tn } from '@beanpool/core';
import { request } from '../lib/api';
import { readInviteRole } from '../lib/node-invites';
import { CREDIT_LIST_WORDS as W, dayWords, getCreditLooks, isOwnerOrAdmin, refusalText, type LookGroup, type LookLine } from '../lib/credit-sight';

const PAGE = 20;

export function CreditLooksSection() {
    const [may, setMay] = useState(false);
    const [open, setOpen] = useState(false);
    const [groups, setGroups] = useState<LookGroup[]>([]);
    const [more, setMore] = useState(false);
    const [day, setDay] = useState<LookGroup | null>(null);
    const [lines, setLines] = useState<LookLine[]>([]);
    const [failed, setFailed] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let alive = true;
        request<{ role?: unknown }>('GET', '/api/node-admin/me')
            .then((b) => { if (alive) setMay(isOwnerOrAdmin(readInviteRole(b?.role))); })
            .catch(() => { if (alive) setMay(false); });
        return () => { alive = false; };
    }, []);

    async function load(offset: number) {
        setFailed(null);
        try {
            const out = await getCreditLooks({ limit: PAGE, offset });
            const got = out.groups ?? [];
            setGroups((g) => (offset === 0 ? got : [...g, ...got]));
            setMore(got.length >= PAGE);
        } catch (e) {
            setFailed(refusalText(e, t(W.cardUnavailable)));
        } finally {
            setLoaded(true);
        }
    }

    function toggle() {
        const next = !open;
        setOpen(next);
        if (next && !loaded) void load(0);
        if (!next) { setGroups([]); setDay(null); setLines([]); setLoaded(false); }
    }

    async function openDay(g: LookGroup) {
        setDay(g);
        setLines([]);
        setFailed(null);
        try {
            const out = await getCreditLooks({ actor: g.actorPubkey, day: g.day, limit: 100 });
            setLines(out.looks ?? []);
        } catch (e) {
            setFailed(refusalText(e, t(W.cardUnavailable)));
        }
    }

    if (!may) return null;
    const note = 'm-0 text-[12px] leading-relaxed text-nature-600 dark:text-nature-300 break-words';

    return (
        <div data-testid="credit-looks">
            <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-400 mb-2 px-1">{t(W.looksTitle)}</div>
            <div className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 overflow-hidden">
                <button
                    type="button"
                    aria-expanded={open}
                    onClick={toggle}
                    className="w-full min-h-[48px] p-4 flex items-center justify-between gap-3 text-left bg-transparent border-0 cursor-pointer text-nature-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-2xl"
                    data-testid="credit-looks-toggle"
                >
                    <span className="min-w-0 font-bold text-[15px] break-words">{t(W.looksTitle)}</span>
                    <span aria-hidden="true" className="text-nature-400">{open ? '⌃' : '⌄'}</span>
                </button>
                {open && (
                    <div className="px-4 pb-4 space-y-3">
                        <p className={note}>{t(W.looksIntro)}</p>
                        {failed && <p role="alert" className={note} data-testid="credit-looks-failed">{failed}</p>}
                        {day ? (
                            <div className="space-y-2">
                                <button type="button" onClick={() => { setDay(null); setLines([]); }} className="min-h-[44px] px-2 font-bold underline bg-transparent border-0 cursor-pointer text-nature-800 dark:text-nature-100">{t(W.looksBack)}</button>
                                <p className="m-0 text-[13px] font-bold text-nature-900 dark:text-white break-words">{t(W.looksPerson, { name: day.callsign, day: dayWords(day.day) })}</p>
                                <ul className="list-none p-0 m-0 space-y-1" data-testid="credit-looks-day">
                                    {lines.map((l) => (
                                        <li key={`${l.subjectPubkey}-${l.surface}`} className="text-[13px] text-nature-800 dark:text-nature-200 break-words">@{l.subjectCallsign}</li>
                                    ))}
                                </ul>
                            </div>
                        ) : loaded && groups.length === 0 && !failed ? (
                            <p className={note} data-testid="credit-looks-none">{t(W.looksNone)}</p>
                        ) : (
                            <>
                                <ul className="list-none p-0 m-0 divide-y divide-nature-100 dark:divide-nature-800" data-testid="credit-looks-groups">
                                    {groups.map((g) => (
                                        <li key={`${g.actorPubkey}-${g.day}`}>
                                            <button
                                                type="button"
                                                onClick={() => openDay(g)}
                                                className="w-full min-h-[48px] py-2 text-left bg-transparent border-0 cursor-pointer text-[13px] text-nature-900 dark:text-white break-words"
                                            >
                                                {t(W.looksGroup, { name: g.callsign, day: dayWords(g.day), people: tn(g.people, '{n} person', '{n} people') })}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                                {more && (
                                    <button type="button" onClick={() => load(groups.length)} className="w-full min-h-[48px] rounded-xl border border-bp-accent-fill bg-transparent text-text-primary text-sm font-bold cursor-pointer">
                                        {t(W.looksMore)}
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
