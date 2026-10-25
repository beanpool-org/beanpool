/**
 * The one Create a Group form's choices and defaults (groups decisions 4, 11, 14, Fable 5.1 §4.2, §5 S2).
 * One table for both apps.
 */

import { word, type WordKey } from './words.js';
import type { GroupCategory, JoinPolicy } from './groups.js';

export interface GroupCategoryOption {
    key: GroupCategory;
    label: WordKey;
    emoji: string;
    desc: WordKey;
}

/**
 * Decision 11: Social Circle (default, pre-selected) → General → Working Group → Guild. No Project Team (pick 7).
 * Labels and descriptions are word() keys, shown through t() where the form draws them.
 */
export const GROUP_CATEGORY_OPTIONS: ReadonlyArray<GroupCategoryOption> = [
    { key: 'social', label: word('Social Circle'), emoji: '🌻', desc: word('Friends, neighbours, shared interests') },
    { key: 'general', label: word('General'), emoji: '💬', desc: word('Open discussion space') },
    { key: 'working_group', label: word('Working Group'), emoji: '🤝', desc: word('Getting a practical job done together') },
    { key: 'guild', label: word('Guild'), emoji: '🛡️', desc: word('People who share a skill or craft') },
];

export interface GroupJoinPolicyOption {
    key: JoinPolicy;
    label: WordKey;
    desc: WordKey;
}

export const GROUP_JOIN_POLICY_OPTIONS: ReadonlyArray<GroupJoinPolicyOption> = [
    { key: 'open', label: word('Open', 'join policy'), desc: word('Anyone can join immediately') },
    { key: 'request_to_join', label: word('Request to Join', 'join policy'), desc: word('Convenor approval required to join') },
    { key: 'invite_only', label: word('Invite Only', 'join policy'), desc: word('Convenor must invite new members') },
];

export const CREATE_GROUP_DEFAULTS: Readonly<{ category: GroupCategory; joinPolicy: JoinPolicy }> = {
    category: 'social',
    joinPolicy: 'open',
};

/** Decision 14: at the foot of the category list, the bridge for people who are really running something. */
export const START_ENTERPRISE_BRIDGE = {
    lead: word('🥖 With Beans involved?'),
    link: word('Start a project or an enterprise →'),
    route: '/propose-project',
} as const;
