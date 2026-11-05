import { describe, test, expect } from 'vitest';
import { shortCount, exactTitleAttr } from './short-count.js';

describe('shortCount', () => {
    test('shortens from 1,000 up', () => {
        expect(shortCount(1_234_567)).toBe('1.2M');
        expect(shortCount(12_345)).toBe('12.3K');
        expect(shortCount(1000)).toBe('1.0K');
        // 999.6 rounds to 1000 before shortening, so it reads 1.0K rather than "1000"
        expect(shortCount(999.6)).toBe('1.0K');
    });

    test('keeps a figure under 1,000 whole', () => {
        expect(shortCount(999)).toBe('999');
        expect(shortCount(42.4)).toBe('42');
        expect(shortCount(0)).toBe('0');
    });

    test('keeps the sign of a negative', () => {
        expect(shortCount(-5000)).toBe('-5.0K');
        expect(shortCount(-12)).toBe('-12');
    });

    test('an unknown value is a dash, never 0', () => {
        expect(shortCount(null)).toBe('—');
        expect(shortCount(undefined)).toBe('—');
        expect(shortCount(NaN)).toBe('—');
        expect(shortCount(Infinity)).toBe('—');
        expect(shortCount('12345')).toBe('—');
    });
});

describe('exactTitleAttr', () => {
    test('carries the exact figure only where the short form hides digits', () => {
        expect(exactTitleAttr(1_234_567)).toBe(' title="1,234,567"');
        expect(exactTitleAttr(-5000)).toBe(' title="-5,000"');
        expect(exactTitleAttr(999)).toBe('');
        expect(exactTitleAttr(0)).toBe('');
        expect(exactTitleAttr(0.4)).toBe('');
    });

    test('says nothing for an unknown value', () => {
        expect(exactTitleAttr(null)).toBe('');
        expect(exactTitleAttr(undefined)).toBe('');
        expect(exactTitleAttr(NaN)).toBe('');
    });
});
