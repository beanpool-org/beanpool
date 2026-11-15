/**
 * Your deals → Bills (DESIGN-getting-paid-fable §4.2, §4.3; slice B2), the web's half; the phone's is components/Bills.tsx
 * there, drawn from the same core model (@beanpool/core bills.ts), so both say the same at every step.
 *
 * To pay lists the bills waiting on the member; a tap opens the bill's sheet, which says who sent it, what for, how much,
 * and the one money line, with Pay (asked once), Decline and Message, and for a sender they haven't dealt with the warning
 * with Block and Report. Sent lists the member's own, with Withdraw while one is not paid. Nothing is ever taken by itself.
 *
 * The rules every action keeps (the L2 and B3 reviews): the sheet acts only on the exact bill it was opened for and closes
 * when the latest read no longer lists that bill as it was (core billBoundSheet); a payment's retry id belongs to that bill
 * alone (billPayRequestFor); a lost answer says the outcome is unknown and the same press finds out (billAnswerLost); and
 * what goes is only what the sheet shows.
 */
import { useCallback, useEffect, useState } from 'react';
import {
    billAnswerLost, billBinding, billBoundSheet, billLines, billPayRequestFor, billPaySheet, billSentRow, billToPayRow, formatDate,
    type BillBalanceRead, type BillBinding, type BillPayRequest, type BillView,
} from '@beanpool/core';
import { declineBill, getBalance, getBills, payBill, reportBill, withdrawBill } from '../lib/api';
import { blockUser } from '../lib/blocklist';
import { ReportModal } from './ReportModal';

const day = (iso: string) => formatDate(new Date(iso), 'day-month');
const QUIET = 'flex-1 min-h-[44px] py-2 px-2 rounded-lg border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-700 dark:text-nature-200 font-bold text-sm hover:bg-nature-100 dark:hover:bg-nature-800 disabled:opacity-60 break-words';
const GO = 'flex-1 min-h-[44px] py-2 px-2 rounded-lg font-bold text-bp-commit-on text-sm bg-bp-commit-fill hover:bg-bp-commit-hover disabled:opacity-60 break-words';
const REFUSAL = 'text-sm font-bold text-bp-ink-warning break-words';

/** A refusal in the node's words; a lost answer in `lost`, never "nothing happened". */
const failureWords = (e: unknown, lost: string): string => {
    if (billAnswerLost(e)) return lost;
    const m = (e as { message?: unknown } | null)?.message;
    return typeof m === 'string' && m.trim() ? m : lost;
};

export interface BillsPanelProps {
    me: string;
    /** A bill to open as the panel opens (a bell row, a push, a notice); `onBillOpened` once it has been looked for. */
    openBillId?: string | null;
    onBillOpened?: () => void;
    onMessage?: (publicKey: string) => void;
    onOpenPost?: (postId: string) => void;
    onPostOffer?: () => void;
}

