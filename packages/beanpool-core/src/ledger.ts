export interface LedgerAccount {
    id: string; // User or Node ID
    balance: number;
    lastDemurrageEpoch: number; // Unix Epoch (Days since 1970)
}

// Global variable exported for visibility (or could be managed within the class statically)
export let COMMONS_BALANCE = 0;

/**
 * Restore persisted commons balance on server startup.
 * Without this, COMMONS_BALANCE resets to 0 every restart, silently destroying all accumulated demurrage.
 */
export function setCommonsBalance(value: number): void {
    COMMONS_BALANCE = value;
}

export const TRANSACTION_FEE_RATE = 0.015;

/**
 * A demurrage decay applied to an account. Collected so the host (server) can
 * persist each decay as a ledger transaction row — without this, decay silently
 * mutates balances and the transaction history can never reconcile to balances.
 */
export interface DecayEvent {
    accountId: string;
    amount: number;
    epochsPassed: number;
    /** The epoch the account decayed up to — with epochsPassed this identifies the decay deterministically. */
    toEpoch: number;
    timestamp: string;
}

export class LedgerManager {
    private accounts: Map<string, LedgerAccount>;
    private decayEvents: DecayEvent[] = [];
    private readonly DEFAULT_CREDIT_LIMIT = -100; // Legacy fallback — callers should pass dynamic floor
    private readonly EPOCH_MS = 24 * 60 * 60 * 1000; // 24 hours
    private readonly MAX_PENDING_DECAY_EVENTS = 10_000; // backstop if the host never drains

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
     * Loads ledger state from an array
     */
    loadState(accounts: LedgerAccount[]): void {
        this.accounts = new Map();
        accounts.forEach(acc => this.accounts.set(acc.id, acc));
        // Pending decay events refer to the replaced state — they no longer match the
        // reloaded balances. Decay is epoch-based and recomputes lazily, so dropping
        // them is safe; persisting them against fresh state would double-count.
        this.decayEvents = [];
    }

    /**
     * Returns (and clears) decay events accumulated since the last drain.
     * The host should persist each as a `account → COMMONS_POOL` ledger row.
     */
    drainDecayEvents(): DecayEvent[] {
        const events = this.decayEvents;
        this.decayEvents = [];
        return events;
    }

    /**
     * Gets all accounts for persistence
     */
    getAllAccounts(): LedgerAccount[] {
        return Array.from(this.accounts.values());
    }

    /**
     * Formal Genesis implementation for a new account.
     * Ensures an account starts with 0 balance and the Mutual Credit architecture.
     */
    initializeGenesisAccount(id: string): LedgerAccount {
        const account = { id, balance: 0, lastDemurrageEpoch: this.getCurrentEpoch() };
        this.accounts.set(id, account);
        return account;
    }

    getAccount(id: string): LedgerAccount {
        let account = this.accounts.get(id);
        if (!account) {
            // Auto-create new accounts with 0 balance
            account = { id, balance: 0, lastDemurrageEpoch: this.getCurrentEpoch() };
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
        const isExempt = account.id.startsWith('escrow_') || account.id.startsWith('project_') || account.id === 'COMMONS_POOL';

        if (epochsPassed <= 0 || account.balance <= 0 || isExempt) {
            // Only positive, non-exempt balances decay
            account.lastDemurrageEpoch = currentEpoch;
            return account;
        }

        const monthsPassed = epochsPassed / 30;
        const newBalance = this._calculateProgressiveDecay(account.balance, monthsPassed);
        const decayedAmount = account.balance - newBalance;

        COMMONS_BALANCE += decayedAmount;
        account.balance = newBalance;
        account.lastDemurrageEpoch = currentEpoch;

        if (decayedAmount > 0.0001 && this.decayEvents.length < this.MAX_PENDING_DECAY_EVENTS) {
            this.decayEvents.push({
                accountId: account.id,
                amount: decayedAmount,
                epochsPassed,
                toEpoch: currentEpoch,
                timestamp: new Date().toISOString(),
            });
        }

        return account;
    }

    /**
     * Directly calculate decay for a hypothetical value/time without mutating state
     */
    calculateDecay(balance: number, lastDemurrageEpoch: number, currentEpoch: number): number {
        if (balance <= 0) return balance;

        const epochsPassed = currentEpoch - lastDemurrageEpoch;
        if (epochsPassed <= 0) return balance;

        const monthsPassed = epochsPassed / 30;
        return this._calculateProgressiveDecay(balance, monthsPassed);
    }

    /**
     * Internal helper to calculate progressive decay based on brackets
     */
    private _calculateProgressiveDecay(balance: number, monthsPassed: number): number {
        if (balance <= 0) return balance;

        const brackets = [
            { maxInBracket: 200, rate: 0.000 }, // 0 - 200 (Tax-free Green Zone)
            { maxInBracket: 300, rate: 0.010 }, // 200 - 500
            { maxInBracket: 500, rate: 0.015 }, // 500 - 1000
            { maxInBracket: 1000, rate: 0.020 }, // 1000 - 2000
            { maxInBracket: Infinity, rate: 0.025 } // 2000+
        ];

        let remainingBalance = balance;
        let newBalance = 0;

        for (const bracket of brackets) {
            if (remainingBalance <= 0) break;

            const amountInBracket = Math.min(remainingBalance, bracket.maxInBracket);
            const decayedAmount = amountInBracket * Math.pow(1 - bracket.rate, monthsPassed);
            
            newBalance += decayedAmount;
            remainingBalance -= amountInBracket;
        }

        return newBalance;
    }

    /**
     * Transfers funds between nodes using Mutual Credit logic.
     * Participants can go into debt down to the dynamic credit floor.
     * @param floorOverride - The sender's dynamic credit floor (e.g. -420). If omitted, uses legacy default (-100).
     * @param isFeeExempt - If true, bypasses the transaction fee (e.g., escrow holds, refunds, admin settlements).
     */
    transfer(fromId: string, toId: string, amount: number, floorOverride?: number, isFeeExempt = false): boolean {
        if (amount < 0) return false;
        if (amount === 0) return true; // 0-credit transfer is always a no-op success
        if (fromId === toId) return false;

        const currentEpoch = this.getCurrentEpoch();

        // Apply decays first to ensure accurate balances
        const fromAccount = this.getAccount(fromId);
        const toAccount = this.getAccount(toId);

        const floor = floorOverride ?? this.DEFAULT_CREDIT_LIMIT;

        // Mutual Credit: ensure the fromAccount doesn't exceed the credit floor
        if (fromAccount.balance - amount < floor) {
            // Insufficient credit
            return false;
        }

        // Calculate transaction fee
        const fee = isFeeExempt ? 0 : amount * TRANSACTION_FEE_RATE;
        const netAmount = amount - fee;

        // Execute transfer
        fromAccount.balance -= amount;
        toAccount.balance += netAmount;
        if (fee > 0) {
            COMMONS_BALANCE += fee;
        }

        // Update timestamps
        fromAccount.lastDemurrageEpoch = currentEpoch;
        toAccount.lastDemurrageEpoch = currentEpoch;

        return true;
    }

    /**
     * Deducts funds directly from the global Commons Balance (Demurrage pool).
     */
    deductFromCommons(amount: number): boolean {
        if (amount <= 0 || COMMONS_BALANCE < amount) {
            return false;
        }
        COMMONS_BALANCE -= amount;
        return true;
    }
}
