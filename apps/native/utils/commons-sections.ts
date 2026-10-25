/**
 * What the Commons screen ((tabs)/projects.tsx) shows on a node, and the way to its groups from Talk.
 *
 * A local community shows two sections: Decide and Groups. Groups is one list (group decisions pick 7, Marty
 * 2026-10-10): projects, enterprises and chat groups, with a kind chip each, as the web's Commons. A node that says
 * outright it has no formal Decisions (`features.decisions`, off on the worldwide community: anyone may join it with one
 * sign-in, so no vote there is safe from one person with several accounts) shows no Decide, and one with enterprises
 * off lists no projects or enterprises. Groups are on every node. With Groups the only section left, the screen is the
 * groups list, titled so, and with no switcher.
 *
 * Where Beans and Decisions are both off the Commons tab is hidden (node-profile.ts hiddenTabsFor), so Talk's Groups view offers
 * "Find groups", which opens this screen on Groups. Everywhere else the Commons tab is the way there, and Talk is as it
 * was.
 */

import { word, type WordKey } from '@beanpool/core';
import { decisionsOn, hiddenTabsFor, type NodeFeatures } from './node-profile';
import { groupsYouCouldJoin } from './your-groups';
import type { GroupItem } from './db';

export type CommonsSection = 'decide' | 'groups';

/** The sections this node shows, in the switcher's order. Groups always. A node that says nothing shows both. */
export function commonsSections(
    features: NodeFeatures | null | undefined,
    opts?: { decisionsPreview?: boolean },
): CommonsSection[] {
    const shown: CommonsSection[] = [];
    if (decisionsOn(features) || opts?.decisionsPreview) shown.push('decide');
    shown.push('groups');
    return shown;
}

/** Whether this node lists projects and enterprises among its groups. A node that says nothing does. None with Beans off. */
export function enterprisesOn(features: NodeFeatures | null | undefined): boolean {
    if (features?.beans === false) return false;
    return features?.enterprises !== false;
}

/**
 * The section to show for one that was asked for (a link's `section`, or the one open before the node's profile
 * arrived): itself where this node shows it, otherwise the first it does. Nothing asked is the first too. The old
 * Enterprises section is in Groups now, so a link asking for it opens Groups.
 */
export function commonsSectionFor(
    wanted: string | null | undefined,
    features: NodeFeatures | null | undefined,
    opts?: { decisionsPreview?: boolean },
): CommonsSection {
    const shown = commonsSections(features, opts);
    const asked = wanted === 'enterprises' ? 'groups' : wanted;
    return shown.includes(asked as CommonsSection) ? (asked as CommonsSection) : shown[0];
}

/** The screen's title and the line under it, for what this node shows: word() keys, shown through t(). */
export function commonsHeading(features: NodeFeatures | null | undefined): { title: WordKey; description: WordKey } {
    const decide = decisionsOn(features);
    const enterprises = enterprisesOn(features);
    const commons = word('Commons');
    if (decide && enterprises) {
        return { title: commons, description: word('Community decisions, the Commons, and your groups: projects, enterprises and more. Propose binding actions and vote on what matters.') };
    }
    if (decide) return { title: commons, description: word('Community decisions and groups. Propose binding actions and vote on what matters.') };
    if (enterprises) return { title: commons, description: word('Projects, enterprises, and groups to join or start.') };
    // A node that shows its switched-off features (the worldwide community's showcase) keeps the Commons heading over
    // Example Valley's pool, enterprise and Decision, drawn first, and the real groups under them (design §1 row 6).
    if (features?.showcase === true) {
        return { title: commons, description: word("A local community's Commons, from an example: a shared pool, enterprises and binding decisions. Under it, groups to join here, or start your own with +.") };
    }
    return { title: word('Groups'), description: word('Find a group to join, or start your own with +.') };
}

/** The kind chips over the Groups list. */
export type GroupKind = 'all' | 'projects' | 'enterprises' | 'chat';

