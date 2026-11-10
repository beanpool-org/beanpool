export interface LedgerAccount {
    id: string; // User or Node ID
    /** Whole hundredths of a Bean (hundredths.ts). */
    balance_c: Hundredths;
    lastDemurrageEpoch: number; // Unix Epoch (Days since 1970)
}

// Global variable exported for visibility (or could be managed within the class statically)
export let COMMONS_BALANCE = 0;

/**
 * Restore persisted commons balance on server startup.
 * Without this, COMMONS_BALANCE resets to 0 every restart, silently destroying all accumulated demurrage.
 */
export function setCommonsBalance(value: Hundredths): void {
    COMMONS_BALANCE = value;
}

import { isEscrowAccount, isSyntheticAccount } from './protocol.js';
import { circulationChargeOf } from './circulation.js';
import { feeOf, isHundredths, isMoveAmount, type Hundredths } from './hundredths.js';

/**
 * THE FLOOR FOR AN ESCROW ACCOUNT. An escrow can never pay out more than it holds.
 *
 * Every other account in this ledger is a credit line of some kind: a member may go into debt down to
 * their offer-banded floor, a `bridge_<peer>` account MUST be able to go negative (that negative is the
 * credit extended to the peer), and the Commons may run a deficit when it writes off a pruned member's
 * debt. An escrow is none of those. It holds beans a buyer already paid in, and paying out more than it
 * holds MINTS beans out of nothing — the node stops summing to zero and the extra is real spendable
 * money in somebody's account.
 *
 * That is not hypothetical. Escrow senders used to carry a `-Infinity` floor, and a moderator's post
 * removal refunded 15 Beans to two buyers out of escrows that had never been funded (measured on the
 * test node, 2026-09-24: two escrow accounts sitting at -5 and -10, each with exactly one transaction
 * ever, and no matching hold). The federation settlement commit path carries a comment describing the
 * same hazard from the other side.
 *
 * EXACTLY ZERO. Every figure is whole hundredths (hundredths.ts), so a close-out that debits exactly what was held lands
 * on 0, never a hair below it: the old float slack (and the dust sweep that cleared it) went with the floats.
 */
export const ESCROW_FLOOR: Hundredths = 0;

/**
 * The effective floor for a debit from `fromId`, given whatever floor the caller asked for.
 *
 * Callers pass `-Infinity` for synthetic senders. For an escrow that is wrong, and this is where it is
 * made impossible rather than in each of the dozen call sites that debit an escrow — the whole shape of
 * the bug was one caller out of many forgetting the guard.
 */
function effectiveFloor(fromId: string, requestedFloor: number): number {
    return isEscrowAccount(fromId) ? Math.max(requestedFloor, ESCROW_FLOOR) : requestedFloor;
}

/**
 * AN AMOUNT A MOVE MAY CARRY: whole hundredths, 0 or more (hundredths.ts isMoveAmount). Nothing else: not a float, not
 * a numeric string, not NaN, not Infinity, not a negative.
 *
 * WHY EVERY PRIMITIVE ASKS IT (review FABLE-sec-input F1, 2026-10-01, measured). A listing's price edited to "abc"
 * reached `transfer` as a string. Every guard here tests `<`, and NaN compares false against everything, so
 * `amount < 0` passed, `balance - amount < floor` passed, and `balance -= amount` set the buyer's balance to NaN — which
 * the host then wrote as NULL. A `+=` with a string would have concatenated instead. The ledger is the one place every
 * move passes, so it refuses what is not an amount, whatever a caller forgot to check.
 */
export function isBeanAmount(amount: unknown): amount is Hundredths {
    return isMoveAmount(amount);
}

/** A balance a ledger may hold: whole hundredths. An account holding anything else moves nothing until an operator looks. */
function isFiniteBalance(balance: unknown): balance is Hundredths {
    return isHundredths(balance);
}

/**
 * A demurrage decay applied to an account. Collected so the host (server) can
 * persist each decay as a ledger transaction row — without this, decay silently
 * mutates balances and the transaction history can never reconcile to balances.
 */
