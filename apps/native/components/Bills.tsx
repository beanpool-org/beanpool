/**
 * Your deals → Bills (DESIGN-getting-paid-fable §4.2, §4.3; slice B2), the phone's half; the web's is
 * apps/pwa/src/components/Bills.tsx, drawn from the same core model (@beanpool/core bills.ts), so both say the same at every
 * step. Read from the node each time it opens and after every answer; nothing about a bill is kept on the phone.
 *
 * To pay lists the bills waiting on the member; a tap opens the bill's sheet: who sent it, what for, how much, the one money
 * line, Pay (asked once), Decline and Message, and for a sender they haven't dealt with the warning with Block and Report.
 * Sent lists the member's own, with Withdraw while one is not paid. Nothing is ever taken by itself.
 *
 * The rules every action keeps (the L2 and B3 reviews): the sheet acts only on the exact bill it was opened for and closes
 * when the latest read no longer lists that bill as it was (core billBoundSheet); a payment's retry id belongs to that bill
 * alone (billPayRequestFor); a lost answer says the outcome is unknown and the same press finds out (billAnswerLost); and
 * what goes is only what the sheet shows. Styles from the theme's tokens, wrapping at 320 dp and 1.3× text.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
    billAnswerLost, billBinding, billBoundSheet, billLines, billPayRequestFor, billPaySheet, billSentRow, billToPayRow, formatDate, t,
    type BillBalanceRead, type BillBinding, type BillPayRequest, type BillView,
} from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';
import { createConversationApi, declineBill, getBalance, getBills, payBill, reportBill, withdrawBill } from '../utils/db';
import { Alert } from '../utils/keyboard-alert';
import { blockUser, getBlockedUsers } from '../utils/blocklist';
import { ReportReasonBox } from './ReportReasonBox';

const day = (iso: string) => formatDate(new Date(iso), 'day-month');

/** A refusal in the node's words; a lost answer in `lost`, never "nothing happened". */
const failureWords = (e: unknown, lost: string): string => {
    if (billAnswerLost(e)) return lost;
    const m = (e as { message?: unknown } | null)?.message;
    return typeof m === 'string' && m.trim() ? m : lost;
};