/** The chips this node shows, in order (word() keys, shown through t()). None where it lists no projects or enterprises: every group is a chat group. */
export function groupKindChips(features: NodeFeatures | null | undefined): Array<{ key: GroupKind; label: WordKey }> {
    if (!enterprisesOn(features)) return [];
    return [
        { key: 'all', label: word('All') },
        { key: 'projects', label: word('🌱 Projects') },
        { key: 'enterprises', label: word('🏛️ Enterprises') },
        { key: 'chat', label: word('👥 Chat groups') },
    ];
}

/** A project or an enterprise, as the Groups list needs it: a goal in Beans, or a bounded lifecycle, makes a project. */
export interface CommonsEnterprise {
    publicKey: string;
    lifecycle?: string | null;
    goalAmount?: number | null;
}

/** Whether a project or enterprise is a project (the card's 🌱), by the rule the old Projects filter used. */
export const isProject = (e: CommonsEnterprise): boolean => e.lifecycle === 'bounded' || (e.goalAmount != null && e.goalAmount > 0);

export type CommonsGroupRow<E extends CommonsEnterprise = CommonsEnterprise> =
    | { kind: 'enterprise'; key: string; item: E }
    | { kind: 'group'; key: string; item: GroupItem };

/**
 * The rows of "Groups you could join" for a chip: chat groups first (none you're in, waiting on, or were removed from:
 * groupsYouCouldJoin), then projects and enterprises you don't keep. Where the node lists no projects or enterprises,
 * chat groups only, whatever the chip. Your own groups are in "Your groups" above the list.
 */
export function commonsGroupRows<E extends CommonsEnterprise>(
    kind: GroupKind,
    chatGroups: GroupItem[],
    enterprises: E[],
    yours: ReadonlyArray<{ kind: string; id: string }>,
    features: NodeFeatures | null | undefined,
): CommonsGroupRow<E>[] {
    const withEnterprises = enterprisesOn(features);
    const showChat = !withEnterprises || kind === 'all' || kind === 'chat';
    const mineChat = new Set(yours.filter(y => y.kind === 'group').map(y => y.id));
    const mineKept = new Set(yours.filter(y => y.kind === 'enterprise').map(y => y.id));
    const rows: CommonsGroupRow<E>[] = [];
    if (showChat) {
        for (const g of groupsYouCouldJoin(chatGroups, mineChat)) rows.push({ kind: 'group', key: `group:${g.id}`, item: g });
    }
    if (withEnterprises && kind !== 'chat') {
        for (const e of enterprises) {
            if (mineKept.has(e.publicKey)) continue;
            if (kind === 'projects' && !isProject(e)) continue;
            if (kind === 'enterprises' && isProject(e)) continue;
            rows.push({ kind: 'enterprise', key: `enterprise:${e.publicKey}`, item: e });
        }
    }
    return rows;
}

/** What the empty list says for a chip: word() keys, shown through t(). */
export function commonsGroupsEmpty(kind: GroupKind, features: NodeFeatures | null | undefined): { title: WordKey; desc: WordKey; action: 'group' | 'project' | 'enterprise' | null } {
    if (!enterprisesOn(features) || kind === 'chat') {
        return { title: word('No other groups to join'), desc: word('Start one: a social circle, a working group, a guild.'), action: 'group' };
    }
    if (kind === 'projects') return { title: word('No projects to back yet'), desc: word('Got an idea that needs Beans? Start a project.'), action: 'project' };
    if (kind === 'enterprises') return { title: word('No enterprises yet'), desc: word('Something that keeps going and trades? Start an enterprise.'), action: 'enterprise' };
    return { title: word('No others yet'), desc: word('Start one with +: a chat group, a project or an enterprise.'), action: null };
}

/** Whether Talk's Groups view offers "Find groups": only where the Commons tab, which has them, is hidden. */
export function findGroupsInTalk(features: NodeFeatures | null | undefined): boolean {
    return hiddenTabsFor(features).includes('projects');
}

/** Where "Find groups" and "Find a group to join" go: the Commons screen, on Groups (the route opens with the tab hidden). */
export const FIND_GROUPS_HREF = { pathname: '/(tabs)/projects', params: { section: 'groups' } } as const;
