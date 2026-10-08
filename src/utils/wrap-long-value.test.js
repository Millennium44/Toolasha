/** @vitest-environment happy-dom */

import { describe, test, expect } from 'vitest';
import { fitValueToBox, NOWRAP_VALUE_CHARS } from './wrap-long-value.js';

describe('fitValueToBox', () => {
    test('a short figure holds one line', () => {
        const element = fitValueToBox(document.createElement('span'), '1.2M');
        expect(element.style.whiteSpace).toBe('nowrap');
    });

    test('a sentence wraps inside its box and may shrink below its content', () => {
        const text = 'x'.repeat(NOWRAP_VALUE_CHARS + 1);
        const element = fitValueToBox(document.createElement('span'), text);
        expect(element.style.whiteSpace).toBe('normal');
        expect(element.style.minWidth).toBe('0');
        expect(element.style.overflowWrap).toBe('anywhere');
    });
});
