/**
 * Groups findable, no formal votes, on the worldwide community (Marty's card global-groups-votes, 2026-09-27;
 * utils/commons-sections.ts): the Commons screen shows only the sections a node has, Talk's Groups view offers
 * "Find groups" where the Commons tab is hidden, and nothing opens Decide on a node without Decisions. Every local
 * community, and every node that says nothing, exactly as before.
 *
 * Screens can't be drawn here (vitest.config.ts: logic, not screens), so the last block reads their source and checks
 * that each way into Decide, and the Talk → Find groups path, goes through the helpers tested above it.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Device modules, stubbed at the boundary (vitest.config.ts), for node-profile.ts: the signer's random bytes and storage.
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
import {
    commonsSections, commonsSectionFor, commonsHeading, findGroupsInTalk, FIND_GROUPS_HREF,
    groupKindChips, commonsGroupRows, commonsGroupsEmpty, type GroupKind,
} from '../commons-sections';
import type { GroupItem } from '../db';
import { decisionsOn, readNodeProfile, type NodeFeatures } from '../node-profile';

/** What the global node reports (test-node-profile's BUILT_TODAY.global), read as the phone reads it. */
const GLOBAL = readNodeProfile({
    profile: 'global',
    features: {
        beans: false, escrow: false, enterprises: false, openJoin: true, knocks: false, distanceSearch: true,
        probation: true, autoHideReports: true, autoMute: true, guestListingsOnly: true, decisions: false,
    },
})!.features;
const LOCAL = readNodeProfile({
    profile: 'local',
    features: {
        beans: true, escrow: true, enterprises: true, openJoin: false, knocks: true, distanceSearch: true,
        probation: false, autoHideReports: false, autoMute: false, guestListingsOnly: false, decisions: true,
    },
})!.features;
/** A server from before the switch: says nothing about Decisions. */
const OLD_SERVER = readNodeProfile({ profile: 'local', features: { beans: true, escrow: true, enterprises: true } })!.features;
const AS_BEFORE: Array<[string, NodeFeatures | null | undefined]> = [
    ['local', LOCAL], ['a server from before the switch', OLD_SERVER], ['a node that says nothing', readNodeProfile({})!.features],
    ['no profile yet (null)', null], ['undefined', undefined],
];

describe('the node says whether it has formal Decisions', () => {
    it('the phone keeps what the node said', () => {
        expect(GLOBAL.decisions).toBe(false);
        expect(LOCAL.decisions).toBe(true);
        expect(readNodeProfile({ features: { decisions: 'no' } })!.features.decisions).toBeUndefined();
    });

    it('only a node that says outright it has none has none', () => {
        expect(decisionsOn(GLOBAL)).toBe(false);
        for (const [, f] of AS_BEFORE) expect(decisionsOn(f)).toBe(true);
    });
});

describe('the Commons screen shows the sections a node has', () => {
    it('everywhere as before but one list (pick 7): Decide and Groups, under the same title and words', () => {
        for (const [, f] of AS_BEFORE) {
            expect(commonsSections(f)).toEqual(['decide', 'groups']);
            expect(commonsHeading(f)).toEqual({
                title: 'Commons',
                description: 'Community decisions, the Commons, and your groups: projects, enterprises and more. Propose binding actions and vote on what matters.',
            });
            expect(commonsSectionFor(undefined, f)).toBe('decide');
            for (const s of ['decide', 'groups']) expect(commonsSectionFor(s, f)).toBe(s);
        }
    });

    it('a link to the old Enterprises section opens Groups, which holds them now', () => {
        for (const [, f] of AS_BEFORE) expect(commonsSectionFor('enterprises', f)).toBe('groups');
        expect(commonsSectionFor('enterprises', { ...LOCAL, decisions: false })).toBe('groups');
        expect(commonsSectionFor('enterprises', GLOBAL)).toBe('groups');
    });

    it('on the worldwide community: the groups list, and nothing else', () => {
        expect(commonsSections(GLOBAL)).toEqual(['groups']);
        expect(commonsHeading(GLOBAL)).toEqual({ title: 'Groups', description: 'Find a group to join, or start your own with +.' });
        for (const wanted of ['decide', 'enterprises', 'groups', '', undefined, null, 'junk']) {
            expect(commonsSectionFor(wanted, GLOBAL)).toBe('groups');
        }
    });

    it('one switch at a time: no Decide where Decisions are off, no projects or enterprises where enterprises are', () => {
        expect(commonsSections({ ...LOCAL, decisions: false })).toEqual(['groups']);
        expect(commonsSectionFor('decide', { ...LOCAL, decisions: false })).toBe('groups');
        expect(commonsHeading({ ...LOCAL, decisions: false }).description).not.toMatch(/decision|vote/i);
        expect(commonsHeading({ ...LOCAL, decisions: false }).description).toMatch(/Projects, enterprises/);
        expect(commonsSections({ ...GLOBAL, decisions: true })).toEqual(['decide', 'groups']);
        expect(commonsHeading({ ...GLOBAL, decisions: true }).title).toBe('Commons');
        expect(commonsHeading({ ...GLOBAL, decisions: true }).description).not.toMatch(/enterprise/i);
    });
});

