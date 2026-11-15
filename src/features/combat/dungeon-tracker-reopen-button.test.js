/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    startReopenButton,
    stopReopenButton,
    syncReopenButton,
    REOPEN_BUTTON_ID,
} from './dungeon-tracker-reopen-button.js';

const PER_PLAYER_ID = 'toolasha-combat-dps-panel-button';

const state = { dungeon: false, setting: true, pressed: 0 };

function buildBattlePanel({ perPlayer = true, guild = false } = {}) {
    document.body.innerHTML = '';
    const main = document.createElement('div');
    main.className = 'GamePage_mainPanel__abc';
    const root = document.createElement('div');
    if (guild) root.className = 'GuildPanel_panel__xyz';
    const battleArea = document.createElement('div');
    battleArea.className = 'BattlePanel_battleArea__q1w';
    const area = document.createElement('div');
    area.className = 'BattlePanel_playersArea__xyz';
    battleArea.appendChild(area);
    root.appendChild(battleArea);
    main.appendChild(root);
    document.body.appendChild(main);
    if (perPlayer) {
        const button = document.createElement('button');
        button.id = PER_PLAYER_ID;
        button.getBoundingClientRect = () => ({ width: 60 });
        area.appendChild(button);
    }
    return area;
}

const tracker = () => document.getElementById(REOPEN_BUTTON_ID);

beforeEach(() => {
    vi.useFakeTimers();
    state.dungeon = false;
    state.setting = true;
    state.pressed = 0;
});

afterEach(() => {
    stopReopenButton();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

function start() {
    startReopenButton({ shouldShow: () => state.setting && state.dungeon, onPress: () => state.pressed++ });
}

describe('dungeon tracker reopen button', () => {
    test('appears during a dungeon and not outside one', () => {
        buildBattlePanel();
        start();
        expect(tracker()).toBeNull();
        state.dungeon = true;
        vi.advanceTimersByTime(1000);
        expect(tracker()).not.toBeNull();
        expect(tracker().textContent).toBe('Tracker');
        state.dungeon = false;
        vi.advanceTimersByTime(1000);
        expect(tracker()).toBeNull();
    });

    test('pressing it calls the tracker toggle', () => {
        buildBattlePanel();
        state.dungeon = true;
        start();
        tracker().click();
        expect(state.pressed).toBe(1);
    });

    test('is not duplicated on repeated syncs, and comes back after a re-render', () => {
        const area = buildBattlePanel();
        state.dungeon = true;
        start();
        syncReopenButton();
        syncReopenButton();
        expect(document.querySelectorAll(`#${REOPEN_BUTTON_ID}`)).toHaveLength(1);
        // React replaces the players area
        area.remove();
        buildBattlePanel();
        vi.advanceTimersByTime(1000);
        expect(document.querySelectorAll(`#${REOPEN_BUTTON_ID}`)).toHaveLength(1);
    });

    test('is removed on stop and when the setting turns off', () => {
        buildBattlePanel();
        state.dungeon = true;
        start();
        expect(tracker()).not.toBeNull();
        state.setting = false;
        vi.advanceTimersByTime(1000);
        expect(tracker()).toBeNull();
        state.setting = true;
        vi.advanceTimersByTime(1000);
        expect(tracker()).not.toBeNull();
        stopReopenButton();
        expect(tracker()).toBeNull();
        vi.advanceTimersByTime(5000);
        expect(tracker()).toBeNull();
    });

    test('sits left of Per-player when present and takes the corner when absent', () => {
        buildBattlePanel({ perPlayer: true });
        state.dungeon = true;
        start();
        expect(tracker().style.right).toBe('66px');
        expect(tracker().style.top).toBe('2px');
        stopReopenButton();
        buildBattlePanel({ perPlayer: false });
        start();
        expect(tracker().style.right).toBe('2px');
    });

    test('follows Per-player when it appears after the tracker button', () => {
        const area = buildBattlePanel({ perPlayer: false });
        state.dungeon = true;
        start();
        expect(tracker().style.right).toBe('2px');
        const button = document.createElement('button');
        button.id = PER_PLAYER_ID;
        button.getBoundingClientRect = () => ({ width: 60 });
        area.appendChild(button);
        vi.advanceTimersByTime(1000);
        expect(tracker().style.right).toBe('66px');
    });

    test('never mounts in the guild trial panel', () => {
        buildBattlePanel({ perPlayer: false, guild: true });
        state.dungeon = true;
        start();
        expect(tracker()).toBeNull();
    });
});
