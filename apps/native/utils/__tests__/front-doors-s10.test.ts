/**
 * Front doors S10 (DESIGN-entry-points-fable.md §3.2 item 1 and §3.5): Join with an invite gets Scan a QR code beside Paste, and
 * the restore changes: Recover with Social asks "Which community?" first, and nothing is asked of the phone after a restore.
 * (Restore as the third button, and its place above the fold, are in welcome-doors-render.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inviteFromScan } from '../invite-scan';

const welcome = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf-8');
/** The source from one marker to the next, comments out. */
const between = (from: string, to: string) => {
    const a = welcome.indexOf(from);
    expect(a, from).toBeGreaterThan(-1);
    const b = welcome.indexOf(to, a + from.length);
    expect(b, to).toBeGreaterThan(a);
    return welcome.slice(a, b).replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
};

describe('what Scan a QR code takes as an invite', () => {
    it('takes an invite link, a code and an offline ticket, as pasted ones are', () => {
        expect(inviteFromScan('https://mullum.beanpool.org/?invite=INV-ABCD-EFGH')).toBe('https://mullum.beanpool.org/?invite=INV-ABCD-EFGH');
        expect(inviteFromScan('  INV-ABCD-EFGH\n')).toBe('INV-ABCD-EFGH');
        expect(inviteFromScan('BP-eyJhIjoxfQ')).toBe('BP-eyJhIjoxfQ');
        // A link made for a post carries its invite too (invite-and-share).
        expect(inviteFromScan('https://mullum.beanpool.org/?invite=INV-ABCD-EFGH&post=p1')).toContain('invite=INV-ABCD-EFGH');
    });

    it('refuses everything else, so the camera keeps reading', () => {
        for (const other of ['https://beanpool.org', 'https://mullum.beanpool.org', 'mullum.beanpool.org', 'hello', '', '   ', null, undefined, 42, {}]) {
            expect(inviteFromScan(other), String(other)).toBeNull();
        }
    });
});