describe('Groups is one list, with a kind chip each (pick 7)', () => {
    const group = (id: string, over: Partial<GroupItem> = {}) => ({ id, name: id, category: 'social', viewerStatus: null, ...over }) as unknown as GroupItem;
    const ent = (publicKey: string, over: { lifecycle?: string; goalAmount?: number | null } = {}) => ({ publicKey, ...over });
    const CHAT = [group('garden'), group('mine'), group('waiting', { viewerStatus: 'pending_approval' } as Partial<GroupItem>)];
    const ENTS = [ent('roof', { lifecycle: 'bounded', goalAmount: 500 }), ent('eggs', { lifecycle: 'ongoing' }), ent('kept', { lifecycle: 'ongoing' }), ent('shade', { goalAmount: 200 })];
    const YOURS = [{ kind: 'group', id: 'mine' }, { kind: 'enterprise', id: 'kept' }];
    const keys = (kind: GroupKind, f: NodeFeatures | null | undefined = LOCAL) => commonsGroupRows(kind, CHAT, ENTS, YOURS, f).map(r => r.key);

    it('the chips: All, Projects, Enterprises, Chat groups; none where the node lists no projects or enterprises', () => {
        for (const [, f] of AS_BEFORE) {
            expect(groupKindChips(f).map(c => c.label)).toEqual(['All', '🌱 Projects', '🏛️ Enterprises', '👥 Chat groups']);
        }
        expect(groupKindChips(GLOBAL)).toEqual([]);
        expect(groupKindChips({ ...LOCAL, enterprises: false })).toEqual([]);
    });

    it('All: chat groups you could join, then projects and enterprises you do not keep', () => {
        expect(keys('all')).toEqual(['group:garden', 'enterprise:roof', 'enterprise:eggs', 'enterprise:shade']);
    });

    it('each chip lists its kind only: a goal in Beans or a bounded lifecycle is a project', () => {
        expect(keys('projects')).toEqual(['enterprise:roof', 'enterprise:shade']);
        expect(keys('enterprises')).toEqual(['enterprise:eggs']);
        expect(keys('chat')).toEqual(['group:garden']);
    });

    it('where the node has no projects or enterprises: chat groups only, whatever the chip', () => {
        for (const kind of ['all', 'projects', 'enterprises', 'chat'] as const) {
            expect(keys(kind, GLOBAL)).toEqual(['group:garden']);
            expect(keys(kind, { ...LOCAL, enterprises: false })).toEqual(['group:garden']);
        }
    });

    it('the empty list offers the right start: a project or enterprise on those chips, otherwise a group', () => {
        expect(commonsGroupsEmpty('projects', LOCAL)).toMatchObject({ title: 'No projects to back yet', action: 'project' });
        expect(commonsGroupsEmpty('enterprises', LOCAL)).toMatchObject({ title: 'No enterprises to join yet', action: 'project' });
        expect(commonsGroupsEmpty('chat', LOCAL)).toMatchObject({ title: 'No other groups to join', action: 'group' });
        expect(commonsGroupsEmpty('all', LOCAL)).toMatchObject({ action: 'group' });
        for (const kind of ['all', 'projects', 'enterprises', 'chat'] as const) {
            expect(commonsGroupsEmpty(kind, GLOBAL)).toEqual({ title: 'No other groups to join', desc: 'Start one: a social circle, a working group, a guild.', action: 'group' });
        }
    });
});

describe('Talk → Find groups', () => {
    it('is offered only where the Commons tab is hidden', () => {
        expect(findGroupsInTalk(GLOBAL)).toBe(true);
        for (const [, f] of AS_BEFORE) expect(findGroupsInTalk(f)).toBe(false);
    });

    it('lands on the groups list, with no way into Decide', () => {
        expect(FIND_GROUPS_HREF).toEqual({ pathname: '/(tabs)/projects', params: { section: 'groups' } });
        expect(commonsSectionFor(FIND_GROUPS_HREF.params.section, GLOBAL)).toBe('groups');
        expect(commonsSections(GLOBAL)).not.toContain('decide');
        // On a local community the same link (the empty state's "Find a group to join") still lands on Groups.
        expect(commonsSectionFor(FIND_GROUPS_HREF.params.section, LOCAL)).toBe('groups');
    });
});

