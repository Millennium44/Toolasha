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
        document.body.innerHTML = '<textarea placeholder="Paste character export"></textarea>';
        mocks.team = [{ name: 'Self', player: { attackLevel: 100 } }];
    });

    afterEach(() => {
        disable();
        vi.useRealTimers();
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

        expect(JSON.parse(textarea.value)).toEqual(mocks.team);
        expect(inputs).toEqual([JSON.stringify(mocks.team)]);
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
