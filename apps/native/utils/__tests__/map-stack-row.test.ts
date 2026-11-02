import { describe, it, expect } from 'vitest';
import { stackRow } from '../map-stack';

describe('stackRow: formatting and copy attribution', () => {
    it('formats a normal event, offer and need rows', () => {
        const ev = { id: 'ev1', type: 'event', title: 'Bee', event_start_at: '2026-11-07T09:00:00.000Z', event_end_at: '2026-11-07T12:00:00.000Z' };
        const rowEv = stackRow(ev);
        expect(rowEv.id).toBe('ev1');
        expect(rowEv.title).toBe('Bee');
        expect(rowEv.type).toBe('Event');
        expect(rowEv.isEvent).toBe(true);

        const off = { id: 'off1', type: 'offer', title: 'Tomatoes', category: 'food' };
        const rowOff = stackRow(off);
        expect(rowOff.type).toBe('Offer');
        expect(rowOff.isEvent).toBe(false);

        const need = { id: 'need1', type: 'need', title: 'Ladder', category: 'tools' };
        const rowNeed = stackRow(need);
        expect(rowNeed.type).toBe('Need');
        expect(rowNeed.isEvent).toBe(false);
    });

    it("an event copy from another community gets 'Event · from Mullumbimby' as its type line", () => {
        const copyFrom = { host: 'mullum.example.org', postId: 'p-orig', name: 'Mullumbimby', url: 'https://mullum.example.org', door: 'ask' };
        const copyEvent = {
            id: 'ev-copy',
            type: 'event',
            title: 'Repair café',
            event_start_at: '2026-11-07T14:00:00.000Z',
            event_end_at: '2026-11-07T16:00:00.000Z',
            shown_from: JSON.stringify(copyFrom),
        };
        const row = stackRow(copyEvent);
        expect(row.type).toBe('Event · from Mullumbimby');
        expect(row.label).toContain('Event · from Mullumbimby');
    });

    it("handles camelCase shownCopy and shownFrom as well", () => {
        const copyFrom = { host: 'byron.example.org', postId: 'p-orig', name: 'Byron Bay', url: 'https://byron.example.org', door: 'invite' };
        const copyEvent = {
            id: 'ev-copy-camel',
            type: 'event',
            title: 'Beach Cleanup',
            shownCopy: true,
            shownFrom: copyFrom,
        };
        const row = stackRow(copyEvent);
        expect(row.type).toBe('Event · from Byron Bay');
    });
});
