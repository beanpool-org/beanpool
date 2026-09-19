/**
 * The operator manual ("how to run your community"), shown inside Settings.
 *
 * One source: packages/beanpool-guide/operators/*.md. Its build writes generated/operators.json, bundled here, and
 * the same bytes to beanpool.org/guide/operators/operators.json. Settings shows only the bundled copy and never
 * fetches a newer one: the manual on a server describes the version that server runs.
 *
 * It is the same block model as the members' guide, so the checks, search and bold-splitting in @beanpool/core's
 * member-guide.ts apply unchanged.
 */
import { validateGuide, type Guide, type GuidePage } from '@beanpool/core';
// A relative path, not a package import: @beanpool/guide is not a dependency of the manager, and the undeclared-imports
// guard (scripts/check-undeclared-imports.mjs) rejects a bare import of it.
import bundledManual from '../../../../packages/beanpool-guide/generated/operators.json';

/** The bundled manual. Built from checked source, so it always validates; a broken build fails the tests. */
export const OPERATOR_MANUAL: Guide = validateGuide(bundledManual) as Guide;

/** Where the website keeps the same manual, for the "Also at" line. */
export const OPERATOR_MANUAL_WEB_URL = 'https://beanpool.org/guide/operators/';

/**
 * Every Settings screen and the manual page its "?" opens. A screen is a section tab, or a section tab and one of
 * its sub-tabs. The manager test checks that every page named here exists and that every sub-tab has an entry.
 */
export const SCREEN_HELP = {
    login: 'signing-in',
    'cold-start': 'first-time-setup',
    home: 'the-settings-screens',
    'people/directory': 'members-and-invites',
    'people/invites': 'members-and-invites',
    'people/moderation': 'reports-and-takedowns',
    'people/roles': 'roles',
    'member-detail': 'roles',
    'economy/enterprises': 'enterprises-and-keepers',
    'economy/decisions': 'decisions-and-emergencies',
    'economy/pool': 'enterprises-and-keepers',
    'economy/disputes': 'disputes',
    'bulletin/announcements': 'pulse-and-announcements',
    'bulletin/pulse': 'pulse-and-announcements',
    'appliance/diagnostics': 'updates-and-health',
    'appliance/backups': 'backups-and-replicas',
    'appliance/gateway': 'address-and-peers',
    'appliance/network': 'address-and-peers',
    'appliance/identity': 'address-and-peers',
    'appliance/access': 'access-and-security',
} as const;

export type HelpScreen = keyof typeof SCREEN_HELP;

export function manualPage(slug: string): GuidePage | null {
    return OPERATOR_MANUAL?.guides.find(g => g.slug === slug) ?? null;
}

export function helpPageFor(screen: HelpScreen): GuidePage | null {
    return manualPage(SCREEN_HELP[screen]);
}
