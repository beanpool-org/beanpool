import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOME_STARTER_SET, endTourLayout, homeCardType, type HomeLayoutV2, type HomeNodeFacts } from '../home-frame.js';
import { HOME_TIPS } from '../home-tips.js';
import {
    TOUR_STEP_MAX_CHARS, TOUR_WORDS, checkTourRecord, newcomerCards, readTourProgress, readTourRecord, resumeStep, startCardButton,
    tourChips, tourEnded, tourRecord, tourStepCaption, tourStepForTab, tourSteps,
} from '../tour.js';
import { HELP_LINE_MAX_CHARS, HELP_MAP, helpSheetFor, helpTargets, phoneHelpKey, webHelpKey } from '../help-map.js';
import type { Guide, GuidePage } from '../member-guide.js';

const AT = '2026-10-13T05:00:00.000Z';
const NOW = Date.parse(AT);
const ids = (app: 'phone' | 'web', node: Parameters<typeof tourSteps>[1]) => tourSteps(app, node).map((s) => s.id);

describe('the tour: steps derived from the tabs this node shows (§2)', () => {
    it('phone: a local community has 8 steps, global 6 (no Commons or Ledger tab), 8 once the showcase previews them', () => {
        expect(ids('phone', { global: false, beans: true })).toEqual(['home', 'market', 'map', 'talk', 'commons', 'ledger', 'top', 'cards']);
        expect(ids('phone', { global: true, beans: false })).toEqual(['home', 'market', 'map', 'talk', 'top', 'cards']);
        expect(ids('phone', { global: true, beans: false, showcase: true })).toHaveLength(8);
    });

    it('web: People gets its own step and Talk is Chat; Commons and Ledger only where they are tabs', () => {
        expect(ids('web', { global: false, beans: true })).toEqual(['home', 'market', 'map', 'commons', 'chat', 'people', 'ledger', 'top', 'cards']);
        expect(ids('web', { global: false, beans: false })).toEqual(['home', 'market', 'map', 'chat', 'people', 'top', 'cards']);
    });

    it('a local node with Beans off has no money step (a hidden tab is never a step)', () => {
        expect(ids('phone', { global: false, beans: false })).not.toContain('commons');
        expect(ids('phone', { global: false, beans: false })).not.toContain('ledger');
    });

    it('each step names a real tab of its app, and the last is back on Home', () => {
        const phoneTabs = new Set(['index', 'market', 'map', 'chats', 'projects', 'ledger']);
        const webTabs = new Set(['home', 'marketplace', 'map', 'projects', 'messages', 'people', 'ledger']);
        for (const node of [{ global: false, beans: true }, { global: true, beans: false }]) {
            for (const s of tourSteps('phone', node)) expect(phoneTabs.has(s.tab), s.tab).toBe(true);
            for (const s of tourSteps('web', node)) expect(webTabs.has(s.tab), s.tab).toBe(true);
            expect(tourSteps('phone', node).at(-1)!.tab).toBe('index');
            expect(tourSteps('web', node).at(-1)!.tab).toBe('home');
        }
    });

    it(`no step is over ${TOUR_STEP_MAX_CHARS} characters, and none says locked, earned or tiered, or a symbol for Beans`, () => {
        for (const [key, words] of Object.entries(TOUR_WORDS)) {
            expect(words.length, key).toBeLessThanOrEqual(TOUR_STEP_MAX_CHARS);
            expect(words, key).not.toMatch(/unlock|earn(ed)? a|\btier|\blevel|Ʀ/i);
        }
    });

    it("the Map and Ledger steps are the Tips card's founder-approved words, reused (frozen)", () => {
        const tips = HOME_TIPS.map((t) => t.text).join(' ');
        expect(tips).toContain('green pins are Offers, orange are Needs, purple are events.');
        expect(TOUR_WORDS.map).toContain('green pins are Offers, orange are Needs, purple are events.');
        expect(tips).toContain(TOUR_WORDS.ledger.replace(/\.$/, ''));
    });

    it('"Step 2 of 7", and a tab tapped during the tour moves the tour to its step (it follows, never scolds)', () => {
        expect(tourStepCaption(1, 7)).toBe('Step 2 of 7');
        const steps = tourSteps('phone', { global: false, beans: true });
        expect(tourStepForTab(steps, 'map')).toBe(2);
        expect(tourStepForTab(steps, 'index')).toBe(0);
        expect(tourStepForTab(steps, 'settings')).toBe(-1);
    });
});

