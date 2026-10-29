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
    clientData: null,
    achievements: null,
    collections: null,
    monsters: null,
    skills: null,
    inventory: null,
    characterId: 7,
    ironCow: false,
    prices: {},
    gameObject: null,
    estimated: new Set(),
    settingHandlers: [],
    handlers: {},
    observers: [],
}));

const nav = vi.hoisted(() => ({
    navigateToAction: vi.fn(() => true),
    navigateToMarketplace: vi.fn(),
    openCombatZoneAtTier: vi.fn(async () => ({ opened: true, tierConfirmed: true, filled: false })),
    getItemPriceInfo: vi.fn((hrid) => ({
        price: hrid in game.prices ? game.prices[hrid] : null,
        estimated: game.estimated.has(hrid),
    })),
    marketOn: vi.fn(),
    marketOff: vi.fn(),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => game.setting,
        getSettingValue: () => undefined,
        onSettingChange: (key, fn) => {
            const entry = { key, fn };
            game.settingHandlers.push(entry);
            return () => {
                game.settingHandlers = game.settingHandlers.filter((e) => e !== entry);
            };
        },
    },
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
        getInitClientData: () => game.clientData ?? { achievementDetailMap: game.detail },
        getCharacterAchievements: () => game.achievements,
        getCharacterCollections: () => game.collections,
        getCharacterMonsters: () => game.monsters,
        getSkills: () => game.skills,
        getInventory: () => game.inventory,
        getCurrentCharacterId: () => game.characterId,
        on: (event, fn) => {
            (game.handlers[event] ||= []).push(fn);
        },
        off: (event, fn) => {
            game.handlers[event] = (game.handlers[event] || []).filter((f) => f !== fn);
        },
    },
}));

vi.mock('../../api/marketplace.js', () => ({ default: { on: nav.marketOn, off: nav.marketOff } }));
vi.mock('../../utils/item-navigation.js', () => ({
    getGameObject: () => game.gameObject,
    navigateToAction: nav.navigateToAction,
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: nav.navigateToMarketplace }));
vi.mock('../../utils/combat-zone-open.js', () => ({ openCombatZoneAtTier: nav.openCombatZoneAtTier }));
vi.mock('../../utils/market-data.js', () => ({ getItemPriceInfo: nav.getItemPriceInfo }));
vi.mock('../../utils/ironcow-valuation.js', () => ({ isIronCowCharacter: () => game.ironCow }));

import finisher, { findAchievementsHost, rewardText, PANEL_CLASS } from './achievement-finisher.js';
import { buildTierChecklists } from './achievement-finisher-model.js';
import {
    ACHIEVEMENTS,
    MORE_ACHIEVEMENTS,
    ACTIONS,
    ITEMS,
    MONSTERS,
    INVENTORY,
    PRICES,
    SKILLS,
} from './__fixtures__/achievement-finisher-game.js';