export interface DecayEvent {
    accountId: string;
    /** Whole hundredths, truncated once (circulation.ts circulationChargeOf). */
    amount: Hundredths;
    epochsPassed: number;
    /** The epoch the account decayed up to — with epochsPassed this identifies the decay deterministically. */
    toEpoch: number;
    timestamp: string;
}

export class LedgerManager {
    private accounts: Map<string, LedgerAccount>;
    private decayEvents: DecayEvent[] = [];
    private readonly DEFAULT_CREDIT_LIMIT: Hundredths = -10000; // -100 Beans when a caller passes no floor; callers pass the dynamic floor
    private readonly EPOCH_MS = 24 * 60 * 60 * 1000; // 24 hours
    private readonly MAX_PENDING_DECAY_EVENTS = 10_000; // backstop if the host never drains
    private decayCapWarned = false;                     // so hitting the cap logs once, not per read
    // Community treasury accounts are real members (so they can trade in the marketplace)
    // but, like COMMONS_POOL, are exempt from demurrage so their working balance doesn't
    // erode. Populated by the host at boot from `members WHERE is_treasury=1`, and on create.
    private readonly decayExemptIds = new Set<string>();

    constructor(initialAccounts?: LedgerAccount[]) {
        this.accounts = new Map();
        if (initialAccounts) {
            initialAccounts.forEach(acc => this.accounts.set(acc.id, acc));
        }
    }

    getCurrentEpoch(): number {
        // In a real decentralized network, this would come from block height or a global NTP source
        return Math.floor(Date.now() / this.EPOCH_MS);
    }

    /**
     * Loads ledger state from an array, discarding any queued decay events AND the Commons credit they made.
     *
     * DROPPING THE EVENTS ALONE WAS A CONSERVATION BUG. `applyDecay` does two things together: it debits the
     * account, and it does `COMMONS_BALANCE += decayed`. Only the debit lives in the account map this call is
     * about to REPLACE with the host's stored rows — so the debit was reverted while the credit stayed. A
     * credit with no matching debit, which the host's next `persistCommonsBalance()` makes durable: minting,
     * out of the one function whose entire job is to resynchronise.
     *
     * The old comment reasoned correctly about the events and forgot the credit they had already made.
     *
     * WHY REVERTING THE CREDIT IS EXACTLY RIGHT rather than approximately right: a queued event always means
     * its debit is memory-only. `drainDecayEvents()` is only ever called by a host that immediately persists
     * those balances, so anything still queued has not been written to a row. And since #127's sibling fix
     * every credit has exactly one event — see `applyDecay`, which now defers rather than applying a decay it
     * cannot record.
     *
     * Nothing is lost by dropping both halves. Decay is epoch-based and recomputes lazily from
     * `lastDemurrageEpoch`, which these reloaded rows still carry, so the next read applies it again.
     */
    loadState(accounts: LedgerAccount[]): void {
        const undoneCredit = this.decayEvents.reduce((total, e) => total + e.amount, 0);
        if (undoneCredit > 0) COMMONS_BALANCE -= undoneCredit;
        this.accounts = new Map();
        accounts.forEach(acc => this.accounts.set(acc.id, acc));
        this.decayEvents = [];
        this.decayCapWarned = false;
    }

    /**
     * Returns (and clears) decay events accumulated since the last drain.
     * The host should persist each as a `account → COMMONS_POOL` ledger row.
     */
    drainDecayEvents(): DecayEvent[] {
        const events = this.decayEvents;
        this.decayEvents = [];
        this.decayCapWarned = false;
        return events;
    }

    /**
     * Gets all accounts for persistence
     */
    getAllAccounts(): LedgerAccount[] {
        return Array.from(this.accounts.values());
    }

    /**
     * Mark an account as exempt from demurrage decay (in addition to the synthetic
     * escrow_/project_/COMMONS_POOL wallets). Used for community treasury members —
     * they trade as normal members but their held balance must not erode. Idempotent.
     * Survives loadState() (exemptions are host-owned, not part of ledger snapshots).
     */
    setDecayExempt(id: string, exempt = true): void {
        if (exempt) this.decayExemptIds.add(id);
        else this.decayExemptIds.delete(id);
    }

