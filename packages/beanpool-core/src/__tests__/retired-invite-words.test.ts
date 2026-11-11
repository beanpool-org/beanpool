import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The words sweep (invites-vouching slice I6; DESIGN-invites-vouching-review-fable.md §4, Marty 10 Nov): three sentences the
 * design retired are in no catalog of any language, in the words layer of core, the phone, the web app or the node. A
 * sentence that is not in a catalog's English keys cannot be drawn through t(); the screens' own tests assert what they draw
 * (invited-by-card-render, InvitedByCard.test, people-invites-names-boxes-render, InvitePage.pending) and the guide's test
 * reads every page.
 *
 *  - "Invited directly by the system admin" and "Vetted by the admin at sign-up" were a server bug (an inviter who held a node
 *    role was hidden behind "the system admin"); every inviter is named now, with their role word.
 *  - "Share this cryptographic code" sat over a bare code, so a bound invite was made twice (Byron, 10 Nov); the made card
 *    says who the invite is for, what it carries and how long it has left.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const CATALOG_DIRS = ['packages/beanpool-core/words', 'apps/native/words', 'apps/pwa/words', 'apps/server/words'];
const RETIRED = ['Invited directly by the system admin', 'Vetted by the admin at sign-up', 'Share this cryptographic code'];

describe('the retired invite sentences are in no catalog', () => {
    it('reads every catalog of every language, keys and translations', () => {
        let files = 0;
        const found: string[] = [];
        for (const dir of CATALOG_DIRS) {
            for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith('.json'))) {
                files++;
                const text = fs.readFileSync(path.join(ROOT, dir, f), 'utf8').toLowerCase();
                for (const gone of RETIRED) if (text.includes(gone.toLowerCase())) found.push(`${dir}/${f}: ${gone}`);
            }
        }
        expect(files).toBeGreaterThanOrEqual(24 * 4);
        expect(found).toEqual([]);
    });
});
