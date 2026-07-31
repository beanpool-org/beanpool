import { describe, it, expect } from 'vitest';
import { BeanPoolMerkleTree, AccountState } from '../merkle.js';

describe('BeanPoolMerkleTree', () => {
    it('generates a deterministic root regardless of account order', () => {
        const accountsA: AccountState[] = [
            { id: 'user_1', balance: 100, lastDemurrageEpoch: 10 },
            { id: 'user_2', balance: 250, lastDemurrageEpoch: 10 },
        ];

        const accountsB: AccountState[] = [
            { id: 'user_2', balance: 250, lastDemurrageEpoch: 10 },
            { id: 'user_1', balance: 100, lastDemurrageEpoch: 10 },
        ];

        const rootA = BeanPoolMerkleTree.generateRoot(accountsA);
        const rootB = BeanPoolMerkleTree.generateRoot(accountsB);

        expect(rootA).toBe(rootB);
        expect(rootA).toHaveLength(64); // SHA256 hex string length
    });

    it('combines historical and current roots', () => {
        const root1 = BeanPoolMerkleTree.hash('historical_gen');
        const root2 = BeanPoolMerkleTree.hash('current_tree');

        const combined = BeanPoolMerkleTree.combineHistoricalRoot(root1, root2);
        expect(combined).toBeDefined();
        expect(combined).not.toEqual(root1);
        expect(combined).not.toEqual(root2);
    });
});
