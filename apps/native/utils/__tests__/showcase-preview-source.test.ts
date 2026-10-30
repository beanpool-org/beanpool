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
        // Nothing until the mode is known (the phone's copy of the profile read), then the sample in preview; a live
        // answer lands only while its load is the latest, so one begun before the switch never draws over the sample.
        expect(ledger).toMatch(/const loadData = \(\) => \{\s*const gen = \+\+loadGen\.current;\s*if \(beansMode === undefined\) return;\s*if \(preview\) \{ setBalanceState\(sampleBalance\(\)\); setTxns\(sampleTransactions\(\)\); setEscrowTotal\(sampleEscrowTotal\(\)\); setPledgeHistory\(\[\]\); setHeldSample\(true\); return; \}\s*if \(heldSample\) \{ setBalanceState\(NO_BALANCE\); setTxns\(NO_TXNS\); setEscrowTotal\(0\); setHeldSample\(false\); \}/);
        // What is held is drawn only in the mode it was loaded for (review of #1852, finding 2).
        expect(ledger).toContain('const balanceState = heldSample === preview ? heldBalance : NO_BALANCE;');
        expect(ledger).toContain('const txns = heldSample === preview ? heldTxns : NO_TXNS;');
        expect(ledger).toMatch(/const beansMode = useShowcaseModeOnceKnown\('beans'\);/);
        for (const read of ['getBalance', 'getTransactions', 'getEscrowTotal', 'getPledgeHistory']) {
            expect(ledger, read).toMatch(new RegExp(`${read}\\(identity\\.publicKey\\)\\.then\\(latest\\(`));
        }
        // The member's own name and picture are the one other reader, and it is the shared hook, never a call of the Ledger's
        // own: asked only once the mode is known and not in preview, so the sample member is never drawn over, or fed by, the
        // reader's own row. In preview the hook reads nothing (its first line returns), and each draw of it is guarded again.
        expect(ledger).not.toMatch(/\bgetMemberProfile\b/);
        expect(ledger.match(/\buseOwnProfile\(/g)).toHaveLength(1);
        expect(ledger).toContain('const own = useOwnProfile(beansMode !== undefined && !preview);');
        expect(ledger).toContain('avatarUrl={preview ? null : own.avatarUrl} updatedAt={preview ? undefined : own.updatedAt}');
        expect(ledger).toContain('callsign={preview ? SAMPLE_MEMBER : own.callsign || identity?.callsign || \'G\'}');
        expect(ledger).toContain('{preview ? SAMPLE_MEMBER : own.callsign || identity?.callsign || t(\'GUEST\')}');
        const hook = read('utils/use-own-profile.ts');
        expect(hook).toMatch(/export function useOwnProfile\(reads = true\): OwnProfile \{/);
        expect(hook).toMatch(/if \(!publicKey \|\| !reads\) \{ setState\(UNKNOWN_OWN_PROFILE\); return; \}/);
        expect(hook.match(/\bgetMemberProfile\(/g)).toHaveLength(1);
        expect(hook.indexOf('!reads')).toBeLessThan(hook.indexOf('getMemberProfile('));
        expect(ledger).not.toMatch(/SAMPLE_COMMUNITY/);
        const commons = read('app/(tabs)/projects.tsx');
        // In preview, first under the title, so the strip greets the newcomer (review of #1852, finding 5); never the footer.
        expect(commons).toMatch(/\{t\(heading\.description\)\}<\/Text>\s*<\/View>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?\{enterprisesPreview && activeSection === 'groups' && <View style=\{\{ marginHorizontal: -16 \}\}><CommonsPreview \/><\/View>\}/);
        expect(commons).not.toMatch(/ListFooterComponent=\{enterprisesPreview/);
        expect(commons.split('<CommonsPreview').length - 1).toBe(1);
        expect(commons).not.toMatch(/SAMPLE_COMMUNITY/);
    });

    it("the member's own Ledger in preview: every path to a node or a transfer returns first, and Send and Export are the marker", () => {
        const ledger = read('app/(tabs)/ledger.tsx');
        // Each of these reads the node or moves Beans; in preview each one's first line returns (or opens the sheet).
        for (const fn of ['loadMembers = () =>', 'handleSend = async () =>', 'handleExport = async () =>', 'openSend = async () =>']) {
            const at = ledger.indexOf(fn);
            expect(at, fn).toBeGreaterThan(-1);
            expect(ledger.slice(at, at + 140), fn).toMatch(/\{\s*if \(preview( \|\| beansMode === undefined)?\) (return;|\{ setSheetOpen\(true\); return; \})/);
        }
        // Send is the marker's action on both tabs: Levels' quick Send and the Wallet's.
        expect(ledger.match(/\{preview \? <LocalCommunityMark variant="action" feature="beans" label=\{t\('Send Beans'\)\} \/> : <Pressable/g)).toHaveLength(2);
        // Export: the member's own button only when not in preview, and in preview the marker on a row of its own (it ran off
        // the edge beside the heading at 320 dp: scratch/global-previews-audit/PHONE.md §3 item 3).
        expect(ledger).toMatch(/\{!preview && \(\s*<Pressable style=\{styles\.exportBtn\}/);
        expect(ledger).toMatch(/\{preview && <View style=\{styles\.exportPreviewRow\} testID="ledger-export-row"><LocalCommunityMark variant="action" feature="beans" label=\{t\('Export CSV'\)\} \/><\/View>\}/);
        expect(ledger).toMatch(/\{showSend && !preview && \(/);
        expect(ledger).toMatch(/\{beansMode !== undefined && !preview && <RepaymentCard \/>\}/);
    });

    it("Your deals in preview is the member's own sheet: the sample loads before any node call, and no press reaches a review or a listing", () => {
        const deals = read('components/MyDealsSheet.tsx');
        expect(deals).not.toMatch(/DealsPreview|SAMPLE_COMMUNITY/);
        const load = deals.slice(deals.indexOf('const loadData = async () => {'));
        expect(load).toMatch(/^const loadData = async \(\) => \{\s*const gen = \+\+loadGen\.current;\s*if \(preview\) \{\s*const sample = sampleDeals\(\);\s*setPosts\(sample\.posts\);\s*setTransactions\(sample\.transactions\);\s*setHeldSample\(true\);\s*return;\s*\}\s*if \(heldSample\) \{ setPosts\(NONE\); setTransactions\(NONE\); setHeldSample\(false\); \}/);
        expect(deals).toContain('const posts = heldSample === preview ? heldPosts : NONE;');
        expect(deals).toContain('const transactions = heldSample === preview ? heldTransactions : NONE;');
        // A live load begun before a switch to preview never lands over the sample (showcase-market-render.test.ts).
        expect(load.slice(0, load.indexOf('\n    };')).match(/if \(gen !== loadGen\.current\) return;/g)).toHaveLength(2);
        // Every press that would open the review form or a listing opens the marker's sheet in preview.
        const leads = deals.split('\n').filter(l => /setPromptReview\(\{|pathname: '\/post\/\[id\]'|router\.push\(`\/post\//.test(l) && /onPress=/.test(l));
        expect(leads.length).toBe(4);
        for (const l of leads) expect(l, l).toMatch(/onPress=\{preview \? openMark : /);
        expect(deals).toMatch(/\{promptReview && !preview && \(/);
        expect(deals).toMatch(/const identity = preview \? SAMPLE_DEALS_ME : ownIdentity;/);
        expect(read('app/(tabs)/market.tsx')).toMatch(/preview=\{dealsPreview\}/);
        expect(read('components/showcase/Previews.tsx')).not.toMatch(/DealsPreview/);
    });

    it('the lines and the deal action sit where design §1 rows 2, 4, 7, 8 and 9 put them, each only in preview', () => {
        const post = read('app/post/[id].tsx');
        // The lines in the member's language since words S3b: the same lines, through t().
        expect(post).toMatch(/\{beansPreview && <View style=\{\{ paddingHorizontal: 16 \}\}><LocalCommunityMark variant="line" feature="beans" text=\{t\(LOCAL_COMMUNITY_LINES\.price\)\} \/><\/View>\}/);
        expect(post).toMatch(/\{beansPreview && <LocalCommunityMark variant="line" feature="beans" text=\{t\(LOCAL_COMMUNITY_LINES\.price\)\} \/>\}/);
        // The price card's words are one element to a screen reader, and the line is outside that group, so VoiceOver
        // reads it and reaches it as a button (review of #1852, finding 8); the note says "in a local community" only in
        // preview (finding 7).
        expect(post).toMatch(/<View style=\{styles\.priceCard\} testID="no-beans-terms">\s*<View [^>]*accessible accessibilityLabel=\{t\('\{terms\}\. \{note\}', \{ terms: t\(NO_BEANS_TERMS\.value\), note: noBeansTermsNote\(beansPreview\) \}\)\}>(?:(?!<View)[\s\S])*?<\/View>\s*\{beansPreview && <View style=\{\{ paddingHorizontal: 16 \}\}><LocalCommunityMark variant="line"/);
        expect(post).not.toMatch(/\{NO_BEANS_TERMS\.note\}/);
        expect(post).toMatch(/escrowPreview && \(\s*<View style=\{styles\.otherPostActions\}>\s*<LocalCommunityMark variant="action" feature="escrow" label=\{t\(LOCAL_COMMUNITY_LINES\.dealAction\)/);
        // The line in the member's language since words S3b: the same line, through t().
        expect(read('components/PollCard.tsx')).toMatch(/\{informal && decisionsPreview && <LocalCommunityMark variant="line" feature="decisions" text=\{t\(LOCAL_COMMUNITY_LINES\.poll\)\} \/>\}/);
        expect(read('app/(tabs)/market.tsx')).toMatch(/decisionsPreview=\{decisionsPreview\}/);
        const people = read('app/(tabs)/people.tsx');
        // Its words say 12 words only where the door offers them (invite-entries.ts bringSomeoneHereText: finding 7).
        expect(people).toContain('{bringSomeoneHereText(nodeProfile?.features)}');
        // Through t() as the other lines are (this one was left raw by S3b: English in every language).
        expect(people).toMatch(/\{invitesPreview && <LocalCommunityMark variant="line" feature="invites" text=\{t\(LOCAL_COMMUNITY_LINES\.invites\)\} \/>\}/);
        // The profile's line in the member's language since words S3l: the same line, through t().
        expect(read('app/public-profile.tsx')).toMatch(/\{!showsBeans && beansPreview && \(\s*<View style=\{\{ marginHorizontal: 16 \}\}>\s*<LocalCommunityMark variant="line" feature="beans" text=\{t\(LOCAL_COMMUNITY_LINES\.profile\)\} \/>/);
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
