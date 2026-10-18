// The Worker's entry (wrangler.toml `main`): the registrar itself (src/index.js: fetch and scheduled), and beside it the one
// entrypoint another Worker of ours may call, through a service binding only — never from the internet, since a named
// entrypoint has no route: ReplyTokens, for apps/feedback's reply page (https://beanpool.org/reply/<token>, design
// scratch/global-node/DESIGN-registrar-trust-fable.md §3.2). It checks a reply link and takes its one use; the feedback
// Worker never touches this Worker's database. Kept out of index.js because `cloudflare:workers` exists only in the
// Workers runtime: the tests run index.js in Node, and call checkReplyToken / redeemReplyToken there.

import { WorkerEntrypoint } from 'cloudflare:workers';
import registrar, { checkReplyToken, redeemReplyToken } from './index.js';

export default registrar;

export class ReplyTokens extends WorkerEntrypoint {
    // Does this reply link still work? { ok }: nothing about the name or the key.
    async check(token) {
        return checkReplyToken(this.env, token);
    }

    // The link's one use: { ok: true, name, notice_id } to the one call that took it, else { ok: false }. The admin's
    // alert of the reply is sent after the answer (waitUntil).
    async redeem(token) {
        const env = Object.assign(Object.create(this.env), { waitUntil: (p) => this.ctx.waitUntil(p) });
        return redeemReplyToken(env, token);
    }
}
