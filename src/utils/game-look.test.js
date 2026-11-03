/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { BUTTON_LOOK, setButtonRest, setButtonVariant, stopButtonHover, styleGameButton } from './game-look.js';

function press(button, type) {
    button.dispatchEvent(new MouseEvent(type, { bubbles: true }));
}

describe('styleGameButton hover', () => {
    it('hovers to the variant it was built with', () => {
        const button = styleGameButton(document.createElement('button'), 'quiet');
        press(button, 'mouseover');
        expect(button.style.background).toBe(BUTTON_LOOK.quiet.hover);
        press(button, 'mouseout');
        expect(button.style.background).toBe(BUTTON_LOOK.quiet.rest);
    });

    it('a button promoted to primary hovers to the primary hover, not the quiet one', () => {
        const button = styleGameButton(document.createElement('button'), 'quiet');
        setButtonVariant(button, 'primary');
        expect(button.style.background).toBe(BUTTON_LOOK.primary.rest);
        press(button, 'mouseover');
        expect(button.style.background).toBe(BUTTON_LOOK.primary.hover);
        press(button, 'mouseout');
        expect(button.style.background).toBe(BUTTON_LOOK.primary.rest);
    });

    it('a promoted button handed back to quiet hovers quiet again', () => {
        const button = styleGameButton(document.createElement('button'), 'quiet');
        setButtonVariant(button, 'primary');
        setButtonVariant(button, 'quiet');
        press(button, 'mouseover');
        expect(button.style.background).toBe(BUTTON_LOOK.quiet.hover);
    });

    it('setButtonRest takes an explicit hover, and leaves the hover alone when none is given', () => {
        const button = styleGameButton(document.createElement('button'), 'quiet');
        setButtonRest(button, 'var(--test-rest)', 'var(--test-hover)');
        press(button, 'mouseover');
        expect(button.style.background).toBe('var(--test-hover)');
        setButtonRest(button, 'var(--test-rest-two)');
        press(button, 'mouseover');
        expect(button.style.background).toBe('var(--test-hover)');
        press(button, 'mouseout');
        expect(button.style.background).toBe('var(--test-rest-two)');
    });

    it('a button handed back to a host stylesheet paints nothing inline on hover or mouseout', () => {
        const button = styleGameButton(document.createElement('button'), 'quiet');
        button.style.cssText = '';
        stopButtonHover(button);
        press(button, 'mouseover');
        expect(button.style.background).toBe('');
        press(button, 'mouseout');
        expect(button.style.background).toBe('');
    });
});
