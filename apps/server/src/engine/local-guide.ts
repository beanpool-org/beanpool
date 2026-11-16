/**
 * The Local guide badge (slice K8; scratch/fable-design/DESIGN-local-knowledge-fable.md §2.10, unchanged by the amendment):
 * a member with LOCAL_GUIDE_PAGES pages of Local knowledge showing now, each written by them (never gathered with the
 * assistant: `created_via` 'assistant-draft:…'), each "used" (helped by at least LOCAL_GUIDE_HELPED counted members, the
 * page's `knowledge_helped`, stamped at each tap). Worked out when read and stored nowhere: it goes when the pages go, or when
 * Learn is switched off here. It gates nothing and pays nothing. Shown on the trust profile (`badges`) and on the writer's
 * line of a page (`writerLocalGuide`, a member's signed read by id).
 */
import { LOCAL_GUIDE_BADGE, LOCAL_GUIDE_HELPED, LOCAL_GUIDE_PAGES } from '@beanpool/core';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';

/** Of these keys, the ones that are Local guides now. Learn off here: none. */
export function localGuidesAmong(keys: readonly string[]): Set<string> {
    const wanted = [...new Set(keys.filter((k) => typeof k === 'string' && k !== ''))];
    if (wanted.length === 0 || !getProfileSwitches().knowledge) return new Set();
    const rows = db.prepare(`
        SELECT author_pubkey AS writer FROM posts
        WHERE type = 'knowledge' AND active = 1 AND status = 'active'
          AND hidden_by_reports_at IS NULL AND removed_by_moderator_at IS NULL
          AND (created_via IS NULL OR created_via NOT LIKE 'assistant-draft:%')
          AND knowledge_helped >= ?
          AND author_pubkey IN (${wanted.map(() => '?').join(',')})
        GROUP BY author_pubkey HAVING COUNT(*) >= ?`).all(LOCAL_GUIDE_HELPED, ...wanted, LOCAL_GUIDE_PAGES) as { writer: string }[];
    return new Set(rows.map((r) => r.writer));
}

/** A member's badges, as the trust profile carries them: `['local-guide']` or `[]`. */
export function memberBadges(publicKey: string): string[] {
    return localGuidesAmong([publicKey]).has(publicKey) ? [LOCAL_GUIDE_BADGE] : [];
}

/**
 * Pages read by id, each with `writerLocalGuide` (routes/marketplace.ts, beside `helpedByMe`): whether its writer is a Local
 * guide now. A page gathered with the assistant carries none: it shows nobody's card.
 */
export function withWriterLocalGuide<T extends { authorPublicKey: string; knowledge?: { gathered: boolean } | null }>(posts: T[]): T[] {
    const writers = posts.filter((p) => p.knowledge && !p.knowledge.gathered).map((p) => p.authorPublicKey);
    if (writers.length === 0) return posts;
    const guides = localGuidesAmong(writers);
    return posts.map((p) => (p.knowledge && !p.knowledge.gathered ? { ...p, knowledge: { ...p.knowledge, writerLocalGuide: guides.has(p.authorPublicKey) } } : p));
}