export function BillsPanel({ me, openBillId, onBillOpened, onMessage, onOpenPost, onPostOffer }: BillsPanelProps) {
    const [bills, setBills] = useState<{ toPay: BillView[]; sent: BillView[] } | null>(null);
    const [failed, setFailed] = useState(false);
    const [side, setSide] = useState<'to-pay' | 'sent'>('to-pay');
    const [open, setOpen] = useState<BillBinding | null>(null);
    const [said, setSaid] = useState<string | null>(null);
    const [withdrawing, setWithdrawing] = useState<string | null>(null);
    const [rowError, setRowError] = useState<{ id: string; line: string } | null>(null);

    const read = useCallback(async () => {
        try {
            const b = await getBills();
            setBills({ toPay: Array.isArray(b?.toPay) ? b.toPay : [], sent: Array.isArray(b?.sent) ? b.sent : [] });
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, []);
    useEffect(() => { void read(); }, [read]);

    // The bill a door named: opened once the first read has it; one no longer waiting says so in place of a sheet.
    useEffect(() => {
        if (!openBillId || !bills) return;
        const b = bills.toPay.find((x) => x.id === openBillId);
        if (b && billToPayRow(b, me, Date.now())) { setSide('to-pay'); setOpen(billBinding(b)); setSaid(null); }
        else setSaid(billLines.notWaiting());
        onBillOpened?.();
    }, [openBillId, bills, me, onBillOpened]);

    // The open sheet's bill as the latest read lists it; gone or changed, the sheet closes and is forgotten.
    const current = open && bills ? billBoundSheet(open, bills.toPay, me, Date.now()) : null;
    if (open && bills && !current) setOpen(null);

    const withdraw = async (id: string) => {
        if (withdrawing) return;
        setWithdrawing(id);
        setRowError(null);
        try {
            await withdrawBill(id);
            await read();
        } catch (e) {
            setRowError({ id, line: failureWords(e, billLines.withdrawLost()) });
        } finally {
            setWithdrawing(null);
        }
    };

    if (current) {
        return (
            <BillSheet key={current.id} bill={current} me={me}
                onDone={(line) => { setOpen(null); setSaid(line); void read(); }}
                onRefused={(line) => { setSaid(line); void read(); }}
                onClose={() => setOpen(null)} onMessage={onMessage} onOpenPost={onOpenPost} onPostOffer={onPostOffer} />
        );
    }
    const now = Date.now();
    const toPay = (bills?.toPay ?? []).map((b) => ({ b, row: billToPayRow(b, me, now) })).filter((x) => x.row);
    const sent = (bills?.sent ?? []).map((b) => billSentRow(b, me, now, day)).filter((r): r is NonNullable<typeof r> => r !== null);
    return (
        <div data-testid="bills-panel" className="flex flex-col gap-3">
            <div className="flex flex-wrap justify-center gap-2">
                {([['to-pay', billLines.toPayTab()], ['sent', billLines.sentTab()]] as const).map(([id, label]) => (
                    <button key={id} type="button" data-testid={`bills-side-${id}`} aria-pressed={side === id} onClick={() => setSide(id)}
                        className={`min-h-[44px] px-4 text-sm font-bold rounded-full border ${side === id
                            ? 'bg-nature-800 dark:bg-nature-200 text-white dark:text-nature-900 border-nature-900 dark:border-nature-100'
                            : 'bg-white dark:bg-nature-900 text-nature-700 dark:text-nature-300 border-nature-200 dark:border-nature-700'}`}>
                        {label}
                    </button>
                ))}
            </div>
            {said && <p data-testid="bills-said" role="status" className="text-sm font-bold text-nature-900 dark:text-white break-words">{said}</p>}
            {failed && <p data-testid="bills-failed" role="alert" className={REFUSAL}>{billLines.readFailed()}</p>}
            {side === 'to-pay' && bills && (toPay.length === 0
                ? <p className="text-sm text-nature-600 dark:text-nature-300 text-center py-8">{billLines.noneToPay()}</p>
                : toPay.map(({ b, row }) => (
                    <button key={b.id} type="button" data-testid={`bill-row-${b.id}`} onClick={() => { setSaid(null); setOpen(billBinding(b)); }}
                        className={`text-left w-full min-h-[48px] rounded-2xl p-4 border break-words text-sm font-bold text-nature-900 dark:text-white ${row!.accent
                            ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700'
                            : 'bg-white dark:bg-nature-900 border-nature-200 dark:border-nature-700'}`}>
                        🧾 {row!.label}
                    </button>
                )))}
            {side === 'sent' && bills && (sent.length === 0
                ? <p className="text-sm text-nature-600 dark:text-nature-300 text-center py-8">{billLines.noneSent()}</p>
                : sent.map((r) => (
                    <div key={r.billId} data-testid={`bill-sent-${r.billId}`} className="rounded-2xl p-4 border bg-white dark:bg-nature-900 border-nature-200 dark:border-nature-700 flex flex-col gap-2">
                        <p className="text-sm text-nature-900 dark:text-white break-words">{r.line}</p>
                        {rowError?.id === r.billId && <p role="alert" className={REFUSAL}>{rowError.line}</p>}
                        {r.withdraw && (
                            <button type="button" data-testid={`bill-withdraw-${r.billId}`} className={`${QUIET} self-start flex-none px-4`}
                                disabled={withdrawing !== null} onClick={() => withdraw(r.billId)}>{r.withdraw}</button>
                        )}
                    </div>
                )))}
        </div>
    );
}

/** The payer's sheet for one bill (design §4.3): its lines from core billPaySheet, Pay asked once, a refusal kept on it. */
export function BillSheet({ bill, me, onDone, onRefused, onClose, onMessage, onOpenPost, onPostOffer }: {
    bill: BillView; me: string; onDone: (said: string) => void; onRefused?: (said: string) => void; onClose: () => void;
    onMessage?: (publicKey: string) => void; onOpenPost?: (postId: string) => void; onPostOffer?: () => void;
}) {
    const [balance, setBalance] = useState<BillBalanceRead | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reporting, setReporting] = useState(false);
    // One retry id for this bill's payment, made as the sheet opens and sent again only on a retry of it.
    const [payRequest] = useState<BillPayRequest>(() => billPayRequestFor(null, bill.id));

    useEffect(() => {
        let alive = true;
        getBalance(me).then((b) => {
            if (alive) setBalance({ balance_c: b.balance_c, usableFloor_c: b.usableFloor_c ?? 0, floor_c: b.floor_c, liveOffers: b.liveOffers ?? 0 });
        }, () => {});
        return () => { alive = false; };
    }, [me]);

    const s = billPaySheet(bill, me, balance, Date.now(), day);
    if (!s) return null;
    const act = async (go: () => Promise<unknown>, said: string, lost: string) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await go();
            onDone(said);
        } catch (e) {
            const words = failureWords(e, lost);
            setError(words);
            // The node refused in its words: read again, so a bill paid, withdrawn or changed meanwhile closes the sheet (its
            // refusal said on the list). A lost answer reads nothing: the same press finds out.
            if (!billAnswerLost(e)) onRefused?.(words);
        } finally {
            setBusy(false);
            setConfirming(false);
        }
    };
    const pay = () => act(() => payBill(bill.id, payRequest.requestId), billLines.paid(bill.billerName, bill.amount_c), billLines.payLost());
    const decline = () => act(() => declineBill(bill.id), billLines.declined(bill.billerName), billLines.declineLost());
    const block = () => act(() => blockUser(bill.billerPublicKey, me), '', '');

    return (
        <div data-testid={`bill-sheet-${bill.id}`} className="rounded-2xl p-4 border bg-white dark:bg-nature-900 border-nature-200 dark:border-nature-700 flex flex-col gap-2">
            <h4 className="font-black text-lg text-nature-900 dark:text-white break-words">{s.title}</h4>
            <p className="text-sm text-nature-900 dark:text-white break-words">{s.whatFor}</p>
            <p data-testid="bill-amount" className="text-xl font-black text-nature-900 dark:text-white">{s.amount}</p>
            {s.about && s.aboutPostId && (
                <button type="button" className="text-left text-sm font-bold underline text-nature-900 dark:text-white min-h-[44px] break-words"
                    onClick={() => onOpenPost?.(s.aboutPostId!)}>{s.about}</button>
            )}
            <p className="text-xs text-nature-600 dark:text-nature-300 break-words">{s.sent}</p>
            {s.stranger && (
                <p data-testid="bill-stranger" role="note" className="text-sm font-bold rounded-lg p-3 border bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 break-words">{s.stranger}</p>
            )}
            {s.money && <p data-testid="bill-money" className="text-sm text-nature-700 dark:text-nature-300 break-words">{s.money.line}</p>}
            {s.postOffer && onPostOffer && (
                <button type="button" data-testid="bill-post-offer" className={`${QUIET} self-start flex-none px-4`} onClick={onPostOffer}>{s.postOffer}</button>
            )}
            {error && <p data-testid="bill-refusal" role="alert" className={REFUSAL}>{error}</p>}
            {confirming ? (
                <div data-testid="bill-confirm" className="flex flex-col gap-2 rounded-lg p-3 border border-nature-200 dark:border-nature-700">
                    <p className="font-bold text-nature-900 dark:text-white break-words">{s.confirmTitle}</p>
                    <p className="text-sm text-nature-700 dark:text-nature-300 break-words">{s.confirmBody}</p>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" className={QUIET} disabled={busy} onClick={() => setConfirming(false)}>{billLines.payConfirmCancel()}</button>
                        <button type="button" data-testid="bill-confirm-pay" className={GO} disabled={busy || !s.canPay} onClick={pay}>{s.confirmYes}</button>
                    </div>
                </div>
            ) : (
                <div className="flex flex-wrap gap-2">
                    <button type="button" data-testid="bill-decline" className={QUIET} disabled={busy} onClick={decline}>{s.decline}</button>
                    <button type="button" data-testid="bill-pay" className={GO} disabled={busy || !s.canPay} aria-disabled={!s.canPay}
                        onClick={() => { setError(null); setConfirming(true); }}>{s.pay}</button>
                </div>
            )}
            <div className="flex flex-wrap gap-2">
                {onMessage && <button type="button" data-testid="bill-message" className={QUIET} disabled={busy} onClick={() => onMessage(bill.billerPublicKey)}>{s.message}</button>}
                {s.block && <button type="button" data-testid="bill-block" className={QUIET} disabled={busy} onClick={block}>{s.block}</button>}
                {s.report && <button type="button" data-testid="bill-report" className={QUIET} disabled={busy} onClick={() => setReporting(true)}>{s.report}</button>}
                <button type="button" data-testid="bill-close" className={QUIET} disabled={busy} onClick={onClose}>{billLines.close()}</button>
            </div>
            {s.report && (
                <ReportModal isOpen={reporting} onClose={() => setReporting(false)} reporterPubkey={me} targetPubkey={bill.billerPublicKey}
                    targetName={bill.billerName} onReported={() => onDone('')}
                    onSubmitReason={async (reason) => {
                        try {
                            await reportBill(bill.id, reason);
                        } catch (e) {
                            throw new Error(failureWords(e, billLines.reportLost()));
                        }
                    }} />
            )}
        </div>
    );
}
