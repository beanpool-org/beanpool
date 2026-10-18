/**
 * The one Create a Group form's choices and defaults (groups decisions 4, 11, 14). The same form, the same
 * defaults, from Commons and from Talk. Kept apart from the Modal so the order and defaults are unit tested.
 */

import { word, type WordKey } from '@beanpool/core';
import type { GroupCategory, JoinPolicy } from './db';
import { GROUP_CATEGORY_EMOJI, GROUP_CATEGORY_WORDS } from './your-groups';

/**
 * Decision 11: Social Circle (default, pre-selected) → General → Working Group → Guild. No Project Team (pick 7).
 * Labels and descriptions are word() keys, shown through t() where the form draws them.
 */
export const GROUP_CATEGORY_OPTIONS: ReadonlyArray<{ key: GroupCategory; label: WordKey; emoji: string; desc: WordKey }> = [
    { key: 'social', label: GROUP_CATEGORY_WORDS.social, emoji: GROUP_CATEGORY_EMOJI.social, desc: word('Friends, neighbours, shared interests') },
    { key: 'general', label: GROUP_CATEGORY_WORDS.general, emoji: GROUP_CATEGORY_EMOJI.general, desc: word('Open discussion space') },
    { key: 'working_group', label: GROUP_CATEGORY_WORDS.working_group, emoji: GROUP_CATEGORY_EMOJI.working_group, desc: word('Getting a practical job done together') },
    { key: 'guild', label: GROUP_CATEGORY_WORDS.guild, emoji: GROUP_CATEGORY_EMOJI.guild, desc: word('People who share a skill or craft') },
];

export const GROUP_JOIN_POLICY_OPTIONS: ReadonlyArray<{ key: JoinPolicy; label: WordKey; icon: string; desc: WordKey }> = [
    { key: 'open', label: word('Open', 'join policy'), icon: 'door-open', desc: word('Anyone can join immediately') },
    { key: 'request_to_join', label: word('Request to Join', 'join policy'), icon: 'account-clock', desc: word('Convenor approval required to join') },
    { key: 'invite_only', label: word('Invite Only', 'join policy'), icon: 'lock', desc: word('Convenor must invite new members') },
];

export const CREATE_GROUP_DEFAULTS: Readonly<{ category: GroupCategory; joinPolicy: JoinPolicy }> = {
    category: GROUP_CATEGORY_OPTIONS[0].key,
    joinPolicy: 'open',
};

/** Decision 14: at the foot of the category list, the bridge for people who are really running something. */
export const START_ENTERPRISE_BRIDGE = {
    lead: word('🥖 With Beans involved?'),
    link: word('Start a project or an enterprise →'),
    route: '/propose-project',
} as const;
