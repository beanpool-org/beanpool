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

/** The whole ledger as one number. This is the figure that must not move. */
const total = (l: LedgerManager, ids: string[]) =>
    round4(ids.reduce((t, id) => t + l.getAccount(id).balance, 0) + core.COMMONS_BALANCE);

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** An account whose stored epoch is `daysStale` behind, so the next read applies real demurrage. */
const stale = (l: LedgerManager, id: string, balance: number, daysStale: number): LedgerAccount =>
    ({ id, balance, lastDemurrageEpoch: l.getCurrentEpoch() - daysStale });

describe('demurrage accounting', () => {
    let ledger: LedgerManager;

    beforeEach(() => {
        core.setCommonsBalance(0);
        ledger = new LedgerManager();
    });

    it('applies decay as a matched debit and credit, with exactly one event', () => {
        ledger.loadState([stale(ledger, 'alice', 500, 60)]);
        const before = total(ledger, []) + 500;   // rows not yet read, so add the stored balance

        const decayed = ledger.getAccount('alice').balance;
        expect(decayed).toBeLessThan(500);

        const credited = core.COMMONS_BALANCE;
        expect(credited).toBeCloseTo(500 - decayed, 10);
        expect(total(ledger, ['alice'])).toBeCloseTo(before, 10);

        const events = ledger.drainDecayEvents();
        expect(events).toHaveLength(1);
        expect(events[0].amount).toBeCloseTo(credited, 10);
        expect(events[0].accountId).toBe('alice');
    });

    it('does not MINT when loadState discards queued decay (the live bug)', () => {
        ledger.loadState([stale(ledger, 'alice', 500, 60)]);
        ledger.getAccount('alice');                       // decay applied in memory, event queued

        const creditFromDecay = core.COMMONS_BALANCE;
        expect(creditFromDecay).toBeGreaterThan(0);

        // The host resyncs from its stored rows — which still hold the PRE-decay balance and epoch, because
        // a queued event means the debit was never written. This is the exact call the balance-mutation hook
        // makes on every raw-SQL mutation.
        ledger.loadState([stale(ledger, 'alice', 500, 60)]);

        expect(core.COMMONS_BALANCE).toBe(0);             // the credit is unwound with the debit
        expect(ledger.drainDecayEvents()).toHaveLength(0);
        // Before the fix this was 500 + creditFromDecay: a credit with no debit, which the host's next
        // persistCommonsBalance() would have made durable.
        expect(total(ledger, ['alice'])).toBeCloseTo(500, 10);
    });

    it('keeps the credit when the events are DRAINED, because the host is about to persist them', () => {
        ledger.loadState([stale(ledger, 'alice', 500, 60)]);
        ledger.getAccount('alice');
        const credit = core.COMMONS_BALANCE;

        const events = ledger.drainDecayEvents();
        expect(events).toHaveLength(1);

        // A drain hands ownership to the host, so a later resync must NOT unwind it — the debit is durable by
        // then. This is the other half of the rule, and getting it backwards would destroy beans instead.
        ledger.loadState([{ id: 'alice', balance: ledger.getAccount('alice').balance, lastDemurrageEpoch: ledger.getCurrentEpoch() }]);
        expect(core.COMMONS_BALANCE).toBeCloseTo(credit, 10);
    });

    it('unwinds MANY queued events, not just the last one', () => {
        const ids = ['a', 'b', 'c', 'd', 'e'];
        ledger.loadState(ids.map(id => stale(ledger, id, 800, 90)));
        ids.forEach(id => ledger.getAccount(id));

        expect(core.COMMONS_BALANCE).toBeGreaterThan(0);

        ledger.loadState(ids.map(id => stale(ledger, id, 800, 90)));
        expect(core.COMMONS_BALANCE).toBe(0);
        expect(total(ledger, [])).toBe(0);
    });

    // The first 200 beans are the tax-free Green Zone (rate 0.000), so a sub-threshold decay needs a balance
    // only just above 200 — 200.2 puts 0.2 beans in the 1%/month bracket and nothing above it.
    const JUST_OVER_GREEN_ZONE = 200.2;

    it('never decays a balance inside the tax-free Green Zone, however long it sits', () => {
        ledger.loadState([stale(ledger, 'modest', 199.99, 4000)]);
        const account = ledger.getAccount('modest');

        expect(account.balance).toBe(199.99);
        expect(core.COMMONS_BALANCE).toBe(0);
        expect(ledger.drainDecayEvents()).toHaveLength(0);
    });

    it('FORFEITS a decay too small to record, and closes the interval anyway', () => {
        // 0.2 beans in the 1%/month bracket over one day ≈ 0.000067 — below the 0.0001 recording threshold.
        ledger.loadState([stale(ledger, 'sliver', JUST_OVER_GREEN_ZONE, 1)]);
        const account = ledger.getAccount('sliver');

        expect(account.balance).toBe(JUST_OVER_GREEN_ZONE);   // not decayed
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
        // 0.005 above the Green Zone over 60 days decays by 0.0000995 — just under the threshold. (0.2 over
        // the same interval would be 0.00398, comfortably recordable, so the sliver has to be this thin.)
        const THIN_SLIVER = 200.005;
        ledger.loadState([
            stale(ledger, 'sliver', THIN_SLIVER, 60),
            { id: 'whale', balance: 50_000, lastDemurrageEpoch: ledger.getCurrentEpoch() },
        ]);
        ledger.getAccount('sliver');                       // sub-threshold: forfeited, interval closed
        expect(core.COMMONS_BALANCE).toBe(0);

        expect(ledger.transfer('whale', 'sliver', 10_000, -100, /* isFeeExempt */ true)).toBe(true);
        const after = ledger.getAccount('sliver');

        // No retrospective charge: the only decay owed is on the interval since the deposit, which is zero.
        expect(after.balance).toBeCloseTo(THIN_SLIVER + 10_000, 6);
        expect(core.COMMONS_BALANCE).toBe(0);
        expect(ledger.drainDecayEvents()).toHaveLength(0);
    });

    it('collects a recordable decay on the read inside a transfer, and still balances', () => {
        const staleEpoch = ledger.getCurrentEpoch() - 30;
        ledger.loadState([
            { id: 'sliver', balance: JUST_OVER_GREEN_ZONE, lastDemurrageEpoch: staleEpoch },
            { id: 'payee', balance: 0, lastDemurrageEpoch: staleEpoch },
        ]);
        const opening = JUST_OVER_GREEN_ZONE;

        ledger.transfer('sliver', 'payee', 1, -100, true);

        // A month of interval on the 0.2 beans above the Green Zone IS recordable, so it is collected rather
        // than forfeited — the threshold is about size, not about being inside a transfer.
        expect(core.COMMONS_BALANCE).toBeGreaterThan(0.0001);
        expect(ledger.drainDecayEvents()).toHaveLength(1);
        expect(total(ledger, ['sliver', 'payee'])).toBeCloseTo(opening, 10);
    });

    it('FORFEITS decay at the pending-events cap instead of crediting without an event', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // Fill the queue. Each of these is a real decay with a real event.
            const many = Array.from({ length: 10_000 }, (_, i) => stale(ledger, `acct_${i}`, 500, 60));
            ledger.loadState([...many, stale(ledger, 'overflow', 500, 60)]);
            for (let i = 0; i < 10_000; i++) ledger.getAccount(`acct_${i}`);

            const creditAtCap = core.COMMONS_BALANCE;
            const overflow = ledger.getAccount('overflow');

            expect(overflow.balance).toBe(500);                   // forfeited, not decayed
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
            stale(ledger, 'escrow_abc', 500, 60),      // synthetic: exempt by structure
            stale(ledger, 'COMMONS_POOL', 500, 60),
            stale(ledger, 'debtor', -50, 60),          // nothing to decay
        ]);
        ledger.setDecayExempt('treasury_1');
        ledger.loadState([
            stale(ledger, 'escrow_abc', 500, 60),
            stale(ledger, 'COMMONS_POOL', 500, 60),
            stale(ledger, 'debtor', -50, 60),
            stale(ledger, 'treasury_1', 500, 60),
        ]);

        ['escrow_abc', 'COMMONS_POOL', 'debtor', 'treasury_1'].forEach(id => ledger.getAccount(id));
        expect(core.COMMONS_BALANCE).toBe(0);
        expect(ledger.drainDecayEvents()).toHaveLength(0);
        expect(ledger.getAccount('escrow_abc').balance).toBe(500);
        expect(ledger.getAccount('treasury_1').balance).toBe(500);
        expect(ledger.getAccount('debtor').balance).toBe(-50);
    });
});
