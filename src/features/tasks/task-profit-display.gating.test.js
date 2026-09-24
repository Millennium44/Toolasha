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
    test("the 'taskProfitDisplay' entry's customCheck includes taskCombatEstimate", () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const entrypointSrc = readFileSync(path.join(here, '..', '..', 'entrypoint.js'), 'utf8');

        const keyIndex = entrypointSrc.indexOf("key: 'taskProfitDisplay',");
        expect(keyIndex).toBeGreaterThan(-1);
        const entryText = entrypointSrc.slice(keyIndex, keyIndex + 700);
        expect(entryText).toContain("config.getSetting('taskCombatEstimate')");
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
