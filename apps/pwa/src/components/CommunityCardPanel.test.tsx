/**
 * A local community's public card on the welcome page (front doors S15): what it says and where each door goes, as the
 * node's own page at `/` has them (apps/server routes/community-card.ts, test-community-card.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { readCommunityCard, type CommunityCard } from '@beanpool/core';
import { CommunityCardPanel } from './CommunityCardPanel';
import { askDoor, setAccountHint, takeWelcomeDoor, ACCOUNT_HINT_COOKIE } from '../lib/community-card';

const CARD: CommunityCard = {
    name: 'Castlemaine BeanPool', host: 'castlemaine.beanpool.org', members: 9,
    area: { name: 'Castlemaine and around', radiusKm: 15 }, joining: 'requests',
    askUrl: 'https://global.beanpool.org/?ask=castlemaine.beanpool.org', globalUrl: 'https://global.beanpool.org',
};
/** A self-hoster's node: its own domain, no global community, not in our directory. */
const SELF_HOSTED: CommunityCard = { ...CARD, name: 'Riverbend Commons', host: 'pool.riverbend.example', askUrl: null, globalUrl: null };
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

afterEach(() => { vi.restoreAllMocks(); });

describe('the card on the welcome page', () => {
    it('names the community and says its members, its area and that it takes requests to join', () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(DESKTOP);
        render(<CommunityCardPanel card={CARD} onSignIn={() => {}} />);
        expect(screen.getByRole('heading', { name: 'Castlemaine BeanPool' })).toBeTruthy();
        expect(screen.getByTestId('community-card-members').textContent).toBe('9 members');
        expect(screen.getByTestId('community-card-area').textContent).toBe('Castlemaine and around, within about 15 km');
        expect(screen.getByTestId('community-card-joining').textContent).toBe('Takes requests to join');
        expect(screen.getByTestId('community-card-ask').getAttribute('href')).toBe(CARD.askUrl);
        expect(screen.getByText('You join the global community first, then ask Castlemaine BeanPool from there.')).toBeTruthy();
        expect(screen.getByTestId('community-card-global').getAttribute('href')).toBe('https://global.beanpool.org');
    });

    it('Already a member opens the ways back', () => {
        const onSignIn = vi.fn();
        render(<CommunityCardPanel card={CARD} onSignIn={onSignIn} />);
        fireEvent.click(screen.getByTestId('community-card-signin'));
        expect(onSignIn).toHaveBeenCalledTimes(1);
    });

    it("a self-hoster's card: Ask to join from the BeanPool app, and no link to us", () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(DESKTOP);
        const { container } = render(<CommunityCardPanel card={SELF_HOSTED} onSignIn={() => {}} />);
        expect(screen.getByTestId('community-card-ask-app').textContent).toBe('Ask to join from the BeanPool app.');
        expect(screen.queryByTestId('community-card-ask')).toBeNull();
        expect(screen.queryByTestId('community-card-global')).toBeNull();
        expect(container.innerHTML).not.toMatch(/beanpool\.org/);
    });

    it('nothing it was not sent: no member count, no area, "by invite" and no Ask to join', () => {
        render(<CommunityCardPanel card={{ ...CARD, members: null, area: null, joining: 'invite', askUrl: null }} onSignIn={() => {}} />);
        expect(screen.queryByTestId('community-card-members')).toBeNull();
        expect(screen.queryByTestId('community-card-area')).toBeNull();
        expect(screen.getByTestId('community-card-joining').textContent).toBe('Takes new members by invite');
        expect(screen.queryByTestId('community-card-ask')).toBeNull();
        expect(screen.queryByTestId('community-card-ask-app')).toBeNull();
    });

    it('compact (from the card\'s own "I have an invite"): the name and facts, no doors', () => {
        render(<CommunityCardPanel card={CARD} onSignIn={() => {}} compact />);
        expect(screen.getByRole('heading', { name: 'Castlemaine BeanPool' })).toBeTruthy();
        expect(screen.queryByTestId('community-card-ask')).toBeNull();
        expect(screen.queryByTestId('community-card-signin')).toBeNull();
    });

    it('a community with no name of its own shows its host', () => {
        render(<CommunityCardPanel card={{ ...CARD, name: null }} onSignIn={() => {}} />);
        expect(screen.getByRole('heading', { name: 'castlemaine.beanpool.org' })).toBeTruthy();
    });
});

describe('where Ask to join goes', () => {
    it('on Android: the app\'s card screen, falling back to the lobby', () => {
        expect(askDoor(CARD, true)).toEqual({
            href: 'intent://community-card?node=https%3A%2F%2Fcastlemaine.beanpool.org#Intent;scheme=beanpool;package=org.beanpool.pillar;'
                + `S.browser_fallback_url=${encodeURIComponent(CARD.askUrl!)};end`,
            note: null,
        });
        expect(askDoor(SELF_HOSTED, true).href).toBe('intent://community-card?node=https%3A%2F%2Fpool.riverbend.example#Intent;scheme=beanpool;package=org.beanpool.pillar;end');
    });
    it('elsewhere: the lobby, or the words to ask from the app; a community that takes no requests: nowhere', () => {
        expect(askDoor(CARD, false).href).toBe(CARD.askUrl);
        expect(askDoor(SELF_HOSTED, false)).toEqual({ href: null, note: 'Ask to join from the BeanPool app.' });
        expect(askDoor({ ...CARD, joining: 'invite' }, false)).toEqual({ href: null, note: null });
        expect(askDoor({ ...CARD, joining: 'open' }, true)).toEqual({ href: null, note: null });
    });
});

describe("a node's answer, read as a card", () => {
    it('keeps the fields, drops anything else, and takes only https links', () => {
        const read = readCommunityCard({ ...CARD, extra: 'x', askUrl: 'javascript:alert(1)', globalUrl: 'http://global.example' });
        expect(read).toEqual({ ...CARD, askUrl: null, globalUrl: null });
        expect(readCommunityCard({ ...CARD, joining: 'maybe' })).toBeNull();
        expect(readCommunityCard({ ...CARD, host: 'evil.example/path', members: -1 })).toMatchObject({ host: null, members: null });
        expect(readCommunityCard(null)).toBeNull();
    });
});

describe('the hint the node reads at its bare address', () => {
    it('set while an account is kept here, cleared at sign-out: "1" and nothing else', () => {
        const doc = { cookie: '' };
        setAccountHint(true, doc, true);
        expect(doc.cookie).toBe(`${ACCOUNT_HINT_COOKIE}=1; Path=/; Max-Age=34560000; SameSite=Lax; Secure`);
        setAccountHint(false, doc, true);
        expect(doc.cookie).toBe(`${ACCOUNT_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`);
    });

    it("the card's ?door= opens the welcome page there, once, and leaves the address", () => {
        const replaced: string[] = [];
        const win = (search: string) => ({
            location: { search, pathname: '/app', hash: '' } as Location,
            history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); } } as unknown as History,
        });
        expect(takeWelcomeDoor(win('?door=invite'))).toBe('invite');
        expect(takeWelcomeDoor(win('?door=signin&lang=es'))).toBe('signin');
        expect(takeWelcomeDoor(win('?door=elsewhere'))).toBeNull();
        expect(takeWelcomeDoor(win(''))).toBeNull();
        expect(replaced).toEqual(['/app', '/app?lang=es', '/app']);
    });
});
