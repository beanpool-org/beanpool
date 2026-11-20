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
import { COMMUNITY_WELCOME_HOME_WORDS, WELCOME_TILE_WORDS } from '../home-welcome.js';

const GUIDE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'beanpool-guide', 'content');
const page = (rel: string) => readFileSync(join(GUIDE, rel), 'utf8');
/** One page's text as one line: a sentence wrapped across lines still matches. */
const flat = (rel: string) => page(rel).replace(/\s+/g, ' ');

describe("the guide's joining page: the phone's three steps", () => {
    const joining = flat('getting-started/joining.md');

    it('the phone has Your Name, Your Photo and Safety Backup, Safety Backup last; How it Works only in a web browser', () => {
        expect(joining).toContain('In the phone app the bar at the top shows **Your Name**, **Your Photo** and **Safety Backup**, and **Safety Backup** is the last step.');
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

    it("the web app's community welcome: its caption, the owners' words as written, Write your community's welcome for an owner, until its ✕ (W2)", () => {
        expect(home).toContain('In the web app, your community\'s own welcome stands beside the tile, headed with its name, such as "From Riverside", with **✕**.');
        expect(home).toContain("It shows what your community's owners wrote for new members, exactly as they wrote it, if they wrote anything;");
        expect(home).toContain(`An owner of a community with no welcome yet sees **${COMMUNITY_WELCOME_HOME_WORDS.write}**, which opens the community's settings, where it is written.`);
        expect(home).toContain('It stays for your first 30 days, after **Got it** too, until you tap **✕**, and **✕** is kept on your account.');
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
