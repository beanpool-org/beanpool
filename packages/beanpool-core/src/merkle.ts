import CryptoJS from 'crypto-js';
const sha256 = CryptoJS.SHA256;

export interface AccountState {
    id: string;
    balance: number;
    lastDemurrageEpoch: number; // Block Height or Global NTP Timestamp, not local clock
}

export class BeanPoolMerkleTree {
    // 1. Ensure accounts are ALWAYS sorted by ID for determinism
    static generateRoot(accounts: AccountState[], pins: any[] = []): string {
        const sortedAccounts = [...accounts].sort((a, b) => a.id.localeCompare(b.id));
        const accountLeaves = sortedAccounts.map(acc =>
            this.hash(`${acc.id}:${acc.balance}:${acc.lastDemurrageEpoch}`)
        );

        const sortedPins = [...pins].sort((a, b) => a.id.localeCompare(b.id));
        const pinLeaves = sortedPins.map(pin =>
            this.hash(`${pin.id}:${pin.type}:${pin.expiresAt}`)
        );

        return this.buildTree([...accountLeaves, ...pinLeaves]);
    }

    // 2. Binary tree logic for Delta Syncing
    static buildTree(hashes: string[]): string {
        if (hashes.length === 0) return this.hash('genesis');
        if (hashes.length === 1) return hashes[0];

        const nextLevel: string[] = [];
        for (let i = 0; i < hashes.length; i += 2) {
            const left = hashes[i];
            const right = hashes[i + 1] || left; // Duplicate for odd numbers
            nextLevel.push(this.hash(left + right));
        }
        return this.buildTree(nextLevel);
    }

    static hash(data: string): string {
        return sha256(data).toString();
    }

    // 3. For PRUNED nodes, they must keep the historical Merkle Root of deleted history
    // This allows them to prove their "Social State" without the full transaction receipt history
    static combineHistoricalRoot(historicalRoot: string, currentRoot: string): string {
        return this.hash(historicalRoot + currentRoot);
    }
}
