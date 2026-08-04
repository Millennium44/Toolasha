/** @vitest-environment happy-dom */
/**
 * Tests for Marketplace Buy Modal Autofill Utility
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const observerState = vi.hoisted(() => ({ handlers: {} }));

vi.mock('../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn((name, _classNames, callback) => {
            observerState.handlers[name] = callback;
            return () => {
                delete observerState.handlers[name];
            };
        }),
    },
}));

const { createAutofillManager } = await import('./marketplace-autofill.js');

function buildModal({ headerText = 'Buy Now', inputs = [{ label: 'Quantity' }] } = {}) {
    const modal = document.createElement('div');
    const header = document.createElement('div');
    header.className = 'MarketplacePanel_header';
    header.textContent = headerText;
    modal.appendChild(header);

    for (const input of inputs) {
        const wrapper = document.createElement('div');
        wrapper.textContent = input.label || '';
        const el = document.createElement('input');
        el.type = 'number';
        wrapper.appendChild(el);
        modal.appendChild(wrapper);
    }
    document.body.appendChild(modal);
    return modal;
}

// Value setter shim: happy-dom supports value assignment directly via the native setter,
// so nativeInputValueSetter.call still works against a real <input>.
describe('createAutofillManager', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        observerState.handlers = {};
    });

    test('initialize() registers a domObserver handler under the given id', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.initialize();
        expect(observerState.handlers['Test-Observer']).toBeTypeOf('function');
    });

    test('fills the quantity input in a Buy Now modal and then clears the static quantity (one-shot)', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(42);
        manager.initialize();

        const modal = buildModal();
        observerState.handlers['Test-Observer'](modal);

        const input = modal.querySelector('input');
        expect(input.value).toBe('42');
        expect(manager.getQuantity()).toBeNull(); // one-shot cleared after use
    });

    test('does nothing when quantity is not set', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.initialize();
        const modal = buildModal();
        observerState.handlers['Test-Observer'](modal);
        expect(modal.querySelector('input').value).toBe('');
    });

    test('ignores modals whose header is not a Buy Now/Buy Listing modal', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(5);
        manager.initialize();
        const modal = buildModal({ headerText: 'Sell Now' });
        observerState.handlers['Test-Observer'](modal);
        // Input is untouched: the header didn't match, so no fill happened
        expect(modal.querySelector('input').value).toBe('');
    });

    test('setPendingCalculation takes priority and is recomputed on every modal open', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(999); // should be overridden
        let counter = 10;
        manager.setPendingCalculation(() => counter++);
        manager.initialize();

        const modal1 = buildModal();
        observerState.handlers['Test-Observer'](modal1);
        expect(modal1.querySelector('input').value).toBe('10');

        const modal2 = buildModal();
        observerState.handlers['Test-Observer'](modal2);
        expect(modal2.querySelector('input').value).toBe('11');
    });

    test('clearQuantity resets both static and pending quantity', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(5);
        manager.clearQuantity();
        expect(manager.getQuantity()).toBeNull();
    });

    test('finds the quantity input among multiple inputs, avoiding the enhancement level input', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(7);
        manager.initialize();

        const modal = buildModal({ inputs: [{ label: 'Enhancement Level' }, { label: 'Quantity' }] });
        observerState.handlers['Test-Observer'](modal);

        const inputs = modal.querySelectorAll('input');
        expect(inputs[0].value).toBe(''); // enhancement level untouched
        expect(inputs[1].value).toBe('7'); // quantity filled
    });

    test('cleanup() unregisters the observer and clears quantity', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(3);
        manager.initialize();
        manager.cleanup();

        expect(observerState.handlers['Test-Observer']).toBeUndefined();
        expect(manager.getQuantity()).toBeNull();
    });
});
