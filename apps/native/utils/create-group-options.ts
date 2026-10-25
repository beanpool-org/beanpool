/**
 * The one Create a Group form's choices and defaults (groups decisions 4, 11, 14, Fable 5.1 §4.2, §5 S2).
 * Core provides the pure table; native adds its icon names.
 */

import {
    GROUP_CATEGORY_OPTIONS,
    GROUP_JOIN_POLICY_OPTIONS as CORE_JOIN_POLICY_OPTIONS,
    CREATE_GROUP_DEFAULTS,
    START_ENTERPRISE_BRIDGE,
    type WordKey,
} from '@beanpool/core';
import type { JoinPolicy } from './db';

export {
    GROUP_CATEGORY_OPTIONS,
    CREATE_GROUP_DEFAULTS,
    START_ENTERPRISE_BRIDGE,
};

const JOIN_POLICY_ICONS: Record<JoinPolicy, string> = {
    open: 'door-open',
    request_to_join: 'account-clock',
    invite_only: 'lock',
};

export const GROUP_JOIN_POLICY_OPTIONS: ReadonlyArray<{ key: JoinPolicy; label: WordKey; icon: string; desc: WordKey }> =
    CORE_JOIN_POLICY_OPTIONS.map(opt => ({
        ...opt,
        icon: JOIN_POLICY_ICONS[opt.key as JoinPolicy],
    }));
