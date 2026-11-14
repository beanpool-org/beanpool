import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EVENT_TYPES_QUERY, POST_TYPES_WITH_EVENTS, SYNC_TYPES_QUERY } from '../events';
import { NEW_POST_TYPES } from '../compose-options';
import { MARKET_TYPE_PILLS } from '../market-filters';

// Learn is its own place, not a Market pill (DESIGN-local-knowledge-fable.md amended §2.11): the Market keeps its six pills and
// reads nothing about Local knowledge. Only the SYNC names the type, and only to fill the phone's own table. These hold that.

const here = path.dirname(new URL(import.meta.url).pathname);
const source = (rel: string) => fs.readFileSync(path.join(here, '..', '..', rel), 'utf8');

describe('what is asked of the node', () => {
    it('the sync names Local knowledge beside the Market’s kinds; the Market’s own reads do not', () => {
        expect(SYNC_TYPES_QUERY).toBe('types=offer,need,poll,event,knowledge');
        expect(EVENT_TYPES_QUERY).toBe('types=offer,need,poll,event');
        expect(POST_TYPES_WITH_EVENTS).not.toContain('knowledge');
    });

    it('the posts pull in services/pillar-sync.ts uses the sync’s list', () => {
        const sync = source('services/pillar-sync.ts');
        expect(sync).toMatch(/api\/marketplace\/posts\?\$\{nearbyLimits \? nearbyQuery\(\) : 'limit=1000&sync=true'\}&\$\{SYNC_TYPES_QUERY\}/);
    });

    it('the Market’s fill and screen never name the type in a request', () => {
        for (const rel of ['utils/market-fill.ts', 'app/(tabs)/market.tsx']) {
            const text = source(rel);
            expect(text, rel).not.toContain('SYNC_TYPES_QUERY');
            expect(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), rel).not.toMatch(/types=[a-z,]*knowledge|type=knowledge/);
        }
    });
});

describe('the Market’s pills, the chooser and the map stay as they were', () => {
    it('the Market has no Learn or knowledge pill', () => {
        const ids = MARKET_TYPE_PILLS.map((f) => f.id);
        expect(ids).toEqual(['all', 'for-you', 'offers', 'needs', 'events', 'polls']);
        expect(source('utils/market-filters.ts').toLowerCase()).not.toMatch(/knowledge|learn/);
    });

    it('Add post keeps its four kinds; the fifth, Local knowledge (slice K4), is added only where Learn is live', () => {
        expect(NEW_POST_TYPES).toHaveLength(4);
        expect(NEW_POST_TYPES.map((o) => o.id)).not.toContain('knowledge');
        // The only way the row reaches the chooser: composeOptions({ learn }) (compose-options.test.ts holds its rows).
        expect(source('utils/compose-options.ts')).toContain('return opts.learn ? [...NEW_POST_TYPES, KNOWLEDGE_COMPOSE_OPTION] : NEW_POST_TYPES;');
    });

    it('the three protected map files are not touched by Learn', () => {
        for (const rel of ['app/(tabs)/map.tsx', 'components/UnifiedMapPin.tsx', 'components/Map.web.tsx']) {
            expect(source(rel).toLowerCase(), rel).not.toMatch(/knowledge/);
        }
    });
});

describe('the pages are kept apart from the listings', () => {
    it('only the sync’s one writer branches on the type, and it writes the pages’ own table', () => {
        const db = source('utils/db.ts');
        expect(db).toContain("if (p?.type === 'knowledge') return writeKnowledgePost(txn, p);");
        expect(db).toContain('INSERT OR REPLACE INTO knowledge_posts');
        // Cleared with every other cache table when the copy is cleared (a Force Resync, a copy below the schema number).
        expect(db).toMatch(/CACHE_TABLES = \[[^\]]*'knowledge_posts'/);
    });
});
