/** @vitest-environment happy-dom */
/**
 * Tests for Choice Dialog
 */
import { describe, test, expect, afterEach } from 'vitest';
import { askChoice } from './choice-dialog.js';

function backdrop() {
    return document.body.querySelector('div');
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('askChoice', () => {
    test('resolves with the value of the clicked choice', async () => {
        const promise = askChoice({
            title: 'Add or replace?',
            choices: [
                { value: 'add', label: 'Add' },
                { value: 'replace', label: 'Replace' },
            ],
        });

        const buttons = document.body.querySelectorAll('button');
        expect(buttons).toHaveLength(2);
        expect(buttons[0].textContent).toBe('Add');
        buttons[1].dispatchEvent(new Event('click', { bubbles: true }));

        expect(await promise).toBe('replace');
    });

    test('removes the dialog from the DOM after resolving', async () => {
        const promise = askChoice({ title: 'T', choices: [{ value: 'x', label: 'X' }] });
        document.body.querySelector('button').click();
        await promise;
        expect(document.body.children).toHaveLength(0);
    });

    test('resolves null when Escape is pressed', async () => {
        const promise = askChoice({ title: 'T', choices: [{ value: 'x', label: 'X' }] });
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(await promise).toBeNull();
    });

    test('resolves null on clicking the backdrop but not the dialog body', async () => {
        const promise = askChoice({ title: 'T', message: 'body text', choices: [{ value: 'x', label: 'X' }] });
        const backdropEl = backdrop();
        // Click directly on backdrop (event.target === backdrop)
        backdropEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(await promise).toBeNull();
    });

    test('clicking inside the dialog does not dismiss it', async () => {
        const promise = askChoice({ title: 'T', choices: [{ value: 'x', label: 'X' }] });
        const dialogInner = backdrop().firstElementChild; // the dialog box itself
        dialogInner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        // Still pending: resolve for real via button click
        const button = document.body.querySelector('button');
        button.click();
        expect(await promise).toBe('x');
    });

    test('only resolves once even if triggered multiple times', async () => {
        const promise = askChoice({
            title: 'T',
            choices: [
                { value: 'a', label: 'A' },
                { value: 'b', label: 'B' },
            ],
        });
        const buttons = document.body.querySelectorAll('button');
        buttons[0].click();
        buttons[1].click(); // second click should be ignored (already settled)
        expect(await promise).toBe('a');
    });

    test('renders a hint as the button title attribute', async () => {
        const promise = askChoice({
            title: 'T',
            choices: [{ value: 'x', label: 'X', hint: 'Explains X' }],
        });
        expect(document.body.querySelector('button').title).toBe('Explains X');
        document.body.querySelector('button').click();
        await promise;
    });
});
