/**
 * "Start a community" in the web app (scratch/global-node/DESIGN-global-showcase-fable.md §3): the phone's
 * /start-community (apps/native/utils/start-community.ts) in the same words, plus the four things to know before the
 * link (what it costs, who hosts, what they take on, what they never see) and the claim step the phone's screen lacks.
 *
 * - **The same words as the phone.** START_COMMUNITY_COPY is the phone's, kept equal by start-community.test.ts (the
 *   exampleListings precedent: two copies and a test that they match), so W3 can change both together.
 * - **Nothing needs our domain.** "How to run a node" is the node's own `startCommunityUrl` (lib/features.ts); the
 *   setup chapter is a page to read, never something the node or the app depends on.
 */

import { BEANPOOL_WEBSITE_URL, word } from '@beanpool/core';

/**
 * The operator manual's setup chapter on the website: the first start, `beanpool claim` and the phone. Published there
 * with W5 (Marty's pick 8, 13 Oct 2026: the setup chapter alone goes on beanpool.org).
 */
export const SETUP_CHAPTER_URL = `${BEANPOOL_WEBSITE_URL}/guide/operators/first-time-setup.html`;

/**
 * The phone's words (apps/native/utils/start-community.ts START_COMMUNITY_COPY), as word() keys: the screen shows each
 * through t() (identity in English, so the two copies stay equal).
 */
export const START_COMMUNITY_COPY = {
    title: word('Start a community'),
    intro: word("Every community runs on its own node: a small server that holds that community's members, posts and trades. Someone local runs it. If your town or valley doesn't have one yet, it could be you."),
    ways: [
        { icon: '💻', title: word('A spare computer'), body: word('An old laptop, a Mini PC, a NAS or a Raspberry Pi at home runs a node. It stays on, and it needs the internet.') },
        { icon: '☁️', title: word('A small rented server'), body: word('A small virtual server from a hosting company, for a few dollars a month. Nobody needs to keep a machine at home.') },
        { icon: '🤝', title: word('Ask for help'), body: word('Post a Need here on BeanPool worldwide, such as "Someone to help run a community in my town". Someone near you may already know how.') },
    ],
    after: word('Once your node is running, you name your community in its settings app, invite the first members, and they invite the rest. Turn on "publish location" there, and people near you who asked to be told will hear about it.'),
    website: word('How to run a node, on beanpool.org'),
    copyButton: word("Copy my community's details"),
    copied: word("Copied. Paste them into your node's settings app."),
} as const;

/** What to know before the link (design §3, in four lines), and the steps the website page walks through. word() keys. */
export const START_COMMUNITY_KNOW = {
    heading: word('Before you start'),
    lines: [
        { label: word('What it costs'), body: word('A spare computer, or a few dollars a month for a rented server. The software is free.') },
        { label: word('Who hosts it'), body: word('You do, on your machine or the one you rent. It never needs beanpool.org: your own web address works too.') },
        { label: word('What you take on'), body: word('Reports from your members come to you. The data folder is yours to back up, with a recovery code. Keep two owners, and keep the server on and up to date.') },
        { label: word('What you never see'), body: word("Your members' direct messages, unless a member reports one.") },
    ],
    steps: word('About half an hour if you can follow a recipe: paste one block of commands, then run beanpool claim on the server and scan its code with your phone to become the owner.'),
    setupChapter: word('The setup chapter: the first start and claiming it with your phone'),
} as const;

export interface CommunityDetails {
    /** What the member wants to call their community. */
    name: string;
    /** Where it is: a town or area. */
    place: string;
    /** How members can reach its organiser. */
    contact: string;
    /** The member's own name on BeanPool. */
    organiser?: string | null;
}

/**
 * The text copied to the clipboard: plain lines the node's settings app can be filled from (as the phone's). English in
 * every language: the settings app reads these labels, and stays English for launch (design M8).
 */
export function communityDetailsText(d: CommunityDetails): string {
    const line = (label: string, value: string | null | undefined) => {
        const v = (value ?? '').replace(/\s+/g, ' ').trim();
        return v ? `${label}: ${v}` : null;
    };
    return [
        line('Community name', d.name),
        line('Place', d.place),
        line('Organiser', d.organiser),
        line('Contact', d.contact),
    ].filter((l): l is string => l !== null).join('\n');
}

/** Whether there is anything worth copying yet. */
export function canCopyDetails(d: CommunityDetails): boolean {
    return d.name.trim().length >= 2;
}
