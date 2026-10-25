import { describe, it, expect } from 'vitest';
import {
    GROUP_CATEGORY_OPTIONS,
    GROUP_JOIN_POLICY_OPTIONS,
    CREATE_GROUP_DEFAULTS,
    START_ENTERPRISE_BRIDGE,
} from '../group-options.js';

describe('group-options in @beanpool/core (decisions 4, 11, 14, §5 S2)', () => {
    it('lists Social Circle first, then General, Working Group, Guild: no Project Team (pick 7)', () => {
        expect(GROUP_CATEGORY_OPTIONS.map(c => c.label)).toEqual(['Social Circle', 'General', 'Working Group', 'Guild']);
        expect(GROUP_CATEGORY_OPTIONS.map(c => c.key)).toEqual(['social', 'general', 'working_group', 'guild']);
    });

    it('pre-selects Social Circle and an open group', () => {
        expect(CREATE_GROUP_DEFAULTS).toEqual({ category: 'social', joinPolicy: 'open' });
        expect(GROUP_CATEGORY_OPTIONS[0].key).toBe(CREATE_GROUP_DEFAULTS.category);
    });

    it('each category has its canonical emoji and description', () => {
        expect(GROUP_CATEGORY_OPTIONS[0]).toMatchObject({ key: 'social', emoji: '🌻', desc: 'Friends, neighbours, shared interests' });
        expect(GROUP_CATEGORY_OPTIONS[1]).toMatchObject({ key: 'general', emoji: '💬', desc: 'Open discussion space' });
        expect(GROUP_CATEGORY_OPTIONS[2]).toMatchObject({ key: 'working_group', emoji: '🤝', desc: 'Getting a practical job done together' });
        expect(GROUP_CATEGORY_OPTIONS[3]).toMatchObject({ key: 'guild', emoji: '🛡️', desc: 'People who share a skill or craft' });
    });

    it('offers the three join policies, open first', () => {
        expect(GROUP_JOIN_POLICY_OPTIONS.map(p => p.key)).toEqual(['open', 'request_to_join', 'invite_only']);
        expect(GROUP_JOIN_POLICY_OPTIONS.map(p => p.label)).toEqual(['Open', 'Request to Join', 'Invite Only']);
    });

    it('bridges to Start a project or an enterprise, neither of them a group category', () => {
        expect(START_ENTERPRISE_BRIDGE.route).toBe('/propose-project');
        expect(START_ENTERPRISE_BRIDGE.lead).toBe('🥖 With Beans involved?');
        expect(START_ENTERPRISE_BRIDGE.link).toBe('Start a project or an enterprise →');
        expect(GROUP_CATEGORY_OPTIONS.some(c => /enterprise|project/i.test(c.label) || c.key === 'project')).toBe(false);
    });
});
