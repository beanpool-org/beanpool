/**
 * Slice F10, the apps' part (DESIGN-forums-fable.md §12; core forum-label.ts):
 *
 * - **The invariant.** Every place either app draws a forum writer's name (the visitors' forum and the members': lists, a
 *   topic, replies, quotes, search hits, first looks, the Home card; phone and web) goes through ONE function, core's
 *   forumWriterLine. The guard below lists every call site, file by file, and fails on a forum writer's name read any other
 *   way in either app's forum code. A new place that draws a writer adds itself to CALL_SITES; one that reads `writer.name`
 *   for anything but a line names itself in NOT_A_LINE with why.
 * - **The switch's logic** both apps run: the forum's answer read, the note asked then handed on, a refusal said in the
 *   words it came with and nothing posted after it, renewing in the note's last week.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    FORUM_LABEL_RENEW_MS, MEMBERSHIP_NOTE_MAX_MS, chooseForumLabel, forumLabelRenewDue, forumLabelWhyLine, forumWriterLine,
    readForumLabelState, renewForumLabel, signMembershipNote, type ForumLabelDeps, type ForumLabelState,
} from '../index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('forumWriterLine: the one name line for a forum writer', () => {
    it('writes a member writer, a visitor\'s public writer, and no writer, the same way', () => {
        expect(forumWriterLine({ name: 'Marty', label: { kind: 'community', community: 'Riverside' } }, 'A member')).toBe('Marty · Riverside');
        expect(forumWriterLine({ name: 'Asha', label: { kind: 'waiting' } }, 'A member')).toBe('Asha · waiting to join');
        expect(forumWriterLine({ name: 'Marty', label: null }, 'A member')).toBe('Marty');
        expect(forumWriterLine({ name: 'Marty' }, 'A member')).toBe('Marty');
        // The visitors' public JSON carries the label as `community` (core forum-visitors.ts ForumPublicWriter).
        expect(forumWriterLine({ name: 'Dax', community: { kind: 'community', community: 'Hillside' } }, 'A member')).toBe('Dax · Hillside');
        expect(forumWriterLine(null, 'A member')).toBe('A member');
        expect(forumWriterLine({ name: '  ', label: { kind: 'waiting' } }, 'A member')).toBe('A member · waiting to join');
        // A community label with no name never leaves a dangling " · ".
        expect(forumWriterLine({ name: 'Marty', label: { kind: 'community', community: '' } }, 'A member')).toBe('Marty');
    });
});

// ── The guard ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Both apps' source folders: every file whose path names the forum is forum code. */
const APP_DIRS = ['apps/native/app', 'apps/native/components', 'apps/native/utils', 'apps/pwa/src'];
const SKIP = /(^|\/)(__tests__|__mocks__|node_modules|dist)(\/|$)|\.test\.tsx?$|\.test-support\.tsx?$|\.d\.ts$/;

function forumFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            const rel = relative(ROOT, full);
            if (SKIP.test(rel)) continue;
            if (statSync(full).isDirectory()) walk(full);
            else if (/\.(tsx?)$/.test(name) && /forum/i.test(rel)) out.push(rel);
        }
    };
    for (const d of APP_DIRS) walk(join(ROOT, d));
    return out.sort();
}

