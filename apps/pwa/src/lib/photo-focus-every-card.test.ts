/**
 * Every crop of a picture on BOTH apps, each one named: a card or tile that crops a post's or event's own photo uses the
 * focus its author picked (core photo-focus.ts), and every other crop says why it does not (review of 200e812d: the web
 * EventCard's list card still cropped centred while the phone's used the focus; the class, closed here).
 *
 * The search: every .tsx file of the web app (apps/pwa/src) and the phone app (apps/native app + components), tests left
 * out. A crop is, on the web, an `object-cover` class; on the phone, a MarketCardPicture, a ListPhoto, or an expo Image
 * drawn `contentFit="cover"`. Each file that has one is in TABLE below with one entry per crop, in the file's order:
 *   - 'focus': a card or tile cropping a post's or event's own photo. The element passes the focus through the app's helper
 *     (web cardObjectPosition / focusObjectPosition, phone cardContentPosition / focusContentPosition), or, where the
 *     element is drawn by a function of the file, `via` names the call that hands the focus in.
 *   - 'left': a post's or event's photo deliberately drawn without it, and why.
 *   - 'other': not a post's or event's photo at all (an avatar, a banner, a page of Local knowledge, a form's own thumbnail).
 * A new crop anywhere fails here until it is put in the table, so a card cannot quietly crop centred again.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOTS: Array<{ app: 'web' | 'phone'; dir: string }> = [
    { app: 'web', dir: 'apps/pwa/src' },
    { app: 'phone', dir: 'apps/native/app' },
    { app: 'phone', dir: 'apps/native/components' },
];
const WEB_CROP = /object-cover/g;
const PHONE_CROP = /<MarketCardPicture\b|<ListPhoto\b|<Image\b(?:(?!\/>)[\s\S])*?contentFit="cover"/g;
const WEB_FOCUS = /\b(?:cardObjectPosition|focusObjectPosition)\(/;
const PHONE_FOCUS = /\b(?:cardContentPosition|focusContentPosition)\(/;

type Entry = ['focus', string, RegExp?] | ['left', string, string] | ['other', string];

const SMALL = 'a small square thumb beside a row\'s words (56 px / dp or less): centred, as before focus points';
const DETAIL = "the post's own page, not a card (the decided shape: cards and tiles); a tap shows the photo whole";
const NO_LIST = "the answer it draws carries the photo's address alone, not the post's photo list or its focus";
const FORM = "a form's own thumbnail of a photo being added";

const TABLE: Record<string, Entry[]> = {
    // ── Web: cards and tiles of a post or an event ───────────────────────────────────────────────────────────────────
    'apps/pwa/src/components/MarketplaceCard.tsx': [
        ['focus', 'Market grid card (cardPicture, drawn with focusCrop ?? GRID_CROP)', /cardPicture\([^\n]*focusCrop \?\? GRID_CROP\)/],
        ['focus', 'Market list card photo and the members\' map pop-up (cardPicture with focusCrop)', /cardPicture\([^\n]*, focusCrop, `\$\{LIST_PHOTO_FILL\} object-cover`\)/],
    ],
    'apps/pwa/src/components/EventCard.tsx': [
        ['focus', 'event list card: the Market\'s List view and the map\'s event pop-up'],
        ['left', 'event compact row', `the 32 px compact picture: ${SMALL}`],
        ['focus', 'event grid tile'],
        ['focus', 'stacked event card (rsvpOnCard)'],
        ['left', 'event detail page photo', DETAIL],
    ],
    'apps/pwa/src/pages/HomePage.tsx': [
        ['focus', 'Home "New in the Market" picture tile'],
        ['focus', 'Home wide tile'],
        ['left', 'Home row thumb', SMALL],
        ['left', 'Home "asked" row thumb', SMALL],
        ['other', 'Pulse tile thumbnail (a Pulse post, not a listing)'],
        ['other', 'Pulse row thumbnail'],
        ['other', 'faces on the Home welcome'],
    ],
    'apps/pwa/src/pages/MapPage.tsx': [
        ['other', FORM],
        ['focus', 'visitor\'s map pin card'],
    ],
    'apps/pwa/src/components/VisitorListing.tsx': [
        ['focus', 'visitor lobby card (80 px, as the list card\'s photo)'],
        ['left', 'visitor detail page photos', DETAIL],
    ],
    'apps/pwa/src/pages/MarketplacePage.tsx': [
        ['other', FORM],
        ['left', 'listing detail page first photo', DETAIL],
        ['left', 'listing detail page further photos', DETAIL],
    ],
    'apps/pwa/src/components/MapStackList.tsx': [['left', 'map stack list row', SMALL]],
    'apps/pwa/src/components/MyDealsModal.tsx': [
        ['left', 'Your deals: a deal\'s row', `${SMALL}; ${NO_LIST}`],
        ['left', 'Your deals: a deal\'s row (finished)', `${SMALL}; ${NO_LIST}`],
        ['left', 'Your deals: one of my listings', SMALL],
        ['left', 'Your deals: one of my listings (finished)', SMALL],
    ],
    'apps/pwa/src/pages/PublicProfilePage.tsx': [
        ['other', 'the member\'s avatar'],
        ['left', 'a profile\'s listing row', SMALL],
    ],
    'apps/pwa/src/components/Shopfront.tsx': [
        ['other', 'the shop\'s banner'],
        ['other', 'the shop\'s logo'],
        ['left', 'shop window tile', `${NO_LIST} (routes/shops.ts ShopfrontListing): a follow-up adds photoFocus there`],
    ],
    'apps/pwa/src/components/PhotoFocusDialog.tsx': [['other', 'the Adjust dialog\'s own card preview, cropped at the focus being chosen']],
    'apps/pwa/src/components/PostPhotoPicker.tsx': [['other', FORM]],
    // ── Web: not a post's photo ──────────────────────────────────────────────────────────────────────────────────────
    'apps/pwa/src/components/AvatarPresetPicker.tsx': [['other', 'avatar presets']],
    'apps/pwa/src/components/CreateGroupModal.tsx': [['other', 'a group\'s picture']],
    'apps/pwa/src/components/CreditPeoplePanel.tsx': [['other', 'a member\'s avatar']],
    'apps/pwa/src/components/DefaultBanner.tsx': [['other', 'drawn banner'], ['other', 'drawn banner'], ['other', 'drawn banner']],
    'apps/pwa/src/components/EnterpriseCard.tsx': [['other', 'an enterprise\'s logo']],
    'apps/pwa/src/components/EnterpriseManage.tsx': [['other', 'an enterprise\'s logo'], ['other', 'an enterprise\'s banner']],
    'apps/pwa/src/components/GroupDetailModal.tsx': [['other', 'a member\'s avatar']],
    'apps/pwa/src/components/LearnCheck.tsx': [['other', 'a page of Local knowledge']],
    'apps/pwa/src/components/LearnForm.tsx': [['other', 'a page of Local knowledge']],
    'apps/pwa/src/components/LearnRow.tsx': [['other', 'a page of Local knowledge']],
    'apps/pwa/src/components/MemberAvatar.tsx': [['other', 'a member\'s avatar']],
    'apps/pwa/src/components/PricingGuideModal.tsx': [['other', 'a pricing guide item']],
    'apps/pwa/src/components/PulseFeedCard.tsx': [['other', 'a Pulse post']],
    'apps/pwa/src/components/PulseKnowledgeCard.tsx': [['other', 'a page of Local knowledge']],
    'apps/pwa/src/components/PulsePreviewCard.tsx': [['other', 'a Pulse post']],
    'apps/pwa/src/components/forum/ForumBits.tsx': [['other', 'a forum post\'s photo'], ['other', 'a forum post\'s photo being added']],
    'apps/pwa/src/pages/HandoffPage.tsx': [['other', 'a member\'s photo']],
    'apps/pwa/src/pages/LearnPage.tsx': [['other', 'a page of Local knowledge']],
    'apps/pwa/src/pages/PeoplePage.tsx': [['other', 'a member\'s avatar']],
    'apps/pwa/src/pages/ProjectsPage.tsx': [['other', 'a project\'s avatar'], ['other', 'a member\'s avatar'], ['other', 'a project\'s avatar being added']],
    'apps/pwa/src/pages/WelcomePage.tsx': [['other', 'the new member\'s avatar'], ['other', 'avatar presets']],
    'apps/pwa/src/pages/YourShopPage.tsx': [['other', 'the shop\'s banner']],
    'apps/pwa/src/tools/ui.tsx': [['other', 'a tool\'s row photo (the host\'s own)'], ['other', 'a tool\'s photo (the host\'s own)']],

    // ── Phone: cards and tiles of a post or an event ─────────────────────────────────────────────────────────────────
    'apps/native/app/(tabs)/market.tsx': [
        ['focus', 'Market grid card'],
        ['left', 'Market compact row', `the 32 dp compact picture: ${SMALL}`],
        ['focus', 'Market list card photo (80 dp)'],
    ],
    'apps/native/components/EventCard.tsx': [
        ['focus', 'event grid tile'],
        ['left', 'event compact row', `the 32 dp compact picture: ${SMALL}`],
        ['focus', 'event list card (the Market\'s List view, the map pop-up)'],
    ],
    'apps/native/components/MapPreviewCard.tsx': [['focus', 'map pop-up card']],
    'apps/native/components/home/MarketTiles.tsx': [['focus', 'Home "New in the Market" tile']],
    'apps/native/components/home/HomeCardBodies.tsx': [['left', 'Home row thumb (48 dp)', SMALL]],
    'apps/native/components/MapStackList.tsx': [['left', 'map stack list row', SMALL]],
    'apps/native/app/public-profile.tsx': [['left', 'a profile\'s listing row (56 dp)', SMALL]],
    'apps/native/app/(tabs)/chats.tsx': [['left', 'a chat row\'s listing photo (44 dp)', SMALL]],
    'apps/native/components/MyDealsSheet.tsx': [
        ['left', 'Your deals: a deal\'s card', `a strip beside the deal's lines; ${NO_LIST}`],
        ['left', 'Your deals: one of my listings', 'a strip beside the listing\'s lines, as the deal\'s card beside it'],
    ],
    'apps/native/app/peek.tsx': [['left', 'a shared link\'s peek of a post', 'the peek reader keeps only the fields it draws (utils/peek.ts readPeekPost), no focus: a follow-up']],
    'apps/native/components/shopfront/Shopfront.tsx': [
        ['other', 'the shop\'s banner'],
        ['left', 'shop window tile', `${NO_LIST} (routes/shops.ts ShopfrontListing): a follow-up adds photoFocus there`],
    ],
    'apps/native/components/PhotoCarousel.tsx': [['left', 'the post\'s own page photos', DETAIL]],
    'apps/native/components/MarketCardPicture.tsx': [['other', 'the card picture itself: its callers hand it the crop (above)']],
    'apps/native/components/PhotoFocusAdjust.tsx': [['other', 'the Adjust screen\'s own card preview, cropped at the focus being chosen']],
    'apps/native/components/NewEventModal.tsx': [['other', FORM]],
    // ── Phone: not a post's photo ────────────────────────────────────────────────────────────────────────────────────
    'apps/native/app/learn/check/[id].tsx': [['other', 'a page of Local knowledge']],
    'apps/native/app/learn/new.tsx': [['other', 'a page of Local knowledge'], ['other', 'a page of Local knowledge']],
    'apps/native/app/shop/mine.tsx': [['other', 'the shop\'s banner']],
    'apps/native/components/DefaultBanner.tsx': [['other', 'drawn banner'], ['other', 'drawn banner'], ['other', 'drawn banner']],
    'apps/native/components/MemberAvatar.tsx': [['other', 'a member\'s avatar']],
    'apps/native/components/PulseFeedCard.tsx': [['other', 'a Pulse post']],
    'apps/native/components/PulseKnowledgeCard.tsx': [['other', 'a page of Local knowledge']],
    'apps/native/components/PulsePreviewCard.tsx': [['other', 'a Pulse post']],
    'apps/native/components/learn/KnowledgeRowCard.tsx': [['other', 'a page of Local knowledge']],
    'apps/native/components/shopfront/Manage.tsx': [['other', 'the shop\'s banner']],
};

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name.endsWith('.tsx') && !/\.test\.tsx$/.test(e.name)) out.push(full);
    }
    return out;
}

/** Each crop in a file, in order, with the element it is on (from its tag to the tag's end). */
type Crop = { file: string; app: 'web' | 'phone'; line: number; element: string };
function crops(): Crop[] {
    return ROOTS.flatMap(({ app, dir }) => walk(join(REPO, dir)).flatMap((full) => {
        const src = readFileSync(full, 'utf8');
        const file = relative(REPO, full).split('\\').join('/');
        return [...src.matchAll(app === 'web' ? WEB_CROP : PHONE_CROP)].map((m): Crop => {
            // The web's class sits inside its tag: the element starts at the tag's `<` before it. The phone's match is the tag.
            const start = app === 'web' ? Math.max(src.lastIndexOf('<img', m.index!), src.lastIndexOf('<ListPhoto', m.index!)) : m.index!;
            const end = src.indexOf('/>', m.index!);
            return { file, app, line: src.slice(0, m.index!).split('\n').length, element: src.slice(Math.max(0, start), end < 0 ? undefined : end) };
        });
    }));
}
const CROPS = crops();
const byFile = new Map<string, Crop[]>();
for (const c of CROPS) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);

