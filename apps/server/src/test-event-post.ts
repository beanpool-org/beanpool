/**
 * Integration & unit test for routes/event-post.ts
 *
 * Covers:
 *   1. `eventTimeAnswer(out)` helper with and without `eventTimeAdjusted`.
 *   2. `createEventFromBody(body, author, createdBy, beforeWrite, out)` creation logic, default fallbacks,
 *      callback execution, and refusal on forbidden fields (shopId, lendable, missing title/start date/pin).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-event-post.ts
 */

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { createEventFromBody, eventTimeAnswer } from './routes/event-post.js';
import { setMemberPhoto } from '@beanpool/engine';
import type { EventTimeOut } from './engine/posts.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ FAIL: ${msg}`);
    }
}

function assertThrows(fn: () => unknown, match: RegExp, msg: string): void {
    run++;
    try {
        fn();
        console.error(`✗ FAIL: ${msg} (nothing thrown)`);
    } catch (e: any) {
        if (match.test(e?.message ?? '')) {
            passed++;
            console.log(`✓ ${msg}`);
        } else {
            console.error(`✗ FAIL: ${msg} (got "${e?.message}")`);
        }
    }
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const HOUR = 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

function makeMember(callsign: string): string {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pub, callsign);
    setMemberPhoto(db, pub, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return pub;
}

async function main(): Promise<void> {
    initStateEngine();

    const host = makeMember('EventHost');

    // ── 1. eventTimeAnswer helper ─────────────────────────────────────────────────────────────
    console.log('\n--- 1. eventTimeAnswer ---');
    const emptyOut: EventTimeOut = {};
    assert(
        Object.keys(eventTimeAnswer(emptyOut)).length === 0,
        'eventTimeAnswer returns empty object when out.eventTimeAdjusted is undefined'
    );

    const adjustedOut: EventTimeOut = {
        eventTimeAdjusted: {
            start: {
                kind: 'gap',
                asked: inHours(24),
                saved: inHours(25),
            },
            end: null,
        },
    };
    const ans = eventTimeAnswer(adjustedOut);
    assert(
        ans.eventTimeAdjusted?.start?.kind === 'gap',
        'eventTimeAnswer returns eventTimeAdjusted when present in out'
    );

    // ── 2. createEventFromBody null/undefined body handling ──────────────────────────────────
    console.log('\n--- 2. createEventFromBody null / undefined body ---');
    assertThrows(
        () => createEventFromBody(null, host),
        /Title must be text/,
        'createEventFromBody safely handles null body and fails on missing title'
    );

    assertThrows(
        () => createEventFromBody({ title: 'T', lat: -28.55, lng: 153.5 }, host),
        /Start time must be a valid date/,
        'createEventFromBody with title and pin but no eventStartAt fails on missing start date'
    );

    // ── 3. createEventFromBody valid creation & options ─────────────────────────────────────
    console.log('\n--- 3. createEventFromBody valid creation ---');
    let beforeWriteCalled = false;
    const beforeWrite = () => {
        beforeWriteCalled = true;
    };
    const out: EventTimeOut = {};

    const validBody = {
        title: 'Community Garden Cleanup',
        description: 'Bring tools and gloves',
        lat: -28.55,
        lng: 153.5,
        eventStartAt: inHours(24),
        eventPlaceName: 'Park Entrance',
        reach: 'everywhere', // forced to local by engine
    };

    const created = createEventFromBody(validBody, host, undefined, beforeWrite, out);
    assert(created !== null && typeof created === 'object', 'event post created successfully');
    if (created) {
        assert(created.title === 'Community Garden Cleanup', 'event title matches body');
        assert(beforeWriteCalled, 'beforeWrite callback was executed');
        assert(created.eventPlaceName === 'Park Entrance', 'event place name matches');
    }

    // ── 4. createEventFromBody refusal on forbidden fields ───────────────────────────────────
    console.log('\n--- 4. createEventFromBody refusal on forbidden fields ---');
    assertThrows(
        () => createEventFromBody({ ...validBody, shopId: 'shop123' }, host),
        /shop_offers_only|shop/i,
        'createEventFromBody refuses an event with shopId'
    );

    assertThrows(
        () => createEventFromBody({ ...validBody, lendable: true }, host),
        /lend|offer/i,
        'createEventFromBody refuses an event marked lendable'
    );

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        process.exit(1);
    }
    process.exit(0);
}

main().catch((e) => {
    console.error('✗ Test failed with error:', e);
    process.exit(1);
});
