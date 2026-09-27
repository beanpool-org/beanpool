/**
 * What the Commons screen ((tabs)/projects.tsx) shows on a node, and the way to its groups from Talk.
 *
 * A local community shows all three sections, as it always has: Decide, Enterprises, Groups. A node that says outright
 * it has no formal Decisions (`features.decisions`, off on the worldwide community: anyone may join it with one
 * sign-in, so no vote there is safe from one person with several accounts) shows no Decide, and one with enterprises
 * off shows no Enterprises. Groups are on every node. With Groups the only section left, the screen is the groups list,
 * titled so, and with no switcher.
 *
 * Where Beans are off the Commons tab is hidden (node-profile.ts hiddenTabsFor), so Talk's Groups view offers
 * "Find groups", which opens this screen on Groups. Everywhere else the Commons tab is the way there, and Talk is as it
 * was.
 */

import { decisionsOn, hiddenTabsFor, type NodeFeatures } from './node-profile';

export type CommonsSection = 'decide' | 'enterprises' | 'groups';

/** The sections this node shows, in the switcher's order. Groups always. A node that says nothing shows all three. */
export function commonsSections(features: NodeFeatures | null | undefined): CommonsSection[] {
    const shown: CommonsSection[] = [];
    if (decisionsOn(features)) shown.push('decide');
    if (features?.enterprises !== false) shown.push('enterprises');
    shown.push('groups');
    return shown;
}

/**
 * The section to show for one that was asked for (a link's `section`, or the one open before the node's profile
 * arrived): itself where this node shows it, otherwise the first it does. Nothing asked is the first too.
 */
export function commonsSectionFor(wanted: string | null | undefined, features: NodeFeatures | null | undefined): CommonsSection {
    const shown = commonsSections(features);
    return shown.includes(wanted as CommonsSection) ? (wanted as CommonsSection) : shown[0];
}

/** The screen's title and the line under it, for the sections it shows. */
export function commonsHeading(sections: readonly CommonsSection[]): { title: string; description: string } {
    const decide = sections.includes('decide');
    const enterprises = sections.includes('enterprises');
    if (decide && enterprises) {
        return { title: 'Commons', description: 'Community decisions, pooled circulation, and shared enterprises. Propose binding actions and vote on what matters.' };
    }
    if (decide) return { title: 'Commons', description: 'Community decisions and groups. Propose binding actions and vote on what matters.' };
    if (enterprises) return { title: 'Commons', description: 'Shared enterprises, and groups to join or start.' };
    return { title: 'Groups', description: 'Find a group to join, or start your own with +.' };
}

/** Whether Talk's Groups view offers "Find groups": only where the Commons tab, which has them, is hidden. */
export function findGroupsInTalk(features: NodeFeatures | null | undefined): boolean {
    return hiddenTabsFor(features).includes('projects');
}

/** Where "Find groups" and "Find a group to join" go: the Commons screen, on Groups (the route opens with the tab hidden). */
export const FIND_GROUPS_HREF = { pathname: '/(tabs)/projects', params: { section: 'groups' } } as const;
