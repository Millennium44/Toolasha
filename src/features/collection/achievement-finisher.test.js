/**
 * @vitest-environment happy-dom
 *
 * The achievement-tier finisher, drawn from the game's shapes:
 * `achievementDetailMap` entries carry `tierHrid` (and `target` on the point
 * totals); `characterAchievements` rows are `{achievementHrid, isCompleted}`.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    setting: true,
    detail: null,
    achievements: null,
    collections: null,
    monsters: null,
    handlers: {},
    observers: [],
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => game.setting },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, cls, cb) => {
            const entry = { cb };
            game.observers.push(entry);
            return () => {
                game.observers = game.observers.filter((e) => e !== entry);
            };
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ achievementDetailMap: game.detail }),
        getCharacterAchievements: () => game.achievements,
        getCharacterCollections: () => game.collections,
        getCharacterMonsters: () => game.monsters,
        on: (event, fn) => {
            (game.handlers[event] ||= []).push(fn);
        },
        off: (event, fn) => {
            game.handlers[event] = (game.handlers[event] || []).filter((f) => f !== fn);
        },
    },
}));

import finisher, { findAchievementsHost, rewardText, PANEL_CLASS } from './achievement-finisher.js';
import { buildTierChecklists } from './achievement-finisher-model.js';

const DETAIL = {
    '/achievements/a1': { hrid: '/achievements/a1', name: 'A1', tierHrid: '/achievement_tiers/beginner' },
    '/achievements/a2': { hrid: '/achievements/a2', name: 'A2', tierHrid: '/achievement_tiers/beginner' },
    '/achievements/n1': { hrid: '/achievements/n1', name: 'N1', tierHrid: '/achievement_tiers/novice' },
    '/achievements/n2': { hrid: '/achievements/n2', name: 'N2', tierHrid: '/achievement_tiers/novice' },
    '/achievements/e1': { hrid: '/achievements/e1', name: 'E1', tierHrid: '/achievement_tiers/elite' },
    '/achievements/collection_points_100': {
        hrid: '/achievements/collection_points_100',
        name: 'Collector',
        tierHrid: '/achievement_tiers/adept',
        target: 100,
    },
};

const done = (hrid) => ({ achievementHrid: hrid, isCompleted: true });
const notDone = (hrid) => ({ achievementHrid: hrid, isCompleted: false });

function tierOf(result, name) {
    return result.tiers.find((tier) => tier.tierHrid === `/achievement_tiers/${name}`);
}

describe('buildTierChecklists', () => {
    test('a tier with everything done is complete and its reward is earned', () => {
        const r = buildTierChecklists({
            detailMap: DETAIL,
            achievements: [done('/achievements/a1'), done('/achievements/a2')],
        });
        const beginner = tierOf(r, 'beginner');
        expect(beginner.complete).toBe(true);
        expect(beginner.doneCount).toBe(2);
        expect(beginner.remaining).toEqual([]);
        expect(rewardText(beginner)).toContain('Reward earned');
    });

    test('a partly done tier lists exactly what is left', () => {
        const r = buildTierChecklists({
            detailMap: DETAIL,
            achievements: [done('/achievements/n1'), notDone('/achievements/n2')],
        });
        const novice = tierOf(r, 'novice');
        expect(novice.complete).toBe(false);
        expect(novice.doneCount).toBe(1);
        expect(novice.remaining.map((a) => a.name)).toEqual(['N2']);
        expect(rewardText(novice)).toContain('Reward on completion: Wisdom +2%');
    });

    test('a tier with nothing done lists everything, even with no rows at all', () => {
        const r = buildTierChecklists({ detailMap: DETAIL, achievements: [] });
        const novice = tierOf(r, 'novice');
        expect(novice.doneCount).toBe(0);
        expect(novice.remaining).toHaveLength(2);
        expect(r.completeTiers).toBe(0);
    });

    test('duplicates and unknown hrids do not inflate completion', () => {
        const r = buildTierChecklists({
            detailMap: DETAIL,
            achievements: [done('/achievements/a1'), done('/achievements/a1'), done('/achievements/not_in_catalog')],
        });
        const beginner = tierOf(r, 'beginner');
        expect(beginner.doneCount).toBe(1);
        expect(beginner.total).toBe(2);
    });

    test('missing data is unknown, never zero', () => {
        expect(buildTierChecklists({ detailMap: DETAIL, achievements: null })).toEqual({
            state: 'unknown',
            reason: 'achievements',
        });
        expect(buildTierChecklists({ detailMap: null, achievements: [] })).toEqual({
            state: 'unknown',
            reason: 'catalog',
        });
        expect(buildTierChecklists({ detailMap: {}, achievements: [] }).state).toBe('unknown');
    });

    test('inferred rewards are marked inferred, combat tiers are not', () => {
        const r = buildTierChecklists({ detailMap: DETAIL, achievements: [] });
        expect(tierOf(r, 'beginner').reward.inferred).toBe(true);
        expect(rewardText(tierOf(r, 'beginner'))).toContain('inferred, not verified');
        expect(tierOf(r, 'elite').reward.inferred).toBe(false);
        expect(rewardText(tierOf(r, 'elite'))).not.toContain('inferred');
    });

    test('a point-total achievement carries its planner and progress; unloaded totals stay unknown', () => {
        const withPoints = buildTierChecklists({
            detailMap: DETAIL,
            achievements: [],
            points: { collection: 40, bestiary: null },
        });
        const item = tierOf(withPoints, 'adept').remaining[0];
        expect(item.planner).toBe('collection');
        expect(item.progress).toEqual({ current: 40, target: 100 });

        const without = buildTierChecklists({ detailMap: DETAIL, achievements: [], points: { collection: null } });
        expect(tierOf(without, 'adept').remaining[0].progress).toBeNull();
        // An ordinary achievement has no progress figure at all
        expect(tierOf(without, 'novice').remaining[0].progress).toBeNull();
        expect(tierOf(without, 'novice').remaining[0].planner).toBeNull();
    });

    test('a tier absent from the reward catalog has an unknown reward', () => {
        const r = buildTierChecklists({
            detailMap: { '/achievements/x': { tierHrid: '/achievement_tiers/mystery' } },
            achievements: [],
        });
        expect(r.tiers[0].reward).toBeNull();
        expect(rewardText(r.tiers[0])).toBe('Reward: unknown');
    });
});

function achievementsPage(extraClass = 'AchievementsPanel_achievements__x') {
    const page = document.createElement('div');
    page.className = extraClass;
    document.body.appendChild(page);
    return page;
}

const panelText = () => document.querySelector(`.${PANEL_CLASS}`)?.textContent ?? null;
const click = (selector) => document.querySelector(selector).dispatchEvent(new Event('click', { bubbles: true }));

describe('the panel', () => {
    beforeEach(() => {
        game.setting = true;
        game.detail = DETAIL;
        game.achievements = [done('/achievements/a1'), done('/achievements/a2'), notDone('/achievements/n1')];
        game.collections = null;
        game.monsters = null;
        game.handlers = {};
        game.observers = [];
        document.body.replaceChildren();
    });

    afterEach(() => {
        finisher.disable();
    });

    test('mounts on the own Achievements page and summarizes tiers', () => {
        achievementsPage();
        finisher.initialize();
        expect(panelText()).toContain('Achievement tier finisher');
        expect(panelText()).toContain('1 of 4 tiers complete');
    });

    test('expanding shows the checklist, done/total, reward, and what is left', () => {
        achievementsPage();
        finisher.initialize();
        click(`.${PANEL_CLASS}-header`);
        expect(panelText()).toContain('Beginner 2/2 ✓');
        expect(panelText()).toContain('Reward on completion: Wisdom +2%');
        // Novice is the second tier block
        document.querySelectorAll(`.${PANEL_CLASS}-tier`)[1].firstChild.dispatchEvent(new Event('click'));
        expect(document.querySelectorAll(`.${PANEL_CLASS}-item`).length).toBeGreaterThan(0);
        expect(panelText()).toContain('N1 — progress unavailable');
        expect(panelText()).toContain('does not give progress inside one');
    });

    test('missing achievement data shows an explicit unknown state', () => {
        game.achievements = null;
        achievementsPage();
        finisher.initialize();
        expect(panelText()).toContain('progress unknown');
        click(`.${PANEL_CLASS}-header`);
        expect(document.querySelector(`.${PANEL_CLASS}-unknown`).textContent).toContain('has not loaded');
        expect(document.querySelectorAll(`.${PANEL_CLASS}-tier`)).toHaveLength(0);
    });

    test('an achievements update completing the last requirement redraws without a reload', () => {
        achievementsPage();
        finisher.initialize();
        expect(panelText()).toContain('1 of 4 tiers complete');
        game.achievements = [
            done('/achievements/a1'),
            done('/achievements/a2'),
            done('/achievements/n1'),
            done('/achievements/n2'),
        ];
        game.handlers.achievements_updated.forEach((fn) => fn({}));
        expect(panelText()).toContain('2 of 4 tiers complete');
    });

    test('never mounts on another player profile, a dialog, or the Collections tab', () => {
        const profile = document.createElement('div');
        profile.className = 'SharableProfile_overviewTab__1';
        const inner = document.createElement('div');
        inner.className = 'AchievementsPanel_achievements__y';
        profile.appendChild(inner);
        document.body.appendChild(profile);

        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<div class="AchievementsPanel_achievements__z"></div>';
        document.body.appendChild(dialog);

        const collections = document.createElement('div');
        collections.className = 'AchievementsPanel_collections__q';
        collections.innerHTML = '<div class="AchievementsPanel_controls__c"></div>';
        document.body.appendChild(collections);

        expect(findAchievementsHost()).toBeNull();
        finisher.initialize();
        expect(panelText()).toBeNull();
    });

    test('mounts when the page appears after init, once', () => {
        finisher.initialize();
        expect(panelText()).toBeNull();
        achievementsPage();
        game.observers.forEach((o) => o.cb());
        game.observers.forEach((o) => o.cb());
        expect(document.querySelectorAll(`.${PANEL_CLASS}`)).toHaveLength(1);
    });

    test('a character switch removes the panel; the next character gets a fresh one', () => {
        achievementsPage();
        finisher.initialize();
        game.handlers.character_switching.forEach((fn) => fn());
        expect(panelText()).toBeNull();
        game.handlers.character_initialized.forEach((fn) => fn());
        expect(panelText()).toContain('tiers complete');
    });

    test('disable removes the panel, the observer and every listener', () => {
        achievementsPage();
        finisher.initialize();
        expect(panelText()).not.toBeNull();
        finisher.disable();
        expect(panelText()).toBeNull();
        expect(game.observers).toHaveLength(0);
        expect(Object.values(game.handlers).every((list) => list.length === 0)).toBe(true);
    });

    test('re-enable draws again, and a switched-off setting never initializes', () => {
        achievementsPage();
        finisher.initialize();
        finisher.disable();
        finisher.initialize();
        expect(panelText()).not.toBeNull();
        finisher.disable();
        game.setting = false;
        finisher.initialize();
        expect(panelText()).toBeNull();
    });
});
