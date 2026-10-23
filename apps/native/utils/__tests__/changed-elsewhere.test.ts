/**
 * A refused trade step that moved on elsewhere (utils/changed-elsewhere.ts): read from the node's code, never from its
 * sentence, which is in the member's language; an older node's answer, with no code, by the English it always had.
 */
import { describe, expect, it } from 'vitest';
import { changedElsewhere } from '../changed-elsewhere';

const refusal = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

describe('changedElsewhere', () => {
    it('reads the code, whatever language the sentence beside it is in', () => {
        expect(changedElsewhere(refusal('Impossible d’annuler — transaction introuvable', 'transaction_gone'), 'transaction_gone')).toBe(true);
        expect(changedElsewhere(refusal('Publicación no encontrada o inactiva', 'post_gone'), 'post_gone')).toBe(true);
    });

    it('another code is not this one, even when its English says "not found"', () => {
        expect(changedElsewhere(refusal('Cannot cancel — transaction not found or not authorized', 'post_gone'), 'transaction_gone')).toBe(false);
        expect(changedElsewhere(refusal('Group not found', 'not_found'), 'post_gone')).toBe(false);
        expect(changedElsewhere(refusal('This member is away (holiday mode) and not trading right now.', 'holiday'), 'post_gone')).toBe(false);
    });

    it('an older node, with no code: its English as before', () => {
        expect(changedElsewhere(refusal('Cannot cancel — transaction not found or not authorized'), 'transaction_gone')).toBe(true);
        expect(changedElsewhere(refusal('Post not found or not active'), 'post_gone')).toBe(true);
        expect(changedElsewhere(refusal('Escrow release failed'), 'transaction_gone')).toBe(false);
    });

    it('anything that is not an error is no move', () => {
        expect(changedElsewhere(undefined, 'post_gone')).toBe(false);
        expect(changedElsewhere('not found', 'post_gone')).toBe(false);
    });
});