    /**
     * Formal Genesis implementation for a new account.
     * Ensures an account starts with 0 balance and the Mutual Credit architecture.
     */
    initializeGenesisAccount(id: string): LedgerAccount {
        const account = { id, balance_c: 0, lastDemurrageEpoch: this.getCurrentEpoch() };
        this.accounts.set(id, account);
        return account;
    }

    getAccount(id: string): LedgerAccount {
        let account = this.accounts.get(id);
        if (!account) {
            // Auto-create new accounts with 0 balance
            account = { id, balance_c: 0, lastDemurrageEpoch: this.getCurrentEpoch() };
            this.accounts.set(id, account);
        }

        // Always apply decay when fetching to auto-compound demurrage
        return this.applyDecay(account, this.getCurrentEpoch());
    }

    /**
     * Applies demurrage using progressive brackets:
     * 1st Bracket (0–200 Beans): 0.0%/mo (Fee-Free Green Zone)
     * 2nd Bracket (200–500 Beans): 1.0%/mo
     * 3rd Bracket (500–1000 Beans): 1.5%/mo
     * 4th Bracket (1000–2000 Beans): 2.0%/mo
     * 5th Bracket (2000+ Beans): 2.5%/mo
     * The decayed amount is transferred to the global COMMONS_BALANCE.
     */
    private applyDecay(account: LedgerAccount, currentEpoch: number): LedgerAccount {
        const epochsPassed = currentEpoch - account.lastDemurrageEpoch;

        // Exempt synthetic wallets (escrow, project, commons pool) from demurrage decay
        // isSyntheticAccount() rather than a hardcoded prefix list, so exemption does NOT depend on the
        // host having registered it. initStateEngine() calls loadState() before it registers
        // exemptions, and the registration is wrapped in a try/catch — so a window existed where a
        // synthetic account could decay. Structural fix: the ledger knows on its own.
        const isExempt = this.decayExemptIds.has(account.id) || isSyntheticAccount(account.id);

        // A balance that is not a finite number (a NULL row loaded as null, a NaN) decays nothing: `NaN <= 0` is false,
        // so it used to fall through and credit the Commons with NaN, spreading one broken account to the pot.
        if (epochsPassed <= 0 || !isFiniteBalance(account.balance_c) || account.balance_c <= 0 || isExempt) {
            // Only positive, non-exempt balances decay
            account.lastDemurrageEpoch = currentEpoch;
            return account;
        }

        // EVERY CREDIT MUST HAVE EXACTLY ONE EVENT, which is what lets `loadState` unwind it and the host
        // write a ledger row for it. Where a decay cannot be recorded, it is FORFEITED — not applied, not
        // credited — and the epoch is still stamped to close the interval.
        //
        // FORFEIT, NOT DEFER (two review rounds, in opposite directions — this is the resolution).
        //
        // Deferring looked better: leave the epoch alone and the interval survives to be collected later.
        // But demurrage is principal × time × rate, and an interval CANNOT be carried across a change of
        // principal. An account holding 200.005 with a deferred 60-day interval that then receives 10,000
        // gets the whole 60 days charged against 10,200 on the next read. Measured: **465.33 beans**, 4.6% of
        // the deposit, taken instantly. Against the sub-hundredth that deferring was protecting.
        //
        // Forfeiting costs at most one sub-threshold decay per read — bounded by the very threshold that
        // says it is not worth recording — and it is conservation-safe by construction: no debit and no
        // credit, so the books cannot move. Nothing else in the ledger has to know about it either, which is
        // what makes it safe against the server paths that adjust `balance` directly after a `getAccount()`.
        if (this.decayEvents.length >= this.MAX_PENDING_DECAY_EVENTS) {
            // Previously the credit was applied and the event silently skipped past this cap, so the host
            // could never write the matching row and the Commons held a credit with no traceable source.
            // Loud, because unlike the threshold case the forfeited amount here can be large.
            if (!this.decayCapWarned) {
                console.warn(`[Ledger] ${this.MAX_PENDING_DECAY_EVENTS} decay events pending and undrained — `
                    + 'forfeiting further demurrage until the host persists them.');
                this.decayCapWarned = true;
            }
            account.lastDemurrageEpoch = currentEpoch;
            return account;
        }

        const monthsPassed = epochsPassed / 30;
        // Truncated ONCE to whole hundredths (circulation.ts): the holder keeps the part below a hundredth.
        const decayedAmount = circulationChargeOf(account.balance_c, monthsPassed);

        // Below one hundredth: forfeit it (circulationChargeOf gives 0). The old form credited the Commons anyway and
        // skipped the event, leaving a credit with no traceable source that `loadState` could not unwind.
        if (decayedAmount < 1 || !Number.isSafeInteger(COMMONS_BALANCE + decayedAmount)) {
            account.lastDemurrageEpoch = currentEpoch;
            return account;
        }

        COMMONS_BALANCE += decayedAmount;
        account.balance_c -= decayedAmount;
        account.lastDemurrageEpoch = currentEpoch;
        this.decayEvents.push({
            accountId: account.id,
            amount: decayedAmount,
            epochsPassed,
            toEpoch: currentEpoch,
            timestamp: new Date().toISOString(),
        });

        return account;
    }

