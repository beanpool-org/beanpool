/**
 * A group chat's membership lines (joined, left, removed, role changed) are shown in the chat but never count
 * as unread — nobody should get a badge because someone joined. The server's group chat
 * (apps/server/src/engine/group-thread.ts, GroupSystemType) writes these kinds.
 */
export const QUIET_SYSTEM_TYPES: readonly string[] = [
    'GROUP_MEMBER_JOINED', 'GROUP_MEMBER_LEFT', 'GROUP_MEMBER_REMOVED', 'GROUP_ROLE_CHANGED',
];
const QUIET_SQL = QUIET_SYSTEM_TYPES.map(t => `'${t}'`).join(', ');

/**
 * SQL predicate on a messages table row (default table alias `m`): true when it counts toward the viewer's unread badge.
 * Not a membership line, and not a system line about something the viewer did themselves (their own event or poll landing
 * in a group chat). Takes ONE bound parameter: the viewer's pubkey.
 */
export function countsAsUnreadSql(tableAlias: string = 'm'): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableAlias)) {
        throw new TypeError(`Invalid SQL table alias: ${tableAlias}`);
    }
    return `NOT (COALESCE(${tableAlias}.type, '') = 'system' AND (
    COALESCE(${tableAlias}.system_type, '') IN (${QUIET_SQL})
    OR COALESCE(CASE WHEN json_valid(${tableAlias}.metadata) THEN json_extract(${tableAlias}.metadata, '$.actorPubkey') END, '') = ?
))`;
}

export const COUNTS_AS_UNREAD_SQL = countsAsUnreadSql('m');
