/**
 * The members' guide (bundled in the phone app) says what slice S5 of scratch/fable-design/DESIGN-onboarding-home-landing-
 * fable.md made of the phone's join and Home: the join's three steps with Safety Backup last (How it Works stays in a web
 * browser until the web's own slice), the WELCOME TO BEANPOOL! tile with Show me around and Got it, its band after 7 days
 * and its end at 30, First steps above the Market, and no notifications card in the join (review of #3315, inline comment
 * on welcome.tsx). The English pages; their 24 language versions follow by their source-hash (packages/beanpool-guide/README.md §6).
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

    it('the phone has dots for the name, Your Photo and Safety Backup, Safety Backup last; How it Works only in a web browser', () => {
        // Slice S3: the labelled bar became dots and ‹ (components/welcome/StepDots.tsx); the steps and their order are the same.
        expect(joining).toContain('In the phone app the dots at the top show the steps and where you are: one dot each for your name, your photo and **Safety Backup**, and **Safety Backup** is the last step.');
        expect(joining).not.toContain('the bar at the top shows **Your Name**');
        expect(joining).not.toContain('**Restore Existing Identity**');
        expect(joining).not.toContain('The bar at the top shows **Your Name**, **Your Photo**, **Safety Backup** and **How it Works**.');
        expect(joining).toContain('- **How it Works** (in a web browser only):');
    });

    it("the join asks nothing about notifications: no How it Works card, First steps' line instead", () => {
        expect(joining).not.toMatch(/How it Works:\*\* a short tour\. At the end, a card asks \*\*Turn on notifications\?\*\*/);
        expect(joining).toContain('**First steps** on **Home** has **Hear when someone answers you**');
    });
});

describe("the guide's Home page: the tile, its band, its end, the order", () => {
    const home = flat('getting-started/home.md');

    it("the phone's tile: Show me around and Got it, folded after 7 days, gone at 30; the web keeps Take the tour and Not now", () => {
        expect(home).toContain(`**${WELCOME_TILE_WORDS.tour}** starts the tour (below). **${WELCOME_TILE_WORDS.gotIt}** puts the tile away.`);
        expect(home).toContain('After 7 days, if you haven\'t tapped either, the tile folds to one line, "Welcome to BeanPool ›"');
        expect(home).toContain('30 days after you joined it is gone, whether or not you tapped anything.');
        expect(home).toContain('In the web app, **Welcome** is a card with those first lines, **Take the tour ›** and **Not now**.');
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
    it('names no card at the end of How it Works: the phone asks from First steps, or at the first message or request to join', () => {
        const notifications = flat('settings/notifications.md');
        expect(notifications).not.toContain('the card at the end of How it Works');
        expect(notifications).toContain('**Hear when someone answers you** in **First steps** on **Home**, or when you send your first message or request to join.');
    });
});

// Slice S7: the community's own welcome under the phone's tile, in the words the app draws (core's COMMUNITY_WELCOME_CARD_WORDS).
describe("the guide's Home page: the community's own welcome on the phone (S7)", () => {
    const home = flat('getting-started/home.md');

    it('under the tile: the owners\' words never translated, the inviter\'s line, its ×, 30 days, and the line to read it again', () => {
        expect(home).toContain('On the phone, under the tile, is your community\'s own welcome, headed "From" and the community\'s name, such as "From Riverside".');
        expect(t(COMMUNITY_WELCOME_CARD_WORDS.caption, { community: 'Riverside' })).toBe('From Riverside');
        expect(home).toContain('as they wrote them: they are never translated.');
        expect(home).toContain('**Got it** on the tile leaves it there: tap its **×** to put it away.');
        expect(home).toContain(`such as "${t(COMMUNITY_WELCOME_CARD_WORDS.again, { community: 'Riverside' })}"`);
        expect(home).toContain(`sees **${t(COMMUNITY_WELCOME_CARD_WORDS.write)}** there.`);
        // Whose invite brought you moved from the phone's tile to it; the web app's card keeps the line until its own slice.
        expect(home).toContain('In the web app it also says who invited you, with **Say hello ›** to open a chat with them;');
        expect(home).toContain('On the phone those lines are in your community\'s own welcome, under the tile (below).');
    });
});
