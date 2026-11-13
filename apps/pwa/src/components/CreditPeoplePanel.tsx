/**
 * People → Community with "Show credit" (DESIGN-credit-list-fable.md §3.1, §3.2 with amendment 1 §3.1, §3.2, §3.5, §3.6): one
 * switch, only for someone who can give credit (owner, admin, voucher), off at every visit. On, each person's row says what
 * they have, the balance beside the line, the credit risk, and has one button, Give credit. The chips: All · No credit yet ·
 * Has Offers · My people, and for owners and the credit committee Vouchers (each voucher's budget, running low, Top up).
 *
 * What this never does:
 *   - offer credit where it can't be: on a Beans-off node (the global node among them) it draws nothing and asks nothing.
 *   - guess a role. The node's own answers decide (readGiver), and its first list read is the last word: a 403 `not_a_giver`
 *     (a stopped budget, a changed role) takes the switch away at once.
 *   - ask for credit before the switch is on. A plain member's page makes no request to /api/credit/*: the switch is drawn
 *     only after the node says this member is an owner, an admin or a voucher.
 *   - keep what it reads. The list lives in this component's state while the screen is open; nothing goes to the browser's
 *     storage or a cache (amendment §5.1), so leaving the pane forgets every balance.
 *   - work out a level. The Top up level is the node's offer on the row (topUpTo_c), sent as exactly `{ level }`.
 *
 * The credit view is the node's answer, 30 a page ("Show more people"), never the app's own copy of the members: offline it
 * reads "Connect to your community to see credit lines." Rows wrap to as many lines as they need and are never cut with "…".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CREDIT_SIGHT_WORDS, creditSightLine, formatCount, formatHundredths, t, tn } from '@beanpool/core';
import { resolveAvatarUrl } from '../lib/avatar';
import { setVoucherBudget, type MyVouching } from '../lib/api';
import { fetchKnownRule } from '../lib/known-rule';
import {
    CREDIT_LIST_WORDS as W, dayWords, getCreditPeople, getVouchersChip, isOwnerOrAdmin, mayGive, nodeTakesCredit, notAGiver, readGiver, refusalText,
    type CreditFilter, type CreditPage, type CreditPerson, type GiverFacts, type VoucherBudgetLine, type VoucherChipRow,
} from '../lib/credit-sight';
import { AskForMore } from './AskForMore';
import { CreditLines } from './CreditLines';
import { GiveCreditSheet } from './GiveCreditSheet';
import { VoucherCardModal } from './VoucherCardModal';

export interface CreditStart { chip: CreditFilter; by?: string; nonce: number }

export interface CreditPeoplePanelProps {
    /** The People page's search box: in credit mode the node answers it (30 a page), as it does the chips. */
    query: string;
    blocked: ReadonlySet<string>;
    onOpenProfile?: (pubkey: string) => void;
    /** Opened from the bell's `credit` row, the Invites door or a link: switch on, this chip, this voucher's row. */
    start?: CreditStart | null;
    /** The page hides its own member list while credit is on (the credit list replaces it, same people, search and order). */
    onShowing?: (showing: boolean) => void;
    /** Called once `start` has switched credit on: the page then stops handing it over (credit is off at every visit). */
    onStartUsed?: (nonce: number) => void;
    /**
     * Whether this viewer's credit view is an owner's or admin's (it shows what each line is made of), from this panel's own
     * read: the page offers its Trusted sort only then (lib/member-sort.ts). False until the node has said, and again the
     * moment it ends the sight.
     */
    onFullSight?: (full: boolean) => void;
}

const FILTER_WORDS: Readonly<Record<CreditFilter, typeof W[keyof typeof W]>> = {
    all: W.chipAll, no_credit: W.chipNoCredit, has_offers: W.chipHasOffers, mine: W.chipMine, vouchers: W.chipVouchers,
};

function Avatar({ person }: { person: { callsign: string; memberPubkey: string } }) {
    const src = resolveAvatarUrl(null, person.memberPubkey) || '/avatars/avatar_bean_green.webp';
    return <img src={src} alt="" className="rounded-full object-cover border border-nature-200 dark:border-nature-700 shrink-0" style={{ width: 36, height: 36, minWidth: 36 }} />;
}

