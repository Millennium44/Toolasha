/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn(() => () => {}),
        onReady: vi.fn((_id, callback) => {
            callback();
            return () => {};
        }),
    },
}));
vi.mock('./task-profit-calculator.js', () => ({
    calculateTaskProfit: vi.fn(),
    calculateTaskRewardValue: vi.fn(() => ({})),
    formatTokenFigure: String,
}));
import display from './task-profit-display.js';
import domObserver from '../../core/dom-observer.js';
import dataManager from '../../core/data-manager.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { calculateTaskProfit } from './task-profit-calculator.js';

let card;
let marker;
let detach;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function mount() {
    document.body.innerHTML = `<div class="TasksPanel_taskList_x"><div class="RandomTask_taskInfo_x">
    <div class="RandomTask_name_x">Defeat - Swampy</div><div class="RandomTask_action_x"></div>
    <div class="RandomTask_rewards_x"></div><div class="progress">Progress: 0 / 10</div></div></div>`;
    card = document.querySelector('.RandomTask_taskInfo_x');
    marker = document.createElement('div');
    marker.className = 'mwi-task-profit';
    marker.dataset.taskKey = 'Defeat - Swampy|10';
    card.querySelector('.RandomTask_action_x').append(marker);
    detach = vi.fn();
    display._estimateLayouts.set(marker, detach);
    display._cardEstimates.set(card, { old: true });
}
beforeEach(() => {
    mount();
    display.isInitialized = true;
    vi.spyOn(display, '_scheduleCardRefresh').mockImplementation(() => {});
    display.registerDOMObservers();
});
afterEach(() => {
    display.disable();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

test.each(['replace text', 'character data', 'goal'])(
    'invalidates a reused card before the quest debounce: %s',
    async (kind) => {
        if (kind === 'replace text') card.querySelector('.RandomTask_name_x').textContent = 'Defeat - Frogger';
        if (kind === 'character data') card.querySelector('.RandomTask_name_x').firstChild.data = 'Defeat - Frogger';
        if (kind === 'goal') card.querySelector('.progress').textContent = 'Progress: 0 / 20';
        await flush();
        expect(marker.isConnected).toBe(false);
        expect(detach).toHaveBeenCalledOnce();
        expect(display._cardEstimates.has(card)).toBe(false);
        expect(display._scheduleCardRefresh).toHaveBeenCalledOnce();
    }
);

test('progress, Toolasha zone labels and its own estimate updates retain valid rows', async () => {
    card.querySelector('.progress').textContent = 'Progress: 1 / 10';
    card.querySelector('.RandomTask_name_x').insertAdjacentHTML(
        'beforeend',
        '<span class="script_taskMapIndex">Z2</span>'
    );
    marker.textContent = 'Updated total';
    await flush();
    expect(marker.isConnected).toBe(true);
    expect(detach).not.toHaveBeenCalled();
    expect(display._scheduleCardRefresh).not.toHaveBeenCalled();
});

test('disconnects on disable and observes a replacement list after re-enable', async () => {
    display.disable();
    mount();
    card.querySelector('.RandomTask_name_x').textContent = 'Defeat - Frogger';
    await flush();
    expect(marker.isConnected).toBe(true);
    display.isInitialized = true;
    display.registerDOMObservers();
    card.querySelector('.RandomTask_name_x').textContent = 'Defeat - Stabby';
    await flush();
    expect(marker.isConnected).toBe(false);
    expect(domObserver.onReady).toHaveBeenCalledTimes(2);
});

test('a reroll during profit calculation cannot append the old task after its await', async () => {
    marker.remove();
    vi.spyOn(dataManager, 'getInitClientData').mockReturnValue({});
    vi.spyOn(expectedValueCalculator, 'isInitialized', 'get').mockReturnValue(true);
    let resolve;
    calculateTaskProfit.mockReturnValue(
        new Promise((done) => {
            resolve = done;
        })
    );
    const pending = display.addProfitToTask(card);
    card.querySelector('.RandomTask_name_x').textContent = 'Defeat - Frogger';
    resolve(null);
    await pending;
    expect(card.querySelector('.mwi-task-profit')).toBeNull();
});

test('invalidates only the changed card, leaving a duplicate task estimate intact', async () => {
    const sibling = card.cloneNode(true);
    card.parentElement.append(sibling);
    card.querySelector('.RandomTask_name_x').textContent = 'Defeat - Frogger';
    await flush();
    expect(marker.isConnected).toBe(false);
    expect(sibling.querySelector('.mwi-task-profit')).not.toBeNull();
});

test('rebinds to a newly mounted task list without retaining the old observer', async () => {
    const oldCard = card;
    const oldMarker = marker;
    mount();
    const listCallback = domObserver.onClass.mock.calls.find((args) => args[0] === 'TaskProfitDisplay-TaskList')[2];
    vi.spyOn(display, 'updateTaskProfits').mockImplementation(() => {});
    vi.spyOn(display, 'updateQueuedIndicators').mockImplementation(() => {});
    listCallback(document.querySelector('.TasksPanel_taskList_x'));
    oldCard.querySelector('.RandomTask_name_x').textContent = 'Defeat - Frogger';
    card.querySelector('.RandomTask_name_x').textContent = 'Defeat - Stabby';
    await flush();
    expect(marker.isConnected).toBe(false);
    expect(oldCard.contains(oldMarker)).toBe(true);
});

test.each(['reroll', 'disable'])('a rejected old calculation cannot show an error after %s', async (change) => {
    marker.remove();
    vi.spyOn(dataManager, 'getInitClientData').mockReturnValue({});
    vi.spyOn(expectedValueCalculator, 'isInitialized', 'get').mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let reject;
    calculateTaskProfit.mockReturnValue(
        new Promise((_resolve, fail) => {
            reject = fail;
        })
    );
    const pending = display.addProfitToTask(card);
    if (change === 'reroll') card.querySelector('.RandomTask_name_x').textContent = 'Defeat - Frogger';
    else display.disable();
    // A newer render may own this retry entry. The obsolete catch must not remove it.
    display.pendingTaskNodes.add(card);
    reject(new Error('old calculation failed'));
    await pending;
    expect(card.querySelector('.mwi-task-profit')).toBeNull();
    expect(display.pendingTaskNodes.has(card)).toBe(true);
});

test('a rejected current calculation still renders its error and clears its retry entry', async () => {
    marker.remove();
    vi.spyOn(dataManager, 'getInitClientData').mockReturnValue({});
    vi.spyOn(expectedValueCalculator, 'isInitialized', 'get').mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    display.pendingTaskNodes.add(card);
    calculateTaskProfit.mockRejectedValue(new Error('current calculation failed'));
    await display.addProfitToTask(card);
    expect(card.querySelector('.mwi-task-profit')?.textContent).toContain('Unable to calculate profit');
    expect(display.pendingTaskNodes.has(card)).toBe(false);
});