function useBillStyles() {
    const { colors } = useTheme();
    return useMemo(() => StyleSheet.create({
        col: { gap: 10 },
        sides: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
        side: { minHeight: 44, paddingHorizontal: 16, borderRadius: 22, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, justifyContent: 'center' },
        sideOn: { backgroundColor: colors.text.body, borderColor: colors.text.body },
        sideText: { color: colors.text.secondary, fontSize: 14, fontWeight: '700' },
        sideTextOn: { color: colors.surface.card },
        said: { color: colors.text.body, fontSize: 14, fontWeight: '700', lineHeight: 20 },
        none: { color: colors.text.secondary, fontSize: 14, textAlign: 'center', paddingVertical: 24 },
        row: { minHeight: 48, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, gap: 8 },
        rowAccent: { backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border },
        rowText: { color: colors.text.body, fontSize: 14, fontWeight: '700', lineHeight: 20 },
        rowPlain: { color: colors.text.body, fontSize: 14, lineHeight: 20 },
        sheet: { borderRadius: 16, padding: 14, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, gap: 8 },
        title: { color: colors.text.body, fontSize: 18, fontWeight: '800' },
        body: { color: colors.text.body, fontSize: 14, lineHeight: 20 },
        amount: { color: colors.text.body, fontSize: 20, fontWeight: '800' },
        muted: { color: colors.text.secondary, fontSize: 13, lineHeight: 18 },
        link: { minHeight: 44, justifyContent: 'center' },
        linkText: { color: colors.text.body, fontSize: 14, fontWeight: '700', textDecorationLine: 'underline' },
        banner: { borderRadius: 12, padding: 12, borderWidth: 1, backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border },
        bannerText: { color: colors.feedback.warning.fg, fontSize: 14, fontWeight: '700', lineHeight: 20 },
        refusal: { color: colors.feedback.warning.fg, fontSize: 13, fontWeight: '700', lineHeight: 19 },
        confirm: { borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border.default, gap: 8 },
        buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
        quiet: { flexGrow: 1, flexBasis: 120, minHeight: 44, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        quietText: { color: colors.text.secondary, fontSize: 14, fontWeight: '700', textAlign: 'center' },
        go: { flexGrow: 1, flexBasis: 140, minHeight: 44, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
        goText: { color: colors.text.inverse, fontSize: 14, fontWeight: '800', textAlign: 'center' },
        off: { opacity: 0.6 },
    }), [colors]);
}

function Button({ label, onPress, go, disabled, testID }: { label: string; onPress: () => void; go?: boolean; disabled?: boolean; testID?: string }) {
    const s = useBillStyles();
    return (
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} testID={testID} disabled={disabled} onPress={onPress}
            style={[go ? s.go : s.quiet, disabled && s.off]}>
            <Text style={go ? s.goText : s.quietText}>{label}</Text>
        </Pressable>
    );
}

/**
 * Your deals → Bills as a screen hands it to the deals sheet (MyDealsSheet's `bills`): the panel with its ways forward, each
 * closing the sheet first (`leave`) so the next screen opens on top: Message opens a direct chat with the sender, the listing a
 * bill is about opens that listing, Post an Offer opens the composer on an Offer.
 */
export function BillsTab({ me, openBillId, onBillOpened, leave }: { me: string; openBillId?: string | null; onBillOpened?: () => void; leave: () => void }) {
    return (
        <BillsPanel me={me} openBillId={openBillId} onBillOpened={onBillOpened}
            onMessage={async (peer) => {
                try {
                    const conv = await createConversationApi('dm', [me, peer], me);
                    leave();
                    router.push(`/chat/${conv.id}`);
                } catch (e: any) {
                    Alert.alert(t('Error'), typeof e?.message === 'string' && e.message ? e.message : t('Connect to your community to start a chat.'));
                }
            }}
            onOpenPost={(postId) => { leave(); router.push(`/post/${postId}`); }}
            onPostOffer={() => { leave(); router.push({ pathname: '/new-listing', params: { newPost: 'offer' } }); }} />
    );
}

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
    const s = useBillStyles();
    const [bills, setBills] = useState<{ toPay: BillView[]; sent: BillView[] } | null>(null);
    const [failed, setFailed] = useState(false);
    const [side, setSide] = useState<'to-pay' | 'sent'>('to-pay');
    const [open, setOpen] = useState<BillBinding | null>(null);
    const [said, setSaid] = useState<string | null>(null);
    const [withdrawing, setWithdrawing] = useState<string | null>(null);
    const [rowError, setRowError] = useState<{ id: string; line: string } | null>(null);

    const read = useCallback(async () => {
        try {
            const [b, blocked] = await Promise.all([getBills(), getBlockedUsers().catch(() => [] as string[])]);
            // A sender blocked on this phone and not yet on the node (its next sync takes it there): never shown, as the node does.
            setBills({ toPay: b.toPay.filter((x) => !blocked.includes(x.billerPublicKey)), sent: b.sent });
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
        <View style={s.col} testID="bills-panel">
            <View style={s.sides} accessibilityRole="tablist">
                {([['to-pay', billLines.toPayTab()], ['sent', billLines.sentTab()]] as const).map(([id, label]) => (
                    <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: side === id }} testID={`bills-side-${id}`}
                        style={[s.side, side === id && s.sideOn]} onPress={() => setSide(id)}>
                        <Text style={[s.sideText, side === id && s.sideTextOn]}>{label}</Text>
                    </Pressable>
                ))}
            </View>
            {!!said && <Text style={s.said} testID="bills-said" accessibilityLiveRegion="polite">{said}</Text>}
            {failed && <Text style={s.refusal} testID="bills-failed" accessibilityRole="alert">{billLines.readFailed()}</Text>}
            {side === 'to-pay' && !!bills && (toPay.length === 0
                ? <Text style={s.none}>{billLines.noneToPay()}</Text>
                : toPay.map(({ b, row }) => (
                    <Pressable key={b.id} accessibilityRole="button" testID={`bill-row-${b.id}`} style={[s.row, row!.accent && s.rowAccent]}
                        onPress={() => { setSaid(null); setOpen(billBinding(b)); }}>
                        <Text style={s.rowText}>🧾 {row!.label}</Text>
                    </Pressable>
                )))}
            {side === 'sent' && !!bills && (sent.length === 0
                ? <Text style={s.none}>{billLines.noneSent()}</Text>
                : sent.map((r) => (
                    <View key={r.billId} style={s.row} testID={`bill-sent-${r.billId}`}>
                        <Text style={s.rowPlain}>{r.line}</Text>
                        {rowError?.id === r.billId && <Text style={s.refusal} accessibilityRole="alert">{rowError.line}</Text>}
                        {!!r.withdraw && (
                            <View style={s.buttons}>
                                <Button label={r.withdraw} testID={`bill-withdraw-${r.billId}`} disabled={withdrawing !== null} onPress={() => withdraw(r.billId)} />
                            </View>
                        )}
                    </View>
                )))}
        </View>
    );
}