describe('the screens go through the helpers (source check)', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');

    /**
     * The JSX a `{cond && (` opens, from `from` on: from the line holding `open` to the first line after it that closes
     * it at the same indent. Throws if `open` is missing, so a check can't pass on an absent gate.
     */
    function block(src: string, open: string, from = 0): string {
        const lines = src.slice(from).split('\n');
        const i = lines.findIndex(l => l.includes(open));
        if (i < 0) throw new Error(`not found: ${open}`);
        const indent = lines[i].match(/^\s*/)![0];
        const end = lines.findIndex((l, j) => j > i && /^\s*\)}\s*$/.test(l) && l.match(/^\s*/)![0] === indent);
        if (end < 0) throw new Error(`no close for: ${open}`);
        return lines.slice(i, end + 1).join('\n');
    }

    it('Talk: "Find groups" beside "New group" where findGroupsInTalk says, and both links to FIND_GROUPS_HREF', () => {
        const src = read('app/(tabs)/chats.tsx');
        expect(src).toContain('const findGroups = findGroupsInTalk(nodeProfile?.features);');
        expect(src).toContain('{findGroups && <FindGroupsButton onPress={() => router.push(FIND_GROUPS_HREF)} />}');
        expect(src).toContain('onFindGroups={() => router.push(FIND_GROUPS_HREF)}');
        expect(src.split('<FindGroupsButton').length - 1).toBe(1);
        expect(src).not.toContain("params: { section: 'groups' }");
        expect(read('components/YourGroupsPane.tsx')).toContain('accessibilityLabel="Find groups"');
    });

    it('Commons: the section drawn is commonsSectionFor, and Decide, its pill and the propose form only where shown', () => {
        const src = read('app/(tabs)/projects.tsx');
        expect(src).toContain('const sections = commonsSections(reader.effective);');
        expect(src).toContain("const showsDecide = sections.includes('decide');");
        expect(src).toContain('const activeSection = commonsSectionFor(pickedSection, reader.effective);');
        expect(src).not.toMatch(/const \[activeSection,/);
        expect(src.split('<DecideSection').length - 1).toBe(1);
        expect(src.slice(src.lastIndexOf('\n', src.indexOf('<DecideSection')) - 60, src.indexOf('<DecideSection'))).toContain("{activeSection === 'decide' ? (");
        expect(block(src, '{showsDecide && (')).toContain('accessibilityLabel="Decide Section"');
        const modal = block(src, '{showsDecide && (', src.indexOf('{createGroup.modal}') - 800);
        expect(modal).toContain('<ProposeDecisionModal');
        expect(src.split('<ProposeDecisionModal').length - 1).toBe(1);
        // No Enterprises pill: Groups holds them (pick 7), with the kind chips from groupKindChips and the rows from
        // commonsGroupRows.
        expect(src).not.toContain('Enterprises Section');
        expect(block(src, '{sections.length > 1 && (')).toContain('accessibilityLabel="Groups Section"');
        expect(src).toContain('const kindChips = groupKindChips(reader.effective);');
        expect(src).toContain('return commonsGroupRows(groupKind, groups, sorted, yourGroups, reader.effective);');
        expect(src).toContain("data={activeSection === 'decide' ? [] : groupRows}");
        expect(src).toContain('const heading = commonsHeading(reader.effective);');
        expect(src).toContain('<PageTitle title={heading.title}');
    });

    it("the header's vote icon asks for votes only where the node has Decisions, and draws them by Home's rule (PR #1483 review 4166559525, opus-1767 N3)", () => {
        const src = read('components/NeedsYouIcons.tsx');
        // Home's own vote line, asked as Home asks it (lands=enterprise), so a keepers' vote shows and opens the enterprise.
        expect(src).toContain("decisionsOn(features) ? settle(signedGet(homePath(['needs'])).then(r => (r.ok ? r.json() : null))) : null,");
        expect(src).toContain('...mergeNeeds(votes, null, now, features)');
        expect(src).not.toContain('getDecisions(');
        // Home's rule for a vote's landing, the one its own lines follow (mergeNeeds): Decisions on, and Beans on.
        expect(read('utils/home-cards.ts')).toContain("export const decideOnNode = (features: HomeAnswer['features']): boolean => features.decisions !== false && features.beans !== false;");
    });

    it("the header's 🛡️ words are told whether the node has Decisions, so an emergency suspension isn't called a vote where there is none", () => {
        const src = read('components/NeedsYouIcons.tsx');
        expect(src).toContain('admin: admin?.admin ? { ...admin.admin, decisions: decisionsOn(features) } : null,');
        expect(read('utils/needs-you.ts')).toContain('label: adminLabel(adminItems, { decisions: i.admin?.decisions }),');
    });
});
