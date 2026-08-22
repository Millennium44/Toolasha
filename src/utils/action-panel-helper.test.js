/** @vitest-environment happy-dom */
/**
 * Tests for Action Panel Display Helper
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
    findActionInput,
    attachInputListeners,
    performInitialUpdate,
    refreshActionPanels,
} from './action-panel-helper.js';

beforeEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
});

function buildPanel() {
    const panel = document.createElement('div');
    const container = document.createElement('div');
    container.className = 'maxActionCountInput_wrapper';
    const input = document.createElement('input');
    container.appendChild(input);
    panel.appendChild(container);
    document.body.appendChild(panel);
    return { panel, input };
}

describe('refreshActionPanels', () => {
    test('re-runs the callback for every mounted panel with its current input value', () => {
        const a = buildPanel();
        a.panel.className = 'SkillActionDetail_skillActionDetail__x';
        a.input.value = '12';
        const b = buildPanel();
        b.panel.className = 'SkillActionDetail_skillActionDetail__x';
        b.input.value = '7';
        // A panel with no input is skipped rather than called with undefined
        const bare = document.createElement('div');
        bare.className = 'SkillActionDetail_skillActionDetail__x';
        document.body.appendChild(bare);

        const calls = [];
        refreshActionPanels((panel, value) => calls.push([panel, value]));
        expect(calls).toEqual([
            [a.panel, '12'],
            [b.panel, '7'],
        ]);
    });
});

describe('findActionInput', () => {
    test('finds the input nested inside the maxActionCountInput container', () => {
        const { panel, input } = buildPanel();
        expect(findActionInput(panel)).toBe(input);
    });

    test('returns null when the container is missing', () => {
        const panel = document.createElement('div');
        expect(findActionInput(panel)).toBeNull();
    });

    test('returns null when the container has no input inside', () => {
        const panel = document.createElement('div');
        const container = document.createElement('div');
        container.className = 'maxActionCountInput_x';
        panel.appendChild(container);
        expect(findActionInput(panel)).toBeNull();
    });
});

describe('attachInputListeners', () => {
    test('fires the callback on keyup and input events with the current value', () => {
        const { panel, input } = buildPanel();
        input.value = '5';
        const updateCallback = vi.fn();
        attachInputListeners(panel, input, updateCallback);

        input.dispatchEvent(new Event('keyup'));
        expect(updateCallback).toHaveBeenCalledWith('5');

        input.value = '10';
        input.dispatchEvent(new Event('input'));
        expect(updateCallback).toHaveBeenCalledWith('10');
    });

    test('panel clicks fire the callback after the configured delay, skipping clicks on the input itself', () => {
        vi.useFakeTimers();
        const { panel, input } = buildPanel();
        input.value = '3';
        const updateCallback = vi.fn();
        attachInputListeners(panel, input, updateCallback, { clickDelay: 50 });

        // Click on the input itself: should be skipped
        input.dispatchEvent(new Event('click', { bubbles: true }));
        vi.advanceTimersByTime(100);
        expect(updateCallback).not.toHaveBeenCalled();

        // Click elsewhere in the panel: should fire after delay
        panel.dispatchEvent(new Event('click', { bubbles: true }));
        expect(updateCallback).not.toHaveBeenCalled(); // not yet
        vi.advanceTimersByTime(50);
        expect(updateCallback).toHaveBeenCalledWith('3');

        vi.useRealTimers();
    });

    test('the returned cleanup function removes all listeners', () => {
        const { panel, input } = buildPanel();
        const updateCallback = vi.fn();
        const cleanup = attachInputListeners(panel, input, updateCallback);

        cleanup();
        input.dispatchEvent(new Event('keyup'));
        expect(updateCallback).not.toHaveBeenCalled();
    });
});

describe('performInitialUpdate', () => {
    test('calls the callback and returns true when the input already has a value', () => {
        const input = document.createElement('input');
        input.value = '99';
        const updateCallback = vi.fn();

        expect(performInitialUpdate(input, updateCallback)).toBe(true);
        expect(updateCallback).toHaveBeenCalledWith('99');
    });

    test('does nothing and returns false for an empty input', () => {
        const input = document.createElement('input');
        const updateCallback = vi.fn();

        expect(performInitialUpdate(input, updateCallback)).toBe(false);
        expect(updateCallback).not.toHaveBeenCalled();
    });
});
