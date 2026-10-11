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

    it('the page sets its listing through it, so a null read never reaches the full-screen spinner', () => {
        const page = fs.readFileSync(path.resolve(__dirname, '../../app/post/[id].tsx'), 'utf-8');
        expect(page).toMatch(/getPost\(singleId\)\.then\(p => \{\s*(\/\/[^\n]*\n\s*)*setPost\(\(prev: any\) => shownPostAfterReload\(prev, p, singleId\)\);/);
        expect(page).not.toMatch(/getPost\(singleId\)\.then\(p => \{\s*setPost\(p\);/);
    });
});
