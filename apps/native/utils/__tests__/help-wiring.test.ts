/**
 * The phone's "?" (scratch/global-node/DESIGN-getting-started-fable.md §4; review of #1857, B4): the header's button says
 * open_help, the tabs' layout opens its sheet for the path on screen and the view the screen names (the Market's Polls,
 * Talk's Groups and People), and each of those has its own words in the bundled guide.
 *
 * GlobalHeader and the tab screens need the whole app to render, so their wiring is read from their source here, the
 * way tour-render.test.ts reads the tabs' bottom buttons; what the wiring leads to is run for real.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { helpSheetFor, phoneHelpKey } from '@beanpool/core';

import { getBundledGuide } from '../guide';

const src = (rel: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), 'utf8');
/** What the layout's sheet shows on a path while a screen names a view (setHelpContext → helpContext()). */
const sheetOn = (path: string, view: string | null = null) => helpSheetFor(getBundledGuide(), phoneHelpKey(path, view));

describe('the phone\'s "?" opens the words for the screen on show', () => {
    it('the header\'s ? says open_help, and the tabs\' layout opens its sheet on it, for the path and the view on screen', () => {
        const store = src('../tour-store.ts');
        expect(store).toMatch(/export const OPEN_HELP_EVENT = 'open_help';/);
        expect(store).toMatch(/export function setHelpContext\(view: string \| null\): void \{\s*helpView = view;/);
        expect(store).toMatch(/export const helpContext = \(\): string \| null => helpView;/);
        const header = src('../../components/GlobalHeader.tsx');
        expect(header).toMatch(/onPress=\{\(\) => DeviceEventEmitter\.emit\('open_help'\)\}\s*testID="header-help"/);
        const layout = src('../../app/(tabs)/_layout.tsx');
        expect(layout).toMatch(/DeviceEventEmitter\.addListener\(OPEN_HELP_EVENT, \(\) => setHelpOpen\(true\)\)/);
        expect(layout).toMatch(/helpSheetFor\(guide\.guide, phoneHelpKey\(pathname, helpContext\(\)\)\)/);
        expect(layout).toMatch(/<HelpSheet\s+visible=\{helpOpen\}\s+sheet=\{helpWords\}/);
    });

    it('the Market names Polls while it shows them, and Talk names Groups and People', () => {
        expect(src('../../app/(tabs)/market.tsx')).toMatch(/setHelpContext\(filter === 'polls' \? 'polls' : null\)/);
        expect(src('../../app/(tabs)/chats.tsx')).toMatch(/setHelpContext\(talkView === 'messages' \? null : talkView\)/);
    });

    it('each tab and view has its own words: the Market\'s are not Polls\', Talk\'s are not Groups\' or People\'s', () => {
        const market = sheetOn('/market'), polls = sheetOn('/market', 'polls');
        const talk = sheetOn('/chats'), groups = sheetOn('/chats', 'groups'), people = sheetOn('/chats', 'people');
        for (const s of [market, polls, talk, groups, people]) {
            expect(s.title).toBeTruthy();
            expect(s.text).toBeTruthy();
        }
        expect(polls.title).not.toBe(market.title);
        expect(new Set([talk.title, groups.title, people.title]).size).toBe(3);
        // Home's words are Home's, the Map's the Map's: no screen falls back to Home's page unasked.
        const home = sheetOn('/');
        for (const p of ['/market', '/map', '/chats', '/projects', '/ledger']) expect(sheetOn(p).title, p).not.toBe(home.title);
    });
});
