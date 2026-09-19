import { describe, it, expect } from 'vitest';
import { communityName, realName, NODE_NAME_PLACEHOLDER } from '../community-name';

describe('communityName: one name for a community, used by the BeanPool sheet heading and its list', () => {
    it("prefers the node's own name over the saved alias", () => {
        expect(communityName({ url: 'https://mullum.example', nodeName: 'Mullumbimby', alias: 'mullum' })).toBe('Mullumbimby');
    });

    it('falls back to the saved alias before the node has answered', () => {
        expect(communityName({ url: 'https://mullum.example', alias: 'Mullumbimby' })).toBe('Mullumbimby');
    });

    it('never shows the node placeholder as a name', () => {
        expect(communityName({ url: 'https://x.example:8443/', nodeName: NODE_NAME_PLACEHOLDER, alias: NODE_NAME_PLACEHOLDER })).toBe('x.example:8443');
        expect(realName(`  ${NODE_NAME_PLACEHOLDER} `)).toBeNull();
    });

    it('ends at the host, and at BeanPool with no community at all', () => {
        expect(communityName({ url: 'https://test.beanpool.org', nodeName: '  ', alias: '' })).toBe('test.beanpool.org');
        expect(communityName({ url: 'not a url/path' })).toBe('not a url');
        expect(communityName({})).toBe('BeanPool');
    });

    it('ignores a name that is not a string', () => {
        expect(communityName({ url: 'https://a.example', nodeName: 42 as unknown, alias: 'A' })).toBe('A');
    });
});
