import { describe, expect, it } from 'vitest';
import { findEmptyTitle } from './commons-sections';

// The web twin of the phone's commonsGroupsEmpty titles (apps/native/utils/commons-sections.ts): same words on both apps.
describe('findEmptyTitle: the title over the empty Find list, by chip', () => {
    const LOCAL = { beans: true, enterprises: true };

    it('names what the chip lists, never another kind', () => {
        expect(findEmptyTitle('all', LOCAL)).toBe('No others yet');
        expect(findEmptyTitle('projects', LOCAL)).toBe('No projects to back yet');
        expect(findEmptyTitle('enterprises', LOCAL)).toBe('No enterprises yet');
    });

    it('a node that says nothing lists enterprises, so the same titles', () => {
        expect(findEmptyTitle('projects', null)).toBe('No projects to back yet');
        expect(findEmptyTitle('all', undefined)).toBe('No others yet');
    });

    it('chat groups, or enterprises off or Beans off: groups only', () => {
        expect(findEmptyTitle('chat', LOCAL)).toBe('No other groups to join');
        expect(findEmptyTitle('all', { beans: true, enterprises: false })).toBe('No other groups to join');
        expect(findEmptyTitle('projects', { beans: false })).toBe('No other groups to join');
    });
});
