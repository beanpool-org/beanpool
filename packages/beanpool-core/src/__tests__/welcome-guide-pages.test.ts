/**
 * The members' guide (bundled in the phone app) says what slice S5 of scratch/fable-design/DESIGN-onboarding-home-landing-
 * fable.md made of the phone's join and Home: the join's three steps with Safety Backup last (How it Works stays in a web
 * browser until the web's own slice), the WELCOME TO BEANPOOL! tile with Show me around and Got it, its band after 7 days
 * and its end at 30, First steps above the Market, and no notifications card in the join (review of #3315, inline comment
 * on welcome.tsx), and since slice W2 the web app's tile and community welcome. The English pages; their 24 language versions follow by their source-hash (packages/beanpool-guide/README.md §6).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOME_DEFAULT_LIST } from '../home-frame.js';
import { COMMUNITY_WELCOME_CARD_WORDS, WELCOME_TILE_WORDS } from '../home-welcome.js';
import { t } from '../words.js';

const GUIDE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'beanpool-guide', 'content');
const page = (rel: string) => readFileSync(join(GUIDE, rel), 'utf8');
/** One page's text as one line: a sentence wrapped across lines still matches. */
const flat = (rel: string) => page(rel).replace(/\s+/g, ' ');

describe("the guide's joining page: the phone's three steps", () => {
    const joining = flat('getting-started/joining.md');

    it('the phone has dots for the name, Your Photo and the way back, the way back last; the web the same since W1 (Safety Backup there), with no How it Works', () => {
        // Slice S3: the labelled bar became dots and ‹ (components/welcome/StepDots.tsx); the steps and their order are the same.
        // Slice S4: the way back is titled "Keep a way back in" on the phone (no screen says "Safety Backup" there any more),
        // skipped where a way back is already kept, and its ‹ is said as it is built (the Go back? question after an invite).
        expect(joining).toContain('In the phone app the dots at the top show the steps and where you are: one dot each for your name, your photo and **Keep a way back in**, the last step.');
        // Round 2 of the review of #3330: a claim is never skipped; a sign-in's copy at the vault counts, an admins' copy never.
        expect(joining).toContain("a sign-in's copy at BeanPool's key vault, or your 12 words already noted as written down), an invite or the global community's join has no way-back step, and two dots. A claim always shows it.");
        expect(joining).toContain("**Your community's admins**, in **Account Protection**, doesn't count here either: the step and the card still show.");
        expect(joining).not.toContain('there is no way-back step, and two dots.');
        // ‹ keeps the account and its words (join-after-lost-answer.test.ts: the same key after Go Back), never a new account.
        expect(joining).toContain('after an invite it first asks **Have you saved your words?**, then goes back to your name. It is still the same account, with the same 12 words: tap **Join** and you carry on (with the account the phone already had, straight into the community).');
        expect(joining).not.toContain('with a new account');
        expect(joining).not.toContain('one dot each for your name, your photo and **Safety Backup**');
        expect(joining).not.toContain('**Rather write down 12 words?**');
        expect(joining).not.toContain("tap **Let's Begin!** here");
        // Since W1 the web's Your name says Join too (WelcomePage.tsx), so the button is named once, for both apps.
        expect(joining).toContain('**Failed to register identity** (after you tap **Join**)');
        expect(joining).not.toContain('in a web browser, **Next**)');
        expect(joining).not.toContain('the bar at the top shows **Your Name**');
        expect(joining).not.toContain('**Restore Existing Identity**');
        expect(joining).not.toContain('The bar at the top shows **Your Name**, **Your Photo**, **Safety Backup** and **How it Works**.');
        // Slice W1 (#3333): the web's join has the same dots (apps/pwa/src/components/StepDots.tsx, core join-steps.ts) and
        // How it Works left it, so the step the page kept "in a web browser only" until then is gone.
        expect(joining).toContain('A web browser shows the same dots and **‹**, with **Safety Backup** last there too');
        expect(joining).not.toContain('**How it Works**');
    });

    it("the join asks nothing about notifications: no How it Works card, First steps' line instead", () => {
        expect(joining).not.toMatch(/How it Works:\*\* a short tour\. At the end, a card asks \*\*Turn on notifications\?\*\*/);
        expect(joining).toContain('**First steps** on **Home** has **Hear when someone answers you**');
    });
});

