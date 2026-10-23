/**
 * What utils/db.ts throws on its own when a signed send or read fails, in the member's language where a screen shows it
 * (components/signed-request-lines.ts): the Treasury (its ledger, an initiative's cancel, a pledge, a keeper's request),
 * a DM's start from a profile, a post or People, a poll's vote and close, a friend's add and removal, a group's page,
 * its lead vote and its Decisions, a post's edit and pause, a review, a transfer, a repeating event's date, an event's
 * RSVP from its card, and an invite redeemed from Settings, People or the wrong-community screen.
 *
 * db.ts signs with the member's key and never reaches the words layer, so those screens showed its English as thrown
 * ("You are off-grid. Please connect to a node first.", "Could not load enterprise ledger (502)"). Each sentence is held
 * to the throw in db.ts it stands for (a sentence changed there fails here), shown in English exactly as written,
 * bracketed in the pseudo-locale and in Portuguese from a catalog that has it (the words round drafts the real ones
 * after merge). A node's own words and the platform's are shown exactly as given. The screens are held to their source.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pseudoLocalise, setLanguage, type Catalog } from '@beanpool/core';
import { signedRequestWords } from '../../components/signed-request-lines';
import { eventLineWords } from '../../components/event-lines';
import { welcomeLineWords } from '../../components/welcome/welcome-lines';

const ROOT = path.resolve(__dirname, '../..');
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const db = source('utils/db.ts');
/** One function of db.ts, from its first line to the brace that closes it. */
const body = (start: string) => {
    const at = db.indexOf(start);
    expect(at, start).toBeGreaterThan(-1);
    return db.slice(at, db.indexOf('\n}\n', at));
};
/** Every fixed sentence a function throws, or falls back to when the node's refusal has no words. */
const thrown = (src: string) => [...src.matchAll(/(?:new Error\(|errMsg = |errorMsg = |message = |\|\| )'([^']+)'/g)].map((m) => m[1]);
const xx = (s: string) => pseudoLocalise(s);

afterEach(() => setLanguage('en'));

describe("db.ts's own sentences, read from its source", () => {
    const byFunction: Array<[string, string[]]> = [
        ['async function _signedRequest(', ['You are off-grid. Please connect to a BeanPool Node to perform this action.', 'No identity found. You must be logged in.', 'Network request failed. You must be connected to a node.']],
        ['export async function signedGet(', ['You are off-grid. Please connect to a BeanPool Node.']],
        ['export async function signedRequestWithMethod(', ['You are off-grid. Please connect to a BeanPool Node.', 'No identity found. You must be logged in.']],
        ['export async function createConversationApi(', ['You are off-grid. Please connect to a node first.', 'No identity found.', 'Failed to create conversation thread.', 'Network request failed when creating thread.']],
        ['export async function deleteCrowdfundProjectApi(', ['You are currently offline. Please connect to a BeanPool Node to cancel your initiative.', 'No identity found.', 'Network request failed. You must be connected to a node to cancel initiatives.']],
        ['export async function votePoll(', ['You are currently offline.', 'No identity found.', 'Failed to record vote']],
        ['export async function closePoll(', ['You are currently offline.', 'No identity found.', 'Failed to close poll']],
        ['export async function addFriendLocal(', ['Your community did not add them.']],
        ['export async function getGroupForLanding(', ['Could not reach the node.']],
        ['export async function pausePost(', ['Not logged in. Identity required.']],
        ['export async function resumePost(', ['Not logged in. Identity required.']],
    ];

    it('each is one the table knows: English exactly as written, bracketed in the pseudo-locale', () => {
        const all = byFunction.flatMap(([start, sentences]) => {
            expect(thrown(body(start)), start).toEqual(sentences);
            return sentences;
        });
        // removeFriendOnNode's, after the node's words when it answered (`? String(e.message)`, then this).
        const removal = 'Couldn’t reach your community, so they are still your friend. Check your connection and try again.';
        expect(body('export async function removeFriendOnNode(')).toContain(`: '${removal}'`);
        all.push(removal);
        for (const s of all) expect(signedRequestWords(s), s).toBe(s);
        setLanguage('xx');
        for (const s of all) expect(signedRequestWords(s), s).toBe(xx(s));
    });

    it('the ones with a status or the node\'s answer in them, the number and the answer as they came', () => {
        expect(body('async function _signedRequest(')).toContain('`Server returned ${res.status}`');
        expect(body('export async function signedRequestWithMethod(')).toContain('`Request failed: ${res.status}`');
        expect(body('export async function getEnterpriseLedger(')).toContain('`Could not load enterprise ledger (${res.status})`');
        expect(body('export async function deleteCrowdfundProjectApi(')).toContain('`Failed to cancel initiative: ${errorText}`');
        const answer = '{"error":"Only the creator can cancel this initiative."}';
        for (const s of ['Server returned 502', 'Request failed: 502', 'Could not load enterprise ledger (502)', `Failed to cancel initiative: ${answer}`]) {
            expect(signedRequestWords(s), s).toBe(s);
        }
        setLanguage('xx');
        expect(signedRequestWords('Server returned 502')).toBe(xx('Server returned {status}').replace('{status}', '502'));
        expect(signedRequestWords('Request failed: 502')).toBe(xx('Request failed: {status}').replace('{status}', '502'));
        expect(signedRequestWords('Could not load enterprise ledger (502)')).toBe(xx('Could not load enterprise ledger ({status})').replace('{status}', '502'));
        expect(signedRequestWords(`Failed to cancel initiative: ${answer}`)).toBe(xx('Failed to cancel initiative: {reason}').replace('{reason}', answer));
    });

    it("a chat's (handed on to utils/chat-line-words.ts), a repeating event's date, and an invite's redeem", () => {
        expect(thrown(body('export async function getEventChat('))).toEqual(['Could not open this event chat.']);
        expect(thrown(body('export async function setEventDateCancelled('))).toEqual(['You are currently offline.', 'No identity found.', 'Could not change that date']);
        expect(thrown(body('export async function redeemInvite('))).toEqual(['No identity to register', 'The community node did not confirm the invite. Please try again.']);
        setLanguage('xx');
        expect(signedRequestWords('Could not open this event chat.')).toBe(xx('Could not open this event chat.'));
        expect(signedRequestWords('This phone has switched community since this chat was opened.')).toBe(xx('This phone has switched community since this chat was opened.'));
        expect(eventLineWords('Could not change that date')).toBe(xx('Could not change that date'));
        // The general ones moved out of the event's table: still worded there, by handing on.
        expect(eventLineWords('You are currently offline.')).toBe(xx('You are currently offline.'));
        expect(eventLineWords('Not logged in. Identity required.')).toBe(xx('Not logged in. Identity required.'));
        expect(welcomeLineWords('No identity to register')).toBe(xx('No identity to register'));
    });

    it("a node's own words, and the platform's, exactly as given", () => {
        setLanguage('xx');
        for (const s of ['Only the creator can cancel this initiative.', 'Network request failed', 'Aborted', '']) {
            expect(signedRequestWords(s), s).toBe(s);
        }
    });
});

describe('in Portuguese, from a catalog that has them', () => {
    const PT: Catalog = {
        'You are off-grid. Please connect to a node first.': 'Está sem ligação. Ligue-se primeiro a uma comunidade.',
        'No identity found. You must be logged in.': 'Não foi encontrada nenhuma identidade. Tem de ter sessão iniciada.',
        'Could not load enterprise ledger ({status})': 'Não foi possível carregar as contas da empresa ({status})',
        'Failed to cancel initiative: {reason}': 'Não foi possível cancelar a iniciativa: {reason}',
        'Could not change that date': 'Não foi possível alterar essa data',
    };

    it('the sentence is the catalog\'s; the status and the node\'s answer as they came', () => {
        setLanguage('pt', [PT]);
        expect(signedRequestWords('You are off-grid. Please connect to a node first.')).toBe('Está sem ligação. Ligue-se primeiro a uma comunidade.');
        expect(signedRequestWords('No identity found. You must be logged in.')).toBe('Não foi encontrada nenhuma identidade. Tem de ter sessão iniciada.');
        expect(signedRequestWords('Could not load enterprise ledger (503)')).toBe('Não foi possível carregar as contas da empresa (503)');
        expect(signedRequestWords('Failed to cancel initiative: Not yours')).toBe('Não foi possível cancelar a iniciativa: Not yours');
        expect(eventLineWords('Could not change that date')).toBe('Não foi possível alterar essa data');
    });
});

describe('the screens that show them pass the message through the table (read from their source)', () => {
    /** A message shown as it was thrown (`e.message || …`, or `Alert.alert(…, e.message)`), outside the console's. */
    const raw = /\b(?:e|err)\??\.message \|\||Alert\.alert\([^;]*, (?:e|err)\??\.message\);/;
    const rawLines = (src: string) => src.split('\n').filter((l) => raw.test(l) && !/console\.(?:warn|error|log)/.test(l)).map((l) => l.trim());

    it.each<[string, number, string[]]>([
        ['app/treasury-detail.tsx', 20, []], ['app/treasury-post.tsx', 1, []], ['app/propose-project.tsx', 1, []], ['app/group-post.tsx', 1, []],
        ['app/names-list.tsx', 1, []], ['components/GroupDetailModal.tsx', 9, []], ['components/GroupSuccessionPanel.tsx', 2, []],
        ['components/EnterpriseDecisions.tsx', 3, []], ['components/DecideSection.tsx', 1, []], ['components/ProposeDecisionModal.tsx', 1, []],
        ['components/PollCard.tsx', 2, []], ['components/NewPollModal.tsx', 1, []], ['components/ReviewModal.tsx', 1, []],
        ['components/AddedYouLines.tsx', 1, []], ['components/BlockedFriendRemove.tsx', 1, []], ['components/CreateGroupModal.tsx', 1, []],
        // The export's own throws are t() already; what else it shows is the node's or the platform's.
        ['app/(tabs)/ledger.tsx', 1, ["Alert.alert(t('Export Failed'), e.message || t('Could not export ledger.'));"]],
        // The load error is worded where it is drawn ({signedRequestWords(error)}, {chatLineWords(loadError)}).
        ['components/EventChatView.tsx', 3, ["setError(isWaitingForHost(e) ? eventChatWaitingText() : (e?.message || t('Could not open this event chat.')));"]],
        ['app/chat/[id].tsx', 4, ["setLoadError(e?.message || t('Could not open this chat.'));"]],
    ])('%s: %i through the table', (file, n, left) => {
        const src = source(file);
        expect(rawLines(src), file).toEqual(left);
        expect((src.match(/signedRequestWords\(/g) ?? []).length, file).toBeGreaterThanOrEqual(n);
    });

    it("a post's page: every db.ts refusal, the trade gate's last line, and the camera's own words as given", () => {
        const src = source('app/post/[id].tsx');
        expect(src).toContain("message: signedRequestWords(raw.replace(/^[A-Z_]+:\\s*/, '')) };");
        expect(src).toContain('{ reason: signedRequestWords(e.message) }');
        // What is left raw: the trade gate reading the message (worded on its way out, above), and the camera's own words.
        expect(rawLines(src)).toEqual([
            "const raw = String(e?.message || e || t('Something went wrong'));",
            "Alert.alert(t('Camera Unavailable'), e?.message || t('Could not launch camera.'));",
        ]);
        expect((src.match(/signedRequestWords\(/g) ?? []).length).toBeGreaterThanOrEqual(15);
    });

    it("People, a profile and Settings: a DM's start, a friend's add, an invite's redeem, holiday and preferences", () => {
        const people = source('app/(tabs)/people.tsx');
        const profile = source('app/public-profile.tsx');
        const settings = source('app/(tabs)/settings.tsx');
        for (const src of [people, profile]) {
            expect(src).toContain("isOffline ? t('Connect to your community to start a chat.') : signedRequestWords(e.message)");
            expect(src).toContain("e?.message ? signedRequestWords(e.message) : t('Your community did not add them.')");
        }
        expect(people).toContain("Alert.alert(t('Error'), signedRequestWords(e.message));");
        for (const src of [people, settings]) expect(src).toContain("Alert.alert(t('Redemption Failed'), welcomeLineWords(e.message));");
        expect(settings).toContain("e?.message ? signedRequestWords(e.message) : t('Please try again.')");
        expect(settings).toContain("e?.message ? signedRequestWords(e.message) : t('Your community could not save that.')");
    });

    it("the wrong-community screen, the address-follow card, an event's card and its next dates, and Talk's mute", () => {
        const mismatch = source('app/node-mismatch.tsx');
        expect(mismatch).toContain("e?.message ? settingsLineWords(e.message) : t('Could not switch to that community.')");
        expect(mismatch).toContain("e?.message ? settingsLineWords(e.message) : t(\"That invite doesn't look right.\")");
        expect(mismatch).toContain("e?.message ? welcomeLineWords(e.message) : t('Your join could not be completed. Please try again.')");
        expect(source('components/AddressFollowCard.tsx')).toContain('(e instanceof Error && e.message) ? settingsLineWords(e.message)');
        expect(source('components/EventCard.tsx')).toContain('err?.message ? eventLineWords(err.message)');
        expect(source('components/EventNextDates.tsx')).toContain('setProblem(eventLineWords(repeatRefusalText(e?.message))');
        expect(source('components/GroupChatView.tsx')).toContain("e?.message ? signedRequestWords(e.message) : t('Could not reach the node.')");
        // The event chat's load error is worded where it is drawn, so the waiting line (already the member's) passes through.
        expect(source('components/EventChatView.tsx')).toContain('accessibilityRole="alert">{signedRequestWords(error)}</Text>');
    });
});
