/**
 * The shortfall readers: one for a download's headers, one for a restore's body.
 *
 * Since confirmation round 4, a backup that could not carry every image object is a SUCCESSFUL response, not
 * a refusal — the refusal it replaced could only be cleared by a query parameter no shipped UI sends, so one
 * lost object made a node un-backupable from every screen. That makes these two functions the only place an
 * operator can learn of the shortfall, and returning '' when there IS one is the silent failure the whole
 * design exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { downloadShortfall, restoreShortfall, shortfallSuffix } from './backup-shortfall';

const headers = (map: Record<string, string>) => ({
    headers: { get: (name: string) => map[name] ?? map[name.toLowerCase()] ?? null },
});

describe('downloadShortfall', () => {
    it('says nothing about a whole backup', () => {
        expect(downloadShortfall(headers({ 'X-Backup-Images': '412/412', 'X-Backup-Contents': 'database+images' }))).toBe('');
    });

    it('says nothing when the node did not state any counts (an older node)', () => {
        expect(downloadShortfall(headers({}))).toBe('');
    });

    it('names the number missing and the number referenced when the file is short', () => {
        const said = downloadShortfall(headers({
            'X-Backup-Images': '411/412',
            'X-Backup-Missing-Images': '1',
            'X-Backup-Contents': 'database+images-partial',
        }));
        expect(said).toMatch(/missing 1 of 412/);
        expect(said).toMatch(/Everything else is in the file/);
    });

    it('derives the shortfall from the counts alone when the count header is absent', () => {
        expect(downloadShortfall(headers({ 'X-Backup-Images': '400/412' }))).toMatch(/missing 12 of 412/);
    });

    it('never reports a shortfall from counts that do not parse', () => {
        expect(downloadShortfall(headers({ 'X-Backup-Images': 'lots' }))).toBe('');
        expect(downloadShortfall(headers({ 'X-Backup-Images': '412/412', 'X-Backup-Missing-Images': '0' }))).toBe('');
    });
});

describe('restoreShortfall', () => {
    it('says nothing about a restore that came back whole', () => {
        expect(restoreShortfall({ success: true, complete: true, images: { restored: 412, missing: 0, referenced: 412 } })).toBe('');
    });

    it("prefers the server's own sentence, which knows WHY the objects are absent", () => {
        expect(restoreShortfall({ complete: false, warning: 'The backup was SHORT: 1 of the 2 photo(s)…' }))
            .toBe('The backup was SHORT: 1 of the 2 photo(s)…');
    });

    it('builds a sentence from the measured counts when the server sent no words', () => {
        expect(restoreShortfall({ complete: false, images: { missing: 3, referenced: 9 } }))
            .toMatch(/3 of 9 photo\(s\) or attachment\(s\) it references are not on this node/);
    });

    it('reports an image store that could not be written', () => {
        expect(restoreShortfall({ complete: false, images: { missing: 0, error: 'EACCES: permission denied' } }))
            .toMatch(/EACCES: permission denied/);
    });

    it('still refuses to call an unmeasurable restore complete', () => {
        expect(restoreShortfall({ complete: false, images: { missing: 0, referenced: null } }))
            .toMatch(/could not confirm/);
    });

    it('is safe on a body that is not an object at all', () => {
        expect(restoreShortfall(null)).toBe('');
        expect(restoreShortfall(undefined)).toBe('');
        expect(restoreShortfall('not json')).toBe('');
    });
});

describe('shortfallSuffix', () => {
    it('appends nothing when there is nothing short', () => {
        expect(shortfallSuffix('')).toBe('');
    });
    it('marks the sentence so it reads as a warning beside a success message', () => {
        expect(shortfallSuffix('1 photo is missing.')).toBe(' ⚠️ 1 photo is missing.');
    });
});
