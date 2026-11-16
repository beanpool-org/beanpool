/**
 * One community, several addresses, slice S2 (design scratch/fable-design/DESIGN-several-addresses-fable.md §2.2, §2.3):
 * the two public reads every address answers (services/address-list.ts says what each signs).
 *
 *   GET /api/node/addresses                      → 200 { list, sig }: the signed list
 *                                                  404 no_address_list: no node key, no community, or no address to list
 *                                                  503 replaced: another server took over this community
 *   GET /api/node/proof?for=<address>&nonce=<hex> → 200 { peerId, for, nonce, epoch, seq, ts, sig }
 *                                                  400 bad_nonce, 421 not_listed, 503 replaced
 *
 * Public (https-server.ts PUBLIC_READ_EXACT): they carry nothing about anyone, and a phone asks them before it has an
 * account. Readable from any origin for GET and HEAD alone, no credential (https-server.ts PUBLIC_CORS_READS), so the web
 * app at one address can check another. Charged by the gateway as any request is. Never cached: a shared cache could hand
 * out a list after an owner removed an address, or one proof to two questions.
 */
import Router from '@koa/router';
import { ADDRESS_LIST_PATH, ADDRESS_PROOF_PATH } from '@beanpool/core';
import { addressProofFor, signedAddressList } from '../services/address-list.js';

export function createAddressListRoutes(): Router {
    const router = new Router();

    router.get(ADDRESS_LIST_PATH, async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const got = await signedAddressList();
        if (got.ok) {
            ctx.body = got.signed;
            return;
        }
        ctx.status = got.why === 'replaced' ? 503 : 404;
        ctx.body = { error: got.message, code: got.why === 'replaced' ? 'replaced' : 'no_address_list', ...(got.why === 'replaced' ? { readOnly: true } : {}) };
    });

    router.get(ADDRESS_PROOF_PATH, async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const got = await addressProofFor({ for: ctx.query.for, nonce: ctx.query.nonce });
        if (got.status === 200) {
            ctx.body = got.proof;
            return;
        }
        ctx.status = got.status;
        ctx.body = { error: got.error, code: got.code, ...(got.code === 'replaced' ? { readOnly: true } : {}) };
    });

    return router;
}
