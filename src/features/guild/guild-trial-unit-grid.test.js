/**
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ settings: {}, listeners: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback),
        onSettingChange: (key, fn) => {
            const entry = { key, fn };
            game.listeners.push(entry);
            return () => {
                game.listeners = game.listeners.filter((l) => l !== entry);
            };
        },
    },
}));

const { default: feature, SETTING, FLAT_MARK } = await import('./guild-trial-unit-grid.js');

const COMBAT = (extra = '') => `<div class="BattlePanel_guildPartyArea__a"><div class="MiniUnitGrid_miniUnitGrid__b">
  <div class="CombatUnit_combatUnit__c" id="card"></div>
  <div class="MiniUnitGrid_miniUnitColumn__e" id="beside"><div class="MiniUnit_miniUnit__f" id="t1"></div></div>
  <div class="MiniUnitGrid_miniUnitColumn__e" id="below"><div class="MiniUnit_miniUnit__f" id="t2"></div></div>
  ${extra}</div></div>`;

const SKILLING = `<div class="SkillingInstancePanel_playerArea__a"><div class="MiniUnitGrid_miniUnitGrid__b">
  <div class="SkillingInstancePanel_skillingUnit__c" id="card"></div>
  <div class="MiniUnitGrid_miniUnitColumn__e" id="below"><div class="MiniUnit_miniUnit__f" id="t2"></div></div>
  </div></div>`;

const NORMAL = `<div class="BattlePanel_playersArea__z"><div class="MiniUnitGrid_miniUnitGrid__b">
  <div class="CombatUnit_combatUnit__c" id="ncard"></div>
  <div class="MiniUnitGrid_miniUnitColumn__e" id="ncol"><div class="MiniUnit_miniUnit__f" id="nt"></div></div></div></div>`;

/** happy-dom has no layout: give elements a top / bottom */
const rect = (el, top, bottom = top + 48) => {
    el.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top });
};
const $ = (id) => document.getElementById(id);
const flush = () => new Promise((r) => requestAnimationFrame(() => r()));
const tick = async () => {
    await Promise.resolve();
    await flush();
};

/** card bottom 150; t1 beside (top 0), t2 below (top 154) */
const layout = () => {
    rect($('card'), 0, 150);
    if ($('t1')) rect($('t1'), 0);
    rect($('t2'), 154);
    if ($('nt')) {
        rect($('ncard'), 0, 150);
        rect($('nt'), 200);
    }
};

describe('guild trial unit grid', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        game.settings = {};
        game.listeners = [];
    });
    afterEach(() => feature.cleanup());

    test('columns beside the card are untouched, columns below are flattened', async () => {
        document.body.innerHTML = COMBAT();
        layout();
        feature.initialize();
        await flush();
        expect($('beside').style.display).toBe('');
        expect($('beside').hasAttribute(FLAT_MARK)).toBe(false);
        expect($('below').style.display).toBe('contents');
        expect($('below').hasAttribute(FLAT_MARK)).toBe(true);
    });

    test('a column exactly at the card bottom counts as below', async () => {
        document.body.innerHTML = COMBAT();
        layout();
        rect($('t2'), 149);
        feature.initialize();
        await flush();
        expect($('below').style.display).toBe('contents');
    });

    test('a flattened column that moves back up is restored', async () => {
        document.body.innerHTML = COMBAT();
        layout();
        feature.initialize();
        await flush();
        rect($('t2'), 10);
        window.dispatchEvent(new Event('resize'));
        await flush();
        expect($('below').style.display).toBe('');
        expect($('below').hasAttribute(FLAT_MARK)).toBe(false);
    });

    test('players joining re-runs it via the observer', async () => {
        document.body.innerHTML = COMBAT();
        layout();
        feature.initialize();
        await flush();
        const col = document.createElement('div');
        col.className = 'MiniUnitGrid_miniUnitColumn__e';
        col.id = 'new';
        col.innerHTML = '<div class="MiniUnit_miniUnit__f" id="t3"></div>';
        document.querySelector('[class*="MiniUnitGrid_miniUnitGrid"]').appendChild(col);
        rect($('t3'), 210);
        await tick();
        await flush();
        expect($('new').style.display).toBe('contents');
    });

    test('the skilling trial area is handled too', async () => {
        document.body.innerHTML = SKILLING;
        layout();
        feature.initialize();
        await flush();
        expect($('below').style.display).toBe('contents');
    });

    test('a normal party area is never touched', async () => {
        document.body.innerHTML = COMBAT() + NORMAL;
        layout();
        feature.initialize();
        await flush();
        expect($('ncol').style.display).toBe('');
        expect($('ncol').hasAttribute(FLAT_MARK)).toBe(false);
    });

    test('no card: nothing is done', async () => {
        document.body.innerHTML = COMBAT();
        layout();
        $('card').remove();
        feature.initialize();
        await flush();
        expect($('below').style.display).toBe('');
    });

    test('a column the game styled itself is not overwritten or restored', async () => {
        document.body.innerHTML = COMBAT();
        layout();
        $('below').style.display = 'flex';
        feature.initialize();
        await flush();
        expect($('below').style.display).toBe('flex');
        expect($('below').hasAttribute(FLAT_MARK)).toBe(false);
        rect($('t2'), 10);
        window.dispatchEvent(new Event('resize'));
        await flush();
        expect($('below').style.display).toBe('flex');
    });

    test('setting off restores only flattened columns and stops observing; on redoes it', async () => {
        document.body.innerHTML = COMBAT();
        layout();
        $('beside').style.display = 'flex';
        feature.initialize();
        await flush();
        const listener = game.listeners.find((l) => l.key === SETTING);
        listener.fn(false);
        expect($('below').style.display).toBe('');
        expect($('below').hasAttribute(FLAT_MARK)).toBe(false);
        expect($('beside').style.display).toBe('flex');
        // nothing re-flattens while off
        window.dispatchEvent(new Event('resize'));
        await flush();
        expect($('below').style.display).toBe('');
        listener.fn(true);
        await flush();
        expect($('below').style.display).toBe('contents');
    });

    test('default off at start does nothing', async () => {
        game.settings[SETTING] = false;
        document.body.innerHTML = COMBAT();
        layout();
        feature.initialize();
        await flush();
        expect($('below').style.display).toBe('');
    });

    test('cleanup restores, removes the listener and the observer; re-initialize works', async () => {
        document.body.innerHTML = COMBAT();
        layout();
        feature.initialize();
        await flush();
        const spy = vi.spyOn(window, 'removeEventListener');
        feature.cleanup();
        expect(spy).toHaveBeenCalledWith('resize', expect.any(Function));
        spy.mockRestore();
        expect($('below').style.display).toBe('');
        expect(game.listeners.length).toBe(0);
        feature.initialize();
        await flush();
        expect($('below').style.display).toBe('contents');
        expect(game.listeners.length).toBe(1);
    });
});
