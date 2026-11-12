/**
 * Where a visit to People ends (utils/people-visit.ts; the deciding review of #3096, finding 1). The behaviour on the real
 * screen is people-show-credit-visit-render.test.ts; this pins the list of tab paths to the tabs the app really has, so a
 * new tab cannot be taken for a pushed screen (and a pushed screen for a tab), and that People uses the hook and nothing else
 * to turn Show credit off.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-router', () => ({ usePathname: () => '/people' }));

import { TAB_PATHS, tabOf } from '../people-visit';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

describe('the tab paths', () => {
    it('are exactly the screens in app/(tabs), `index` being `/`', () => {
        const dir = path.resolve(__dirname, '../../app/(tabs)');
        const tabs = fs.readdirSync(dir).filter((f) => f.endsWith('.tsx') && !f.startsWith('_')).map((f) => f.replace(/\.tsx$/, ''));
        expect([...TAB_PATHS].sort()).toEqual(tabs.map((t) => (t === 'index' ? '/' : `/${t}`)).sort());
    });
    it('a tab is itself; a screen pushed on top of one is none', () => {
        for (const p of TAB_PATHS) expect(tabOf(p)).toBe(p);
        for (const pushed of ['/public-profile', '/names-list', '/chat/abc', '/chats/extra', '/market/x', '/guide/section/credit', '']) expect(tabOf(pushed), pushed).toBeNull();
    });
});

describe('People turns Show credit off through the hook only', () => {
    const people = read('../../app/(tabs)/people.tsx').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    it('the switch state is the hook\'s, not a useState of its own', () => {
        expect(people).toContain('usePeopleVisitEnds()');
        expect(people).toContain('useShowCredit(view === \'community\', visitEnds)');
        expect(people).not.toMatch(/setCredit(On|Start)\b/);
        expect(people).not.toMatch(/const \[credit(On|Start),/);
    });
    it('every way it goes off is the hook\'s close: the switch by hand, the node\'s refusal', () => {
        expect(people).toContain('onValueChange={(v) => { if (v) openCredit(); else closeCredit(); }}');
        expect(people).toContain('onRefused={closeCredit}');
    });
});
