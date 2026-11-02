/**
 * `GET /check`: the page an owner opens from outside, on a phone on mobile data, to see that the outside world reaches
 * the right server (design scratch/fable-design/DESIGN-dns-robustness-fable.md §5.3). The server's own round
 * (services/address-check.ts) looks from inside its own network; this is the look from anywhere else.
 *
 * Plain HTML in the reader's language (routes/community-card.ts cardLanguage), with no script, and nothing on it but the
 * community's name, the address, the server key's last characters and the time. Each is public already
 * (`/api/community/info`, `/api/attest`). Never cached: a kept copy would prove nothing.
 *
 * The address shown is the one the reader opened only when it is one of this community's names, never a Host header as
 * sent (engine/own-addresses.ts: the node's ports are reachable directly, so anyone can send any Host); otherwise its
 * main address, or none on a node that knows no name.
 */
import Router from '@koa/router';
import { ADDRESS_CHECK_WORDS, communityCardName, type Lang } from '@beanpool/core';
import { getLocalConfig } from '../config/local-config.js';
import { audienceStanding, normalizeAddress, primaryAddress } from '../engine/own-addresses.js';
import { isDefaultOrEmptyCommunityName } from '../services/directory-publisher.js';
import { serverKeyFingerprint } from '../services/address-check.js';
import { wordsIn } from '../member-words.js';
import { cardLanguage, cardStyle, escapeHtml as e, RTL } from './community-card.js';

export function renderCheckPage(facts: { name: string | null; host: string | null; key: string | null; time: string; lang: Lang | null }): string {
    const w = wordsIn(facts.lang);
    const W = ADDRESS_CHECK_WORDS;
    const lang = facts.lang ?? 'en';
    const name = communityCardName({ name: facts.name, host: facts.host }, w);
    const here = facts.host && facts.host !== name ? w.t(W.pageHereAt, { name, host: facts.host }) : w.t(W.pageHere, { name });
    return `<!doctype html>
<html lang="${e(lang)}"${RTL.has(lang) ? ' dir="rtl"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(name)}</title>
<style>${cardStyle()}</style>
</head>
<body>
<main>
<div class="card" data-testid="address-check">
<h1 dir="auto">${e(here)}</h1>
<ul class="facts">
${facts.key ? `<li data-fact="key">${e(w.t(W.pageKey, { key: facts.key }))}</li>\n` : ''}<li data-fact="time">${e(w.t(W.pageTime, { time: facts.time }))}</li>
</ul>
</div>
</main>
</body>
</html>`;
}

export function createCheckPageRoutes(): Router {
    const router = new Router();
    router.get('/check', async (ctx) => {
        const asked = normalizeAddress(ctx.host);
        const own = getLocalConfig().communityName;
        ctx.vary('Accept-Language');
        ctx.set('Cache-Control', 'no-store');
        ctx.type = 'html';
        ctx.body = renderCheckPage({
            name: isDefaultOrEmptyCommunityName(own) ? null : own!.trim(),
            host: asked && audienceStanding(asked) === 'own' ? asked : primaryAddress(),
            key: serverKeyFingerprint(),
            time: `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
            lang: cardLanguage(ctx),
        });
    });
    return router;
}
