/**
 * What a pasted invite says, for both apps' invite step: its code, and the community it is for.
 *
 * A friend pastes whatever they were sent: the link alone, the code alone, or the whole message a member's Share sends
 * (invite-share-text.ts: the link, then "install BeanPool from beanpool.org and paste this code: INV-…", then
 * "Community address: byron.beanpool.org"), often with only part of it selected. Each part is read on its own, so any of
 * them is enough, and the message's other words never end up in the code field (9 Nov: a whole message pasted put
 * everything after `invite=` in the code box).
 */

/** The website's own names: the message says "install BeanPool from beanpool.org", which is no community. */
const WEBSITE_HOSTS: ReadonlySet<string> = new Set(['beanpool.org', 'www.beanpool.org']);

/** A standard code (`INV-` and two groups of 4) or an offline ticket's short form, standing alone as a word. */
const CODE_IN_TEXT = /(?:^|[^A-Za-z0-9-])((?:INV|BP)-[A-Za-z0-9]{4}-[A-Za-z0-9]{4})(?![A-Za-z0-9-])/i;

/** A host and its port, if any: `byron.beanpool.org`, `bp.example.net:8443`. */
const HOST = String.raw`(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?::\d{1,5})?`;

/**
 * A bare host standing alone: after any character that can't be part of a host (a space, a full-width colon as in the
 * ja/zh messages' "アドレス：", a bracket; never a dot, `/` or `@`), and never cut short. The host is read whole once
 * (a lookahead captured and matched again, as an atomic group), then refused if it runs on, so "byron.beanpool.org/"
 * or "…org。" is the whole host and never the "byron.beanpool" a backtrack would leave (review 4507903022).
 */
const BARE_HOST = new RegExp(String.raw`(?:^|[^A-Za-z0-9.\-/@])(?=(${HOST}))\1(?![A-Za-z0-9-]|\.[A-Za-z0-9]|:\d)`, 'g');

/**
 * The invite code in `raw`, as written, or null when it holds none. An `invite=` in a link first (it may be a long
 * offline ticket), read up to the first space, `&` or `#`, so the words after a link in a message are never part of it;
 * else the first `INV-xxxx-xxxx` / `BP-xxxx-xxxx` anywhere; else a whole paste that is one long `BP-` ticket.
 */
export function inviteCodeIn(raw: string): string | null {
    const text = String(raw ?? '');
    const param = /[?&]invite=([^&\s#]+)/.exec(text);
    if (param) {
        try {
            return decodeURIComponent(param[1]);
        } catch {
            return param[1];
        }
    }
    const code = CODE_IN_TEXT.exec(text);
    if (code) return code[1];
    const whole = text.trim();
    if (/^BP-\S{21,}$/.test(whole)) return whole;
    return null;
}

/**
 * The community address a message names WITHOUT a scheme (the share's last line, "Community address: byron.beanpool.org"),
 * as `host[:port]` in lower case, or null. The last one wins, as the share puts the community's address last; the
 * website's name (beanpool.org) is never one. A link with a scheme is the caller's to read first (both apps' own parsers
 * check that its address is plain); this is for a paste that has no link in it.
 */
export function communityAddressIn(raw: string): string | null {
    const text = String(raw ?? '');
    let found: string | null = null;
    for (const m of text.matchAll(BARE_HOST)) {
        const host = m[1].toLowerCase();
        if (WEBSITE_HOSTS.has(host.replace(/:\d+$/, ''))) continue;
        // A host inside a link (`https://a.b/…`) is the link's: the caller reads links with their own parser.
        const before = text.slice(0, (m.index ?? 0) + m[0].length - m[1].length);
        if (/[a-z]+:\/\/\S*$/i.test(before)) continue;
        found = host;
    }
    return found;
}
