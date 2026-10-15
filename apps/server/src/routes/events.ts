/**
 * "Your events" and per-event reminders (docs/events-on-the-map.md §2.2).
 *
 *   GET /api/events/mine                  — the signer's own RSVPs, soonest first
 *   PUT /api/events/:postId/reminder      — the signer's reminders for one event
 *
 * Both are the SIGNER's and nobody else's. The member is `ctx.state.actor`, which only the signature
 * middleware sets, and never a field in the body or the query — the same rule the RSVP route already keeps
 * ("nobody RSVPs for someone else"), and the reason there is no `publicKey` parameter here to get wrong.
 *
 * The per-event write additionally needs an RSVP: a reminder for an event you have not said you are going
 * to is not a thing, and the check is 403 rather than 404 because whether the event exists is not a secret.
 */

import Router from '@koa/router';
import {
    listMyEvents, setEventReminderOffsets, parseReminderOffsets,
    NO_RSVP_MESSAGE, BAD_OFFSETS_MESSAGE,
} from '../state-engine.js';
import type { RouteDeps } from './types.js';

export function createEventsRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    /**
     * GET /api/events/mine
     *
     * NOT on the public-read allowlist and not meant to be: it is one member's calendar. When
     * ENFORCE_READ_AUTH is off the middleware lets an unsigned GET through with no actor, so the 401 below
     * is the gate in that case, not a formality.
     */
    router.get('/api/events/mine', async (ctx) => {
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'A signed request is required' };
            return;
        }
        ctx.body = { events: listMyEvents(actor) };
    });

    /**
     * PUT /api/events/:postId/reminder   body `{ offsets: number[] | null }`
     *
     * `null` puts the event back on the member's Settings default; `[]` turns reminders off for this one.
     * An offset outside the five the picker offers is a 400 — the set is closed on purpose, so a client
     * bug shows up here rather than as a reminder nobody expected.
     */
    router.put('/api/events/:postId/reminder', async (ctx) => {
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'A signed request is required' };
            return;
        }
        const body = (ctx as any).requestBody || {};
        if (!Object.prototype.hasOwnProperty.call(body, 'offsets')) {
            ctx.status = 400;
            ctx.body = { error: 'offsets is required — an array of minutes, or null for your default' };
            return;
        }
        let offsets: number[] | null;
        try {
            offsets = parseReminderOffsets(body.offsets);
        } catch {
            ctx.status = 400;
            ctx.body = { error: BAD_OFFSETS_MESSAGE };
            return;
        }
        try {
            const saved = setEventReminderOffsets(ctx.params.postId, actor, offsets);
            ctx.body = { success: true, reminderOffsets: saved.offsets };
        } catch (e: any) {
            const msg = e?.message || 'Could not save that reminder';
            ctx.status = msg === NO_RSVP_MESSAGE ? 403 : 400;
            ctx.body = { error: msg };
        }
    });

    return router;
}
