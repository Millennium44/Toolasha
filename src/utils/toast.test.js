/** @vitest-environment happy-dom */

/**
 * What a shared toast has to get right that the two ad-hoc ones did not:
 * a second message must not replace the first, and anything it puts on screen
 * must be removable — by the player, by a timer, or by teardown. The stack is
 * the whole point of replacing them, so it is the thing under test.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// The real one reaches through config into storage, and none of that is what a
// toast test is about
vi.mock('./panel-z-index.js', () => ({ PANEL_Z_CAP: 1199 }));

import { showToast, dismissAllToasts, activeToastCount, TOAST_CONTAINER_ID } from './toast.js';

const container = () => document.getElementById(TOAST_CONTAINER_ID);
const toasts = () => [...document.querySelectorAll('.toolasha-toast')];

describe('toast', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        dismissAllToasts();
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
    });

    test('stacks rather than replacing', () => {
        showToast('first');
        showToast('second');

        expect(toasts().map((el) => el.textContent)).toEqual(['first✕', 'second✕']);
        expect(activeToastCount()).toBe(2);
    });

    test('sits above every floating panel', () => {
        showToast('over the panels');
        expect(container().style.zIndex).toBe('1200');
    });

    test('drops the oldest once the stack is too tall', () => {
        for (let i = 1; i <= 6; i++) showToast(`msg ${i}`);

        const remaining = toasts().map((el) => el.textContent);
        expect(remaining).toHaveLength(4);
        expect(remaining[0]).toContain('msg 3');
        expect(remaining[3]).toContain('msg 6');
    });

    test('the dismiss button takes only its own toast away', () => {
        showToast('keep me');
        const doomed = showToast('close me');

        doomed.element.querySelector('.toolasha-toast-dismiss').click();

        expect(toasts().map((el) => el.textContent)).toEqual(['keep me✕']);
        expect(activeToastCount()).toBe(1);
    });

    test('expires on its own, and takes the container with the last one', () => {
        showToast('brief', { duration: 1000 });
        expect(activeToastCount()).toBe(1);

        vi.advanceTimersByTime(1000);
        expect(activeToastCount()).toBe(0);

        // The fade runs before the node goes, so the container outlives it
        vi.advanceTimersByTime(300);
        expect(toasts()).toHaveLength(0);
        expect(container()).toBeNull();
    });

    test('duration 0 stays up', () => {
        showToast('sticky', { duration: 0 });
        vi.advanceTimersByTime(60_000);
        expect(activeToastCount()).toBe(1);
    });

    test('an action makes the body clickable and closes the toast', () => {
        const onClick = vi.fn();
        const handle = showToast('N features failed to start', {
            kind: 'warn',
            duration: 0,
            action: { label: 'Show which ones', onClick },
        });

        expect(handle.element.querySelector('.toolasha-toast-action').textContent).toBe('Show which ones');

        handle.element.click();

        expect(onClick).toHaveBeenCalledTimes(1);
        expect(activeToastCount()).toBe(0);
    });

    test('dismissing does not fire the action', () => {
        const onClick = vi.fn();
        const handle = showToast('ignore me', { duration: 0, action: { label: 'Details', onClick } });

        handle.element.querySelector('.toolasha-toast-dismiss').click();

        expect(onClick).not.toHaveBeenCalled();
        expect(activeToastCount()).toBe(0);
    });

    test('an action that throws does not leave the toast wedged', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const handle = showToast('boom', {
            duration: 0,
            action: {
                label: 'Details',
                onClick: () => {
                    throw new Error('nope');
                },
            },
        });

        handle.element.click();

        expect(activeToastCount()).toBe(0);
    });

    test('kind chooses the styling and the urgency it announces', () => {
        const error = showToast('bad', { kind: 'error', duration: 0 });
        expect(error.element.className).toContain('toolasha-toast-error');
        expect(error.element.getAttribute('role')).toBe('alert');

        const info = showToast('fine', { duration: 0 });
        expect(info.element.getAttribute('role')).toBe('status');
    });

    test('the message is text, never markup', () => {
        const handle = showToast('<img src=x onerror=alert(1)>', { duration: 0 });
        expect(handle.element.querySelector('img')).toBeNull();
        expect(handle.element.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    test('dismissAllToasts clears the stack and the container', () => {
        showToast('a', { duration: 0 });
        showToast('b', { duration: 0 });

        dismissAllToasts();

        expect(activeToastCount()).toBe(0);
        expect(container()).toBeNull();
    });
});
