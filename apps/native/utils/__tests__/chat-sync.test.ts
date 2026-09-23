/**
 * What a message fetched from the node does to the row already on the phone.
 *
 * The DM sync has to apply an EDIT and a TOMBSTONE, and must never undo either. Before chat parity this
 * lived entirely in one SQL `ON CONFLICT DO UPDATE` that could only express "a newer edit replaces the
 * text" — so a delete (the node replaces the ciphertext and sets type = 'removed', with no editedAt) landed
 * as a metadata-only update and the deleted words stayed on screen.
 */

import { describe, it, expect } from 'vitest';
import { mergeIncomingMessage, isRemovedPayload, type LocalMessageRow } from '../chat-sync';

const local = (over: Partial<LocalMessageRow> = {}): LocalMessageRow => ({
    ciphertext: 'OLD',
    nonce: 'v2:abc',
    type: 'text',
    edited_at: null,
    metadata: null,
    ...over,
});

describe('a message the phone has never seen', () => {
    it('is taken as the node sent it', () => {
        const m = mergeIncomingMessage(null, { id: 'm1', ciphertext: 'NEW', nonce: 'v2:xyz', type: 'text', metadata: '{}' });
        expect(m).toMatchObject({ ciphertext: 'NEW', nonce: 'v2:xyz', type: 'text', metadata: '{}', contentReplaced: true });
    });
});

describe('an edit', () => {
    it('replaces the words when the node\'s edit is newer than ours', () => {
        const m = mergeIncomingMessage(local({ edited_at: '2026-09-23T09:00:00Z' }), {
            id: 'm1', ciphertext: 'NEWER', nonce: 'v2:xyz', type: 'text', editedAt: '2026-09-23T09:05:00Z',
        });
        expect(m.ciphertext).toBe('NEWER');
        expect(m.editedAt).toBe('2026-09-23T09:05:00Z');
        expect(m.contentReplaced).toBe(true);
    });

    it('does not revert a fresh edit from a sync that was already in flight', () => {
        const m = mergeIncomingMessage(local({ ciphertext: 'FRESH', edited_at: '2026-09-23T09:05:00Z' }), {
            id: 'm1', ciphertext: 'STALE', nonce: 'v2:old', type: 'text', editedAt: '2026-09-23T09:00:00Z',
        });
        expect(m.ciphertext).toBe('FRESH');
        expect(m.editedAt).toBe('2026-09-23T09:05:00Z');
        expect(m.contentReplaced).toBe(false);
    });

    it('leaves an unedited message alone when the node sends no editedAt', () => {
        const m = mergeIncomingMessage(local(), { id: 'm1', ciphertext: 'SOMETHING ELSE', nonce: 'v2:xyz', type: 'text' });
        expect(m.ciphertext).toBe('OLD');
        expect(m.contentReplaced).toBe(false);
    });

    it('refreshes metadata (reactions, reply refs) on every answer, edit or not', () => {
        const m = mergeIncomingMessage(local({ metadata: '{"reactions":[]}' }), {
            id: 'm1', ciphertext: 'OLD', nonce: 'v2:abc', type: 'text', metadata: '{"reactions":[{"emoji":"👍","author":"a"}]}',
        });
        expect(m.metadata).toBe('{"reactions":[{"emoji":"👍","author":"a"}]}');
    });
});

describe('a tombstone', () => {
    const deleted = {
        id: 'm1',
        ciphertext: 'VGhpcyBtZXNzYWdlIHdhcyBkZWxldGVk',
        nonce: 'plaintext-v1',
        type: 'removed',
        metadata: '{"removed":true,"removedBy":"me","removedAt":"2026-09-23T10:00:00Z"}',
    };

    it('lands even though it carries no editedAt — the case the old SQL could not express', () => {
        const m = mergeIncomingMessage(local(), deleted);
        expect(m.type).toBe('removed');
        expect(m.ciphertext).toBe(deleted.ciphertext);
        expect(m.nonce).toBe('plaintext-v1');
        expect(m.contentReplaced).toBe(true);
    });

    it('lands on a message that was edited first, without pretending to be a newer edit', () => {
        const m = mergeIncomingMessage(local({ edited_at: '2026-09-23T09:05:00Z', ciphertext: 'EDITED' }), deleted);
        expect(m.type).toBe('removed');
        expect(m.ciphertext).toBe(deleted.ciphertext);
        expect(m.editedAt).toBe('2026-09-23T09:05:00Z');
    });

    it('is never undone by an answer that was in flight before the delete', () => {
        const alreadyDead = local({ type: 'removed', ciphertext: deleted.ciphertext, nonce: 'plaintext-v1', metadata: deleted.metadata });
        const stale = { id: 'm1', ciphertext: 'THE ORIGINAL WORDS', nonce: 'v2:abc', type: 'text', metadata: '{}' };
        const m = mergeIncomingMessage(alreadyDead, stale);
        expect(m.type).toBe('removed');
        expect(m.ciphertext).toBe(deleted.ciphertext);
        // The stale metadata would have dropped removed/removedBy and the bubble would read as an
        // ordinary message again, so the tombstone keeps its own.
        expect(m.metadata).toBe(deleted.metadata);
    });

    it('is recognised by type or by metadata.removed, whichever the node sent', () => {
        expect(isRemovedPayload({ type: 'removed' })).toBe(true);
        expect(isRemovedPayload({ type: 'text', metadata: '{"removed":true}' })).toBe(true);
        expect(isRemovedPayload({ type: 'text', metadata: '{"reactions":[]}' })).toBe(false);
        expect(isRemovedPayload({ type: 'text', metadata: 'not json' })).toBe(false);
    });

    it('a convenor\'s removal lands the same way, and keeps who did it', () => {
        const removed = {
            id: 'm1', ciphertext: 'cmVtb3ZlZCBieSBhIGNvbnZlbm9y', nonce: 'plaintext-v1', type: 'removed',
            metadata: '{"removed":true,"removedBy":"convenor-key"}',
        };
        const m = mergeIncomingMessage(local(), removed);
        expect(JSON.parse(m.metadata!).removedBy).toBe('convenor-key');
    });
});
