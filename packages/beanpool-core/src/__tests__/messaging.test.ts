import { describe, it, expect } from 'vitest';
import { QUIET_SYSTEM_TYPES, COUNTS_AS_UNREAD_SQL, countsAsUnreadSql } from '../messaging.js';

describe('messaging unread count SQL predicates', () => {
    it('defines the quiet membership system types', () => {
        expect(QUIET_SYSTEM_TYPES).toEqual([
            'GROUP_MEMBER_JOINED',
            'GROUP_MEMBER_LEFT',
            'GROUP_MEMBER_REMOVED',
            'GROUP_ROLE_CHANGED',
        ]);
    });

    it('generates the predicate with default alias m', () => {
        expect(COUNTS_AS_UNREAD_SQL).toContain("NOT (COALESCE(m.type, '') = 'system' AND (");
        expect(COUNTS_AS_UNREAD_SQL).toContain("'GROUP_MEMBER_JOINED', 'GROUP_MEMBER_LEFT', 'GROUP_MEMBER_REMOVED', 'GROUP_ROLE_CHANGED'");
        expect(COUNTS_AS_UNREAD_SQL).toContain("COALESCE(CASE WHEN json_valid(m.metadata) THEN json_extract(m.metadata, '$.actorPubkey') END, '') = ?");
    });

    it('generates the predicate with a custom table alias', () => {
        const sql = countsAsUnreadSql('msg');
        expect(sql).toContain("NOT (COALESCE(msg.type, '') = 'system' AND (");
        expect(sql).toContain("COALESCE(CASE WHEN json_valid(msg.metadata) THEN json_extract(msg.metadata, '$.actorPubkey') END, '') = ?");
    });

    it('validates table alias to prevent invalid SQL identifiers', () => {
        expect(() => countsAsUnreadSql('invalid-alias')).toThrow(TypeError);
        expect(() => countsAsUnreadSql('')).toThrow(TypeError);
        expect(() => countsAsUnreadSql('m; DROP TABLE messages;')).toThrow(TypeError);
        expect(() => countsAsUnreadSql('123m')).toThrow(TypeError);
    });
});
