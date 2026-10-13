import { describe, it, expect } from 'vitest';
import { GROUP_CATEGORY_OPTIONS, GROUP_JOIN_POLICY_OPTIONS, CREATE_GROUP_DEFAULTS, START_ENTERPRISE_BRIDGE } from '../create-group-options';
import { chatEmoji } from '../your-groups';

describe('the one Create a Group form (decisions 4, 11, 14)', () => {
    it('lists Social Circle first, then General, Working Group, Guild: no Project Team (pick 7)', () => {
        expect(GROUP_CATEGORY_OPTIONS.map(c => c.label)).toEqual(['Social Circle', 'General', 'Working Group', 'Guild']);
    });

    it('pre-selects Social Circle and an open group', () => {
        expect(CREATE_GROUP_DEFAULTS).toEqual({ category: 'social', joinPolicy: 'open' });
        expect(GROUP_CATEGORY_OPTIONS[0].key).toBe(CREATE_GROUP_DEFAULTS.category);
    });

    it('shows each category with the emoji its chat header will carry', () => {
        for (const c of GROUP_CATEGORY_OPTIONS) expect(c.emoji).toBe(chatEmoji('group', c.key));
    });

    it('offers the three join policies, open first', () => {
        expect(GROUP_JOIN_POLICY_OPTIONS.map(p => p.key)).toEqual(['open', 'request_to_join', 'invite_only']);
    });

    it('bridges to Start a project or an enterprise, neither of them a group category', () => {
        expect(START_ENTERPRISE_BRIDGE.route).toBe('/propose-project');
        expect(START_ENTERPRISE_BRIDGE.link).toMatch(/Start a project or an enterprise/);
        expect(GROUP_CATEGORY_OPTIONS.some(c => /enterprise|project/i.test(c.label) || c.key === 'project')).toBe(false);
    });
});
