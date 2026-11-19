/**
 * The root layout reads a link as an invite only when it carries one (walk 147, low): a chat's link with an address in it,
 * `beanpool://chat/<id>?community=…`, was read as the invite "<id>" by extractInviteToken's last resort (the path's last
 * part), and with the address beside it raised "You're already in!". Every invite link the apps and the node make carries
 * `invite=` or an INV-/BP- code, so a link with neither is no invite; a scan with no scheme (a code alone) is read as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractInviteToken, isLinkWithoutInvite, normaliseInviteCode } from '../invite-parser';

const ADDRESS = 'https://riverside.example';
const CHAT = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

/** What app/_layout.tsx makes of a link once the named links before it (sign-in returns, pairing, doors, cards) are skipped. */
function layoutInvite(url: string): string | null {
    if (isLinkWithoutInvite(url)) return null;
    const token = extractInviteToken(url);
    if (!token || token.startsWith('http') || token.includes('/') || token.length < 5) return null;
    return normaliseInviteCode(token);
}

describe('a link with an address and no invite is not an invite', () => {
    const notInvites: Array<[string, string]> = [
        ['a chat, its address encoded', `beanpool://chat/${CHAT}?community=${encodeURIComponent(ADDRESS)}`],
        ['a chat, its address as typed', `beanpool://chat/${CHAT}?community=${ADDRESS}`],
        ['a chat with no address', `beanpool://chat/${CHAT}`],
        ['a listing, its address beside it', `beanpool://post/${CHAT}?community=${ADDRESS}`],
        ['a web address whose last part looks like a code', `${ADDRESS}/chat/${CHAT}`],
        ['the scheme in capitals', `BEANPOOL://CHAT/${CHAT}?community=${ADDRESS}`],
    ];
    it.each(notInvites)('%s', (_name, link) => {
        expect(isLinkWithoutInvite(link)).toBe(true);
        expect(layoutInvite(link)).toBeNull();
    });

    it('the last resort still reads a chat link\'s id as a code: the layout must not reach it', () => {
        expect(extractInviteToken(`beanpool://chat/${CHAT}?community=${ADDRESS}`)).toBe(CHAT);
    });
});

describe('an invite, by link or scan, is read as before', () => {
    const invites: Array<[string, string, string]> = [
        ['the invite link', `${ADDRESS}/?invite=INV-ABCD-EFGH`, 'INV-ABCD-EFGH'],
        ['the node\'s app link', `beanpool://welcome?invite=INV-ABCD-EFGH&server=${encodeURIComponent(ADDRESS)}`, 'INV-ABCD-EFGH'],
        ['invite and share', `${ADDRESS}/?invite=INV-ABCD-EFGH&post=${CHAT}`, 'INV-ABCD-EFGH'],
        ['an offline ticket', `beanpool://welcome?invite=BP-${'Q'.repeat(30)}`, `BP-${'Q'.repeat(30)}`],
        ['a code in the path', `${ADDRESS}/INV-ABCD-EFGH`, 'INV-ABCD-EFGH'],
        ['a scanned code alone', 'INV-ABCD-EFGH', 'INV-ABCD-EFGH'],
        ['an older short code, scanned', 'ABCD1234', 'INV-ABCD-1234'],
        ['the whole share message', `Join my BeanPool community node: ${ADDRESS}/?invite=INV-ABCD-EFGH`, 'INV-ABCD-EFGH'],
    ];
    it.each(invites)('%s', (_name, link, code) => {
        expect(isLinkWithoutInvite(link)).toBe(false);
        expect(layoutInvite(link)).toBe(code);
    });
});

describe('app/_layout.tsx', () => {
    it('skips a link without an invite before it reads one', () => {
        const layout = fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf8');
        const skip = layout.indexOf('if (isLinkWithoutInvite(currentUrl)) return;');
        expect(skip).toBeGreaterThan(-1);
        expect(skip).toBeLessThan(layout.indexOf('const inviteToken = extractInviteToken(currentUrl);'));
    });
});
