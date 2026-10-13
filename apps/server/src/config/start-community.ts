/**
 * Where "Start a community" leads (DESIGN-global-showcase-fable.md §5): the sheet every 🏘️ Local community marker opens
 * offers it first. node_config `startCommunityUrl`, a community setting (it travels to a standby with the others,
 * config/community-settings.ts). No row: START_COMMUNITY_URL_DEFAULT, beanpool.org's own page. A self-hoster names
 * their own page (an owner, POST /api/local/admin/start-community-url), so no part of the showcase needs our domain
 * (memory no-domain-lock-in). Reported on GET /api/community/info as `startCommunityUrl`.
 */
import { db } from '../db/db.js';
import { START_COMMUNITY_URL_DEFAULT } from '@beanpool/core';

export const START_COMMUNITY_URL_KEY = 'startCommunityUrl';
export const START_COMMUNITY_URL_MAX = 300;

/** A web address an app may open for a stranger: https, a host, no user name or password, at most 300 characters. Else null. */
export function cleanStartCommunityUrl(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s || s.length > START_COMMUNITY_URL_MAX || /\s/.test(s)) return null;
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
    return s;
}

/** The address Start a community opens on this node. A stored row that isn't one is ignored for the default. */
export function getStartCommunityUrl(): string {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(START_COMMUNITY_URL_KEY) as { value: string | null } | undefined;
    return cleanStartCommunityUrl(row?.value) ?? START_COMMUNITY_URL_DEFAULT;
}

/** Sets it; null, empty or the default removes the row, so the record holds only what an owner changed. */
export function setStartCommunityUrl(v: unknown): { ok: true; startCommunityUrl: string } | { ok: false } {
    const reset = v === null || v === '' || (typeof v === 'string' && v.trim() === START_COMMUNITY_URL_DEFAULT);
    if (reset) {
        db.prepare('DELETE FROM node_config WHERE key = ?').run(START_COMMUNITY_URL_KEY);
        return { ok: true, startCommunityUrl: START_COMMUNITY_URL_DEFAULT };
    }
    const url = cleanStartCommunityUrl(v);
    if (!url) return { ok: false };
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(START_COMMUNITY_URL_KEY, url);
    return { ok: true, startCommunityUrl: url };
}
