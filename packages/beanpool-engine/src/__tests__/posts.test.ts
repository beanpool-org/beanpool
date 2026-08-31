import { describe, it } from 'vitest';
import assert from 'node:assert';
import { generateSearchKeywords } from '../posts.js';

describe('Posts Search Keyword Expansion', () => {
    const synonymMap: Record<string, string[]> = {
        'lemon': ['citrus', 'fruit'],
        'cup of tea': ['chai', 'hot beverage'],
        '3d printer': ['additive manufacturing', 'rapid prototyping'],
    };

    it('expands single-word synonyms correctly', () => {
        const keywords = generateSearchKeywords('Fresh Lemon', 'Fresh organic lemons for sale', 'produce', synonymMap);
        assert.ok(keywords.includes('produce'));
        assert.ok(keywords.includes('citrus'));
        assert.ok(keywords.includes('fruit'));
    });

    it('expands multi-word n-gram synonyms containing short words correctly', () => {
        const keywords = generateSearchKeywords('Nice cup of tea', 'Enjoy a warm cup of tea', 'food', synonymMap);
        assert.ok(keywords.includes('food'));
        assert.ok(keywords.includes('chai'));
        assert.ok(keywords.includes('hot beverage'));
    });

    it('expands n-gram synonyms with numbers and abbreviations', () => {
        const keywords = generateSearchKeywords('Creality 3D printer', 'Fast 3d printer for hobbyists', 'tools', synonymMap);
        assert.ok(keywords.includes('tools'));
        assert.ok(keywords.includes('additive manufacturing'));
        assert.ok(keywords.includes('rapid prototyping'));
    });

    it('handles empty synonym map or missing synonyms gracefully', () => {
        const keywords = generateSearchKeywords('Guitar', 'Vintage electric guitar', 'music');
        assert.strictEqual(keywords, 'music');
    });
});
