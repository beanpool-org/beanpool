/**
 * The one Create a Group form's choices and defaults (groups decisions 4, 11, 14). The same form, the same
 * defaults, from Commons and from Talk. Kept apart from the Modal so the order and defaults are unit tested.
 */

import type { GroupCategory, JoinPolicy } from './db';
import { GROUP_CATEGORY_EMOJI, GROUP_CATEGORY_WORDS } from './your-groups';

/** Decision 11: Social Circle (default, pre-selected) → General → Working Group → Project Team → Guild. */
export const GROUP_CATEGORY_OPTIONS: ReadonlyArray<{ key: GroupCategory; label: string; emoji: string; desc: string }> = [
    { key: 'social', label: GROUP_CATEGORY_WORDS.social, emoji: GROUP_CATEGORY_EMOJI.social, desc: 'Friends, neighbours, shared interests' },
    { key: 'general', label: GROUP_CATEGORY_WORDS.general, emoji: GROUP_CATEGORY_EMOJI.general, desc: 'Open discussion space' },
    { key: 'working_group', label: GROUP_CATEGORY_WORDS.working_group, emoji: GROUP_CATEGORY_EMOJI.working_group, desc: 'Getting a practical job done together' },
    { key: 'project', label: GROUP_CATEGORY_WORDS.project, emoji: GROUP_CATEGORY_EMOJI.project, desc: 'Collaborating on an initiative' },
    { key: 'guild', label: GROUP_CATEGORY_WORDS.guild, emoji: GROUP_CATEGORY_EMOJI.guild, desc: 'People who share a skill or craft' },
];

export const GROUP_JOIN_POLICY_OPTIONS: ReadonlyArray<{ key: JoinPolicy; label: string; icon: string; desc: string }> = [
    { key: 'open', label: 'Open', icon: 'door-open', desc: 'Anyone can join immediately' },
    { key: 'request_to_join', label: 'Request to Join', icon: 'account-clock', desc: 'Convenor approval required to join' },
    { key: 'invite_only', label: 'Invite Only', icon: 'lock', desc: 'Convenor must invite new members' },
];

export const CREATE_GROUP_DEFAULTS: Readonly<{ category: GroupCategory; joinPolicy: JoinPolicy }> = {
    category: GROUP_CATEGORY_OPTIONS[0].key,
    joinPolicy: 'open',
};

/** Decision 14: at the foot of the category list, the bridge for people who are really running something. */
export const START_ENTERPRISE_BRIDGE = {
    lead: '🥖 Running something together?',
    link: 'Start an enterprise →',
    route: '/propose-project',
} as const;
