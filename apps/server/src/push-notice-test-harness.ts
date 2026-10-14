/**
 * For suites that catch pushes where they leave for Expo.
 *
 * A push now carries only its kind's fixed words and a signed notice (@beanpool/core push-notice.ts). What the member is
 * told (who, which listing, how many beans, where a tap lands) is the notice's details, kept on their server
 * (engine/push-notices.ts) and read by their app with GET /api/notices/push/:id. So a suite's checks of who was told what
 * read the details, and every caught message is also held to the fixed words:
 *
 *   - `pushIsGeneric(m)`: its title and text are exactly its kind's, and its data is the notice and nothing else (beside
 *     the one hint old apps act on for an account recovery);
 *   - `toldPush(db, m)`: the message with `title`, `body` and `data` read from its notice's details, `kind` its kind, and
 *     `sent` the message exactly as it left.
 */
import { PUSH_NOTICE_TITLE, isPushNoticeKind, pushNoticeWords } from '@beanpool/core';

/** The keys a push's data may have: the notice's, and `kind` for the old apps' recovery tap only. */
const NOTICE_KEYS = new Set(['bp', 'k', 'i', 't', 'c', 's']);

export function pushIsGeneric(m: any): boolean {
    const d = m?.data;
    if (!d || typeof d !== 'object' || d.bp !== 1 || !isPushNoticeKind(d.k)) return false;
    if (m.title !== PUSH_NOTICE_TITLE || m.body !== pushNoticeWords(d.k).body) return false;
    return Object.keys(d).every(key => NOTICE_KEYS.has(key)
        || (key === 'kind' && d.k === 'account.recovery-started' && d.kind === 'recovery_started'));
}

export interface ToldPush {
    to: string;
    title: string;
    body: string;
    data: Record<string, any>;
    kind: string;
    channelId?: string;
    categoryId?: string;
    /** The message exactly as it left for Expo. */
    sent: any;
}

/**
 * A caught message as its member is told it: its notice's details in place of the fixed words. `db` is the suite's own
 * (imported after its environment is set), so this module imports nothing of the server's.
 */
export function toldPush(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, m: any): ToldPush {
    const row = db.prepare('SELECT title, body, data FROM push_notices WHERE id = ?').get(m?.data?.i) as
        { title: string; body: string; data: string } | undefined;
    let data: Record<string, any> = {};
    try { data = row ? JSON.parse(row.data) : {}; } catch { /* left empty */ }
    return { ...m, title: row?.title as string, body: row?.body as string, data, kind: m?.data?.k, sent: m };
}
