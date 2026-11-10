/**
 * Demurrage accounting — every Commons credit has exactly one recordable event, and nothing invents beans.
 *
 * THE INVARIANT. BeanPool is mutual credit: the network always sums to zero, so `sum(balances) +
 * COMMONS_BALANCE` must never move except when value genuinely enters or leaves an account. Demurrage moves
 * value between the two halves, so it must move both by the same amount or not at all.
 *
 * WHY THIS FILE EXISTS. `applyDecay` does two things together — debit the account, credit the global — but
 * only the debit lived in the account map, and three paths broke the pair:
 *
 *   • `loadState()` replaced the account map (reverting the debit) and dropped the queued events, while
 *     leaving the credit in place. That is minting, from the function whose job is to resynchronise, and it
 *     runs on every raw-SQL balance mutation via the host's balance-mutation hook.
 *   • the pending-events cap applied the decay and skipped the event, so the host could never write the
 *     matching ledger row.
 *   • a decay below the recording threshold advanced the epoch and credited the Commons anyway, consuming
 *     the interval and leaving the credit unaccounted.
 *
 * Diagnosed from a real node: every member account short by a demurrage-shaped amount, `last_demurrage_epoch`
 * set and recent, and ZERO `demurrage_%` transaction rows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LedgerManager, type LedgerAccount } from '../ledger.js';
import * as core from '../ledger.js';

/** The whole ledger as one number, in whole hundredths. This is the figure that must not move: compared with `toBe`, exactly. */
const total = (l: LedgerManager, ids: string[]) =>
    ids.reduce((t, id) => t + l.getAccount(id).balance_c, 0) + core.COMMONS_BALANCE;

/** An account whose stored epoch is `daysStale` behind, so the next read applies real demurrage. */
const stale = (l: LedgerManager, id: string, balance: number, daysStale: number): LedgerAccount =>
    ({ id, balance_c: balance, lastDemurrageEpoch: l.getCurrentEpoch() - daysStale });