describe('Join with an invite: Scan a QR code, beside Paste', () => {
    const create = between("    if (mode === 'create') {", '// --- THE GLOBAL COMMUNITY\'S DOOR');

    it('is a button in the join step, after the paste offer and before the code field', () => {
        const scan = create.indexOf('testID="join-scan-invite"');
        expect(scan).toBeGreaterThan(-1);
        expect(scan).toBeGreaterThan(create.indexOf('pasteCard'));
        expect(scan).toBeLessThan(create.indexOf("placeholder={t('Paste your invite link or code')}"));
        expect(create).toContain("{t('Scan a QR code')}");
        // A 48 dp target.
        expect(welcome).toMatch(/\n\s*scanInviteBtn: \{[^}]*minHeight: 48/);
    });

    it('opens the claim\'s camera screen (ScanCodeModal) and hands an invite to the invite step', () => {
        expect(create).toContain('<Scanner');
        expect(create).toContain('onRead={onInviteScanned}');
        expect(welcome).toMatch(/const onInviteScanned = \(data: string\): boolean => \{\s*const raw = inviteFromScan\(data\);\s*if \(!raw\) return false;[\s\S]*?applyInviteContent\(raw, 'join'\)[\s\S]*?return true;/);
    });

    it('asks for the camera only at the tap: the camera screen is loaded then, and the welcome screen never asks', () => {
        expect(welcome).toMatch(/const openInviteScanner = async \(\) => \{\s*const m = await import\('\.\.\/components\/ScanCodeModal'\);/);
        expect(welcome).not.toMatch(/^import .*ScanCodeModal/m);
        expect(welcome).not.toContain('expo-camera');
        expect(welcome).not.toContain('useCameraPermissions');
        // The permission is the camera screen's own, asked when it opens (components/ScanCodeModal.tsx).
        const modal = fs.readFileSync(path.resolve(__dirname, '../../components/ScanCodeModal.tsx'), 'utf-8');
        expect(modal).toContain('requestPermission()');
        // A refusal says what to do instead: here, paste the invite.
        expect(create).toContain("t('Allow the camera for BeanPool in your phone settings, or paste your invite below.')");
    });
});

describe('Recover with Social asks "Which community?" first', () => {
    it('without a key vault: the chips come before the sign-ins, no name is asked, and the address is typed only for another address', () => {
        const screen = between("    if (mode === 'ssoRecover' && (!hasVault() || ssoAtCommunity)) {", "    if (mode === 'ssoRecover') {");
        const chips = screen.indexOf('<RestoreCommunityChips');
        expect(chips).toBeGreaterThan(-1);
        // The sign-in finds the account (recovery S2): the callsign field is gone.
        expect(screen).not.toContain("accessibilityLabel={t('Callsign')}");
        expect(screen).not.toContain('Your Callsign');
        expect(chips).toBeLessThan(screen.indexOf("handleSsoRecoverAtCommunity('google')"));
        // The old "your communities on this phone" list is gone from this screen: the chips are the same choice.
        expect(screen).not.toContain('<SavedNodePicker');
        // The address field is drawn only for "another address" (or before anything is chosen).
        expect(screen).toMatch(/\{anotherAddress && \(\s*<TextInput/);
        // ...decided by what the member did, never by what the text spells (typing the bare name `global` is a chip's address).
        expect(screen).toContain('const anotherAddress = addressFieldShown(anchorAddressPick, recoveryAnchorUrl, restoreCommunityChoices(savedNodes));');
        expect(screen).toContain('pick={anchorAddressPick}');
        expect(screen).toContain("onChangeText={(text) => { setAnchorAddressPick('another'); setRecoveryAnchorUrl(text); }}");
        expect(screen).not.toContain('chosenRestoreChoice');
        expect(screen).toContain("'Choose your community, then sign in with the account you linked. It finds your account, so there is nothing else to type.'");
        // The restore itself and its address checks are the same as before.
        expect(screen).toContain('handleSsoRecoverAtCommunity');
    });

    it('with a key vault: the chips come before the sign-in buttons, and the 12 words are offered beside the day\'s wait', () => {
        const a = welcome.indexOf("The sign-in finds your account: there's no name or address to type.");
        expect(a).toBeGreaterThan(-1);
        const step = welcome.slice(a, welcome.indexOf('{!waitingUntil && (', a));
        const chips = step.indexOf('<RestoreCommunityChips');
        expect(chips).toBeGreaterThan(-1);
        expect(chips).toBeLessThan(step.indexOf("handleSsoRecover('google')"));
        // The day's wait is explained in the same words as today, and the 12 words come after the buttons as the fast path.
        expect(step).toContain("For your safety it takes a day, or less if another phone of yours says it's you.");
        expect(step.indexOf("t('🔑 Use my 12 words instead')")).toBeGreaterThan(step.indexOf("handleSsoRecover('facebook')"));
        expect(step).toContain("handleSsoStartAgain('recover')");
    });

    it('what the member picked before signing in is not overwritten by the copy\'s own first community', () => {
        expect(welcome).toContain('const ssoCommunityPicked = useRef(false);');
        expect(welcome).toContain('if (first && !ssoCommunityPicked.current) setSsoCommunity(fieldTextFor(first.url));');
        const step = between("The sign-in finds your account: there's no name or address to type.", '{!waitingUntil && (');
        expect(step).toContain('ssoCommunityPicked.current = true');
    });

    it('with a key vault too, the address field follows what the member did, not what the text spells', () => {
        const step = between("The sign-in finds your account: there's no name or address to type.", '{!waitingUntil && (');
        expect(step).toContain('pick={ssoAddressPick}');
        expect(step).toContain('{addressFieldShown(ssoAddressPick, ssoCommunity, restoreCommunityChoices(savedNodes)) && (');
        expect(step).toContain("onChangeText={(text) => { ssoCommunityPicked.current = true; setSsoAddressPick('another'); setSsoCommunity(text); }}");
        expect(step).not.toContain('chosenRestoreChoice');
    });
});

describe('no permission prompt after a restore', () => {
    // The restored member lands on Home; the notifications card (S3, utils/notification-permission.ts) says why and asks when tapped.
    const body = (name: string) => {
        const a = welcome.indexOf(`async function ${name}(`);
        expect(a, name).toBeGreaterThan(-1);
        const b = welcome.indexOf('\n    }\n', a);
        return welcome.slice(a, b);
    };
    for (const fn of ['handleRecover', 'handleSsoRecoverAtCommunity', 'handleSsoRecover', 'handleSsoFinish']) {
        it(`${fn} asks for no permission`, () => {
            expect(body(fn)).not.toMatch(/otification|requestPermission|PermissionsAsync|registerForPush|turnOn/);
        });
    }

    it('the only place welcome asks for notifications is the tap on the onboarding guide\'s card', () => {
        const uses = Array.from(welcome.matchAll(/turnOnNotifications\(/g)).length;
        expect(uses).toBe(1);
        expect(welcome.indexOf('turnOnNotifications(pendingIdentity')).toBeGreaterThan(welcome.indexOf("if (mode === 'onboardingGuide' && pendingIdentity)"));
    });
});

describe('the new invite message, pasted whole into Join with an invite', () => {
    // A friend whose link does not open copies the whole message: the invite step reads the community and the code out of it,
    // as it does from the old message.
    it('gives back the community address and the code', async () => {
        const { inviteShareText, shareAddress } = await import('@beanpool/core');
        const { extractNodeOrigin, extractInviteToken } = await import('../invite-parser');
        const origin = 'https://mullum.beanpool.org';
        const message = inviteShareText({ name: 'Mullum', link: `${origin}/?invite=INV-ABCD-EFGH`, code: 'INV-ABCD-EFGH', address: shareAddress(origin) });
        expect(extractNodeOrigin(message)).toBe(origin);
        expect(extractInviteToken(message)).toBe('INV-ABCD-EFGH');
    });
});
