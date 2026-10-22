/** @vitest-environment happy-dom */
import { afterEach, expect, test, vi } from 'vitest';
import taskProfitDisplay from './task-profit-display.js';

afterEach(() => {
    for (const detach of taskProfitDisplay._estimateLayouts.values()) detach();
    taskProfitDisplay._estimateLayouts.clear();
    document.body.replaceChildren();
    vi.restoreAllMocks();
});

test('combat estimate gets its own row below a narrow task title and returns on widening', () => {
    const card = document.createElement('div');
    card.className = 'RandomTask_taskInfo__fixture';
    const action = document.createElement('div');
    action.className = 'RandomTask_action__fixture';
    const title = document.createElement('span');
    title.textContent = 'Defeat - A long monster name';
    const estimate = document.createElement('div');
    estimate.className = 'mwi-task-profit';
    action.append(title, estimate);
    card.appendChild(action);
    const panel = document.createElement('div');
    panel.className = 'TasksPanel_tasksPanel__fixture';
    panel.appendChild(card);
    document.body.appendChild(panel);
    const rect = vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ width: 330 });
    taskProfitDisplay._placeCombatEstimate(estimate, action, card);
    taskProfitDisplay._renderCombatEstimateConfig(estimate, {});
    expect(estimate.parentElement).toBe(card);
    expect(estimate.previousElementSibling).toBe(action);
    const select = estimate.querySelector('select');
    expect(Number.parseFloat(select.style.minWidth)).toBe(0);
    expect(select.style.maxWidth).toBe('100%');
    expect(select.getAttribute('aria-label')).toBe('Combat estimate loadout');
    expect(estimate.querySelector('.mwi-combat-est-btn').textContent).toContain('Estimate');
    rect.mockReturnValue({ width: 900 });
    window.dispatchEvent(new Event('resize'));
    expect(estimate.parentElement).toBe(action);
});

test('a desktop board keeps the estimate in place: ~430px cards in a wide Tasks panel are not a phone', () => {
    const panel = document.createElement('div');
    panel.className = 'TasksPanel_tasksPanel__fixture';
    const card = document.createElement('div');
    card.className = 'RandomTask_taskInfo__fixture';
    const action = document.createElement('div');
    action.className = 'RandomTask_action__fixture';
    const estimate = document.createElement('div');
    estimate.className = 'mwi-task-profit';
    action.appendChild(estimate);
    card.appendChild(action);
    panel.appendChild(card);
    document.body.appendChild(panel);
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ width: 1400 });
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ width: 432 });

    taskProfitDisplay._placeCombatEstimate(estimate, action, card);

    expect(estimate.parentElement).toBe(action);
    expect(estimate.dataset.toolashaDocked).toBeUndefined();
});
