import { describe, it, expect } from 'vitest';
import { deviceLang } from '../feedback-context';

describe('deviceLang', () => {
    it('passes a plain BCP-47 tag through', () => {
        expect(deviceLang(() => 'es-AR')).toBe('es-AR');
        expect(deviceLang(() => 'sw')).toBe('sw');
        expect(deviceLang(() => 'zh-Hant-TW')).toBe('zh-Hant-TW');
    });

    it('strips Unicode extensions and normalises underscores', () => {
        expect(deviceLang(() => 'hi-IN-u-nu-latn')).toBe('hi-IN');
        expect(deviceLang(() => 'pt_BR')).toBe('pt-BR');
    });

    it('returns null rather than sending junk or throwing', () => {
        expect(deviceLang(() => undefined)).toBeNull();
        expect(deviceLang(() => 'not a locale')).toBeNull();
        expect(deviceLang(() => { throw new Error('no Intl'); })).toBeNull();
    });
});
