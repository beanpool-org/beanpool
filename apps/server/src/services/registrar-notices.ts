/**
 * Notices from the address service (registrar slice S2, scratch/global-node/DESIGN-registrar-trust-fable.md §3.2): the
 * BeanPool project writes to a name's operators from its control room, and this server hears it on its own check-in —
 * the signed /status the public-address agent, the tunnel and Settings already ask (services/registrar-client.ts
 * addressStatus). Each new notice is kept here (local-config `registrarNotices`, the latest KEEP), shown in Settings under
 * Public address, and told to the owners once: one `reg.notice` alert per notice id, in the server's own words (never the
 * notice's: those stay in Settings). The highest id this server has had goes back on the next /status as `seen`, and the
 * address service never carries those again.
 *
 * A convenience, never a dependency (no-domain-lock-in): a server whose address service sends none, or an older one,
 * loses nothing. Only the main server takes them: a standby asking /status with the same key would otherwise take its
 * main server's notices, and its owners would never see them there.
 */

import { getLocalConfig, updateLocalConfig, type LocalConfig } from '../config/local-config.js';
import { getNodeRole } from '../config/node-role.js';
import { noteSecurityEvent, REGISTRAR_NOTICE_WORDS } from './security-signal.js';

export type RegistrarNotice = NonNullable<LocalConfig['registrarNotices']>[number];

/** How many notices Settings keeps: the newest. */
export const KEEP = 20;
/** At most this many characters, as the address service sends at most. */
export const NOTICE_TEXT_MAX = 500;
const LEVELS = ['info', 'warning', 'action'] as const;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const REPLY_PATH = /^\/reply\/[A-Za-z0-9_-]{43}$/;
// Control characters but the line break, and the ones that hide or reorder text: the address service refuses them, so a
// notice holding one is not shown.
const range = (a: number, b: number) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`;
const UNSAFE = new RegExp(`[${range(0x00, 0x09)}${range(0x0b, 0x1f)}${range(0x7f, 0x9f)}${range(0x2028, 0x2029)}${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}]`, 'u');

/** The highest notice id this server has had, for /status's `seen`; 0 on a standby, which takes none. */
export function noticeSeenMark(): number {
    if (getNodeRole() !== 'primary') return 0;
    const n = Number(getLocalConfig().registrarNoticeSeen);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** Settings' list: the notices kept, newest first. */
export function registrarNotices(): RegistrarNotice[] {
    const list = getLocalConfig().registrarNotices;
    return Array.isArray(list) ? list.map((n) => ({ ...n })) : [];
}

/**
 * A reply link Settings may show: only on the address service's own site (`registrarBase`, the address this server asks),
 * at /reply/<token>. Any other is dropped, whatever the notice says.
 */
function replyLink(v: unknown, registrarBase: string): string | null {
    if (typeof v !== 'string' || v.length > 300) return null;
    try {
        const u = new URL(v);
        const base = new URL(registrarBase);
        return u.origin === base.origin && REPLY_PATH.test(u.pathname) && !u.search && !u.hash && !u.username && !u.password ? u.href : null;
    } catch {
        return null;
    }
}

/** A notice as it came, kept only when whole: a number, a time, words this server can show safely, the name it is about. */
function noticeOf(raw: any, registrarBase: string, now: number): RegistrarNotice | null {
    const at = raw?.at;
    if (!Number.isSafeInteger(at) || at <= 0) return null;
    if (typeof raw.text !== 'string' || typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) return null;
    const text = raw.text.replace(/\r\n?/g, '\n').trim();
    if (!text || UNSAFE.test(text) || [...text].length > NOTICE_TEXT_MAX) return null;
    const level = (LEVELS as readonly string[]).includes(raw.level) ? raw.level as RegistrarNotice['level'] : 'info';
    return { id: raw.id, at, level, text, name: raw.name, link: replyLink(raw.link, registrarBase), receivedAt: now };
}

/**
 * The notices a /status answer carried (`list`, its `notices`), from the address service at `registrarBase`: each one this
 * server has not had is kept and told to its owners, once; one it has is not told again (a /status whose answer came
 * before this server's `seen` reached the service carries it again). One that is not whole is not kept, but its id still
 * counts as had, so the service stops carrying it. Answers the ids told. Synchronous from read to write, so two answers
 * at once never tell one notice twice. Never throws.
 */
export function takeRegistrarNotices(list: unknown, registrarBase: string, now = Date.now()): number[] {
    try {
        if (!Array.isArray(list) || !list.length || getNodeRole() !== 'primary') return [];
        const config = getLocalConfig();
        const stored = Array.isArray(config.registrarNotices) ? config.registrarNotices.map((n) => ({ ...n })) : [];
        const had = new Map(stored.map((n) => [n.id, n]));
        const before = noticeSeenMark();
        let seen = before;
        let changed = false;
        const fresh: RegistrarNotice[] = [];
        for (const raw of list.slice(0, KEEP)) {
            const id = (raw as any)?.id;
            if (!Number.isSafeInteger(id) || id <= 0) continue;
            seen = Math.max(seen, id);
            const kept = had.get(id);
            if (kept) {
                // Carried again: told already. Its link, if the first carry came without one (another check-in made it).
                const link = kept.link ? null : replyLink((raw as any).link, registrarBase);
                if (link) { kept.link = link; changed = true; }
                continue;
            }
            const n = noticeOf(raw, registrarBase, now);
            if (!n) {
                console.warn(`[PublicAddr] a notice from the address service (#${id}) could not be shown safely, and was not kept`);
                continue;
            }
            had.set(id, n);
            fresh.push(n);
        }
        if (!fresh.length && !changed && seen === before) return [];
        const keep = [...fresh, ...stored].sort((a, b) => b.id - a.id).slice(0, KEEP);
        updateLocalConfig({ registrarNotices: keep, registrarNoticeSeen: seen });
        for (const n of fresh.sort((a, b) => a.id - b.id)) {
            console.log(`[PublicAddr] 📨 a ${n.level} notice from the address service (#${n.id}): Settings → Public address shows it`);
            noteSecurityEvent({
                key: 'reg.notice', detail: REGISTRAR_NOTICE_WORDS[n.level], priority: n.level === 'info' ? 3 : 4,
                actor: 'address-service', actorRole: 'address service', foldAs: REGISTRAR_NOTICE_WORDS.more,
            });
        }
        return fresh.map((n) => n.id);
    } catch (e) {
        console.warn('[PublicAddr] notices from the address service not taken:', (e as Error).message);
        return [];
    }
}
