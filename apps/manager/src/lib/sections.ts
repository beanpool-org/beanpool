import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The sub-tabs inside each single-node Settings section, for the phone menu and the top bar.
 *
 * The sections themselves stay listed in FleetSidebar's `singleNodeNavItems` (lib/manual.test.ts reads them from
 * there). The ids here are the sections' own `setSubTab('…')` ids; sections.test.ts checks the two agree, so a new
 * sub-tab cannot be missing from the phone menu.
 */
export type SettingsSection = 'home' | 'people' | 'economy' | 'bulletin' | 'appliance';

export const SECTION_SUB_TABS: Record<SettingsSection, { id: string; label: string }[]> = {
    home: [],
    people: [
        { id: 'directory', label: 'Members' },
        { id: 'invites', label: 'Invites & QR' },
        // Right after Invites & QR: invites lead into the funnel, so the two read in the order they happen.
        { id: 'funnel', label: 'Onboarding Funnel' },
        { id: 'moderation', label: 'Triage & Moderation' },
        { id: 'roles', label: 'Owners & admins' },
    ],
    economy: [
        { id: 'enterprises', label: 'Enterprises' },
        { id: 'decisions', label: 'Proposals' },
        { id: 'pool', label: 'Commons Pool' },
        { id: 'disputes', label: 'Escrow Disputes' },
    ],
    bulletin: [
        { id: 'announcements', label: 'Announcements' },
        { id: 'pulse', label: 'Pulse Channels' },
    ],
    appliance: [
        { id: 'diagnostics', label: 'Diagnostics & Logs' },
        { id: 'backups', label: 'Backups & Restore' },
        { id: 'gateway', label: 'Gateway & Peers' },
        { id: 'network', label: 'Public Address' },
        { id: 'identity', label: 'Node Identity' },
        { id: 'access', label: 'Access & Security' },
    ],
};

export function isSettingsSection(tab: string): tab is SettingsSection {
    return Object.prototype.hasOwnProperty.call(SECTION_SUB_TABS, tab);
}

/** The sub-tab a section opens on when none is named. */
export function defaultSubTab(tab: string): string | undefined {
    return isSettingsSection(tab) ? SECTION_SUB_TABS[tab][0]?.id : undefined;
}

export function subTabLabel(tab: string, sub: string | undefined): string | undefined {
    if (!isSettingsSection(tab)) return undefined;
    const id = sub ?? defaultSubTab(tab);
    return SECTION_SUB_TABS[tab].find(s => s.id === id)?.label;
}

/**
 * A section's current sub-tab. It follows `initial` when Settings navigates (the menu, Back, a hand-off link), and
 * tells Settings when the owner picks one, so Back returns to it and the top bar can name it.
 */
export function useSectionSubTab<T extends string>(initial: T, onChange?: (sub: T) => void): [T, (sub: T) => void] {
    const [value, setValue] = useState<T>(initial);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    useEffect(() => { setValue(initial); }, [initial]);
    const set = useCallback((sub: T) => {
        setValue(sub);
        onChangeRef.current?.(sub);
    }, []);
    return [value, set];
}