describe('demurrage accounting', () => {
    let ledger: LedgerManager;

    beforeEach(() => {
        core.setCommonsBalance(0);
        ledger = new LedgerManager();
    });

    it('applies decay as a matched debit and credit, with exactly one event', () => {
        ledger.loadState([stale(ledger, 'alice', 50000, 60)]);
        const before = total(ledger, []) + 50000;   // rows not yet read, so add the stored balance

        const decayed = ledger.getAccount('alice').balance_c;
        expect(decayed).toBeLessThan(50000);

        const credited = core.COMMONS_BALANCE;
        expect(credited).toBe(50000 - decayed);
        expect(total(ledger, ['alice'])).toBe(before);

        const events = ledger.drainDecayEvents();
        expect(events).toHaveLength(1);
        expect(events[0].amount).toBe(credited);
        expect(events[0].accountId).toBe('alice');
    });

    it('does not MINT when loadState discards queued decay (the live bug)', () => {
        ledger.loadState([stale(ledger, 'alice', 50000, 60)]);
        ledger.getAccount('alice');                       // decay applied in memory, event queued

        const creditFromDecay = core.COMMONS_BALANCE;
        expect(creditFromDecay).toBeGreaterThan(0);

        // The host resyncs from its stored rows — which still hold the PRE-decay balance and epoch, because
        // a queued event means the debit was never written. This is the exact call the balance-mutation hook
        // makes on every raw-SQL mutation.
        ledger.loadState([stale(ledger, 'alice', 50000, 60)]);

        expect(core.COMMONS_BALANCE).toBe(0);             // the credit is unwound with the debit
        expect(ledger.drainDecayEvents()).toHaveLength(0);
        // Before the fix this was 500 + creditFromDecay: a credit with no debit, which the host's next
        // persistCommonsBalance() would have made durable.
        expect(total(ledger, ['alice'])).toBe(50000);
    });

    it('keeps the credit when the events are DRAINED, because the host is about to persist them', () => {
        ledger.loadState([stale(ledger, 'alice', 50000, 60)]);
        ledger.getAccount('alice');
        const credit = core.COMMONS_BALANCE;

        const events = ledger.drainDecayEvents();
        expect(events).toHaveLength(1);

        // A drain hands ownership to the host, so a later resync must NOT unwind it — the debit is durable by
        // then. This is the other half of the rule, and getting it backwards would destroy beans instead.
        ledger.loadState([{ id: 'alice', balance_c: ledger.getAccount('alice').balance_c, lastDemurrageEpoch: ledger.getCurrentEpoch() }]);
        expect(core.COMMONS_BALANCE).toBe(credit);
    });

    it('unwinds MANY queued events, not just the last one', () => {
        const ids = ['a', 'b', 'c', 'd', 'e'];
        ledger.loadState(ids.map(id => stale(ledger, id, 80000, 90)));
        ids.forEach(id => ledger.getAccount(id));

        expect(core.COMMONS_BALANCE).toBeGreaterThan(0);

        ledger.loadState(ids.map(id => stale(ledger, id, 80000, 90)));
        expect(core.COMMONS_BALANCE).toBe(0);
        expect(total(ledger, [])).toBe(0);
    });

    // The first 200 beans are the tax-free Green Zone (rate 0.000), so a sub-hundredth decay needs a balance only
    // just above 200 — 202 Beans (20200) puts 200 hundredths in the 1%/month bracket and nothing above it: a day of
    // that is ~0.07 of a hundredth (forfeited), a month of it ~2 hundredths (recorded).
    const JUST_OVER_GREEN_ZONE = 20200;

    it('never decays a balance inside the tax-free Green Zone, however long it sits', () => {
        ledger.loadState([stale(ledger, 'modest', 19999, 4000)]);
        const account = ledger.getAccount('modest');

        expect(account.balance_c).toBe(19999);
        expect(core.COMMONS_BALANCE).toBe(0);
        expect(ledger.drainDecayEvents()).toHaveLength(0);
    });

    it('FORFEITS a decay too small to record, and closes the interval anyway', () => {
        // 200 hundredths in the 1%/month bracket over one day ≈ 0.067 of a hundredth — below one hundredth.
        ledger.loadState([stale(ledger, 'sliver', JUST_OVER_GREEN_ZONE, 1)]);
        const account = ledger.getAccount('sliver');

        expect(account.balance_c).toBe(JUST_OVER_GREEN_ZONE);   // not decayed
        expect(core.COMMONS_BALANCE).toBe(0);                 // and no unaccounted credit
        expect(ledger.drainDecayEvents()).toHaveLength(0);
        // The epoch IS stamped. Forfeiting costs at most this one sub-threshold decay; carrying the interval
        // instead would let it be charged later against whatever the balance has become by then.
        expect(account.lastDemurrageEpoch).toBe(ledger.getCurrentEpoch());
    });

    it('does not charge a carried interval against a LATER, larger balance', () => {
        // The regression that made forfeiting the right answer instead of deferring. With the interval left
        // open, this measured 465.33 beans taken from a 10,000 deposit — 4.6% of it — for a window during
        // which the account held 200.005. Demurrage is principal × time × rate, so an interval cannot be
        // carried across a change of principal.
        // 10 hundredths above the Green Zone over 60 days decays by ~0.2 of a hundredth — under one hundredth, so
        // forfeited. (2 Beans over the same interval would be ~4 hundredths, recordable, so the sliver is this thin.)
        const THIN_SLIVER = 20010;
        ledger.loadState([
            stale(ledger, 'sliver', THIN_SLIVER, 60),
            { id: 'whale', balance_c: 5_000_000, lastDemurrageEpoch: ledger.getCurrentEpoch() },
        ]);
        ledger.getAccount('sliver');                       // sub-threshold: forfeited, interval closed
        expect(core.COMMONS_BALANCE).toBe(0);

        expect(ledger.transfer('whale', 'sliver', 1_000_000, -10000, /* isFeeExempt */ true).ok).toBe(true);
        const after = ledger.getAccount('sliver');

        // No retrospective charge: the only decay owed is on the interval since the deposit, which is zero.
        expect(after.balance_c).toBe(THIN_SLIVER + 1_000_000);
        expect(core.COMMONS_BALANCE).toBe(0);
        expect(ledger.drainDecayEvents()).toHaveLength(0);
    });

    it('collects a recordable decay on the read inside a transfer, and still balances', () => {
        const staleEpoch = ledger.getCurrentEpoch() - 30;
        ledger.loadState([
            { id: 'sliver', balance_c: JUST_OVER_GREEN_ZONE, lastDemurrageEpoch: staleEpoch },
            { id: 'payee', balance_c: 0, lastDemurrageEpoch: staleEpoch },
        ]);
        const opening = JUST_OVER_GREEN_ZONE;

        ledger.transfer('sliver', 'payee', 100, -10000, true);

        // A month of interval on the 0.2 beans above the Green Zone IS recordable, so it is collected rather
        // than forfeited — the threshold is about size, not about being inside a transfer.
        expect(core.COMMONS_BALANCE).toBeGreaterThanOrEqual(1);
        expect(ledger.drainDecayEvents()).toHaveLength(1);
        expect(total(ledger, ['sliver', 'payee'])).toBe(opening);
    });

    it('FORFEITS decay at the pending-events cap instead of crediting without an event', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // Fill the queue. Each of these is a real decay with a real event.
            const many = Array.from({ length: 10_000 }, (_, i) => stale(ledger, `acct_${i}`, 50000, 60));
            ledger.loadState([...many, stale(ledger, 'overflow', 50000, 60)]);
            for (let i = 0; i < 10_000; i++) ledger.getAccount(`acct_${i}`);

            const creditAtCap = core.COMMONS_BALANCE;
            const overflow = ledger.getAccount('overflow');

            expect(overflow.balance_c).toBe(50000);                 // forfeited, not decayed
            expect(core.COMMONS_BALANCE).toBe(creditAtCap);       // and the Commons did not move
            // Interval closed here too — carrying it would risk charging it against a later, larger balance.
            // The forfeited amount can be material at the cap, which is why this path warns.
            expect(overflow.lastDemurrageEpoch).toBe(ledger.getCurrentEpoch());
            expect(warn).toHaveBeenCalledTimes(1);                // logged once, not per read
            ledger.getAccount('overflow');
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
        }
    });

    it('does not decay exempt or non-positive accounts, and does not queue events for them', () => {
        ledger.loadState([
            stale(ledger, 'escrow_abc', 50000, 60),      // synthetic: exempt by structure
            stale(ledger, 'COMMONS_POOL', 50000, 60),
            stale(ledger, 'debtor', -5000, 60),          // nothing to decay
        ]);
        ledger.setDecayExempt('treasury_1');
        ledger.loadState([
            stale(ledger, 'escrow_abc', 50000, 60),
            stale(ledger, 'COMMONS_POOL', 50000, 60),
            stale(ledger, 'debtor', -5000, 60),
            stale(ledger, 'treasury_1', 50000, 60),
        ]);

        ['escrow_abc', 'COMMONS_POOL', 'debtor', 'treasury_1'].forEach(id => ledger.getAccount(id));
        expect(core.COMMONS_BALANCE).toBe(0);
        expect(ledger.drainDecayEvents()).toHaveLength(0);
        expect(ledger.getAccount('escrow_abc').balance_c).toBe(50000);
        expect(ledger.getAccount('treasury_1').balance_c).toBe(50000);
        expect(ledger.getAccount('debtor').balance_c).toBe(-5000);
    });
});