/** Where a forum writer's name is read: `writer.name`, `writer?.name`, `writer!.name`, and `nameLine(` / the core name-line input drawn by hand. */
const RAW_READ = /\bwriter[?!]?\.name\b|\bnameLine\s*\(|\bforumWriterNameLine\s*\(/g;
const CALL = /\bforumWriterLine\s*\(/g;

/** Every forumWriterLine call in both apps, by file (the import line is no call). */
const CALL_SITES: Record<string, number> = {
    // The members' forum, phone.
    'apps/native/app/forum/[id].tsx': 1, // the topic: byline, quotes, "replying to", block and report sentences (its `name`)
    'apps/native/app/forum/first-looks.tsx': 1, // a moderator's first looks
    'apps/native/components/forum/ForumPane.tsx': 1, // the topic list
    'apps/native/components/forum/ForumSearch.tsx': 1, // a search hit
    'apps/native/components/home/ForumHomeBody.tsx': 1, // the Home card "From the forum"
    'apps/native/utils/forum.ts': 1, // "You blocked {name}" when a blocked writer's topic is opened
    'apps/native/components/forum/ForumLabelRow.tsx': 1, // Settings: "Others see: …", the member's own line
    // The visitors' forum, phone.
    'apps/native/app/forum-public/[id].tsx': 2, // a post's byline, a quote
    'apps/native/components/forum/ForumVisitorPane.tsx': 1, // the topic list
    // The members' forum, web.
    'apps/pwa/src/components/forum/ForumTopicView.tsx': 1, // the topic: byline, quotes, "replying to", block and report (its `name`)
    'apps/pwa/src/components/forum/ForumFirstLooks.tsx': 1,
    'apps/pwa/src/components/forum/ForumSearch.tsx': 1,
    'apps/pwa/src/pages/ForumPage.tsx': 1, // the topic list
    'apps/pwa/src/components/ForumLabelRow.tsx': 1, // Settings: "Others see: …"
    // The visitors' forum, web.
    'apps/pwa/src/pages/ForumVisitorPage.tsx': 3, // the topic list, a post's byline, a quote
};

/** A forum writer's `name` read for something that is not their line, each with why. */
const NOT_A_LINE: Record<string, { count: number; why: string }> = {
    'apps/native/app/forum/[id].tsx': { count: 1, why: 'the person\'s own name handed to their profile screen (public-profile `callsign`), which is theirs, not a forum line' },
};

function countIn(source: string, re: RegExp): number {
    return [...source.matchAll(re)].length;
}

describe('the guard: one name line in both apps', () => {
    const files = forumFiles();
    // Settings' rows live outside the forum folders; they are read by name.
    const settingsRows = ['apps/pwa/src/components/ForumLabelRow.tsx'];
    const all = [...new Set([...files, ...settingsRows])].sort();

    it('finds the forum code it guards (the walk can fail)', () => {
        expect(all).toEqual(expect.arrayContaining(Object.keys(CALL_SITES)));
        expect(files.length).toBeGreaterThan(20);
    });

    it('every forumWriterLine call site is listed, and nothing else calls it', () => {
        const found: Record<string, number> = {};
        for (const rel of all) {
            const source = readFileSync(join(ROOT, rel), 'utf8');
            const calls = countIn(source, CALL);
            if (calls > 0) found[rel] = calls;
        }
        expect(found).toEqual(CALL_SITES);
    });

    it('no forum writer\'s name is drawn any other way: no raw `writer.name`, no nameLine by hand, in either app', () => {
        const raw: Record<string, number> = {};
        for (const rel of all) {
            const n = countIn(readFileSync(join(ROOT, rel), 'utf8'), RAW_READ);
            if (n > 0) raw[rel] = n;
        }
        expect(raw).toEqual(Object.fromEntries(Object.entries(NOT_A_LINE).map(([f, { count }]) => [f, count])));
    });

    it('the detector bites: a raw read and a hand-made line are both counted', () => {
        expect(countIn("{[topic.writer.name, sectionName].join(' · ')}", RAW_READ)).toBe(1);
        expect(countIn('hit.writer?.name || t("A member")', RAW_READ)).toBe(1);
        expect(countIn('nameLine(forumWriterNameLine(w))', RAW_READ)).toBe(2);
        expect(countIn('forumWriterLine(post.writer, member)', RAW_READ)).toBe(0);
    });

    it('core draws the line in one place: forum-label.ts', () => {
        const src = readFileSync(join(ROOT, 'packages/beanpool-core/src/forum-label.ts'), 'utf8');
        expect(countIn(src, /nameLine\(forumWriterNameLine\(/g)).toBe(1);
        expect(readFileSync(join(ROOT, 'packages/beanpool-core/src/forum-visitors.ts'), 'utf8')).not.toMatch(/nameLine\(|forumWriterNameLine\(/);
    });
});

// ── The switch ────────────────────────────────────────────────────────────────────────────────────────────────────────

const MEMBER = 'a'.repeat(64);
const COMMUNITY = '12D3KooWRiversideKeyFor1111111111111111111111111';
const NOW = Date.parse('2026-11-17T00:00:00Z');
const note = signMembershipNote({ community: COMMUNITY, name: 'Riverside', member: MEMBER, issuedAt: NOW, expiresAt: NOW + MEMBERSHIP_NOTE_MAX_MS }, () => new Uint8Array(64).fill(7));

function stateOf(over: Partial<ForumLabelState> = {}): ForumLabelState {
    return { show: 'community', community: { key: COMMUNITY, name: 'Riverside' }, lapsesAt: new Date(NOW + MEMBERSHIP_NOTE_MAX_MS).toISOString(), label: { kind: 'community', community: 'Riverside' }, why: null, ...over };
}

function fakeDeps(noteAnswer: { status: number; body: unknown }, labelAnswer: (body: unknown) => { status: number; body: unknown }) {
    const calls: Array<{ to: string; body?: unknown }> = [];
    const deps: ForumLabelDeps = {
        askNote: async (address) => { calls.push({ to: `note@${address}` }); return noteAnswer; },
        postLabel: async (body) => { calls.push({ to: 'label', body }); return labelAnswer(body); },
    };
    return { deps, calls };
}

describe('the switch', () => {
    it('reads the forum\'s answer, and nothing that isn\'t one', () => {
        const s = readForumLabelState({ show: 'waiting', community: null, lapsesAt: null, label: { kind: 'waiting' }, why: null });
        expect(s).toEqual({ show: 'waiting', community: null, lapsesAt: null, label: { kind: 'waiting' }, why: null });
        expect(readForumLabelState({ show: 'everyone' })).toBeNull();
        expect(readForumLabelState(null)).toBeNull();
        expect(readForumLabelState({ show: 'community', community: { key: COMMUNITY, name: null }, lapsesAt: 'x', label: { kind: 'community', community: 5 }, why: 'not_listed' }))
            .toEqual({ show: 'community', community: { key: COMMUNITY, name: null }, lapsesAt: 'x', label: null, why: 'not_listed' });
    });

    it('a community: the note is asked of that community, then handed to the forum', async () => {
        const { deps, calls } = fakeDeps({ status: 200, body: { note } }, () => ({ status: 200, body: stateOf() }));
        const done = await chooseForumLabel(deps, { show: 'community', address: 'https://riverside.example' });
        expect(done).toEqual({ ok: true, state: stateOf() });
        expect(calls).toEqual([{ to: 'note@https://riverside.example' }, { to: 'label', body: { show: 'community', note } }]);
    });

    it('a community that gives no note: its own words, and nothing is posted', async () => {
        const words = 'Your community isn’t listed publicly, so its name can’t be shown.';
        const { deps, calls } = fakeDeps({ status: 409, body: { error: words, code: 'not_listed' } }, () => ({ status: 200, body: stateOf() }));
        expect(await chooseForumLabel(deps, { show: 'community', address: 'https://riverside.example' })).toEqual({ ok: false, error: words });
        expect(calls.map((c) => c.to)).toEqual(['note@https://riverside.example']);
    });

    it('an answer that isn\'t a note is not handed on', async () => {
        const { deps, calls } = fakeDeps({ status: 200, body: { note: { ...note, extra: 1 } } }, () => ({ status: 200, body: stateOf() }));
        const done = await chooseForumLabel(deps, { show: 'community', address: 'https://riverside.example' });
        expect(done.ok).toBe(false);
        expect(calls.map((c) => c.to)).toEqual(['note@https://riverside.example']);
    });

    it('Don\'t show and waiting post no note; a refusal from the forum is said in its words', async () => {
        const { deps, calls } = fakeDeps({ status: 500, body: null }, (body) => ({ status: 200, body: { ...stateOf(), show: (body as { show: string }).show, community: null, label: null } }));
        expect((await chooseForumLabel(deps, { show: 'none' })).ok).toBe(true);
        expect((await chooseForumLabel(deps, { show: 'waiting' })).ok).toBe(true);
        expect(calls).toEqual([{ to: 'label', body: { show: 'none' } }, { to: 'label', body: { show: 'waiting' } }]);
        const refused = fakeDeps({ status: 200, body: { note } }, () => ({ status: 400, body: { error: 'This note from your community has run out. Ask your community again.', code: 'note_expired' } }));
        expect(await chooseForumLabel(refused.deps, { show: 'community', address: 'https://riverside.example' }))
            .toEqual({ ok: false, error: 'This note from your community has run out. Ask your community again.' });
    });

    it('a community that can\'t be reached says so', async () => {
        const deps: ForumLabelDeps = { askNote: async () => { throw new Error('offline'); }, postLabel: async () => { throw new Error('never'); } };
        expect(await chooseForumLabel(deps, { show: 'community', address: 'https://riverside.example' })).toEqual({ ok: false, error: 'Couldn’t reach your community. Please try again.' });
    });

    it('why a chosen community isn\'t shown, in the design\'s words', () => {
        expect(forumLabelWhyLine(stateOf({ why: 'not_listed', label: null }))).toBe('Your community isn’t listed publicly, so its name can’t be shown.');
        expect(forumLabelWhyLine(stateOf({ why: 'expired', label: null }))).toMatch(/run out/);
        expect(forumLabelWhyLine(stateOf())).toBeNull();
        expect(forumLabelWhyLine(stateOf({ show: 'waiting', why: null }))).toBeNull();
    });

    it('renews in the note\'s last week, lapsed included, at the address known for its key; never for one not listed', async () => {
        const fresh = stateOf();
        const lastWeek = stateOf({ lapsesAt: new Date(NOW + FORUM_LABEL_RENEW_MS - 1).toISOString() });
        expect(forumLabelRenewDue(fresh, NOW)).toBe(false);
        expect(forumLabelRenewDue(lastWeek, NOW)).toBe(true);
        expect(forumLabelRenewDue(stateOf({ why: 'expired', lapsesAt: new Date(NOW - 1).toISOString(), label: null }), NOW)).toBe(true);
        expect(forumLabelRenewDue(stateOf({ why: 'not_listed', label: null }), NOW)).toBe(false);
        expect(forumLabelRenewDue(stateOf({ show: 'waiting' }), NOW)).toBe(false);
        expect(forumLabelRenewDue(null, NOW)).toBe(false);

        const { deps, calls } = fakeDeps({ status: 200, body: { note } }, () => ({ status: 200, body: fresh }));
        expect(await renewForumLabel(deps, fresh, () => 'https://riverside.example', NOW)).toBeNull();
        expect(calls).toEqual([]);
        expect(await renewForumLabel(deps, lastWeek, () => null, NOW)).toBeNull();
        expect(calls).toEqual([]);
        expect(await renewForumLabel(deps, lastWeek, (key) => (key === COMMUNITY ? 'https://riverside.example' : null), NOW)).toEqual(fresh);
        expect(calls.map((c) => c.to)).toEqual(['note@https://riverside.example', 'label']);
    });
});