const DETAIL = {
    '/achievements/a1': { hrid: '/achievements/a1', name: 'A1', tierHrid: '/achievement_tiers/beginner' },
    '/achievements/a2': { hrid: '/achievements/a2', name: 'A2', tierHrid: '/achievement_tiers/beginner' },
    '/achievements/n1': {
        hrid: '/achievements/n1',
        name: 'N1',
        description: 'Do the N1 thing',
        tierHrid: '/achievement_tiers/novice',
    },
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
        game.clientData = null;
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

    test('the panel is left-aligned, not centered like the page header it sits in', () => {
        achievementsPage();
        finisher.initialize();
        expect(document.querySelector(`.${PANEL_CLASS}`).style.textAlign).toBe('left');
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
        expect(panelText()).toContain('N1 — Do the N1 thing');
        expect(panelText()).not.toContain('progress unavailable');
        expect(panelText()).toContain('not progress inside one');
        expect(panelText()).toContain('nothing is started or bought');
    });

    test('an expanded tier lists done and remaining entries with distinct markers', () => {
        game.achievements = [done('/achievements/n1'), done('/achievements/a1'), done('/achievements/a2')];
        achievementsPage();
        finisher.initialize();
        click(`.${PANEL_CLASS}-header`);
        const tiers = document.querySelectorAll(`.${PANEL_CLASS}-tier`);
        const open = (i) => tiers[i].firstChild.dispatchEvent(new Event('click'));
        // Partial (novice): one done, one left
        open(1);
        let block = document.querySelectorAll(`.${PANEL_CLASS}-tier`)[1];
        expect(block.querySelector(`.${PANEL_CLASS}-item`).textContent).toContain('○ N2');
        expect(block.querySelector(`.${PANEL_CLASS}-done`).textContent).toBe('✓ N1');
        // Fully done (beginner): done entries listed, nothing remaining
        open(0);
        block = document.querySelectorAll(`.${PANEL_CLASS}-tier`)[0];
        expect(block.querySelectorAll(`.${PANEL_CLASS}-done`)).toHaveLength(2);
        expect(block.querySelectorAll(`.${PANEL_CLASS}-item`)).toHaveLength(0);
        // None done (elite): only remaining
        document.querySelectorAll(`.${PANEL_CLASS}-tier`)[3].firstChild.dispatchEvent(new Event('click'));
        block = document.querySelectorAll(`.${PANEL_CLASS}-tier`)[3];
        expect(block.querySelectorAll(`.${PANEL_CLASS}-item`)).toHaveLength(1);
        expect(block.querySelectorAll(`.${PANEL_CLASS}-done`)).toHaveLength(0);
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

describe('one-off rows: description, readiness, Go', () => {
    /** Every function the game object is asked for, by name */
    let gameCalls;

    beforeEach(() => {
        vi.useFakeTimers();
        game.setting = true;
        game.detail = ACHIEVEMENTS;
        game.clientData = {
            achievementDetailMap: ACHIEVEMENTS,
            actionDetailMap: ACTIONS,
            itemDetailMap: ITEMS,
            combatMonsterDetailMap: MONSTERS,
        };
        game.achievements = [];
        game.skills = SKILLS;
        game.inventory = INVENTORY;
        game.prices = PRICES;
        game.characterId = 7;
        game.ironCow = false;
        game.estimated = new Set();
        game.settingHandlers = [];
        game.handlers = {};
        game.observers = [];
        gameCalls = [];
        game.gameObject = new Proxy(
            {},
            {
                get:
                    (_target, name) =>
                    (...args) =>
                        gameCalls.push([String(name), ...args]),
            }
        );
        Object.values(nav).forEach((fn) => fn.mockClear());
        document.body.replaceChildren();
    });

    afterEach(() => {
        finisher.disable();
        vi.useRealTimers();
        game.clientData = null;
        game.skills = null;
        game.inventory = null;
        game.gameObject = null;
    });

    function openVeteran() {
        achievementsPage();
        finisher.initialize();
        click(`.${PANEL_CLASS}-header`);
        document.querySelector(`.${PANEL_CLASS}-tier`).firstChild.dispatchEvent(new Event('click'));
    }

    const rows = () => [...document.querySelectorAll(`.${PANEL_CLASS}-item`)];
    const rowOf = (name) => rows().find((row) => row.textContent.startsWith(`○ ${name} `));
    const goOf = (name) => rowOf(name).querySelector(`.${PANEL_CLASS}-go`);

    test('rows are sorted ready, needs buying (cheapest first), level not met, unresolved', () => {
        openVeteran();
        // Combat zones with no requirement ({skillHrid: '', level: 0}) are ready
        expect(rows().map((row) => row.textContent.split(' — ')[0].slice(2))).toEqual([
            'Recycler',
            'Chief Slayer',
            'Jerry Hunter',
            'Panda Tamer',
            'Arcane Lumberjack',
            'Dairy Chef',
            'Ginkgo Wielder',
            'Space Baker',
            'Shadow Tailor',
            'Mystery',
        ]);
    });

    test('each row shows the game description and the readiness hint for its ending', () => {
        openVeteran();
        expect(rowOf('Dairy Chef').textContent).toContain('Make a Peach Yogurt with Cooking');
        expect(rowOf('Dairy Chef').textContent).toContain('[level met · buy ~200]');
        expect(rowOf('Recycler').textContent).toContain('[level met · materials owned]');
        expect(rowOf('Space Baker').textContent).toContain('needs Cooking 70 (you 45)');
        expect(rowOf('Space Baker').textContent).toContain('unpriced: Mystery Sugar');
        expect(rowOf('Jerry Hunter').textContent).toContain('[T5 · no level requirement · your Combat Lv');
        expect(rowOf('Chief Slayer').textContent).toContain('[T0 · no level requirement');
        expect(rowOf('Jerry Hunter').textContent).toContain('monster Lv 60]');
        expect(rowOf('Ginkgo Wielder').textContent).toContain('cheapest: Ginkgo Crossbow ~700');
        // Unresolved: the description and nothing else
        expect(rowOf('Mystery').textContent).toBe('○ Mystery — Enhance something to +10');
        expect(goOf('Mystery')).toBeNull();
    });

    test('Go opens the resolved action, zone, alchemy item or market listing, and starts nothing', async () => {
        openVeteran();
        goOf('Dairy Chef').click();
        expect(nav.navigateToAction).toHaveBeenCalledWith('/actions/cooking/peach_yogurt');

        goOf('Jerry Hunter').click();
        // Exactly the zone and tier: no count, so nothing is filled in and nothing queued
        expect(nav.openCombatZoneAtTier.mock.calls).toEqual([['/actions/combat/rat', 5]]);

        goOf('Ginkgo Wielder').click();
        expect(nav.navigateToMarketplace).toHaveBeenCalledWith('/items/ginkgo_crossbow', 0);

        goOf('Recycler').click();
        expect(gameCalls).toEqual([['handleAlchemizeItem', '7::/item_locations/inventory::/items/bamboo_gloves::0']]);

        goOf('Arcane Lumberjack').click();
        expect(nav.navigateToAction.mock.calls).toEqual([
            ['/actions/cooking/peach_yogurt'],
            ['/actions/woodcutting/arcane_tree'],
        ]);
        await vi.runAllTimersAsync();
        // The game object was only ever asked to select the alchemy item
        expect(gameCalls.map(([name]) => name)).toEqual(['handleAlchemizeItem']);
    });

    test('clear <dungeon> opens the dungeon at T0; gather opens the gathering action; the rest get no Go', () => {
        game.clientData = { ...game.clientData, achievementDetailMap: MORE_ACHIEVEMENTS };
        game.detail = MORE_ACHIEVEMENTS;
        openVeteran();
        expect(rowOf('Den Delver').textContent).toContain('[dungeon · T0 · no level requirement');
        goOf('Den Delver').click();
        expect(nav.openCombatZoneAtTier.mock.calls).toEqual([['/actions/combat/chimerical_den', 0]]);
        expect(rowOf('Gated').textContent).toContain('needs Lv 90 (you 50)');
        goOf('Milkmaid').click();
        expect(nav.navigateToAction.mock.calls).toEqual([['/actions/milking/cow']]);
        for (const name of ['Regular', 'Refiner', 'Azure Smith', 'Celestial']) {
            expect(goOf(name)).toBeNull();
            expect(rowOf(name).querySelector(`.${PANEL_CLASS}-ready`)).toBeNull();
        }
    });

    test('alchemy with no stack opens the alchemy action and selects the tab by position', async () => {
        game.inventory = INVENTORY.filter((row) => row.itemHrid !== '/items/bamboo_gloves');
        openVeteran();
        const strip = document.createElement('div');
        strip.className = 'AlchemyPanel_tabsComponentContainer__x';
        const tabClicks = [];
        ['点金', '分解', '转化', '重铸'].forEach((label, i) => {
            const tab = document.createElement('button');
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(i === 0));
            tab.textContent = label;
            tab.addEventListener('click', () => tabClicks.push(i));
            strip.appendChild(tab);
        });
        document.body.appendChild(strip);

        goOf('Recycler').click();
        await vi.runAllTimersAsync();
        expect(gameCalls).toEqual([['handleGoToAction', '/actions/alchemy/decompose']]);
        expect(tabClicks).toEqual([1]);
    });

    test('an owned weapon reads "in inventory" with no Go; an Iron Cow gets no buy cost or market button', () => {
        game.inventory = [
            ...INVENTORY,
            {
                itemHrid: '/items/ginkgo_bow',
                count: 1,
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 2,
            },
        ];
        openVeteran();
        expect(rowOf('Ginkgo Wielder').textContent).toContain('in inventory: Ginkgo Bow');
        expect(goOf('Ginkgo Wielder')).toBeNull();
        finisher.disable();

        game.inventory = INVENTORY;
        game.ironCow = true;
        document.body.replaceChildren();
        openVeteran();
        expect(rowOf('Ginkgo Wielder').textContent).toContain('not owned');
        expect(goOf('Ginkgo Wielder')).toBeNull();
        expect(rowOf('Dairy Chef').textContent).toContain('missing 1 input');
        expect(rowOf('Dairy Chef').textContent).not.toContain('buy ~');
    });

    test('a redraw reuses cached readiness; stock moving, or another character, recomputes it', async () => {
        openVeteran();
        const first = nav.getItemPriceInfo.mock.calls.length;
        expect(first).toBeGreaterThan(0);

        game.handlers.achievements_updated.forEach((fn) => fn({}));
        expect(nav.getItemPriceInfo.mock.calls.length).toBe(first);

        // An inventory update: one coalesced redraw shortly after, with fresh readiness
        game.inventory = [
            ...INVENTORY,
            { itemHrid: '/items/peach', count: 2, itemLocationHrid: '/item_locations/inventory' },
        ];
        game.handlers.items_updated.forEach((fn) => fn({}));
        game.handlers.items_updated.forEach((fn) => fn({}));
        await vi.advanceTimersByTimeAsync(1000);
        expect(rowOf('Dairy Chef').textContent).toContain('materials owned');
        const second = nav.getItemPriceInfo.mock.calls.length;

        game.characterId = 8;
        game.handlers.achievements_updated.forEach((fn) => fn({}));
        expect(nav.getItemPriceInfo.mock.calls.length).toBeGreaterThan(second);
    });

    test('a value-map price is marked as an estimate; a pricing-mode change recomputes the cost', async () => {
        game.estimated = new Set(['/items/peach']);
        openVeteran();
        expect(rowOf('Dairy Chef').textContent).toContain('buy ~200 (est.)');
        expect(rowOf('Ginkgo Wielder').textContent).not.toContain('(est.)');

        expect(game.settingHandlers.map((e) => e.key)).toEqual(['profitCalc_pricingMode']);
        game.prices = { ...PRICES, '/items/peach': 300 };
        game.settingHandlers.forEach((e) => e.fn('optimistic'));
        await vi.advanceTimersByTimeAsync(1000);
        expect(rowOf('Dairy Chef').textContent).toContain('buy ~600 (est.)');
    });

    test('disable removes the buttons, every listener and a pending redraw', async () => {
        openVeteran();
        expect(document.querySelectorAll(`.${PANEL_CLASS}-go`).length).toBeGreaterThan(0);
        const listener = nav.marketOn.mock.calls[0][0];
        game.handlers.items_updated.forEach((fn) => fn({}));
        finisher.disable();
        expect(document.querySelectorAll(`.${PANEL_CLASS}-go`)).toHaveLength(0);
        expect(nav.marketOff).toHaveBeenCalledWith(listener);
        expect(Object.values(game.handlers).every((list) => list.length === 0)).toBe(true);
        expect(game.settingHandlers).toHaveLength(0);
        const calls = nav.getItemPriceInfo.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5000);
        expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
        expect(nav.getItemPriceInfo.mock.calls.length).toBe(calls);
    });
});
