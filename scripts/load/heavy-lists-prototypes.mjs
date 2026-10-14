#!/usr/bin/env node
/**
 * MEASUREMENT ONLY (docs/global-heavy-lists.md, "The options, measured"). Patches the local, git-ignored build
 * (apps/server/dist) so each design option for the heavy lists can be measured on the real server with
 * scripts/load/heavy-lists.mjs. It is not the design's code and nothing here ships: `pnpm run build` in apps/server
 * restores dist. Every change is behind LOAD_PROTO, so the patched build answers exactly as main does without it.
 * It matches main's compiled text at 20b415f and refuses to patch anything else.
 *
 *   LOAD_PROTO=buffer   GET /api/members and the roster: the same body, sent as a Buffer instead of a string
 *   LOAD_PROTO=cache    one shared Buffer per (list, version, query) for up to 5 s, built once however many ask
 *   LOAD_PROTO=cap      at most LOAD_CAP (4) heavy answers in flight, from build to last byte; others wait in a queue of
 *                       LOAD_QUEUE (64) for up to LOAD_WAIT_MS (8000), else 503 with Retry-After
 *   LOAD_PROTO=stream   the directory streamed in 1,000-row chunks (keyset by rowid), with backpressure; the same bytes
 *   LOAD_PROTO=page     ?limit=&after= on the directory: one keyset page, {members, next}
 *
 * Run from the repo root after building the server: node scripts/load/heavy-lists-prototypes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/server/dist/routes');
const C = path.join(DIST, 'community.js');
const G = path.join(DIST, 'groups.js');

const gate = `
const __P = new Set((process.env.LOAD_PROTO || '').split(',').filter(Boolean));
const __heavy = globalThis.__heavyGate ??= { inFlight: 0, queue: [], cap: Number(process.env.LOAD_CAP || 4), qmax: Number(process.env.LOAD_QUEUE || 64), wait: Number(process.env.LOAD_WAIT_MS || 8000), cache: new Map() };
function __release() { __heavy.inFlight--; const next = __heavy.queue.shift(); if (next) next(); }
async function __admit(ctx) {
    if (!__P.has('cap')) return true;
    if (__heavy.inFlight >= __heavy.cap) {
        if (__heavy.queue.length >= __heavy.qmax) { ctx.status = 503; ctx.set('Retry-After', '10'); ctx.body = { error: 'busy', code: 'heavy_read_busy' }; return false; }
        const ok = await new Promise((resolve) => { const go = () => { clearTimeout(t); resolve(true); }; const t = setTimeout(() => { const i = __heavy.queue.indexOf(go); if (i >= 0) __heavy.queue.splice(i, 1); resolve(false); }, __heavy.wait); __heavy.queue.push(go); });
        if (!ok) { ctx.status = 503; ctx.set('Retry-After', '10'); ctx.body = { error: 'busy', code: 'heavy_read_busy' }; return false; }
    }
    __heavy.inFlight++;
    let done = false;
    ctx.res.once('close', () => { if (!done) { done = true; __release(); } });
    return true;
}
function __cached(key, build) {
    if (!__P.has('cache')) return build();
    const hit = __heavy.cache.get(key);
    if (hit && Date.now() - hit.at < 5000) return hit.body;
    const body = build();
    __heavy.cache.set(key, { at: Date.now(), body });
    if (__heavy.cache.size > 64) __heavy.cache.delete(__heavy.cache.keys().next().value);
    return body;
}
`;

let c = fs.readFileSync(C, 'utf8');
if (!c.includes('__heavyGate')) {
    c = c.replace(/(\nexport function|\nexport default function)/, `\n${gate}$1`);
    c = c.replace(`        const rows = getMemberDirectoryRows(ctx.query.updatedAfter || undefined)
            .filter(r => !r.public_key.startsWith('escrow_') && !r.public_key.startsWith('project_') && !r.is_treasury);`,
`        if (!(await __admit(ctx))) return;
        if (__P.has('stream') && !ctx.query.updatedAfter && !point) {
            const { Readable } = await import('node:stream');
            const roles = new Map(listNodeRoles().map(r => [r.member_pubkey, r.role]));
            const page = db.prepare("SELECT rowid AS __rowid, public_key, callsign, joined_at, avatar_ref, profile_updated_at, earned_credit, elder_vouched_by, archetype, is_treasury FROM members WHERE status != 'pruned' AND rowid > ? ORDER BY rowid LIMIT 1000");
            let after = -1, first = true;
            ctx.status = 200; ctx.type = 'application/json';
            ctx.body = new Readable({ read() {
                const rows = page.all(after);
                if (rows.length === 0) { this.push(first ? '[]' : ']'); this.push(null); return; }
                after = rows[rows.length - 1].__rowid;
                const items = rows.filter(r => !r.public_key.startsWith('escrow_') && !r.public_key.startsWith('project_') && !r.is_treasury).map(r => JSON.stringify({
                    publicKey: r.public_key, callsign: r.callsign, joinedAt: r.joined_at, nodeRole: roles.get(r.public_key) ?? null,
                    avatarUrl: avatarUrlOf(r.public_key, r.avatar_ref), profileUpdatedAt: r.profile_updated_at || null, earnedCredit: r.earned_credit ?? 0,
                    elderVouchedBy: r.elder_vouched_by || null, archetype: r.archetype || null }));
                if (items.length === 0) { this.push(Buffer.alloc(0)); return; }
                this.push(Buffer.from((first ? '[' : ',') + items.join(',')));
                first = false;
            } });
            return;
        }
        if (__P.has('page') && ctx.query.limit) {
            const lim = Math.min(Math.max(Number(ctx.query.limit) || 500, 1), 1000), after = Number(ctx.query.after) || -1;
            const roles = new Map(listNodeRoles().map(r => [r.member_pubkey, r.role]));
            const rows = db.prepare("SELECT rowid AS __rowid, public_key, callsign, joined_at, avatar_ref, profile_updated_at, earned_credit, elder_vouched_by, archetype, is_treasury FROM members WHERE status != 'pruned' AND rowid > ? ORDER BY rowid LIMIT ?").all(after, lim);
            const items = rows.filter(r => !r.public_key.startsWith('escrow_') && !r.public_key.startsWith('project_') && !r.is_treasury).map(r => ({
                publicKey: r.public_key, callsign: r.callsign, joinedAt: r.joined_at, nodeRole: roles.get(r.public_key) ?? null,
                avatarUrl: avatarUrlOf(r.public_key, r.avatar_ref), profileUpdatedAt: r.profile_updated_at || null, earnedCredit: r.earned_credit ?? 0,
                elderVouchedBy: r.elder_vouched_by || null, archetype: r.archetype || null }));
            ctx.status = 200; ctx.type = 'application/json';
            ctx.body = Buffer.from(JSON.stringify({ members: items, next: rows.length === lim ? String(rows[rows.length - 1].__rowid) : null }));
            return;
        }
        const __body = __cached('members' + etag, () => {
        const rows = getMemberDirectoryRows(ctx.query.updatedAfter || undefined)
            .filter(r => !r.public_key.startsWith('escrow_') && !r.public_key.startsWith('project_') && !r.is_treasury);`);
    const at = c.indexOf('const __body = __cached(\'members\' + etag');
    c = c.slice(0, at) + c.slice(at).replace(`        const bodyStr = JSON.stringify(point ? withAreaDistances(members, point.lat, point.lng) : members);
        ctx.status = 200;
        ctx.type = 'application/json';
        ctx.body = bodyStr;`,
`        const bodyStr = JSON.stringify(point ? withAreaDistances(members, point.lat, point.lng) : members);
        return __P.has('buffer') || __P.has('cache') ? Buffer.from(bodyStr) : bodyStr;
        });
        ctx.status = 200;
        ctx.type = 'application/json';
        ctx.body = __body;`);
    if (!c.includes('__admit(ctx)') || !c.includes('ctx.body = __body')) throw new Error('community.js patch did not apply');
    fs.writeFileSync(C, c);
}

let g = fs.readFileSync(G, 'utf8');
if (!g.includes('__heavyGate')) {
    g = g.replace(/(\nexport function)/, `\n${gate}$1`);
    g = g.replace(`        const members = getGroupMembers(ctx.params.id, { status: effectiveStatus, role });
        ctx.status = 200;
        ctx.body = members;`,
`        if (!(await __admit(ctx))) return;
        const __body = __cached(\`roster|\${ctx.params.id}|\${effectiveStatus}|\${role}|\${getGroupsVersion()}\`, () => {
            const members = getGroupMembers(ctx.params.id, { status: effectiveStatus, role });
            return __P.has('buffer') || __P.has('cache') ? Buffer.from(JSON.stringify(members)) : members;
        });
        ctx.status = 200;
        ctx.type = 'application/json';
        ctx.body = __body;`);
    if (!g.includes('__admit(ctx)')) throw new Error('groups.js patch did not apply');
    fs.writeFileSync(G, g);
}
console.log('patched (inert unless LOAD_PROTO is set)');