// Slice W1 (#3333, deciding review on 0c8dd9e4): the web's join opens on the phone's front door (apps/pwa/src/components/
// FrontDoor.tsx), with Your invite, Your name and dots, and no tour. The pages say what the web draws now, and none of the
// screens it replaced.
describe("the guide's pages on joining in a browser: the web's front door and dots (W1)", () => {
    const joining = flat('getting-started/joining.md');
    const webApp = flat('getting-started/web-app.md');
    const communities = flat('getting-started/communities.md');
    const recovery = flat('settings/recovery.md');

    it("names none of the web join's removed screens or buttons", () => {
        const gone = [
            '**Used BeanPool before?**', "**I'm New Here**", "**I'm Already a Member →**", '**Restore Existing Identity**',
            '**Create Identity & Join →**', '**How it Works**', 'a short tour', '(in a web browser, **← Back**)', '(in the web app, **Next**)',
        ];
        // The community's card (routes/community-card.ts), at a community's bare address, keeps its own doors: the guide names them.
        for (const door of ['**Ask to join**', '**I have an invite**', '**Already a member**']) expect(communities).toContain(door);
        for (const [name, text] of Object.entries({ joining, webApp, communities, recovery })) {
            for (const label of gone) expect(`${name}: ${text.includes(label) ? label : ''}`).toBe(`${name}: `);
        }
    });

    it("the front door's buttons, the same on the phone and the web", () => {
        expect(joining).toContain("The first screen has three buttons, in the phone app and in the web app (the community's address followed by /app; the address alone shows the community's card");
        expect(joining).toContain('In a web browser, an invite link opens straight at your name.');
        // A community's bare address answers with its card (routes/community-card.ts), not the web app's front door.
        expect(communities).toContain("A community's own address (such as castlemaine.beanpool.org) shows its card to anyone who isn't a member");
        expect(recovery).toContain("On the first screen, tap **I've used BeanPool before**. In a web browser, tap the same button, or **Already have BeanPool?** where the page shows that instead.");
        expect(joining).toContain('In a web browser, **Your invite** opens straight away, with a box for the invite link or code and **Next →**, but no **Scan a QR code**.');
    });

    it("the web's steps: dots and ‹, Next → on Safety Backup goes in, a sign-in chosen right there", () => {
        expect(webApp).toContain('The dots at the top show the steps and where you are: one dot each for your name, your photo, your area and **Safety Backup**.');
        expect(webApp).toContain('On **Safety Backup**, **Next →** takes you in.');
        expect(webApp).toContain('tap it and choose the sign-in right there.');
        expect(joining).toContain('in a web browser, **Next →** here takes you to **Home**');
    });

    it("the way back with a sign-in on a local community's web address is the front door's button", () => {
        expect(webApp).toContain("On your own local community's web address, tap **Already have BeanPool?** or, where the page shows it instead, **I've used BeanPool before**, then **Recover with Social Sign-In**.");
    });
});

