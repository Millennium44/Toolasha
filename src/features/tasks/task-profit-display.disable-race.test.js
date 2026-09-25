/**
 * @vitest-environment happy-dom
 *
 * addProfitToTask() awaits market initialization, then calculateTaskProfit().
 * If the last task-card setting is switched off (disable()) while either
 * await is in flight, the async call resumes with the current UI already
 * torn down and used to append a fresh `.mwi-task-profit` anyway — nothing
 * checked isInitialized, or any generation, after the await. These pin a
 * `_renderGeneration` token, bumped by disable(), checked right after each
 * await: a call that resumes stale must not touch the DOM.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import taskProfitDisplay from './task-profit-display.js';
import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { calculateTaskProfit } from './task-profit-calculator.js';

vi.mock('./task-profit-calculator.js', () => ({
    calculateTaskProfit: vi.fn(),
    calculateTaskRewardValue: vi.fn(() => ({})),
}));

/**
 * A task card DOM node shaped the way parseTaskData reads it.
 * @returns {Element} task card node
 */
function buildTaskNode() {
    const taskNode = document.createElement('div');
    taskNode.innerHTML = `
        <div class="RandomTask_name_x">Gather Milk</div>
        <div class="RandomTask_action_x"></div>
        <div class="RandomTask_rewards_x"></div>
        <div>Progress: 0 / 10</div>
    `;
    return taskNode;
}

afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('addProfitToTask() after a mid-flight disable()', () => {
    test('a disable() during the calculateTaskProfit() await stops the resumed call from rendering', async () => {
        vi.spyOn(dataManager, 'getInitClientData').mockReturnValue({ actionDetailMap: {} });
        vi.spyOn(expectedValueCalculator, 'isInitialized', 'get').mockReturnValue(true);
        taskProfitDisplay.isInitialized = true;

        let resolveProfit;
        calculateTaskProfit.mockReturnValue(
            new Promise((resolve) => {
                resolveProfit = resolve;
            })
        );

        const taskNode = buildTaskNode();
        const pending = taskProfitDisplay.addProfitToTask(taskNode);

        // The last task-card setting goes off while addProfitToTask() is still suspended.
        taskProfitDisplay.disable();

        resolveProfit({
            action: { details: { actionsPerHour: 600, efficiencyMultiplier: 1 } },
            taskInfo: { quantity: 10, currentProgress: 0 },
            rewards: { total: 100, error: null, breakdown: { tokensReceived: 0 } },
            totalProfit: 100,
        });
        await pending;

        const actionNode = taskNode.querySelector('.RandomTask_action_x');
        expect(actionNode.querySelectorAll('.mwi-task-profit').length).toBe(0);
    });

    test('a disable() during the market-init await stops the resumed call from rendering', async () => {
        vi.spyOn(config, 'getSetting').mockImplementation(() => false);
        vi.spyOn(dataManager, 'getInitClientData').mockReturnValue({ actionDetailMap: {} });
        vi.spyOn(expectedValueCalculator, 'isInitialized', 'get').mockReturnValue(false);
        taskProfitDisplay.isInitialized = true;

        let resolveInit;
        vi.spyOn(taskProfitDisplay, 'ensureMarketDataInitialized').mockReturnValue(
            new Promise((resolve) => {
                resolveInit = resolve;
            })
        );

        const taskNode = buildTaskNode();
        const pending = taskProfitDisplay.addProfitToTask(taskNode);

        taskProfitDisplay.disable();

        // Market data comes back ready, but the call is stale by now.
        resolveInit(true);
        await pending;

        const actionNode = taskNode.querySelector('.RandomTask_action_x');
        expect(actionNode.querySelectorAll('.mwi-task-profit').length).toBe(0);
    });
});