describe('the last step: three chips by profile (§3)', () => {
    const local: HomeNodeFacts = { profile: 'local', features: { beans: true, invites: true } };
    it('local with Beans: First steps · New in the Market · Your Beans; Beans off: Coming up instead', () => {
        expect(tourChips(local, null)).toEqual(['steps', 'market', 'beans']);
        expect(tourChips({ profile: 'local', features: { beans: false } }, null)).toEqual(['steps', 'market', 'events']);
    });
    it('global: First steps · Near you · Coming up (until the showcase draws Your Beans as an example)', () => {
        expect(tourChips({ profile: 'global', features: { beans: false, invites: false } }, null)).toEqual(['steps', 'market', 'events']);
    });
    it('an operator alone on a new node: First steps · Grow your community · New in the Market', () => {
        expect(tourChips(local, 'owner', { members: 1 })).toEqual(['steps', 'invite', 'market']);
    });
    it('every chip is a card this node shows this reader', () => {
        for (const id of tourChips(local, null)) expect(homeCardType(id)!.onNode(local, null)).toBe(true);
    });
});

describe('the account record and the device record (§2 State)', () => {
    it('a member\'s write: done, skipped or open; anything else refused; a future date held to now; none sent is now', () => {
        const now = new Date(NOW);
        expect(checkTourRecord({ v: 1, state: 'done', at: AT }, now)).toEqual({ v: 1, state: 'done', at: AT });
        expect(checkTourRecord({ v: 1, state: 'skipped' }, now)).toEqual({ v: 1, state: 'skipped', at: AT });
        expect(checkTourRecord({ v: 1, state: 'done', at: '2099-01-01T00:00:00.000Z' }, now)!.at).toBe(AT);
        for (const bad of [null, 'done', { v: 2, state: 'done' }, { v: 1, state: 'later' }, { v: 1, state: 'done', at: 'soon' }]) {
            expect(checkTourRecord(bad, now)).toBeNull();
        }
    });

    it('done and skipped end the tour; open (Take the tour again) and none do not', () => {
        expect(tourEnded(tourRecord('done', NOW))).toBe(true);
        expect(tourEnded(tourRecord('skipped', NOW))).toBe(true);
        expect(tourEnded(tourRecord('open', NOW))).toBe(false);
        expect(tourEnded(null)).toBe(false);
        expect(readTourRecord({ v: 1, state: 'done', at: AT })).toEqual({ v: 1, state: 'done', at: AT });
        expect(readTourRecord({ v: 1, state: 'done' })).toBeNull();
    });

    it('a tour part way resumes at its step, held inside the steps the node has now', () => {
        const p = readTourProgress({ v: 1, step: 7, startedAt: AT });
        expect(resumeStep(p, 8)).toBe(7);
        expect(resumeStep(p, 6)).toBe(5);
        expect(resumeStep(null, 6)).toBe(0);
        expect(readTourProgress({ v: 1, step: -1, startedAt: AT })).toBeNull();
        expect(readTourProgress({ v: 1, step: 1.5, startedAt: AT })).toBeNull();
        expect(startCardButton(null, 8)).toBe('Look around ›');
        expect(startCardButton({ v: 1, step: 2, startedAt: AT }, 8)).toBe('Pick up the tour at step 3 ›');
    });

    it('with no saved layout: Getting started until the tour ends, then the starter set (never an empty Home)', () => {
        expect(newcomerCards(null).map((c) => c.id)).toEqual(['start']);
        expect(newcomerCards(tourRecord('open', NOW)).map((c) => c.id)).toEqual(['start']);
        expect(newcomerCards(tourRecord('skipped', NOW)).map((c) => c.id)).toEqual([...HOME_STARTER_SET]);
    });
});

describe('endTourLayout: one layout write as the tour ends (§1, §3)', () => {
    const lay = (cards: string[], updatedAt: string | null = null): HomeLayoutV2 => ({ v: 2, cards: cards.map((id) => ({ id, type: id })), dismissed: {}, updatedAt });
    it('Skip, or Done with nothing picked: Getting started goes and the starter set comes', () => {
        expect(endTourLayout(null, { now: NOW }).cards.map((c) => c.id)).toEqual([...HOME_STARTER_SET]);
        expect(endTourLayout(lay(['start']), { now: NOW })).toMatchObject({ updatedAt: AT });
    });
    it('a pinned Find your community stays on top and does not count as a pick', () => {
        expect(endTourLayout(lay(['find', 'start']), { pinned: ['find'], now: NOW }).cards.map((c) => c.id)).toEqual(['find', ...HOME_STARTER_SET]);
    });
    it('Done with chips picked: the picks stay, nothing else is added', () => {
        expect(endTourLayout(lay(['beans', 'market', 'start']), { now: NOW }).cards.map((c) => c.id)).toEqual(['beans', 'market']);
    });
    it('a member who set up Home and added Getting started from the picker keeps their Home, less the card', () => {
        expect(endTourLayout(lay(['pulse', 'start', 'sky'], AT), { now: NOW }).cards.map((c) => c.id)).toEqual(['pulse', 'sky']);
    });
});