/** The payer's sheet for one bill (design §4.3): its lines from core billPaySheet, Pay asked once, a refusal kept on it. */
export function BillSheet({ bill, me, onDone, onRefused, onClose, onMessage, onOpenPost, onPostOffer }: {
    bill: BillView; me: string; onDone: (said: string) => void; onRefused?: (said: string) => void; onClose: () => void;
    onMessage?: (publicKey: string) => void; onOpenPost?: (postId: string) => void; onPostOffer?: () => void;
}) {
    const s = useBillStyles();
    const [balance, setBalance] = useState<BillBalanceRead | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reporting, setReporting] = useState(false);
    // One retry id for this bill's payment, made as the sheet opens and sent again only on a retry of it.
    const [payRequest] = useState<BillPayRequest>(() => billPayRequestFor(null, bill.id));

    useEffect(() => {
        let alive = true;
        getBalance(me).then((b: any) => {
            if (alive) setBalance({ balance_c: b.balance_c, usableFloor_c: b.usableFloor_c ?? 0, floor_c: b.floor_c ?? 0, liveOffers: b.liveOffers ?? 0 });
        }, () => {});
        return () => { alive = false; };
    }, [me]);

    const sheet = billPaySheet(bill, me, balance, Date.now(), day);
    if (!sheet) return null;
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
    // A block is the phone's own list first (utils/blocklist.ts), which reaches the node when it next syncs: the panel hides
    // the sender's bills from that list at once (read), as the node does once it has the block.
    const block = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await blockUser(bill.billerPublicKey, me);
        } finally {
            setBusy(false);
        }
        onDone('');
    };

    return (
        <View style={s.sheet} testID={`bill-sheet-${bill.id}`}>
            <Text style={s.title} accessibilityRole="header">{sheet.title}</Text>
            <Text style={s.body}>{sheet.whatFor}</Text>
            <Text style={s.amount} testID="bill-amount">{sheet.amount}</Text>
            {!!sheet.about && !!sheet.aboutPostId && (
                <Pressable accessibilityRole="link" style={s.link} onPress={() => onOpenPost?.(sheet.aboutPostId!)}>
                    <Text style={s.linkText}>{sheet.about}</Text>
                </Pressable>
            )}
            <Text style={s.muted}>{sheet.sent}</Text>
            {!!sheet.stranger && (
                <View style={s.banner} testID="bill-stranger"><Text style={s.bannerText}>{sheet.stranger}</Text></View>
            )}
            {!!sheet.money && <Text style={s.body} testID="bill-money">{sheet.money.line}</Text>}
            {!!sheet.postOffer && !!onPostOffer && (
                <View style={s.buttons}><Button label={sheet.postOffer} testID="bill-post-offer" onPress={onPostOffer} /></View>
            )}
            {!!error && <Text style={s.refusal} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="bill-refusal">{error}</Text>}
            {confirming ? (
                <View style={s.confirm} testID="bill-confirm">
                    <Text style={[s.body, { fontWeight: '800' }]}>{sheet.confirmTitle}</Text>
                    <Text style={s.muted}>{sheet.confirmBody}</Text>
                    <View style={s.buttons}>
                        <Button label={billLines.payConfirmCancel()} disabled={busy} onPress={() => setConfirming(false)} />
                        <Button label={sheet.confirmYes} go testID="bill-confirm-pay" disabled={busy || !sheet.canPay} onPress={pay} />
                    </View>
                </View>
            ) : (
                <View style={s.buttons}>
                    <Button label={sheet.decline} testID="bill-decline" disabled={busy} onPress={decline} />
                    <Button label={sheet.pay} go testID="bill-pay" disabled={busy || !sheet.canPay} onPress={() => { setError(null); setConfirming(true); }} />
                </View>
            )}
            <View style={s.buttons}>
                {!!onMessage && <Button label={sheet.message} testID="bill-message" disabled={busy} onPress={() => onMessage(bill.billerPublicKey)} />}
                {!!sheet.block && <Button label={sheet.block} testID="bill-block" disabled={busy} onPress={block} />}
                {!!sheet.report && <Button label={sheet.report} testID="bill-report" disabled={busy} onPress={() => setReporting((r) => !r)} />}
                <Button label={billLines.close()} testID="bill-close" disabled={busy} onPress={onClose} />
            </View>
            {!!sheet.report && reporting && (
                <ReportReasonBox onCancel={() => setReporting(false)} onSubmit={async (reason) => {
                    try {
                        await reportBill(bill.id, reason);
                        onDone('');
                    } catch (e) {
                        setError(failureWords(e, billLines.reportLost()));
                        throw e;
                    }
                }} />
            )}
        </View>
    );
}
