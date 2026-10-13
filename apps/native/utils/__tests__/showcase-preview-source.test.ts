/**
 * No preview can write (DESIGN-global-showcase-fable.md §6 W3, as example-listings.test.ts reads the Market's source):
 * the marker and the preview screens import nothing that talks to a node, and no handler in them reaches a transfer,
 * a request, an accept, a vote or a pledge. Every press opens the sheet, collapses the strip, opens an explainer, or
 * goes to Start a community, Communities near you or a guide page.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');
const FILES = ['components/showcase/LocalCommunityMark.tsx', 'components/showcase/Previews.tsx'];
const WRITES = /\b(sendTransfer|transfer|request(Deal|Escrow)?|accept\w*|vote\w*|pledge\w*|fetch|signedPost|signedFetch|post[A-Z]\w*)\s*\(/;

describe('the preview sources', () => {
    for (const f of FILES) {
        it(`${f} imports nothing that talks to a node`, () => {
            const src = read(f);
            const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]);
            for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/utils\/(db|nodes|api|signed|sync)|services\//);
            expect(src).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket/);
        });

        it(`${f}: no onPress reaches a transfer, request, accept, vote or pledge`, () => {
            const src = read(f);
            const handlers = [...src.matchAll(/onPress=\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)].map(m => m[1]);
            expect(handlers.length).toBeGreaterThan(0);
            for (const h of handlers) {
                expect(h, h).not.toMatch(WRITES);
                expect(h, h).toMatch(/setOpen|setInfo|setCollapsed|onClose|router\.push|go\(/);
            }
        });
    }

    it('the Ledger and Commons tabs show the preview only in preview mode, and it is the only sample reader there', () => {
        const ledger = read('app/(tabs)/ledger.tsx');
        expect(ledger).toMatch(/if \(beansMode === 'preview'\) \{[\s\S]{0,300}<LedgerPreview \/>/);
        expect(ledger).not.toMatch(/SAMPLE_COMMUNITY/);
        const commons = read('app/(tabs)/projects.tsx');
        expect(commons).toMatch(/enterprisesPreview \? <CommonsPreview \/> : null/);
        expect(commons).not.toMatch(/SAMPLE_COMMUNITY/);
    });

    it('the sample is read only by the preview components', () => {
        const hits: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(path.resolve(__dirname, '../..', dir), { withFileTypes: true })) {
                const rel = path.join(dir, e.name);
                if (e.isDirectory()) { if (!/node_modules|__tests__|^\./.test(e.name)) walk(rel); continue; }
                if (/\.(tsx?|mts)$/.test(e.name) && /SAMPLE_COMMUNITY/.test(read(rel))) hits.push(rel);
            }
        };
        for (const d of ['app', 'components', 'utils', 'services']) if (fs.existsSync(path.resolve(__dirname, '../..', d))) walk(d);
        expect(hits.sort()).toEqual(['components/showcase/Previews.tsx']);
    });

    it('the marker never locks, greys or talks tiers', () => {
        for (const f of FILES) {
            // The code, not the comments that say what it must never do.
            const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            expect(src).not.toMatch(/🔒|lock|opacity|TrustBadge|trust\.|amber|Ʀ/i);
        }
    });
});