describe("the guide's Home page: the tile, its band, its end, the order", () => {
    const home = flat('getting-started/home.md');

    it("the tile on both apps (the web since W2): Show me around and Got it, folded after 7 days, gone at 30; no Take the tour or Not now", () => {
        expect(home).toContain(`**${WELCOME_TILE_WORDS.tour}** starts the tour (below). **${WELCOME_TILE_WORDS.gotIt}** puts the tile away.`);
        expect(home).toContain(`After 7 days, if you haven't tapped either, the tile folds to one line, "${WELCOME_TILE_WORDS.band}"`);
        expect(home).toContain('30 days after you joined it is gone, whether or not you tapped anything.');
        // The web app's old card and its words are gone from the page (DESIGN-onboarding-home-landing-fable.md §5, slice W2).
        expect(home).not.toContain('In the web app, **Welcome** is a card with those first lines, **Take the tour ›** and **Not now**.');
        expect(home).not.toContain('**Take the tour ›**');
        expect(home).not.toMatch(/\*\*Not now\*\*/);
        // The phone's Welcome no longer goes at seven days or by Not now: said for the web app only.
        expect(home).not.toContain('It says which community you are in, such as "You\'re in Riverside.", and who invited you, with **Say hello ›** to open a chat with them. An owner alone on a new community, whom nobody invited, sees "You\'re the first one here." instead, with **Invite someone ›** where they can invite. **Welcome** goes when');
        expect(home).not.toContain('**Welcome** has **Not now** instead.');
    });

    it("the newcomer's order is core's default list: First steps above New in the Market", () => {
        expect(HOME_DEFAULT_LIST.indexOf('steps')).toBeLessThan(HOME_DEFAULT_LIST.indexOf('market'));
        expect(home).toContain('**Welcome**, **Your way back in**, **First steps**, **New in the Market** (**Near you** on the global community), **What are you into?**');
    });
});

describe("the guide's notifications page", () => {
    // Slice N2a: no pop-up at the first message or request to join; a named line's Tell me there instead.
    it('names no card at the end of How it Works: the phone asks from First steps, or from Tell me on a named line', () => {
        const notifications = flat('settings/notifications.md');
        expect(notifications).not.toContain('the card at the end of How it Works');
        expect(notifications).not.toContain('or when you send your first message or request to join');
        expect(notifications).toContain('**Hear when someone answers you** in **First steps** on **Home**, or **Tell me** on a one-line offer such as **Hear when Asha answers.** under your first message.');
        expect(notifications).toContain("The same line shows once after your first listing, a request on someone's listing, a request to join, or a message you read, never more than one a day.");
    });
});

// Slice S7: the community's own welcome under the phone's tile, in the words the app draws (core's COMMUNITY_WELCOME_CARD_WORDS);
// since slice W2 the web app's too, beside the tile on a wide screen.
describe("the guide's Home page: the community's own welcome on both apps (S7, W2)", () => {
    const home = flat('getting-started/home.md');

    it('under the tile: the owners\' words never translated, the inviter\'s line, its ×, 30 days, and the line to read it again', () => {
        expect(home).toContain('Under the tile is your community\'s own welcome, headed "From" and the community\'s name, such as "From Riverside".');
        expect(home).toContain('In the web app, on a wide screen, it stands beside the tile instead, and the two run across the whole width.');
        expect(t(COMMUNITY_WELCOME_CARD_WORDS.caption, { community: 'Riverside' })).toBe('From Riverside');
        expect(home).toContain('as they wrote them: they are never translated.');
        expect(home).toContain('**Got it** on the tile leaves it there: tap its **×** to put it away.');
        expect(home).toContain(`such as "${t(COMMUNITY_WELCOME_CARD_WORDS.again, { community: 'Riverside' })}"`);
        expect(home).toContain(`sees **${t(COMMUNITY_WELCOME_CARD_WORDS.write)}** there.`);
        // Whose invite brought you moved from the tile to it, the phone's at S7 and the web app's at W2.
        expect(home).not.toContain('In the web app it also says who invited you, with **Say hello ›** to open a chat with them;');
        expect(home).toContain('Who invited you is in your community\'s own welcome, under the tile (below).');
        expect(home).toContain('with **Say hello ›** to open a chat with them, or, for an owner alone on a new community whom nobody invited, "You\'re the first one here." with **Invite someone ›** where they can invite');
    });
});
