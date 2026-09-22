/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ team: [{ name: 'Self', player: { attackLevel: 100 } }] }));

vi.mock('./combat-sim-export-metz.js', () => ({
    constructMetzTeamExport: vi.fn(async () => mocks.team),
}));
vi.mock('../../core/config.js', () => ({ default: { COLOR_ACCENT: '#123456' } }));

import { disable, initialize } from './combat-sim-integration-metz.js';

describe('Metz simulator page integration', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        window.history.replaceState(null, '', '?toolashaCharacterId=self-1');
        document.body.innerHTML = '<textarea placeholder="Paste character export"></textarea>';
        mocks.team = [{ name: 'Self', player: { attackLevel: 100 } }];
    });

    afterEach(() => {
        disable();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        window.history.replaceState(null, '', window.location.pathname);
        document.body.innerHTML = '';
    });

    test('mounts idempotently beside the import field and dispatches its team payload', async () => {
        const textarea = document.querySelector('textarea');
        const inputs = [];
        textarea.addEventListener('input', () => inputs.push(textarea.value));

        initialize();
        initialize();
        const button = document.querySelector('#toolasha-metz-import-button');
        expect(document.querySelectorAll('#toolasha-metz-import-button')).toHaveLength(1);
        expect(button.previousElementSibling).toBe(textarea);

        button.click();
        await vi.runAllTimersAsync();

        expect((await import('./combat-sim-export-metz.js')).constructMetzTeamExport).toHaveBeenCalledWith('self-1');
        expect(JSON.parse(textarea.value)).toEqual(mocks.team);
        expect(inputs).toEqual([JSON.stringify(mocks.team)]);
    });

    test('uses the native value setter so a controlled textarea receives the import', async () => {
        const textarea = document.querySelector('textarea');
        const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        const controlledSetter = vi.fn();
        Object.defineProperty(textarea, 'value', {
            configurable: true,
            get: () => descriptor.get.call(textarea),
            set: controlledSetter,
        });
        const inputs = [];
        textarea.addEventListener('input', () => inputs.push(descriptor.get.call(textarea)));

        initialize();
        document.querySelector('#toolasha-metz-import-button').click();
        await vi.runAllTimersAsync();

        expect(controlledSetter).not.toHaveBeenCalled();
        expect(inputs).toEqual([JSON.stringify(mocks.team)]);
    });

    test('does not import an ambiguous bridge when the page was not opened from a character', async () => {
        window.history.replaceState(null, '', window.location.pathname);
        vi.stubGlobal('alert', vi.fn());
        const { constructMetzTeamExport } = await import('./combat-sim-export-metz.js');
        constructMetzTeamExport.mockClear();

        initialize();
        document.querySelector('#toolasha-metz-import-button').click();
        await vi.runAllTimersAsync();

        expect(constructMetzTeamExport).not.toHaveBeenCalled();
        expect(alert).toHaveBeenCalledWith(expect.stringContaining('game page'));
    });

    test('warns instead of importing when another tab last synced a different character', async () => {
        vi.stubGlobal('alert', vi.fn());
        mocks.team = null;
        initialize();

        document.querySelector('#toolasha-metz-import-button').click();
        await vi.runAllTimersAsync();

        expect(alert).toHaveBeenCalledWith(expect.stringContaining('does not match'));
        expect(document.querySelector('textarea').value).toBe('');
    });

    test('cancels a pending DOM-ready start when disabled', () => {
        const body = document.body;
        body.remove();
        const observe = vi.spyOn(MutationObserver.prototype, 'observe');

        initialize();
        disable();
        document.documentElement.append(body);
        document.dispatchEvent(new Event('DOMContentLoaded'));

        expect(observe).not.toHaveBeenCalled();
    });

    test('remounts when the single-page setup field is replaced and cleans up', async () => {
        initialize();
        document.body.innerHTML = '<div><textarea placeholder="Import export"></textarea></div>';
        await vi.advanceTimersByTimeAsync(250);

        expect(document.querySelector('#toolasha-metz-import-button')?.previousElementSibling).toBe(
            document.querySelector('textarea')
        );

        disable();
        expect(document.querySelector('#toolasha-metz-import-button')).toBeNull();
    });
});
