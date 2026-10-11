/**
 * The listing page keeps the listing it shows when a reload reads no row (app/post/[id].tsx, utils/shown-post.ts). On a
 * community that syncs by area the phone drops a far listing's row: one opened from search, Home or a link goes on the
 * next sync (it isn't in the member's set) and on a near push past the cap (the review of #1778, finding 3). The page's
 * reload (sync_data_updated) then read null and swapped the whole page for a full-screen spinner, losing its scroll and
 * its children's state, until getPost's by-id refetch wrote the row again. Now the shown listing stays, and the refetch's
 * row replaces it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shownPostAfterReload } from '../shown-post';

const shown = { id: 'far-1', title: 'Kayak', status: 'active' };

describe('the listing page after a reload', () => {
    it('keeps the shown listing when the reload reads no row', () => {
        expect(shownPostAfterReload(shown, null, 'far-1')).toBe(shown);
        expect(shownPostAfterReload(shown, undefined, 'far-1')).toBe(shown);
    });

    it('takes the row the reload read: the by-id refetch replaces the shown one', () => {
        const fresh = { ...shown, title: 'Kayak (with paddles)' };
        expect(shownPostAfterReload(shown, fresh, 'far-1')).toBe(fresh);
    });

    it('a cancelled row is a row: it replaces the shown one, so a removed listing says so', () => {
        const removed = { ...shown, status: 'cancelled' };
        expect(shownPostAfterReload(shown, removed, 'far-1')).toBe(removed);
    });

    it('never keeps another listing: nothing shown yet, or the page now open on a different id', () => {
        expect(shownPostAfterReload(null, null, 'far-1')).toBeNull();
        expect(shownPostAfterReload(shown, null, 'far-2')).toBeNull();
    });

    it("probe 13: the node answered no such listing (utils/db.ts post_not_on_node) and the phone holds no row: it goes", () => {
        // The page then reads null, and the not-found timer's "Post not found" shows (the confirmation review of #1778, finding 1).
        expect(shownPostAfterReload(shown, null, 'far-1', true)).toBeNull();
        expect(shownPostAfterReload(shown, undefined, 'far-1', true)).toBeNull();
    });

    it('a row the phone holds still wins over the node\'s answer: the sync drops the row, never the page', () => {
        const row = { ...shown, title: 'Kayak (held)' };
        expect(shownPostAfterReload(shown, row, 'far-1', true)).toBe(row);
    });

    it('without that answer (offline, a failed read) the shown listing stays (decision (a))', () => {
        expect(shownPostAfterReload(shown, null, 'far-1', false)).toBe(shown);
    });

    it('the page sets its listing through it, so a null read never reaches the full-screen spinner', () => {
        const page = fs.readFileSync(path.resolve(__dirname, '../../app/post/[id].tsx'), 'utf-8');
        expect(page).toMatch(/getPost\(singleId\)\.then\(p => \{\s*(\/\/[^\n]*\n\s*)*setPost\(\(prev: any\) => shownPostAfterReload\(prev, p, singleId, goneOnNode\.current === singleId\)\);/);
        expect(page).not.toMatch(/getPost\(singleId\)\.then\(p => \{\s*setPost\(p\);/);
    });

    it("the page hears the node's answer for its own listing, and clears it only when its last read found no row", () => {
        const page = fs.readFileSync(path.resolve(__dirname, '../../app/post/[id].tsx'), 'utf-8');
        expect(page).toMatch(/addListener\('post_not_on_node', \(goneId: unknown\) => \{\s*if \(goneId !== singleId\) return;\s*goneOnNode\.current = singleId;\s*if \(readNoRow\.current === singleId\) setPost\(\(prev: any\) => shownPostAfterReload\(prev, null, singleId, true\)\);/);
        expect(page).toMatch(/readNoRow\.current = p \? null : singleId;/);
        // Removed with the page's other listeners.
        expect(page).toMatch(/goneSub\.remove\(\);/);
    });
});
