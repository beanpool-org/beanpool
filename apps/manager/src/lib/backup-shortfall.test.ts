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

    // A copy the fleet manager holds, kept by a harvester older than the image store: its database names three
    // objects and nothing was kept beside it. The manager measures that and says so — but there is no
    // `missing-images.json` in that archive, and the node never lost anything. The sentence must not say either.
    it('claims no list inside the archive and no loss on the node, which a manager-held copy may have neither of', () => {
        const said = downloadShortfall(headers({
            'X-Backup-Images': '0/3',
            'X-Backup-Missing-Images': '3',
            'X-Backup-Contents': 'database+images-partial',
        }));
        expect(said).toMatch(/missing 3 of 3/);
        expect(said).not.toMatch(/lists which ones/);
        expect(said).not.toMatch(/node no longer holds/);
    });

    // A copy the fleet manager holds whose database it could not read: served byte for byte, labelled partial,
    // and — because nothing was measured — no `X-Backup-Images` and, with no manifest, no missing count either.
    // The label says partial; saying nothing here is the silent shortfall again.
    it('speaks for a file labelled partial whose counts were never taken', () => {
        const said = downloadShortfall(headers({ 'X-Backup-Contents': 'database+images-partial' }));
        expect(said).toMatch(/could not be checked against its database/);
        expect(said).not.toMatch(/missing \d/);
        expect(said).not.toMatch(/Everything else is in the file/);
    });

    it('speaks for a file labelled partial whose counts do not parse', () => {
        expect(downloadShortfall(headers({ 'X-Backup-Images': 'lots', 'X-Backup-Contents': 'database+images-partial' })))
            .toMatch(/could not be checked against its database/);
    });

    // The same unread database with the node's manifest beside it: the manifest's count is real, but nothing
    // checked the rest of the file, so "everything else is in the file" is not established.
    it('does not call the rest of the file whole when only the manifest was counted', () => {
        const said = downloadShortfall(headers({
            'X-Backup-Missing-Images': '2',
            'X-Backup-Contents': 'database+images-partial',
        }));
        expect(said).toMatch(/missing 2 photo/);
        expect(said).toMatch(/could not be checked against its database/);
        expect(said).not.toMatch(/Everything else is in the file/);
    });

    // Measured whole against its database, labelled partial only because an empty manifest came with it.
    it('says nothing about a partial label whose counts show nothing missing', () => {
        expect(downloadShortfall(headers({ 'X-Backup-Images': '3/3', 'X-Backup-Contents': 'database+images-partial' })))
            .toBe('');
    });

    it('derives the shortfall from the counts alone when the count header is absent', () => {
        expect(downloadShortfall(headers({ 'X-Backup-Images': '400/412' }))).toMatch(/missing 12 of 412/);
    });

    it('never reports a shortfall from counts that do not parse', () => {
        expect(downloadShortfall(headers({ 'X-Backup-Images': 'lots' }))).toBe('');
        expect(downloadShortfall(headers({ 'X-Backup-Images': '412/412', 'X-Backup-Missing-Images': '0' }))).toBe('');
    });

    // IMAGE_STORE=s3: the photos are in the node's bucket, never in the file. Saying nothing would let the
    // operator believe the photos are inside it; "missing 412 of 412" would read as a node that lost them all.
    it('says an s3 node\'s backup holds the database only, and names the bucket, even when nothing is missing', () => {
        const said = downloadShortfall(headers({
            'X-Backup-Contents': 'database+images-in-bucket',
            'X-Backup-Images': 'in-bucket',
            'X-Backup-Images-Bucket': 'global-photos',
            'X-Backup-Images-Referenced': '412',
            'X-Backup-Images-Checked': 'yes',
        }));
        expect(said).toMatch(/database only/);
        expect(said).toMatch(/"global-photos"/);
        expect(said).toMatch(/not inside the backup/);
        expect(said).not.toMatch(/missing \d+ of/);
    });

    it('counts what an s3 node\'s bucket did not hold, as the node measured it', () => {
        const said = downloadShortfall(headers({
            'X-Backup-Images': 'in-bucket',
            'X-Backup-Images-Referenced': '412',
            'X-Backup-Missing-Images': '3',
        }));
        expect(said).toMatch(/3 of the 412 photo\(s\) or attachment\(s\)/);
        expect(said).toMatch(/not in the bucket when it was taken/);
    });

    it('says so when an s3 node could not check its bucket', () => {
        const said = downloadShortfall(headers({ 'X-Backup-Images': 'in-bucket', 'X-Backup-Images-Checked': 'no' }));
        expect(said).toMatch(/could not be checked/);
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
