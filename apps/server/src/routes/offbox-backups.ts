/**
 * Off-box backups in Settings (services/offbox-backups.ts): what the server sends where, the destinations and schedule,
 * "send one now", and reading a destination back for a restore.
 *
 * An owner's, every one of them, reading included: the destinations are where the community's backups are kept, a
 * download is the whole community (locked), and the settings hold the keys to those stores. An admin or a moderator is
 * answered 403 in words. A secret is never sent back: the status shortens the key id and says only that a secret is set.
 */

import Router from '@koa/router';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import type { RouteDeps } from './types.js';
import { requireAdminRole } from '../admin-auth.js';
import {
    getOffboxStatus, listOffboxBackups, openOffboxBackup, runOffboxBackups, updateOffboxSettings,
} from '../services/offbox-backups.js';
import { OffboxS3Error } from '../services/offbox-s3.js';

export const OFFBOX_OWNER_ONLY = 'Only an owner of this node can see or change where its backups go off the box';

export function createOffboxBackupRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

    async function ownerOnly(ctx: any): Promise<boolean> {
        if (!(await checkAdminAuth(ctx))) return false;
        return requireAdminRole(ctx, ['owner'], OFFBOX_OWNER_ONLY);
    }

    const body = (ctx: any): Record<string, unknown> => {
        const b = ctx.requestBody;
        return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
    };

    /** A store's own words (which store, which S3 code); never a request, an answer's body or a credential. */
    function storeError(ctx: any, e: unknown): void {
        ctx.status = 502;
        ctx.body = { error: e instanceof OffboxS3Error ? e.message : `The store did not answer: ${String((e as Error)?.message || e).slice(0, 200)}` };
    }

    router.post('/api/local/admin/offbox-backups/status', async (ctx) => {
        if (!(await ownerOnly(ctx))) return;
        ctx.set('Cache-Control', 'no-store');
        ctx.body = getOffboxStatus();
    });

    // { intervalHours?, retentionDays?, destination?: { id?, name, endpoint, bucket, region, prefix, accessKeyId,
    // secretAccessKey? }, removeId? }. null for intervalHours or retentionDays goes back to .env's value or the default.
    router.post('/api/local/admin/offbox-backups/settings', async (ctx) => {
        if (!(await ownerOnly(ctx))) return;
        const b = body(ctx);
        const result = updateOffboxSettings({
            intervalHours: b.intervalHours, retentionDays: b.retentionDays,
            destination: b.destination as any, removeId: b.removeId,
        });
        if (!result.ok) {
            ctx.status = 400;
            ctx.body = { error: result.error };
            return;
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { success: true, status: getOffboxStatus() };
    });

    // Send one now to every destination, then prune. Answers at once; the status says when it is done.
    router.post('/api/local/admin/offbox-backups/run', async (ctx) => {
        if (!(await ownerOnly(ctx))) return;
        void runOffboxBackups({ force: true });
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { started: true, status: getOffboxStatus() };
    });

    // What one destination holds, newest first: { destination: id }.
    router.post('/api/local/admin/offbox-backups/list', async (ctx) => {
        if (!(await ownerOnly(ctx))) return;
        try {
            const listed = await listOffboxBackups(body(ctx).destination);
            if (!listed) {
                ctx.status = 404;
                ctx.body = { error: 'No usable destination with that id' };
                return;
            }
            ctx.set('Cache-Control', 'no-store');
            ctx.body = { destination: listed.destinationId, backups: listed.backups };
        } catch (e) {
            storeError(ctx, e);
        }
    });

    // One backup, to save and restore with the Restore wizard. GET so a browser can stream it; the credentials in a
    // header (X-Admin-Password or a key session), never the query string.
    router.get('/api/local/admin/offbox-backups/download', async (ctx) => {
        const headerPassword = ctx.request.header['x-admin-password'];
        if (headerPassword) (ctx as any).requestBody = { password: headerPassword };
        if (!(await ownerOnly(ctx))) return;
        let opened: Awaited<ReturnType<typeof openOffboxBackup>>;
        try {
            opened = await openOffboxBackup(ctx.query.destination, ctx.query.key);
        } catch (e) {
            storeError(ctx, e);
            return;
        }
        if (!opened) {
            ctx.status = 404;
            ctx.body = { error: 'No such backup in that destination' };
            return;
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.set('Content-Type', 'application/octet-stream');
        ctx.set('Content-Disposition', `attachment; filename="${opened.file}"`);
        if (opened.bytes !== null) ctx.set('Content-Length', String(opened.bytes));
        if (opened.sha256) ctx.set('X-Backup-Sha256', opened.sha256);
        // Checked on the way through against the hash it was uploaded with. The last piece is held back until the hash
        // is known, so a file the store gives back different breaks off short of its length: never a download that
        // looks whole.
        const hash = crypto.createHash('sha256');
        const expected = opened.sha256;
        let held: Buffer | null = null;
        const check = new Transform({
            transform(chunk: Buffer, _enc, cb) {
                hash.update(chunk);
                const out = held;
                held = chunk;
                cb(null, out ?? undefined);
            },
            flush(cb) {
                const got = hash.digest('hex');
                if (expected && got !== expected) cb(new Error(`the store gave back different bytes than were sent (${got.slice(0, 12)} ≠ ${expected.slice(0, 12)})`));
                else cb(null, held ?? undefined);
            },
        });
        const res = ctx.res;
        const store = opened.stream;
        store.on('error', (e) => check.destroy(e));
        check.on('error', (e) => {
            console.warn(`[Off-box] Download of ${opened!.file} ended early: ${e.message}`);
            // Once the first bytes have gone, Koa can no longer answer with an error, and `pipe` never ends its
            // destination when its source fails: the browser would wait for the rest of Content-Length for ever. So the
            // connection is cut, and the download fails where the owner can see it. Before then, Koa answers a 500.
            if (res.headersSent) res.destroy();
        });
        // The owner went away (or the download failed): stop reading from the store.
        check.on('close', () => { if (!store.destroyed) store.destroy(); });
        ctx.body = store.pipe(check);
    });

    return router;
}
