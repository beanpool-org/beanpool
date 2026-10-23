import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { needsTargetHref } from '../needs-you';

/**
 * An enterprise's keepers' vote (DESIGN-group-decisions §2.8, slice S2): the node sends the Needs-you vote line a target of
 * `{ to: 'enterprise', id }` only to an app that says it opens one (`lands=enterprise` on GET /api/home). The two ship
 * together: a `lands=` without the landing would push nowhere (router.push(undefined)); a landing without the `lands=`
 * would never be sent one.
 */
describe('a keepers\' vote lands on its enterprise', () => {
    // Its Decisions block is in the keepers' console since slice S7 (app/treasury-manage.tsx), not on its public page.
    it('the landing opens the enterprise\'s keepers\' console, by its key', () => {
        expect(needsTargetHref({ to: 'enterprise', id: 'ent-key' })).toEqual({ pathname: '/treasury-manage', params: { publicKey: 'ent-key' } });
    });

    it('the screen it names is one the app has, and it draws the Decisions block', () => {
        const screen = path.join(__dirname, '..', '..', 'app', 'treasury-manage.tsx');
        expect(fs.existsSync(screen)).toBe(true);
        expect(fs.readFileSync(screen, 'utf-8')).toMatch(/<EnterpriseDecisions\s/);
    });

    it('Home\'s read says the app opens it (utils/__tests__/home-store.test.ts checks the address)', () => {
        const store = fs.readFileSync(path.join(__dirname, '..', 'home-store.ts'), 'utf-8');
        expect(store).toMatch(/return `\/api\/home\?cards=\$\{asked\.join\(','\)\}&lands=enterprise/);
    });
});
