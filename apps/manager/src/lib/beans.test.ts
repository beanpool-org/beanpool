import { describe, it, expect } from 'vitest';
import { beansFigure, beansText, beansInputText, parseBeans, typedHundredths, beansRefusalText } from './beans';

/** The console's one way to say and read Beans: whole hundredths, through core's hundredths.ts (DESIGN-atomic-beans T6). */
describe('beans', () => {
    it('says whole hundredths as Beans: no decimals when whole, two otherwise, a true minus, grouped', () => {
        expect(beansFigure(1)).toBe('0.01');
        expect(beansFigure(100)).toBe('1');
        expect(beansFigure(4925)).toBe('49.25');
        expect(beansFigure(4950)).toBe('49.50');
        expect(beansFigure(-982)).toBe('−9.82');
        expect(beansFigure(50000)).toBe('500');
        expect(beansFigure(123456)).toBe('1,234.56');
        expect(beansText(4925)).toBe('49.25 Beans');
    });

    it('says "—" for anything that is not whole hundredths, never a number', () => {
        for (const v of [12.5, '4925', NaN, Infinity, null, undefined]) expect(beansFigure(v)).toBe('—');
        expect(beansText(undefined)).toBe('— Beans');
    });

    it('starts an amount box from a figure as plain text, never grouped', () => {
        expect(beansInputText(100000)).toBe('1000');
        expect(beansInputText(1250)).toBe('12.50');
        expect(beansInputText(-982)).toBe('-9.82');
        expect(beansInputText(12.5)).toBe('');
    });

    it('reads typed Beans as whole hundredths by string work, and refuses what is not one', () => {
        expect(typedHundredths('49.25')).toBe(4925);
        expect(typedHundredths('0.5')).toBe(50);
        expect(typedHundredths('12')).toBe(1200);
        expect(typedHundredths(' 1000 ')).toBe(100000);
        expect(parseBeans('12.505')).toEqual({ ok: false, refusal: 'too-many-decimals' });
        expect(parseBeans('1,000')).toEqual({ ok: false, refusal: 'grouped' });
        expect(parseBeans('-5')).toEqual({ ok: false, refusal: 'negative' });
        expect(parseBeans('')).toEqual({ ok: false, refusal: 'empty' });
        expect(beansRefusalText('too-many-decimals')).toBe('Type at most 2 decimals, like 12.5.');
    });
});
