/**
 * @vitest-environment happy-dom
 *
 * Regression coverage for the taskProfitDisplay decoupling.
 *
 * The registry's customCheck and the module's own initialize() repeated the
 * same list of settings that keep the module alive
 * (taskProfitCalculator/taskGoMerge/taskQueuedIndicator/taskMaterialsIndicator/
 * taskEfficiencyRating), but left out taskCombatEstimate ("Show combat
 * estimate on combat tasks"). With every other setting off, the module never
 * initialized and a combat task card never got its estimate. This file pins
 * taskCombatEstimate into both lists (via a source check on the registry
 * entry) and proves a combat task card gets the estimate — and no profit
 * line — with taskCombatEstimate as the only setting on.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import taskProfitDisplay from './task-profit-display.js';
import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';

vi.mock('./task-profit-calculator.js', () => ({
    // null signals "combat task, not calculable" — the branch that decides
    // between the profit line and the combat estimate UI.
    calculateTaskProfit: vi.fn(async () => null),
    calculateTaskRewardValue: vi.fn(() => ({})),
}));

describe('entrypoint.js registry gate for taskProfitDisplay', () => {
    test("the 'taskProfitDisplay' entry's customCheck is the module's own shouldEnable()", () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const entrypointSrc = readFileSync(path.join(here, '..', '..', 'entrypoint.js'), 'utf8');

        const keyIndex = entrypointSrc.indexOf("key: 'taskProfitDisplay',");
        expect(keyIndex).toBeGreaterThan(-1);
        const entryText = entrypointSrc.slice(keyIndex, keyIndex + 700);
        expect(entryText).toMatch(/customCheck:\s*\(\)\s*=>\s*UI\.taskProfitDisplay\.shouldEnable\(\)/);
    });

    test.each([
        'taskProfitCalculator',
        'taskGoMerge',
        'taskQueuedIndicator',
        'taskMaterialsIndicator',
        'taskEfficiencyRating',
        'taskCombatEstimate',
    ])('shouldEnable() is true with only %s on', (only) => {
        const spy = vi.spyOn(config, 'getSetting').mockImplementation((key) => key === only);
        try {
            expect(taskProfitDisplay.shouldEnable()).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('taskProfitDisplay: live switches', () => {
    let on;

    beforeEach(() => {
        on = new Set();
        vi.spyOn(config, 'getSetting').mockImplementation((key) => on.has(key));
        vi.spyOn(dataManager, 'getInitClientData').mockReturnValue({ actionDetailMap: {} });
        taskProfitDisplay.disable();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        taskProfitDisplay.disable();
        vi.restoreAllMocks();
    });

    const flip = (key, value) => {
        if (value) on.add(key);
        else on.delete(key);
        config._notifySettingChange(key, value);
    };

    test('switching the profit line off keeps the module up for the combat estimate', () => {
        on.add('taskProfitCalculator');
        on.add('taskCombatEstimate');
        taskProfitDisplay.initialize();
        expect(taskProfitDisplay.isInitialized).toBe(true);

        flip('taskProfitCalculator', false);

        expect(taskProfitDisplay.isInitialized).toBe(true);
    });

    test('after the module stopped itself, any one task setting switched on restarts it', () => {
        on.add('taskProfitCalculator');
        taskProfitDisplay.initialize();
        flip('taskProfitCalculator', false);
        expect(taskProfitDisplay.isInitialized).toBe(false);

        // The registry already counts this module as started, so it will not start it again
        flip('taskCombatEstimate', true);

        expect(taskProfitDisplay.isInitialized).toBe(true);
    });

    test('switching off the last one stops it, whichever one it is', () => {
        on.add('taskGoMerge');
        taskProfitDisplay.initialize();
        expect(taskProfitDisplay.isInitialized).toBe(true);

        flip('taskGoMerge', false);

        expect(taskProfitDisplay.isInitialized).toBe(false);
    });
});

describe('taskProfitDisplay: only taskCombatEstimate on', () => {
    const onlyTaskCombatEstimate = (key) => key === 'taskCombatEstimate';

    beforeEach(() => {
        vi.spyOn(config, 'getSetting').mockImplementation(onlyTaskCombatEstimate);
        vi.spyOn(dataManager, 'getInitClientData').mockReturnValue({ actionDetailMap: {} });
        vi.spyOn(expectedValueCalculator, 'isInitialized', 'get').mockReturnValue(true);
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * A task card DOM node shaped the way parseTaskData reads it: a name div,
     * an action container (where the estimate/profit UI is appended), a
     * rewards block and a progress line.
     * @returns {Element} task card node
     */
    function buildTaskNode() {
        const taskNode = document.createElement('div');
        taskNode.innerHTML = `
            <div class="RandomTask_name_x">Kill Rats</div>
            <div class="RandomTask_action_x"></div>
            <div class="RandomTask_rewards_x"></div>
            <div>Progress: 0 / 10</div>
        `;
        return taskNode;
    }

    test('a combat task card gets the estimate config UI and no profit line', async () => {
        const taskNode = buildTaskNode();

        await taskProfitDisplay.addProfitToTask(taskNode);

        const actionNode = taskNode.querySelector('.RandomTask_action_x');
        const injected = actionNode.querySelectorAll('.mwi-task-profit');

        // The hidden reroll-detection marker plus the estimate config block —
        // never a rendered profit line (that only exists on non-combat tasks).
        expect(injected.length).toBeGreaterThan(0);
        const text = actionNode.textContent;
        expect(text).not.toMatch(/💰/);
    });
});
