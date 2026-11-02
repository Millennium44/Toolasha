/** @vitest-environment happy-dom */
/**
 * Tests for Choice Dialog
 */
import { describe, test, expect, afterEach } from 'vitest';
import { askChoice } from './choice-dialog.js';
import { GAME_COLORS, GAME_FRAME } from './game-look.js';

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

describe('askChoice look', () => {
    test('the dialog uses the game frame and a white title', async () => {
        const promise = askChoice({ title: 'Restore?', message: 'm', choices: [{ value: 'x', label: 'X' }] });
        const dialog = backdrop().firstElementChild;
        expect(dialog.style.background).toBe(GAME_FRAME.background);
        expect(dialog.style.border).toContain('1px solid');
        expect(dialog.style.boxShadow).not.toBe('');
        expect(dialog.firstElementChild.style.color).toBe(GAME_COLORS.text);
        document.body.querySelector('button').click();
        await promise;
    });

    test('a danger choice is filled in the game warning color, the others blue, and the first stays focused', async () => {
        const promise = askChoice({
            title: 'T',
            choices: [
                { value: 'keep', label: 'Keep' },
                { value: 'main', label: 'Main', tone: 'primary' },
                { value: 'wipe', label: 'Wipe', tone: 'danger' },
            ],
        });
        const [keep, main, wipe] = document.body.querySelectorAll('button');
        expect(wipe.style.background).toContain('--color-warning');
        expect(keep.style.background).toContain('--color-space-800');
        expect(main.style.background).toContain('--color-primary');
        wipe.dispatchEvent(new Event('mouseover'));
        expect(wipe.style.background).toContain('--color-warning-hover');
        wipe.dispatchEvent(new Event('mouseout'));
        expect(wipe.style.background).toContain('--color-warning, ');
        expect(document.activeElement).toBe(keep);
        wipe.click();
        expect(await promise).toBe('wipe');
    });
});
