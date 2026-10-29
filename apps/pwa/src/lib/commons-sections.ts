import { word, type WordKey } from '@beanpool/core';

export type GroupKind = 'all' | 'projects' | 'enterprises' | 'chat';

/** Whether this node lists projects and enterprises among its groups. A node that says nothing does. None with Beans off. */
export function enterprisesOn(features: { beans?: boolean; enterprises?: boolean } | null | undefined): boolean {
    if (features?.beans === false) return false;
    return features?.enterprises !== false;
}

/** The screen's title and description line, for what this node shows: word() keys, shown through t(). */
export function commonsHeading(features: { beans?: boolean; enterprises?: boolean; decisions?: boolean; showcase?: boolean } | null | undefined): { title: WordKey; description: WordKey } {
    const decide = features?.decisions !== false;
    const enterprises = enterprisesOn(features);
    const commons = word('Commons');
    if (decide && enterprises) {
        return { title: commons, description: word('What this community runs together: its pool, decisions, enterprises and groups.') };
    }
    if (decide) return { title: commons, description: word('What this community runs together: its decisions and groups.') };
    if (enterprises) return { title: commons, description: word('What this community runs together: its pool, enterprises and groups.') };
    if (features?.showcase === true) {
        return { title: commons, description: word("A local community's Commons, from an example: a shared pool, enterprises and binding decisions. Under it, groups to join here, or start your own with +.") };
    }
    return { title: word('Groups'), description: word('Groups to join here, or start your own with +.') };
}

/** The heading over the Find list for a chip: names the kinds shown, or groups only where enterprises are off. */
export function findHeading(kind: GroupKind, features: { beans?: boolean; enterprises?: boolean } | null | undefined): WordKey {
    if (!enterprisesOn(features) || kind === 'chat') return word('Groups you could join');
    if (kind === 'projects') return word('Projects to back');
    if (kind === 'enterprises') return word('Enterprises here');
    return word('Groups, projects and enterprises here');
}

/** The title over the empty Find list for a chip, as the phone's commonsGroupsEmpty says it: word() key, shown through t(). */
export function findEmptyTitle(kind: GroupKind, features: { beans?: boolean; enterprises?: boolean } | null | undefined): WordKey {
    if (!enterprisesOn(features) || kind === 'chat') return word('No other groups to join');
    if (kind === 'projects') return word('No projects to back yet');
    if (kind === 'enterprises') return word('No enterprises yet');
    return word('No others yet');
}

/** The line shown when Yours has no rows yet: word() key, shown through t(). */
export function yoursEmpty(features: { beans?: boolean; enterprises?: boolean } | null | undefined): WordKey {
    return enterprisesOn(features)
        ? word('Nothing of yours yet. Start something with +, or find one below.')
        : word('No groups of yours yet. Start one with +, or join one below.');
}