/** "! Running low" or "✕ Nothing left to vouch with": a word with a shape, never colour alone (the glyph is for the eye only). */
function BudgetMark({ nothingLeft, runningLow }: { nothingLeft: boolean; runningLow: boolean }) {
    if (!nothingLeft && !runningLow) return null;
    return (
        <span className={`ml-2 inline-flex gap-1 rounded-lg px-2 py-0.5 text-[11px] font-bold ${nothingLeft ? 'bg-bp-chip-danger-tint text-bp-chip-danger-ink' : 'bg-bp-chip-warn-tint text-bp-chip-warn-ink'}`} data-testid="budget-mark">
            <span aria-hidden="true">{nothingLeft ? '✕' : '!'}</span>
            <span>{nothingLeft ? t(W.nothingLeftToVouch) : t(W.runningLow)}</span>
        </span>
    );
}

/** "Vouched 800 to 9 people · 50 held on invites": the held part only when something is held (a sentence of its own, joined here, never inside a template). */
function vouchedLine(v: VoucherChipRow): string {
    const vouched = tn(v.peopleVouched, 'Vouched {amount} to {n} person', 'Vouched {amount} to {n} people', { n: formatCount(v.peopleVouched), amount: formatHundredths(v.vouched) });
    const held = v.held > 0 ? t(W.heldOnInvites, { amount: formatHundredths(v.held) }) : null;
    return held ? [vouched, held].join(' · ') : vouched;
}

/** A voucher's budget on a row: "Voucher · 150 of 1,000 left ! Running low", "Owner · no limit", and when they asked. */
export function VoucherBudgetLines({ b }: { b: VoucherBudgetLine }) {
    if (b.noLimit) return <p className="m-0 text-[13px] text-nature-800 dark:text-nature-200" data-testid="voucher-line">{t(W.ownerLine)}</p>;
    return (
        <div className="space-y-0.5" data-testid="voucher-line">
            <p className="m-0 text-[13px] text-nature-800 dark:text-nature-200 break-words">
                {t(W.voucherLine, { left: formatHundredths(b.left_c ?? 0), level: formatHundredths(b.setLevel_c ?? b.level_c ?? 0) })}
                <BudgetMark nothingLeft={b.nothingLeft} runningLow={b.runningLow} />
            </p>
            {b.askedAt && <p className="m-0 text-[12px] text-nature-700 dark:text-nature-300" data-testid="voucher-asked">{t(W.askedOn, { day: dayWords(b.askedAt) })}</p>}
        </div>
    );
}