    /**
     * The balance a hypothetical account would hold after decaying from `lastDemurrageEpoch` to `currentEpoch`, without
     * mutating state: the same truncated charge applyDecay takes.
     */
    calculateDecay(balance: Hundredths, lastDemurrageEpoch: number, currentEpoch: number): Hundredths {
        if (balance <= 0) return balance;

        const epochsPassed = currentEpoch - lastDemurrageEpoch;
        if (epochsPassed <= 0) return balance;

        return balance - circulationChargeOf(balance, epochsPassed / 30);
    }

    /**
     * Transfers funds between nodes using Mutual Credit logic.
     * Participants can go into debt down to the dynamic credit floor.
     * Every figure is whole hundredths. The fee is truncated ONCE here (feeOf) and returned, so the host writes the ledger
     * row from that value and never recomputes it: `amount` leaves the payer, `amount − fee` reaches the payee, `fee`
     * reaches the pot, three integers that sum to zero.
     * @param floorOverride - The sender's dynamic credit floor in hundredths (e.g. -42000). If omitted, -10000 (-100 Beans).
     * @param isFeeExempt - If true, bypasses the transaction fee (e.g., escrow holds, refunds, admin settlements).
     * @returns `{ ok: true, fee }` when it moved (fee 0 when exempt), `{ ok: false, fee: 0 }` when refused.
     */
    transfer(fromId: string, toId: string, amount: Hundredths, floorOverride?: Hundredths, isFeeExempt = false): { ok: boolean; fee: Hundredths } {
        const refused = { ok: false, fee: 0 };
        // Not an amount (a float, NaN, Infinity, a string, a negative): refused, before anything is read or moved.
        if (!isBeanAmount(amount)) return refused;
        if (amount === 0) return { ok: true, fee: 0 }; // 0-credit transfer is always a no-op success
        if (fromId === toId) return refused;

        // Apply decays first to ensure accurate balances — this also settles each account's epoch.
        const fromAccount = this.getAccount(fromId);
        const toAccount = this.getAccount(toId);

        const floor = effectiveFloor(fromId, floorOverride ?? this.DEFAULT_CREDIT_LIMIT);
        // A NaN floor passes every `<` test below, as a NaN amount did. -Infinity is a synthetic sender's "no floor".
        if (Number.isNaN(floor)) return refused;

        // Mutual Credit: ensure the fromAccount doesn't exceed the credit floor
        if (fromAccount.balance_c - amount < floor) {
            // Insufficient credit
            return refused;
        }

        // The fee, truncated once (feeOf): the half-hundredth stays with the payee, never the Commons.
        const fee = isFeeExempt ? 0 : feeOf(amount);
        const netAmount = amount - fee;

        // Never a balance that is not whole hundredths, on either side or in the pot: refused before anything moves. An
        // account already holding one (a NULL row, a NaN, a float) moves nothing either, so the damage cannot spread.
        if (!isFiniteBalance(fromAccount.balance_c) || !isFiniteBalance(toAccount.balance_c) || !isHundredths(COMMONS_BALANCE)
            || !Number.isSafeInteger(fromAccount.balance_c - amount) || !Number.isSafeInteger(toAccount.balance_c + netAmount)
            || !Number.isSafeInteger(COMMONS_BALANCE + fee)) {
            return refused;
        }

        // Execute transfer: three integers that sum to zero.
        fromAccount.balance_c -= amount;
        toAccount.balance_c += netAmount;
        if (fee > 0) {
            COMMONS_BALANCE += fee;
        }

        // The epoch is not touched here, and does not need to be: `getAccount()` above ran `applyDecay`, which
        // stamps it on EVERY path — decayed, nothing to decay, or forfeited. Both accounts therefore arrive
        // here with their interval already closed, so the balance change below cannot carry a stale window
        // onto a new principal.
        //
        // That property lives in `applyDecay` rather than being repeated at each mutation site on purpose: the
        // server also adjusts `balance` directly after a `getAccount()` (payFromCommons, the voting-round
        // grant), and stamping here would not have covered those.
        return { ok: true, fee };
    }

