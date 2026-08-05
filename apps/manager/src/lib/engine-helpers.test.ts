import { describe, it, expect } from 'vitest';
import { computeSampleTrustSummary, PER_COUNTERPARTY_VOLUME_CAP } from './engine-helpers';

describe('computeSampleTrustSummary', () => {
    it('should calculate correct score and trust level for a Newcomer', () => {
        // rawScore = (1 * 25) + (1 * 5) - (0 * 50) + (10 * 0.5) = 25 + 5 - 0 + 5 = 35 -> Resident? Wait. Let's calculate exactly.
        // Let's make it a Newcomer (score < 30)
        // rawScore = (0 * 25) + (2 * 5) - (0 * 50) + (10 * 0.5) = 10 + 5 = 15
        const result = computeSampleTrustSummary(0, 2, 0, 10);
        expect(result.score).toBe(15);
        expect(result.trustLevel).toBe('Newcomer');
        expect(result.perCounterpartyVolumeCap).toBe(PER_COUNTERPARTY_VOLUME_CAP);
    });

    it('should calculate correct score and trust level for a Resident', () => {
        // Resident is >= 30 and < 60
        // rawScore = (1 * 25) + (1 * 5) - (0 * 50) + (20 * 0.5) = 25 + 5 + 10 = 40
        const result = computeSampleTrustSummary(1, 1, 0, 20);
        expect(result.score).toBe(40);
        expect(result.trustLevel).toBe('Resident');
        expect(result.perCounterpartyVolumeCap).toBe(PER_COUNTERPARTY_VOLUME_CAP);
    });

    it('should calculate correct score and trust level for a Steward', () => {
        // Steward is >= 60 and < 80
        // rawScore = (2 * 25) + (2 * 5) - (0 * 50) + (20 * 0.5) = 50 + 10 + 10 = 70
        const result = computeSampleTrustSummary(2, 2, 0, 20);
        expect(result.score).toBe(70);
        expect(result.trustLevel).toBe('Steward');
        expect(result.perCounterpartyVolumeCap).toBe(PER_COUNTERPARTY_VOLUME_CAP);
    });

    it('should calculate correct score and trust level for an Elder', () => {
        // Elder is >= 80
        // rawScore = (3 * 25) + (5 * 5) - (0 * 50) + (100 * 0.5) = 75 + 25 + 50 = 150 -> Maxed at 100
        const result = computeSampleTrustSummary(3, 5, 0, 100);
        expect(result.score).toBe(100);
        expect(result.trustLevel).toBe('Elder');
        expect(result.perCounterpartyVolumeCap).toBe(PER_COUNTERPARTY_VOLUME_CAP);
    });

    it('should cap the score at a maximum of 100', () => {
        const result = computeSampleTrustSummary(10, 50, 0, 1000);
        expect(result.score).toBe(100);
    });

    it('should cap the score at a minimum of 0', () => {
        const result = computeSampleTrustSummary(0, 0, 10, 0); // (0 * 25) + (0 * 5) - (10 * 50) + (0 * 0.5) = -500 -> 0
        expect(result.score).toBe(0);
        expect(result.trustLevel).toBe('Newcomer');
    });

    it('should reduce score significantly for disputes', () => {
        // Without dispute: rawScore = (2 * 25) + (2 * 5) + (20 * 0.5) = 50 + 10 + 10 = 70 (Steward)
        // With dispute: rawScore = 70 - (1 * 50) = 20 (Newcomer)
        const result = computeSampleTrustSummary(2, 2, 1, 20);
        expect(result.score).toBe(20);
        expect(result.trustLevel).toBe('Newcomer');
    });
});