// ── The "?" (§4) and the guide's coverage ─────────────────────────────────────────────────────────────────────────

const GUIDE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../beanpool-guide/content');
const manifest = JSON.parse(readFileSync(join(GUIDE_DIR, 'manifest.json'), 'utf8')) as { sections: { id: string; title: string; summary: string; pages: string[] }[] };
const frontMatter = (section: string, slug: string): Record<string, string> => {
    const text = readFileSync(join(GUIDE_DIR, section, `${slug}.md`), 'utf8');
    const head = text.split('\n---')[0].split('\n').slice(1);
    return Object.fromEntries(head.map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
};
const sectionOf = (slug: string) => manifest.sections.find((s) => s.pages.includes(slug))?.id;

describe('the "?": every screen with one has a help: line or a fallback (guide coverage)', () => {
    it('every page the map names is in the guide and has a help: line of at most 160 characters', () => {
        for (const slug of helpTargets().slugs) {
            const section = sectionOf(slug);
            expect(section, `${slug} is in the manifest`).toBeTruthy();
            const help = frontMatter(section!, slug).help;
            expect(help, `${slug} has a help: line`).toBeTruthy();
            expect(help.length, slug).toBeLessThanOrEqual(HELP_LINE_MAX_CHARS);
            expect(help, slug).not.toMatch(/Ʀ|\btier/i);
        }
    });

    it('every section the map names is in the manifest, with a summary (the fallback)', () => {
        for (const id of helpTargets().sections) expect(manifest.sections.find((s) => s.id === id)?.summary, id).toBeTruthy();
    });

    it('every phone tab and web tab resolves to a key in the map', () => {
        for (const path of ['/', '/index', '/market', '/map', '/chats', '/projects', '/ledger', '/pulse', '/people', '/settings']) {
            expect(HELP_MAP[phoneHelpKey(path)], path).toBeTruthy();
        }
        expect(phoneHelpKey('/market', 'polls')).toBe('market/polls');
        expect(phoneHelpKey('/chats', 'groups')).toBe('talk/groups');
        expect(phoneHelpKey('/market', 'unknown')).toBe('market');
        expect(phoneHelpKey('/chat/abc')).toBe('home');
        for (const tab of ['home', 'marketplace', 'map', 'projects', 'messages', 'people', 'ledger', 'pulse']) {
            expect(HELP_MAP[webHelpKey({ tab })], tab).toBeTruthy();
        }
        expect(webHelpKey({ tab: 'home', settings: true, settingsView: 'privacy' })).toBe('settings/privacy');
        expect(webHelpKey({ tab: 'marketplace', lobby: true })).toBe('lobby/market');
        expect(webHelpKey({ tab: 'join', lobby: true })).toBe('lobby/join');
        expect(webHelpKey({ tab: 'ledger', lobby: true })).toBe('lobby/ledger');
    });

    it('the sheet: help line, else summary, else the section, else Search and the tour only (never dead)', () => {
        const page = (slug: string, section: string, help?: string): GuidePage => ({ slug, title: slug.toUpperCase(), summary: `${slug} summary`, section, related: [], blocks: [{ type: 'p', text: 'x' }], ...(help ? { help } : {}) });
        const guide = {
            schema: 2, version: 1, hash: 'h',
            guides: [page('home', 'getting-started', 'You are home.'), page('browsing-the-market', 'market')],
            sections: [{ id: 'commons', title: 'Commons', summary: 'Deciding together.', slugs: [] }],
        } as unknown as Guide<GuidePage>;
        expect(helpSheetFor(guide, 'home')).toEqual({ title: 'HOME', text: 'You are home.', slug: 'home', section: 'getting-started' });
        expect(helpSheetFor(guide, 'market').text).toBe('browsing-the-market summary');
        expect(helpSheetFor(guide, 'commons')).toEqual({ title: 'Commons', text: 'Deciding together.', slug: null, section: 'commons' });
        expect(helpSheetFor(guide, 'ledger')).toEqual({ title: null, text: null, slug: null, section: null });
        expect(helpSheetFor(null, 'home').text).toBeNull();
    });
});
