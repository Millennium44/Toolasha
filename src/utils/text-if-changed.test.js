/** @vitest-environment happy-dom */
import { describe, test, expect } from 'vitest';
import { setTextIfChanged } from './text-if-changed.js';

describe('setTextIfChanged', () => {
    test('leaves an element that already shows the text untouched', async () => {
        const el = document.createElement('div');
        el.textContent = '12K';
        const records = [];
        const observer = new MutationObserver((m) => records.push(...m));
        observer.observe(el, { childList: true, characterData: true, subtree: true });
        expect(setTextIfChanged(el, '12K')).toBe(false);
        records.push(...observer.takeRecords());
        observer.disconnect();
        expect(records).toHaveLength(0);
    });

    test('writes changed text, including to empty', () => {
        const el = document.createElement('div');
        expect(setTextIfChanged(el, '5M')).toBe(true);
        expect(el.textContent).toBe('5M');
        expect(setTextIfChanged(el, '')).toBe(true);
        expect(el.textContent).toBe('');
    });
});