    /**
     * Move value from an account INTO the global Commons pot. The mirror of `deductFromCommons()`.
     *
     * WHY THIS EXISTS instead of `transfer(x, 'COMMONS_POOL', n)`: the Commons pot IS the
     * `COMMONS_BALANCE` global, and the `COMMONS_POOL` *account* is only its persisted shadow —
     * `persistCommonsBalance()` rewrites that row from the global after every transfer. So value
     * transferred into the account is written and then immediately overwritten, and disappears from the
     * node's books on the next flush. Anything crediting the Commons must go through the global.
     *
     * @param floorOverride the sender's credit floor. Pass `-Infinity` for a synthetic sender that is not
     *                      bounded by a member floor (bridge_*). An escrow_* sender is clamped to
     *                      `ESCROW_FLOOR` whatever is passed here, so it can only pay out what it holds.
     */
    moveToCommons(fromId: string, amount: Hundredths, floorOverride?: Hundredths): boolean {
        if (!isBeanAmount(amount)) return false;   // as in `transfer()`
        if (amount === 0) return true;

        const fromAccount = this.getAccount(fromId);      // applies any pending decay, and settles the epoch
        // Clamped for an escrow sender exactly as in `transfer()`: this is the other way value leaves an
        // escrow (#104 moves the cross-node fee to the Commons from the settlement's own escrow account),
        // and its caller passes `-Infinity` for every synthetic sender.
        const floor = effectiveFloor(fromId, floorOverride ?? this.DEFAULT_CREDIT_LIMIT);
        if (Number.isNaN(floor)) return false;

        if (fromAccount.balance_c - amount < floor) return false;
        if (!isFiniteBalance(fromAccount.balance_c) || !isHundredths(COMMONS_BALANCE) || !Number.isSafeInteger(fromAccount.balance_c - amount)
            || !Number.isSafeInteger(COMMONS_BALANCE + amount)) {
            return false;
        }

        fromAccount.balance_c -= amount;
        COMMONS_BALANCE += amount;
        // Epoch already settled by `getAccount()` above — see the note in `transfer()`.
        return true;
    }

    /**
     * Deducts funds directly from the global Commons Balance (Demurrage pool).
     */
    deductFromCommons(amount: Hundredths): boolean {
        // `amount <= 0` alone let NaN through (and `COMMONS_BALANCE < NaN` is false), so the pot became NaN.
        if (!isBeanAmount(amount) || amount === 0 || !isFiniteBalance(COMMONS_BALANCE) || COMMONS_BALANCE < amount) {
            return false;
        }
        COMMONS_BALANCE -= amount;
        return true;
    }
}