describe('every crop on both apps is named, and every card of a post or event crops at its focus', () => {
    it('finds the crops (a guard on the search)', () => {
        expect(CROPS.length).toBeGreaterThan(80);
        expect(byFile.get('apps/native/components/EventCard.tsx')?.length).toBe(3);
        expect(byFile.get('apps/pwa/src/components/EventCard.tsx')?.length).toBe(5);
    });

    it('every file with a crop is in the table, and every file in the table still has its crops, one entry each', () => {
        const found = Object.fromEntries([...byFile].map(([f, cs]) => [f, cs.length]));
        const listed = Object.fromEntries(Object.entries(TABLE).map(([f, es]) => [f, es.length]));
        expect(found).toEqual(listed);
    });

    it('a card or tile of a post or event passes the focus; nothing else does', () => {
        const wrong: string[] = [];
        for (const [file, entries] of Object.entries(TABLE)) {
            const found = byFile.get(file) ?? [];
            const src = readFileSync(join(REPO, file), 'utf8');
            entries.forEach((entry, i) => {
                const crop = found[i];
                if (!crop) return;
                const focusRe = crop.app === 'web' ? WEB_FOCUS : PHONE_FOCUS;
                const via = entry[0] === 'focus' ? entry[2] : undefined;
                const uses = via ? via.test(src) : focusRe.test(crop.element);
                if (entry[0] === 'focus' && !uses) wrong.push(`${file}:${crop.line} ${entry[1]}: should crop at the focus`);
                if (entry[0] !== 'focus' && focusRe.test(crop.element) && entry[0] !== 'other') wrong.push(`${file}:${crop.line} ${entry[1]}: uses the focus, so its entry should say 'focus'`);
            });
        }
        expect(wrong).toEqual([]);
    });

    it('parity: each kind of card crops at the focus on both apps', () => {
        const focusOn = (file: string, what: RegExp) => TABLE[file].some((e) => e[0] === 'focus' && what.test(e[1]));
        const PAIRS: Array<[string, RegExp, string, RegExp]> = [
            ['apps/native/app/(tabs)/market.tsx', /grid card/, 'apps/pwa/src/components/MarketplaceCard.tsx', /grid card/],
            ['apps/native/app/(tabs)/market.tsx', /list card/, 'apps/pwa/src/components/MarketplaceCard.tsx', /list card/],
            ['apps/native/components/EventCard.tsx', /grid tile/, 'apps/pwa/src/components/EventCard.tsx', /grid tile/],
            ['apps/native/components/EventCard.tsx', /list card/, 'apps/pwa/src/components/EventCard.tsx', /list card/],
            ['apps/native/components/home/MarketTiles.tsx', /New in the Market/, 'apps/pwa/src/pages/HomePage.tsx', /New in the Market/],
        ];
        for (const [phone, p, web, w] of PAIRS) expect({ phone, web, both: focusOn(phone, p) && focusOn(web, w) }).toEqual({ phone, web, both: true });
    });
});
