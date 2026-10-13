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
        // One component (design §4): the member's own Ledger, fed the sample only in preview, never a second screen.
        expect(ledger).not.toMatch(/LedgerPreview/);
        expect(ledger).toMatch(/if \(preview\) \{ setBalanceState\(sampleBalance\(\)\); setTxns\(sampleTransactions\(\)\); return; \}/);
        expect(ledger).not.toMatch(/SAMPLE_COMMUNITY/);
        const commons = read('app/(tabs)/projects.tsx');
        expect(commons).toMatch(/enterprisesPreview \? <View style=\{\{ marginHorizontal: -16 \}\}><CommonsPreview \/><\/View> : null/);
        expect(commons).not.toMatch(/SAMPLE_COMMUNITY/);
    });

    it("the member's own Ledger in preview: every path to a node or a transfer returns first, and Send and Export are the marker", () => {
        const ledger = read('app/(tabs)/ledger.tsx');
        // Each of these reads the node or moves Beans; in preview each one's first line returns (or opens the sheet).
        for (const fn of ['loadMembers = () =>', 'handleSend = async () =>', 'handleExport = async () =>', 'openSend = async () =>']) {
            const at = ledger.indexOf(fn);
            expect(at, fn).toBeGreaterThan(-1);
            expect(ledger.slice(at, at + 140), fn).toMatch(/\{\s*if \(preview\) (return;|\{ setSheetOpen\(true\); return; \})/);
        }
        expect(ledger).toMatch(/\{preview \? <LocalCommunityMark variant="action" feature="beans" label="Send Beans" \/> : <Pressable/);
        expect(ledger).toMatch(/\{preview \? <LocalCommunityMark variant="action" feature="beans" label="Export CSV" \/> : \(/);
        expect(ledger).toMatch(/\{showSend && !preview && \(/);
        expect(ledger).toMatch(/\{!preview && <RepaymentCard \/>\}/);
    });

    it('the lines and the deal action sit where design §1 rows 2, 4, 7, 8 and 9 put them, each only in preview', () => {
        const post = read('app/post/[id].tsx');
        expect(post).toMatch(/\{beansPreview && <View style=\{\{ paddingHorizontal: 16 \}\}><LocalCommunityMark variant="line" feature="beans" text=\{LOCAL_COMMUNITY_LINES\.price\} \/><\/View>\}/);
        expect(post).toMatch(/\{beansPreview && <LocalCommunityMark variant="line" feature="beans" text=\{LOCAL_COMMUNITY_LINES\.price\} \/>\}/);
        expect(post).toMatch(/escrowPreview && \(\s*<View style=\{styles\.otherPostActions\}>\s*<LocalCommunityMark variant="action" feature="escrow" label=\{LOCAL_COMMUNITY_LINES\.dealAction/);
        expect(read('components/PollCard.tsx')).toMatch(/\{informal && decisionsPreview && <LocalCommunityMark variant="line" feature="decisions" text=\{LOCAL_COMMUNITY_LINES\.poll\} \/>\}/);
        expect(read('app/(tabs)/market.tsx')).toMatch(/decisionsPreview=\{decisionsPreview\}/);
        const people = read('app/(tabs)/people.tsx');
        expect(people).toMatch(/with 12 words or a sign-in in the BeanPool app/);
        expect(people).toMatch(/\{invitesPreview && <LocalCommunityMark variant="line" feature="invites" text=\{LOCAL_COMMUNITY_LINES\.invites\} \/>\}/);
        expect(read('app/public-profile.tsx')).toMatch(/\{!showsBeans && beansPreview && \(\s*<View style=\{\{ marginHorizontal: 16 \}\}>\s*<LocalCommunityMark variant="line" feature="beans" text=\{LOCAL_COMMUNITY_LINES\.profile\} \/>/);
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
        expect(hits.sort()).toEqual(['components/showcase/Previews.tsx', 'components/showcase/sample-screens.ts']);
    });

    it('the marker never locks, greys or talks tiers', () => {
        for (const f of FILES) {
            // The code, not the comments that say what it must never do.
            const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            expect(src).not.toMatch(/🔒|lock|opacity|TrustBadge|trust\.|amber|Ʀ/i);
        }
    });
});