export function CreditPeoplePanel({ query, blocked, onOpenProfile, start, onShowing, onStartUsed, onFullSight }: CreditPeoplePanelProps) {
    const [giver, setGiver] = useState<GiverFacts | null | 'loading'>('loading');
    const [on, setOn] = useState(false);
    const [chip, setChip] = useState<CreditFilter>('all');
    const [pageState, setPageState] = useState<'idle' | 'loading' | 'failed' | 'offline'>('idle');
    const [refusal, setRefusal] = useState<string | null>(null);
    const [people, setPeople] = useState<CreditPerson[]>([]);
    const [next, setNext] = useState<string | null>(null);
    const [told, setTold] = useState<string | null>(null);
    const [committee, setCommittee] = useState(false);
    const [vouchers, setVouchers] = useState<VoucherChipRow[]>([]);
    const [vouchersTried, setVouchersTried] = useState(false);
    const [sheet, setSheet] = useState<string | null>(null);
    const [cardOf, setCardOf] = useState<string | null>(null);
    const [topUpNote, setTopUpNote] = useState<string | null>(null);
    const [busyTop, setBusyTop] = useState<string | null>(null);
    const [vouching, setVouching] = useState<MyVouching | null>(null);
    const [knownFloor, setKnownFloor] = useState<number | null>(null);
    const [retry, setRetry] = useState(0);
    const [focusBy, setFocusBy] = useState<string | undefined>(undefined);
    const seq = useRef(0);

    // Who may give credit: the node's own answers, read each time the pane opens. Neither read records a look. Only where
    // credit lives (lib/credit-sight creditOnNode: Beans on, never the global node, as the phone's creditPossible): on a
    // Beans-off node every credit route answers 404 `beans_off`, so nothing is drawn and nothing is asked.
    useEffect(() => {
        let alive = true;
        nodeTakesCredit()
            .then((here) => (here ? readGiver() : null))
            .then((g) => { if (alive) { setGiver(g); setVouching(g?.myVouching ?? null); } })
            .catch(() => { if (alive) setGiver(null); });
        return () => { alive = false; };
    }, []);

    const may = giver !== 'loading' && mayGive(giver);
    const full = giver !== 'loading' && giver !== null && isOwnerOrAdmin(giver.role);

    // A way in that arrives with a chip (the bell's ask, the Invites door): switch on, this chip, off again at the next visit.
    // The page is told it was used, so opening Community again by hand in the same People visit starts with the switch off.
    useEffect(() => {
        if (!start) return;
        setOn(true);
        setChip(start.chip);
        setFocusBy(start.by);
        onStartUsed?.(start.nonce);
    }, [start?.nonce]);

    useEffect(() => { onShowing?.(may && on); }, [may, on]);
    useEffect(() => { onFullSight?.(full); }, [full]);
    // Leaving the pane takes the sight with it: the page's next Community starts without it until this panel reads again.
    useEffect(() => () => onFullSight?.(false), []);

    // The community's known floor, for the sheet's Confirm line: the node's rule, only where the community confirms its members.
    useEffect(() => {
        if (!on || !full) return;
        let alive = true;
        fetchKnownRule().then((r) => { if (alive) setKnownFloor(typeof r?.knownFloor === 'number' ? r.knownFloor : null); });
        return () => { alive = false; };
    }, [on, full]);

    // The committee's chip: the node answers it (200) or does not (403 committee_only). It records no look.
    async function loadVouchers(): Promise<void> {
        try {
            const a = await getVouchersChip();
            setVouchers(a.vouchers);
            setCommittee(true);
        } catch (e) {
            if (notAGiver(e)) { setCommittee(false); if ((e as { code?: string }).code === 'not_a_giver') setGiver(null); }
        } finally {
            setVouchersTried(true);
        }
    }
    // On switch-on (the probe) and each time the Vouchers chip is picked, so its rows are the node's now, never an earlier visit's.
    useEffect(() => {
        if (!on || !full) return;
        void loadVouchers();
    }, [on, full, chip === 'vouchers']);

    // The list: the node's page for the chip and the search; a late answer to an earlier ask is dropped.
    useEffect(() => {
        if (!on || !may || chip === 'vouchers') return;
        const mine = ++seq.current;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { setPageState('offline'); return; }
        setPageState('loading');
        setRefusal(null);
        const wait = setTimeout(() => {
            getCreditPeople({ filter: chip, q: query }).then((page: CreditPage) => {
                if (mine !== seq.current) return;
                setPeople(page.people);
                setNext(page.next);
                setTold(page.told);
                setPageState('idle');
            }).catch((e) => {
                if (mine !== seq.current) return;
                if (notAGiver(e)) { setGiver(null); return; }
                const status = (e as { status?: number })?.status;
                // The node's own sentence for a refusal it made (a spent hour of looks); no answer at all reads as offline.
                if (typeof status === 'number') { setRefusal(refusalText(e, t(W.unreadable))); setPageState('failed'); } else setPageState('offline');
            });
        }, query ? 350 : 0);
        return () => clearTimeout(wait);
    }, [on, may, chip, query, retry]);

    async function more() {
        if (!next) return;
        const mine = ++seq.current;
        try {
            const page = await getCreditPeople({ filter: chip as Exclude<CreditFilter, 'vouchers'>, q: query, after: next });
            if (mine !== seq.current) return;
            setPeople((p) => [...p, ...page.people]);
            setNext(page.next);
        } catch (e) {
            if (notAGiver(e)) setGiver(null); else setRefusal(refusalText(e, t(W.unreadable)));
        }
    }

    // The bell's ask lands on that voucher's row.
    useEffect(() => {
        if (!focusBy || chip !== 'vouchers' || vouchers.length === 0) return;
        const el = typeof document !== 'undefined' ? document.getElementById(`voucher-row-${focusBy}`) : null;
        (el as HTMLElement | null)?.scrollIntoView?.({ block: 'center' });
    }, [focusBy, chip, vouchers]);

    const shown = useMemo(() => people.filter((p) => !blocked.has(p.memberPubkey)), [people, blocked]);
    const sheetPerson = sheet ? people.find((p) => p.memberPubkey === sheet) ?? null : null;
    const giveable = (p: CreditPerson) => p.canGive && !p.own && !blocked.has(p.memberPubkey);
    const nextOf = (pk: string): string | undefined => {
        const i = shown.findIndex((p) => p.memberPubkey === pk);
        return shown.slice(i + 1).find(giveable)?.memberPubkey;
    };

    async function topUp(row: VoucherChipRow) {
        if (row.topUpTo_c === null) return;
        setBusyTop(row.memberPubkey);
        setTopUpNote(null);
        try {
            // The level is the node's offer on the row, sent exactly as it is: `{ level }`.
            const card = await setVoucherBudget(row.memberPubkey, row.topUpTo_c);
            setTopUpNote(t(W.toppedUp, { name: row.callsign, level: formatHundredths(card.level), left: formatHundredths(card.left) }));
            await loadVouchers();
        } catch (e) {
            setTopUpNote(refusalText(e, t('Could not top up just now.')));
        } finally {
            setBusyTop(null);
        }
    }

    if (giver === 'loading' || !may) return null;

    const chips: CreditFilter[] = committee ? ['all', 'no_credit', 'has_offers', 'mine', 'vouchers'] : ['all', 'no_credit', 'has_offers', 'mine'];
    const budget = vouching?.voucher && !vouching.noLimit && vouching.budget ? vouching.budget : null;
    const note = 'm-0 text-[12px] leading-relaxed text-nature-600 dark:text-nature-300 break-words';

    return (
        <section className="mb-4" data-testid="credit-panel" aria-label={t(W.showCredit)}>
            <label className="flex items-center gap-3 min-h-[44px] cursor-pointer">
                <input
                    type="checkbox"
                    role="switch"
                    checked={on}
                    onChange={(e) => { setOn(e.target.checked); if (!e.target.checked) { setPeople([]); setVouchers([]); setSheet(null); setTold(null); } }}
                    className="w-5 h-5 shrink-0 accent-[var(--bp-accent-fill)]"
                    data-testid="credit-switch"
                />
                <span className="text-[14px] font-bold text-nature-900 dark:text-white">{t(W.showCredit)}</span>
            </label>
            {on && (
                <div className="space-y-3 mt-1">
                    <p className={note} data-testid="credit-only-givers">{t(CREDIT_SIGHT_WORDS.onlyGivers)}</p>

                    {budget && (
                        <div className="p-3 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 space-y-2" data-testid="credit-my-budget">
                            <p className="m-0 text-[13px] font-bold text-nature-900 dark:text-white break-words">
                                {t(W.yourBudget, { left: formatHundredths(budget.left), level: formatHundredths(budget.level) })}
                            </p>
                            <AskForMore ask={vouching?.ask ?? null} onAsked={(ask) => setVouching((v) => (v ? { ...v, ask } : v))} />
                        </div>
                    )}

                    <div className="flex flex-wrap gap-2" role="group" aria-label={t(W.showCredit)}>
                        {chips.map((c) => (
                            <button
                                key={c}
                                type="button"
                                aria-pressed={chip === c}
                                onClick={() => setChip(c)}
                                className={`min-h-[44px] px-3 rounded-xl border text-[13px] font-bold cursor-pointer ${chip === c
                                    ? 'border-transparent bg-bp-commit-fill text-bp-commit-on'
                                    : 'border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-900 dark:text-white'}`}
                                data-testid={`credit-chip-${c}`}
                            >
                                {t(FILTER_WORDS[c])}
                            </button>
                        ))}
                    </div>

                    {chip === 'vouchers' ? (
                        <div data-testid="credit-vouchers">
                            {topUpNote && <p role="status" className="m-0 mb-2 p-3 rounded-xl bg-bp-chip-ok-tint text-bp-chip-ok-ink text-[13px] font-bold break-words" data-testid="topup-note">{topUpNote}</p>}
                            {vouchersTried && vouchers.length === 0 ? <p className={note}>{t(W.noVouchers)}</p> : (
                                <ul className="list-none p-0 m-0 bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm divide-y divide-nature-100 dark:divide-nature-800 overflow-hidden">
                                    {vouchers.map((v) => (
                                        <li key={v.memberPubkey} id={`voucher-row-${v.memberPubkey}`} className={`p-3 px-4 space-y-2 ${focusBy === v.memberPubkey ? 'ring-2 ring-inset ring-bp-accent-fill' : ''}`} data-testid="voucher-row">
                                            <button
                                                type="button"
                                                onClick={() => onOpenProfile?.(v.memberPubkey)}
                                                aria-label={t("View {name}'s profile", { name: v.callsign })}
                                                className="flex items-start gap-3 w-full min-h-[44px] text-left bg-transparent border-0 p-0 cursor-pointer"
                                            >
                                                <Avatar person={v} />
                                                <span className="min-w-0 space-y-0.5">
                                                    <span className="block font-bold text-[14px] text-nature-900 dark:text-white break-words">{v.callsign}</span>
                                                    {v.noLimit ? (
                                                        <span className="block text-[13px] text-nature-800 dark:text-nature-200">{t(W.ownerLine)}</span>
                                                    ) : (
                                                        <>
                                                            <span className="block text-[13px] text-nature-800 dark:text-nature-200 break-words" data-testid="voucher-left">
                                                                {t(W.voucherLine, { left: formatHundredths(v.left), level: formatHundredths(v.setLevel_c ?? v.level) })}
                                                                <BudgetMark nothingLeft={v.nothingLeft} runningLow={v.runningLow} />
                                                            </span>
                                                            <span className="block text-[12px] text-nature-700 dark:text-nature-300 break-words" data-testid="voucher-vouched">
                                                                {vouchedLine(v)}
                                                            </span>
                                                            <span className="block text-[12px] text-nature-700 dark:text-nature-300 break-words">
                                                                {t(W.belowZeroCount, { below: formatCount(v.belowZero), people: formatCount(v.peopleVouched), amount: formatHundredths(v.writtenOff) })}
                                                            </span>
                                                            {v.askedAt && <span className="block text-[12px] font-bold text-nature-800 dark:text-nature-200" data-testid="voucher-asked">{t(W.askedOn, { day: dayWords(v.askedAt) })}</span>}
                                                        </>
                                                    )}
                                                </span>
                                            </button>
                                            <div className="flex flex-wrap items-center gap-2">
                                                {v.topUpTo_c !== null && (
                                                    <button
                                                        type="button"
                                                        disabled={busyTop === v.memberPubkey}
                                                        onClick={() => topUp(v)}
                                                        className="min-h-[48px] px-4 rounded-xl bg-bp-commit-fill text-bp-commit-on border-0 text-sm font-bold cursor-pointer disabled:opacity-50 shadow-sm"
                                                        data-testid="voucher-topup"
                                                    >
                                                        {t(W.topUp, { level: formatHundredths(v.topUpTo_c) })}
                                                    </button>
                                                )}
                                                {!v.noLimit && v.topUpBlocked === 'at_most' && <span className={note} data-testid="topup-blocked">{t(W.atMost)}</span>}
                                                {!v.noLimit && v.topUpBlocked === 'frozen' && <span className={note} data-testid="topup-blocked">{t(W.voucherFrozen)}</span>}
                                                {!v.noLimit && v.topUpBlocked === 'paused' && <span className={note} data-testid="topup-blocked">{t(W.voucherPaused)}</span>}
                                                {!v.noLimit && (
                                                    <button type="button" onClick={() => setCardOf(v.memberPubkey)} className="min-h-[48px] px-3 rounded-xl border border-bp-accent-fill bg-transparent text-text-primary text-sm font-bold cursor-pointer" data-testid="voucher-card">
                                                        {t(W.theirCard)}
                                                    </button>
                                                )}
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    ) : pageState === 'offline' ? (
                        <p className={`${note} flex flex-wrap items-center gap-x-2`} data-testid="credit-offline">
                            <span>{t(W.offline)}</span>
                            <button type="button" onClick={() => setRetry((n) => n + 1)} className="min-h-[44px] px-2 font-bold underline bg-transparent border-none cursor-pointer text-nature-800 dark:text-nature-100">{t(W.tryAgain)}</button>
                        </p>
                    ) : pageState === 'failed' ? (
                        <p role="alert" className={note} data-testid="credit-failed">{refusal}</p>
                    ) : pageState === 'loading' && shown.length === 0 ? (
                        <p className={`${note} animate-pulse`} aria-live="polite">{t(W.loading)}</p>
                    ) : shown.length === 0 ? (
                        <p className={note} data-testid="credit-empty">{t(W.nobody)}</p>
                    ) : (
                        <>
                            <ul className="list-none p-0 m-0 bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm divide-y divide-nature-100 dark:divide-nature-800 overflow-hidden" data-testid="credit-list">
                                {shown.map((p) => (
                                    // Under the text on a narrow screen (320 px at 130%), beside it where there is room (design §3.2).
                                    <li key={p.memberPubkey} className={`p-3 px-4 space-y-2 sm:space-y-0 sm:flex sm:items-center sm:gap-4 ${p.status === 'paused' ? 'opacity-60' : ''}`} data-testid="credit-row" data-pubkey={p.memberPubkey}>
                                        <button
                                            type="button"
                                            onClick={() => onOpenProfile?.(p.memberPubkey)}
                                            aria-label={t("View {name}'s profile", { name: p.callsign })}
                                            aria-describedby={`credit-lines-${p.memberPubkey.slice(0, 16)}`}
                                            className="flex items-start gap-3 w-full sm:flex-1 sm:w-auto min-w-0 min-h-[44px] text-left bg-transparent border-0 p-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-lg"
                                        >
                                            <Avatar person={p} />
                                            <span className="min-w-0 space-y-1 flex-1">
                                                <span className="block font-bold text-[14px] text-nature-900 dark:text-white break-words">{p.callsign}</span>
                                                {/* The button's name is the callsign (aria-label); what the row says, balance and risk included, is its
                                                    description, so a screen reader hears "minus 420 Beans" and the word, not only "View Rob's profile". */}
                                                <span id={`credit-lines-${p.memberPubkey.slice(0, 16)}`} className="block space-y-1">
                                                    <CreditLines person={p} />
                                                    {p.voucherBudget && <VoucherBudgetLines b={p.voucherBudget} />}
                                                </span>
                                            </span>
                                        </button>
                                        {giveable(p) && (
                                            <button
                                                type="button"
                                                onClick={() => setSheet(p.memberPubkey)}
                                                aria-label={t(W.sheetTitle, { name: p.callsign })}
                                                className="w-full sm:w-auto sm:shrink-0 sm:min-w-[160px] min-h-[48px] px-4 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on border-0 text-sm font-bold cursor-pointer shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                                                data-testid="credit-give"
                                            >
                                                {t(W.giveCredit)}
                                            </button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                            {next && (
                                <button type="button" onClick={more} className="w-full min-h-[48px] rounded-xl border border-bp-accent-fill bg-transparent text-text-primary text-sm font-bold cursor-pointer" data-testid="credit-more">
                                    {t(W.showMore)}
                                </button>
                            )}
                            {refusal && <p role="alert" className={note}>{refusal}</p>}
                        </>
                    )}
                    {told && chip !== 'vouchers' && <p className={note} data-testid="credit-told">{creditSightLine(true)}</p>}
                </div>
            )}

            {sheetPerson && (
                // Keyed by the person: Next starts the next one clean (no preset, result, refusal or raise amount carried over;
                // a vouch can't be taken back). A give keeps the key, so the person read again updates the same sheet.
                <GiveCreditSheet
                    key={sheetPerson.memberPubkey}
                    person={sheetPerson}
                    myVouching={vouching}
                    knownFloor_c={knownFloor}
                    full={full}
                    onClose={() => setSheet(null)}
                    onChanged={(fresh) => setPeople((all) => all.map((p) => (p.memberPubkey === fresh.memberPubkey ? fresh : p)))}
                    onVouching={setVouching}
                    onNext={nextOf(sheetPerson.memberPubkey) ? () => setSheet(nextOf(sheetPerson.memberPubkey) ?? null) : undefined}
                />
            )}
            {cardOf && <VoucherCardModal memberPubkey={cardOf} onClose={() => { setCardOf(null); void loadVouchers(); }} />}
        </section>
    );
}
