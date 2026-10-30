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
    bridgeOff: false,
    houseRooms: null,
    learned: null,
}));

const nav = vi.hoisted(() => ({
    navigateToAction: vi.fn(() => true),
    navigateToMarketplace: vi.fn(),
    openCombatZoneAtTier: vi.fn(async () => ({ opened: true, tierConfirmed: true, filled: false })),
    // Enhanced levels are keyed `hrid+level`; +0 is the bare hrid
    getItemPriceInfo: vi.fn((hrid, opts) => {
        const key = opts?.enhancementLevel > 0 ? `${hrid}+${opts.enhancementLevel}` : hrid;
        return { price: key in game.prices ? game.prices[key] : null, estimated: game.estimated.has(key) };
    }),
    openMissingMaterials: vi.fn(async () => {}),
    openAlchemyMissingMaterials: vi.fn(async () => {}),
    marketOn: vi.fn(),
    marketOff: vi.fn(),
    setShopFilter: vi.fn(() => true),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => game.setting,
        setSetting: (key, value) => {
            game.setting = value;
            game.settingHandlers.filter((e) => e.key === key).forEach((e) => e.fn(value));
        },
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
        get characterData() {
            return game.houseRooms || game.learned ? {} : null;
        },
        getHouseRooms: () => new Map(game.houseRooms || []),
        getLearnedAbilities: () => game.learned || [],
        on: (event, fn) => {
            (game.handlers[event] ||= []).push(fn);
        },
        off: (event, fn) => {
            game.handlers[event] = (game.handlers[event] || []).filter((f) => f !== fn);
        },
    },
}));

vi.mock('../../utils/bundle-bridge.js', async (importOriginal) => ({
    ...(await importOriginal()),
    missingMaterialsButton: () =>
        game.bridgeOff
            ? null
            : {
                  openMissingMaterials: nav.openMissingMaterials,
                  openAlchemyMissingMaterials: nav.openAlchemyMissingMaterials,
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
vi.mock('../../utils/tester-shop-nav.js', () => ({ setShopFilter: nav.setShopFilter }));
vi.mock('../../utils/enhancement-input-pricing.js', () => ({
    perAttemptMaterialCost: () => ({ cost: 100, hasCost: true, hasMissingPrices: false, hasPartialPrices: false }),
    priceProtection: () => ({ price: 50, itemHrid: '/items/cheese', unpriced: false, estimated: false }),
}));
vi.mock('../../utils/enhancement-config.js', () => ({
    getAutoDetectedParams: () => ({
        enhancingLevel: 100,
        toolBonus: 0,
        speedBonus: 0,
        teas: { blessed: false },
        guzzlingBonus: 1,
        blessedTeaBonus: 0.01,
    }),
}));

import finisher, { findAchievementsHost, PANEL_CLASS } from './achievement-finisher.js';
import { buildTierChecklists } from './achievement-finisher-model.js';
import { resetSpriteSheetCache } from '../../utils/overlay-format.js';
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
import { ANY_OF_ACHIEVEMENTS, ANY_OF_DATA } from './__fixtures__/achievement-finisher-anyof.js';
import { PLACE_ACHIEVEMENTS, PLACE_DATA } from './__fixtures__/achievement-finisher-places.js';
import { ABILITY_ACHIEVEMENTS, ABILITY_DATA } from './__fixtures__/achievement-finisher-abilities.js';
import { ENHANCE_ACHIEVEMENTS, ENHANCE_DATA } from './__fixtures__/achievement-finisher-enhance.js';

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
        expect(beginner.reward.label).toBe('Gathering +2%');
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
        expect(novice.reward.label).toBe('Wisdom +2%');
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

    test('every tier reward is shown as fact, with no inferred mark', () => {
        const r = buildTierChecklists({ detailMap: DETAIL, achievements: [] });
        expect(tierOf(r, 'beginner').reward).toEqual({ label: 'Gathering +2%' });
        expect(tierOf(r, 'elite').reward).toEqual({ label: 'Damage +2%' });
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
    });
});

const nativeControl = (label) =>
    `<div class="AchievementsPanel_checkboxControl__3e6CJ"><label class="MuiFormControlLabel-root Checkbox_checkbox__dP0DH">` +
    `<span class="MuiButtonBase-root MuiCheckbox-root MuiCheckbox-colorPrimary"><svg viewBox="0 0 24 24"><path d="M0 0"></path></svg></span>` +
    `<span class="MuiTypography-root MuiFormControlLabel-label">${label}</span></label></div>`;

/**
 * The Achievements tab as the test server draws it: a controls bar with "Show Incomplete Only", and tier
 * sections whose grids hold one card per achievement. The icon's sprite id is the hrid's last segment.
 * `translate` blanks the name and description, as a client in another language would show other text.
 */
function achievementsTab(detailMap = game.detail, { translate = false, icons = true } = {}) {
    const page = document.createElement('div');
    page.id = 'tab';
    const controls = document.createElement('div');
    controls.className = 'AchievementsPanel_controls__c';
    controls.innerHTML = nativeControl('Show Incomplete Only');
    page.appendChild(controls);
    const content = document.createElement('div');
    content.className = 'AchievementsPanel_achievementsContent__x';
    const section = document.createElement('div');
    section.className = 'AchievementsPanel_tierSection__t';
    section.innerHTML = '<div class="AchievementsPanel_tierHeader__h">Veteran</div>';
    const list = document.createElement('div');
    list.className = 'AchievementsPanel_achievementGrid__g';
    for (const [hrid, detail] of Object.entries(detailMap)) {
        const card = document.createElement('div');
        card.className = 'Achievement_achievement__a Achievement_tierVeteran__v';
        card.dataset.hrid = hrid;
        const icon = icons
            ? `<svg><use href="/static/media/achievements_sprite.abc.svg#${hrid.split('/').pop()}" xlink:href="/static/media/achievements_sprite.abc.svg#${hrid.split('/').pop()}"></use></svg>`
            : '';
        card.innerHTML =
            `<div class="Achievement_content__c"><div class="Achievement_iconContainer__i Achievement_incomplete__n">${icon}</div>` +
            `<div class="Achievement_leftColumn__l"><div class="Achievement_titleRow__r"><div class="Achievement_name__n">${translate ? '成就' : detail.name}</div></div>` +
            `<div class="Achievement_description__d">${translate ? '说明' : detail.description || ''}</div></div>` +
            `<div class="Achievement_progressText__p">0 / 1</div></div>`;
        list.appendChild(card);
    }
    section.appendChild(list);
    content.appendChild(section);
    page.appendChild(content);
    document.body.appendChild(page);
    return { page, controls, list };
}

const cardOf = (name) =>
    [...document.querySelectorAll('.Achievement_achievement__a')].find(
        (card) => card.querySelector('.Achievement_name__n').textContent === name
    );
const lineOf = (name) => cardOf(name)?.querySelector(`.${PANEL_CLASS}-line`) ?? null;
const goOf = (name) => lineOf(name)?.querySelector(`.${PANEL_CLASS}-go`) ?? null;
const matsOf = (name) => lineOf(name)?.querySelector(`.${PANEL_CLASS}-mats`) ?? null;
const toggle = () => document.querySelector(`.${PANEL_CLASS}-toggle`);
const lines = () => [...document.querySelectorAll(`.${PANEL_CLASS}-line`)];
const mountAgain = () => game.observers.forEach((o) => o.cb());

describe('hints on the game achievement cards', () => {
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
        game.collections = null;
        game.monsters = null;
        game.skills = SKILLS;
        game.inventory = INVENTORY;
        game.prices = PRICES;
        game.characterId = 7;
        game.ironCow = false;
        game.bridgeOff = false;
        game.estimated = new Set();
        game.houseRooms = null;
        game.learned = null;
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

    test('a candidate row names the action it picked; the line is rebuilt when the pick changes', () => {
        game.detail = ANY_OF_ACHIEVEMENTS;
        const named = { ...ANY_OF_DATA.actionDetailMap };
        named['/actions/milking/unicow'] = { ...named['/actions/milking/unicow'], name: 'Unicow' };
        named['/actions/milking/holy_cow'] = { ...named['/actions/milking/holy_cow'], name: 'Holy Cow' };
        game.clientData = { ...ANY_OF_DATA, actionDetailMap: named, achievementDetailMap: ANY_OF_ACHIEVEMENTS };
        game.skills = [
            { skillHrid: '/skills/milking', level: 70 },
            { skillHrid: '/skills/cheesesmithing', level: 1 },
        ];
        game.inventory = [];
        achievementsTab(ANY_OF_ACHIEVEMENTS);
        finisher.initialize();
        expect(lineOf('Buttered Up').textContent).toContain('[Unicow · level met · ~1 in 100.0K actions');
        game.skills = [
            { skillHrid: '/skills/milking', level: 90 },
            { skillHrid: '/skills/cheesesmithing', level: 1 },
        ];
        finisher.readinessChanged();
        vi.advanceTimersByTime(1500);
        expect(lineOf('Buttered Up').textContent).toContain('[Holy Cow · level met · ~1 in 33.3K actions');
    });

    test('a rare-drop card shows the odds and Go opens the chosen action; a re-pick redraws the line', () => {
        game.detail = ANY_OF_ACHIEVEMENTS;
        game.clientData = { ...ANY_OF_DATA, achievementDetailMap: ANY_OF_ACHIEVEMENTS };
        game.skills = [
            { skillHrid: '/skills/milking', level: 70 },
            { skillHrid: '/skills/cheesesmithing', level: 1 },
        ];
        game.inventory = [];
        achievementsTab(ANY_OF_ACHIEVEMENTS);
        finisher.initialize();
        expect(lineOf('Buttered Up').textContent).toContain('level met · ~1 in 100.0K actions');
        goOf('Buttered Up').click();
        expect(nav.navigateToAction).toHaveBeenLastCalledWith('/actions/milking/unicow');
        // Levelling up changes the pick: the line is rebuilt and Go follows it
        game.skills = [
            { skillHrid: '/skills/milking', level: 90 },
            { skillHrid: '/skills/cheesesmithing', level: 1 },
        ];
        finisher.readinessChanged();
        vi.advanceTimersByTime(1500);
        expect(lineOf('Buttered Up').textContent).toContain('~1 in 33.3K actions');
        goOf('Buttered Up').click();
        expect(nav.navigateToAction).toHaveBeenLastCalledWith('/actions/milking/holy_cow');
    });

    test('Missing Mats on an any-of card opens the bill of the action it picked', () => {
        game.detail = ANY_OF_ACHIEVEMENTS;
        game.clientData = {
            ...ANY_OF_DATA,
            itemDetailMap: { ...ANY_OF_DATA.itemDetailMap, '/items/silk': { name: 'Silk', isTradable: true } },
            achievementDetailMap: ANY_OF_ACHIEVEMENTS,
        };
        game.skills = [{ skillHrid: '/skills/tailoring', level: 60 }];
        game.inventory = [];
        game.prices = { ...PRICES, '/items/silk': 10 };
        achievementsTab(ANY_OF_ACHIEVEMENTS);
        finisher.initialize();
        // Both pouches cost the same; the lower level (Guzzling, 55) wins the tie
        matsOf('Snack Pack Pro').click();
        expect(nav.openMissingMaterials.mock.calls).toEqual([['/actions/tailoring/guzzling_pouch', 1]]);
    });

    test('unfinished resolvable cards get a hint line under the description; finished and unresolved get none', () => {
        game.achievements = [done('/achievements/decompose_bamboo_gloves')];
        achievementsTab();
        finisher.initialize();
        const dairy = cardOf('Dairy Chef');
        const line = dairy.querySelector(`.${PANEL_CLASS}-line`);
        expect(line.previousElementSibling.className).toBe('Achievement_description__d');
        expect(line.parentElement.className).toBe('Achievement_leftColumn__l');
        expect(lineOf('Dairy Chef').textContent).toContain('[level met · buy ~200 coin]');
        // Completed: nothing. Unresolved: the game card already shows the description
        expect(lineOf('Recycler')).toBeNull();
        expect(lineOf('Mystery')).toBeNull();
        // The separate panel is gone
        expect(document.querySelector(`.${PANEL_CLASS}-header`)).toBeNull();
    });

    test('the live page: Collections and Bestiary tab panels mounted beside the Achievements tab', () => {
        // The game keeps all three tab panels in the page at once, inside one outer panel with a title
        const { page } = achievementsTab();
        page.className = 'AchievementsPanel_achievements__3nd4D';
        const outer = document.createElement('div');
        outer.className = 'AchievementsPanel_achievementsPanel__2rSYa';
        outer.innerHTML = '<div class="AchievementsPanel_title__o1faP">Achievements</div>';
        const tabPanel = document.createElement('div');
        tabPanel.className = 'TabPanel_tabPanel__tXMJF';
        tabPanel.appendChild(page);
        outer.appendChild(tabPanel);
        for (const other of ['collections__qA6CY', 'bestiary__w1C-B']) {
            const node = document.createElement('div');
            node.className = `AchievementsPanel_${other}`;
            node.innerHTML = '<div class="AchievementsPanel_controls__c"></div>';
            outer.appendChild(node);
        }
        document.body.appendChild(outer);
        finisher.initialize();
        expect(lineOf('Dairy Chef')).not.toBeNull();
        expect(toggle()).not.toBeNull();
        expect(page.contains(toggle())).toBe(true);
    });

    test('hint text per ending, from the same readiness the panel used', () => {
        achievementsTab();
        finisher.initialize();
        expect(lineOf('Recycler').textContent).toContain('[level met · materials owned]');
        expect(lineOf('Space Baker').textContent).toContain('needs Cooking 70 (you 45)');
        expect(lineOf('Space Baker').textContent).toContain('unpriced: Mystery Sugar');
        expect(lineOf('Jerry Hunter').textContent).toContain('[T5 · no level requirement · your Combat Lv');
        expect(lineOf('Chief Slayer').textContent).toContain('[T0 · no level requirement');
        expect(lineOf('Ginkgo Wielder').textContent).toContain('cheapest: Ginkgo Crossbow ~700 coin');
    });

    test('Go opens the resolved action, zone, alchemy item or market listing, and starts nothing', async () => {
        achievementsTab();
        finisher.initialize();
        goOf('Dairy Chef').click();
        expect(nav.navigateToAction).toHaveBeenCalledWith('/actions/cooking/peach_yogurt');

        goOf('Jerry Hunter').click();
        expect(nav.openCombatZoneAtTier.mock.calls).toEqual([['/actions/combat/rat', 5]]);

        goOf('Ginkgo Wielder').click();
        expect(nav.navigateToMarketplace).toHaveBeenCalledWith('/items/ginkgo_crossbow', 0);

        goOf('Recycler').click();
        expect(gameCalls).toEqual([['handleAlchemizeItem', '7::/item_locations/inventory::/items/bamboo_gloves::0']]);
        await vi.runAllTimersAsync();
        expect(gameCalls.map(([name]) => name)).toEqual(['handleAlchemizeItem']);
    });

    test('clear <dungeon> opens the dungeon at T0; gather opens the gathering action; the rest get no line', () => {
        game.clientData = { ...game.clientData, achievementDetailMap: MORE_ACHIEVEMENTS };
        game.detail = MORE_ACHIEVEMENTS;
        achievementsTab(MORE_ACHIEVEMENTS);
        finisher.initialize();
        expect(lineOf('Den Delver').textContent).toContain('[dungeon · T0 · no level requirement');
        goOf('Den Delver').click();
        expect(nav.openCombatZoneAtTier.mock.calls).toEqual([['/actions/combat/chimerical_den', 0]]);
        goOf('Milkmaid').click();
        expect(nav.navigateToAction.mock.calls).toEqual([['/actions/milking/cow']]);
        for (const name of ['Refiner', 'Azure Smith', 'Celestial']) expect(lineOf(name)).toBeNull();
        // Repeat T1 clears: the dungeon at T1, progress unknown without a progress row
        expect(lineOf('Regular').textContent).toContain('[dungeon T1 · clears unknown · no level requirement]');
    });

    test('Missing Mats shows only where inputs are short and buyable, and opens the shared bill for one action', () => {
        game.inventory = INVENTORY.filter((row) => row.itemHrid !== '/items/bamboo_gloves');
        achievementsTab();
        finisher.initialize();
        expect(matsOf('Dairy Chef').textContent).toBe('Missing Mats');
        expect(matsOf('Dairy Chef').title).toMatch(/^Will buy: Peach ×/);
        expect(matsOf('Recycler')).not.toBeNull();
        expect(lineOf('Dairy Chef').lastChild).toBe(matsOf('Dairy Chef'));
        // Equip (Go opens the market) and combat rows have none
        expect(matsOf('Ginkgo Wielder')).toBeNull();
        expect(matsOf('Jerry Hunter')).toBeNull();

        matsOf('Dairy Chef').click();
        expect(nav.openMissingMaterials.mock.calls).toEqual([['/actions/cooking/peach_yogurt', 1]]);
        matsOf('Recycler').click();
        expect(nav.openAlchemyMissingMaterials.mock.calls).toEqual([['/items/bamboo_gloves', 'decompose', 1]]);
        expect(nav.navigateToMarketplace).not.toHaveBeenCalled();
    });

    test('an owned weapon and owned materials get no buy buttons; an Iron Cow gets no cost, Go or Missing Mats', () => {
        game.inventory = [
            ...INVENTORY,
            {
                itemHrid: '/items/ginkgo_bow',
                count: 1,
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 2,
            },
        ];
        achievementsTab();
        finisher.initialize();
        expect(lineOf('Ginkgo Wielder').textContent).toContain('in inventory: Ginkgo Bow');
        expect(goOf('Ginkgo Wielder')).toBeNull();
        expect(matsOf('Recycler')).toBeNull();
        finisher.disable();

        game.inventory = INVENTORY;
        game.ironCow = true;
        document.body.replaceChildren();
        achievementsTab();
        finisher.initialize();
        expect(lineOf('Dairy Chef').textContent).toContain('missing 1 input');
        expect(lineOf('Dairy Chef').textContent).not.toContain('buy ~');
        expect(matsOf('Dairy Chef')).toBeNull();
        expect(goOf('Ginkgo Wielder')).toBeNull();
    });

    test('a point-total card gets no line: the game card shows that progress itself', () => {
        const detail = {
            '/achievements/collection_points_100': {
                hrid: '/achievements/collection_points_100',
                name: 'Collector',
                description: 'Reach 100 collection points',
                tierHrid: '/achievement_tiers/adept',
                target: 100,
            },
        };
        game.detail = detail;
        game.clientData = { achievementDetailMap: detail };
        game.collections = [{ itemHrid: '/items/milk', count: 5 }];
        achievementsTab(detail);
        finisher.initialize();
        expect(lineOf('Collector')).toBeNull();
    });

    test('the Toolasha hints checkbox sits beside Show Incomplete Only and flips the setting', () => {
        const { controls } = achievementsTab();
        finisher.initialize();
        const box = toggle();
        expect(box.previousElementSibling).toBe(controls.firstElementChild);
        expect(box.textContent).toBe('Toolasha hints');
        expect(box.querySelector('.Mui-checked')).not.toBeNull();

        box.querySelector('label').click();
        expect(game.setting).toBe(false);
        // Off: every card addition is gone, the checkbox stays so it can be turned back on
        expect(lines()).toHaveLength(0);
        expect(toggle()).not.toBeNull();
        expect(toggle().querySelector('.Mui-checked')).toBeNull();

        toggle().querySelector('label').click();
        expect(game.setting).toBe(true);
        expect(lines().length).toBeGreaterThan(0);
        expect(document.querySelectorAll(`.${PANEL_CLASS}-toggle`)).toHaveLength(1);
        expect(toggle().querySelector('.Mui-checked')).not.toBeNull();
    });

    test('with the setting off at load the module still starts: checkbox only, no lines', () => {
        game.setting = false;
        achievementsTab();
        finisher.initialize();
        expect(finisher.isInitialized).toBe(true);
        expect(toggle()).not.toBeNull();
        expect(lines()).toHaveLength(0);
    });

    test('a settings-page change of the setting redraws live both ways', () => {
        achievementsTab();
        finisher.initialize();
        game.setting = false;
        game.settingHandlers.filter((e) => e.key === 'achievementFinisher').forEach((e) => e.fn(false));
        expect(lines()).toHaveLength(0);
        game.setting = true;
        game.settingHandlers.filter((e) => e.key === 'achievementFinisher').forEach((e) => e.fn(true));
        expect(lines().length).toBeGreaterThan(0);
    });

    test('the game re-rendering its cards, toggling Show Incomplete Only, or leaving and returning redraws the hints once', () => {
        const { list, page } = achievementsTab();
        finisher.initialize();
        const first = lines().length;
        expect(first).toBeGreaterThan(0);
        // An observer pass over an unchanged page adds nothing
        mountAgain();
        mountAgain();
        expect(lines()).toHaveLength(first);

        // The game replaces every card with fresh elements
        page.remove();
        achievementsTab();
        mountAgain();
        expect(lines()).toHaveLength(first);
        expect(document.querySelectorAll(`.${PANEL_CLASS}-toggle`)).toHaveLength(1);

        // "Show Incomplete Only" removes finished cards: the rest keep exactly one line
        game.achievements = [done('/achievements/decompose_bamboo_gloves')];
        const card = cardOf('Recycler');
        card.remove();
        game.handlers.achievements_updated.forEach((fn) => fn({}));
        expect(lines()).toHaveLength(first - 1);

        // Collections tab: no tier list, nothing drawn; back again: drawn
        document.body.replaceChildren();
        const collections = document.createElement('div');
        collections.className = 'AchievementsPanel_collections__q';
        collections.innerHTML =
            '<div class="AchievementsPanel_controls__c"></div>' + nativeControl('Show Incomplete Only');
        document.body.appendChild(collections);
        mountAgain();
        expect(lines()).toHaveLength(0);
        expect(toggle()).toBeNull();
        collections.remove();
        achievementsTab();
        mountAgain();
        expect(lines().length).toBeGreaterThan(0);
        expect(list).toBeTruthy();
    });

    test('never draws on another player profile or a dialog', () => {
        const profile = document.createElement('div');
        profile.className = 'SharableProfile_overviewTab__1';
        profile.innerHTML =
            '<div class="AchievementsPanel_achievements__y"><div class="Achievement_achievement__a"><div class="Achievement_name__n">Dairy Chef</div></div></div>';
        document.body.appendChild(profile);
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<div class="AchievementsPanel_achievements__z"></div>';
        document.body.appendChild(dialog);
        expect(findAchievementsHost()).toBeNull();
        finisher.initialize();
        expect(lines()).toHaveLength(0);
        expect(toggle()).toBeNull();
    });

    test('a card is identified by its icon sprite id first, then by name and description', () => {
        // Translated client: the text names nothing in the catalog, the icon does
        const yogurt = ACHIEVEMENTS['/achievements/cook_peach_yogurt'];
        const { list } = achievementsTab({ [yogurt.hrid]: yogurt }, { translate: true });
        finisher.initialize();
        expect(list.firstElementChild.querySelector(`.${PANEL_CLASS}-line`).textContent).toContain('buy ~200');
        finisher.disable();

        // Same name on two cards: the icon settles each, even when the text could not
        document.body.replaceChildren();
        const gloves = ACHIEVEMENTS['/achievements/decompose_bamboo_gloves'];
        const twins = {
            [yogurt.hrid]: { ...yogurt, name: 'Twin' },
            [gloves.hrid]: { ...gloves, name: 'Twin' },
        };
        game.clientData = { ...game.clientData, achievementDetailMap: twins };
        achievementsTab(twins);
        finisher.initialize();
        const [first, second] = [...document.querySelectorAll('.Achievement_achievement__a')];
        expect(first.querySelector(`.${PANEL_CLASS}-line`).textContent).toContain('buy ~200');
        expect(second.querySelector(`.${PANEL_CLASS}-line`).textContent).toContain('materials owned');
        finisher.disable();

        // No icon (fallback): name settles a unique one, the description separates same-named ones
        document.body.replaceChildren();
        achievementsTab(twins, { icons: false });
        finisher.initialize();
        const [a, b] = [...document.querySelectorAll('.Achievement_achievement__a')];
        expect(a.querySelector(`.${PANEL_CLASS}-line`).textContent).toContain('buy ~200');
        expect(b.querySelector(`.${PANEL_CLASS}-line`).textContent).toContain('materials owned');
    });

    test('a character switch removes every addition; the next character gets fresh ones', () => {
        achievementsTab();
        finisher.initialize();
        game.handlers.character_switching.forEach((fn) => fn());
        expect(lines()).toHaveLength(0);
        expect(toggle()).toBeNull();
        game.handlers.character_initialized.forEach((fn) => fn());
        expect(lines().length).toBeGreaterThan(0);
        expect(toggle()).not.toBeNull();
    });

    test('a redraw reuses cached readiness; stock moving, or another character, recomputes it', async () => {
        achievementsTab();
        finisher.initialize();
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
        expect(lineOf('Dairy Chef').textContent).toContain('buy ~');
        await vi.advanceTimersByTimeAsync(1000);
        expect(lineOf('Dairy Chef').textContent).toContain('materials owned');
        const second = nav.getItemPriceInfo.mock.calls.length;

        game.characterId = 8;
        game.handlers.achievements_updated.forEach((fn) => fn({}));
        expect(nav.getItemPriceInfo.mock.calls.length).toBeGreaterThan(second);
    });

    test('a gold amount is followed by the game coin icon once the item sheet is known', () => {
        const probe = document.createElement('div');
        probe.innerHTML = '<svg><use href="/static/media/items_sprite.abc.svg#milk"></use></svg>';
        document.body.appendChild(probe);
        try {
            achievementsTab();
            finisher.initialize();
            const hint = lineOf('Dairy Chef').querySelector(`.${PANEL_CLASS}-ready`);
            expect(hint.textContent).toBe('[level met · buy ~200]');
            expect(hint.querySelector('use').getAttribute('href')).toBe('/static/media/items_sprite.abc.svg#coin');
            expect(lineOf('Recycler').querySelector(`.${PANEL_CLASS}-ready use`)).toBeNull();
        } finally {
            probe.remove();
            resetSpriteSheetCache();
        }
    });

    test('a value-map price is marked as an estimate; a pricing-mode change recomputes the cost', async () => {
        game.estimated = new Set(['/items/peach']);
        achievementsTab();
        finisher.initialize();
        expect(lineOf('Dairy Chef').textContent).toContain('buy ~200 coin (est.)');
        expect(lineOf('Ginkgo Wielder').textContent).not.toContain('(est.)');

        expect(game.settingHandlers.map((e) => e.key).sort()).toEqual([
            'achievementFinisher',
            'profitCalc_pricingMode',
        ]);
        game.prices = { ...PRICES, '/items/peach': 300 };
        game.settingHandlers.filter((e) => e.key === 'profitCalc_pricingMode').forEach((e) => e.fn('optimistic'));
        await vi.advanceTimersByTimeAsync(1000);
        expect(lineOf('Dairy Chef').textContent).toContain('buy ~600 coin (est.)');
    });

    test('mounts when the tab appears after init, once; disable removes everything, every listener and a pending redraw', async () => {
        finisher.initialize();
        expect(lines()).toHaveLength(0);
        achievementsTab();
        mountAgain();
        mountAgain();
        expect(document.querySelectorAll(`.${PANEL_CLASS}-toggle`)).toHaveLength(1);
        const count = lines().length;
        expect(count).toBeGreaterThan(0);

        const listener = nav.marketOn.mock.calls[0][0];
        game.handlers.items_updated.forEach((fn) => fn({}));
        finisher.disable();
        expect(lines()).toHaveLength(0);
        expect(toggle()).toBeNull();
        expect(game.observers).toHaveLength(0);
        expect(nav.marketOff).toHaveBeenCalledWith(listener);
        expect(Object.values(game.handlers).every((list) => list.length === 0)).toBe(true);
        expect(game.settingHandlers).toHaveLength(0);
        const calls = nav.getItemPriceInfo.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5000);
        expect(lines()).toHaveLength(0);
        expect(nav.getItemPriceInfo.mock.calls.length).toBe(calls);
    });

    test('before the catalog or the achievement list loads, nothing is drawn but the checkbox', () => {
        game.achievements = null;
        achievementsTab();
        finisher.initialize();
        expect(lines()).toHaveLength(0);
        expect(toggle()).not.toBeNull();
    });

    test('a card element the game reuses for another achievement is read again, not remembered', () => {
        achievementsTab();
        finisher.initialize();
        expect(lineOf('Dairy Chef')).not.toBeNull();
        // The list re-renders into the same element: now it shows the finished Recycler
        game.achievements = [done('/achievements/decompose_bamboo_gloves')];
        cardOf('Dairy Chef')
            .querySelector('use')
            .setAttribute('href', '/static/media/achievements_sprite.abc.svg#decompose_bamboo_gloves');
        mountAgain();
        expect(cardOf('Dairy Chef').querySelector(`.${PANEL_CLASS}-line`)).toBeNull();
    });

    test('Missing Mats appears on a redraw once the actions bundle opener has loaded', () => {
        game.inventory = INVENTORY.filter((row) => row.itemHrid !== '/items/bamboo_gloves');
        game.bridgeOff = true;
        achievementsTab();
        finisher.initialize();
        expect(lineOf('Dairy Chef')).not.toBeNull();
        expect(matsOf('Dairy Chef')).toBeNull();
        game.bridgeOff = false;
        game.handlers.items_updated.forEach((fn) => fn());
        vi.advanceTimersByTime(1500);
        expect(matsOf('Dairy Chef')).not.toBeNull();
    });
    /** The game's left navigation entries, by the icon label each carries */
    function navBar(...labels) {
        const clicks = [];
        for (const label of labels) {
            const nav = document.createElement('div');
            nav.className = 'NavigationBar_nav__3uuUl';
            nav.innerHTML = `<svg aria-label="${label}"></svg>`;
            nav.addEventListener('click', () => clicks.push(label));
            document.body.appendChild(nav);
        }
        return clicks;
    }

    const placeSetup = () => {
        game.detail = PLACE_ACHIEVEMENTS;
        game.clientData = { ...PLACE_DATA, achievementDetailMap: PLACE_ACHIEVEMENTS };
    };

    test('place cards: house hint without Go; labyrinth, dungeon, shop and coinify navigate only', async () => {
        placeSetup();
        game.skills = [{ skillHrid: '/skills/attack', level: 1 }];
        game.houseRooms = [['/house_rooms/brewery', { houseRoomHrid: '/house_rooms/brewery', level: 2 }]];
        game.achievements = [
            { achievementHrid: '/achievements/clear_t1_dungeon_10_times', progress: 4, isCompleted: false },
            { achievementHrid: '/achievements/coinify_coins_1m', progress: 250000, isCompleted: false },
        ];
        const clicks = navBar('navigationBar.labyrinth', 'navigationBar.shop');
        achievementsTab(PLACE_ACHIEVEMENTS);
        finisher.initialize();

        expect(lineOf('Homeowner II').textContent).toContain('[build any room to Lv 3 · your highest room Lv 2]');
        expect(goOf('Homeowner II')).toBeNull();

        expect(lineOf('Labyrinth Explorer II').textContent).toContain('[reach Labyrinth floor 4]');
        goOf('Labyrinth Explorer II').click();
        expect(clicks).toEqual(['navigationBar.labyrinth']);

        // A combat level of 1 meets no dungeon: the first is shown with its gate, and Go opens it at T1
        expect(lineOf('Dungeon Elitist').textContent).toContain('[dungeon T1 · 4 / 10 clears · needs Lv 80');
        goOf('Dungeon Elitist').click();
        expect(nav.openCombatZoneAtTier.mock.calls).toEqual([['/actions/combat/chimerical_den', 1]]);

        expect(lineOf('Charmed').textContent).toContain('[Shop: Trainee Milking Charm ~200.0K coin]');
        goOf('Charmed').click();
        expect(clicks).toEqual(['navigationBar.labyrinth', 'navigationBar.shop']);
        expect(nav.setShopFilter).toHaveBeenCalledWith('Trainee Milking Charm');

        expect(lineOf('Midas Touch').textContent).toContain('[coinified 250.0K / 1.0M coin]');
        goOf('Midas Touch').click();
        await vi.runAllTimersAsync();
        // No stack to alchemize: the coinify action itself; nothing is started or bought
        expect(gameCalls).toEqual([['handleGoToAction', '/actions/alchemy/coinify']]);
        expect(nav.navigateToMarketplace).not.toHaveBeenCalled();
        expect(nav.navigateToAction).not.toHaveBeenCalled();
    });

    test('place cards with nothing loaded: rooms and progress unknown, never 0', () => {
        placeSetup();
        game.achievements = [{ achievementHrid: '/achievements/coinify_coins_1m', isCompleted: false }];
        achievementsTab(PLACE_ACHIEVEMENTS);
        finisher.initialize();
        expect(lineOf('Homeowner II').textContent).toContain('rooms not loaded');
        expect(lineOf('Dungeon Elitist').textContent).toContain('clears unknown');
        expect(lineOf('Midas Touch').textContent).toContain('coinify 1.0M coin · progress unknown');
    });

    test('progress moving redraws a place card; the shop filter waits for the box and stops for a new character', () => {
        placeSetup();
        game.achievements = [
            { achievementHrid: '/achievements/clear_t1_dungeon_10_times', progress: 4, isCompleted: false },
        ];
        navBar('navigationBar.shop');
        achievementsTab(PLACE_ACHIEVEMENTS);
        finisher.initialize();
        game.achievements = [
            { achievementHrid: '/achievements/clear_t1_dungeon_10_times', progress: 5, isCompleted: false },
        ];
        game.handlers.achievements_updated.forEach((fn) => fn());
        expect(lineOf('Dungeon Elitist').textContent).toContain('5 / 10 clears');

        nav.setShopFilter.mockReturnValue(false);
        goOf('Charmed').click();
        vi.advanceTimersByTime(250);
        expect(nav.setShopFilter.mock.calls.length).toBe(3);
        game.characterId = 8;
        vi.advanceTimersByTime(5000);
        expect(nav.setShopFilter.mock.calls.length).toBe(3);
        nav.setShopFilter.mockReturnValue(true);
    });
    test('ability cards: buy the cheapest unlearned book, Go opens its listing; an owned book or Iron Cow gets no Go', () => {
        game.detail = ABILITY_ACHIEVEMENTS;
        game.clientData = { ...ABILITY_DATA, achievementDetailMap: ABILITY_ACHIEVEMENTS };
        game.skills = [
            { skillHrid: '/skills/melee', level: 10 },
            { skillHrid: '/skills/magic', level: 70 },
            { skillHrid: '/skills/ranged', level: 1 },
        ];
        game.learned = [{ abilityHrid: '/abilities/poke', level: 1, experience: 0 }];
        game.inventory = [];
        game.prices = { '/items/scratch': 4000, '/items/mystic_aura': 50_000_000, '/items/speed_aura': 1_000_000 };
        game.estimated = new Set(['/items/mystic_aura']);
        achievementsTab(ABILITY_ACHIEVEMENTS);
        finisher.initialize();
        expect(lineOf('Student').textContent).toContain('[level met · buy Scratch ~4.0K coin]');
        goOf('Student').click();
        expect(nav.navigateToMarketplace).toHaveBeenLastCalledWith('/items/scratch', 0);
        // Speed Aura is cheaper but needs Ranged 50: Mystic Aura, an estimate, is the met one
        expect(lineOf('Gifted').textContent).toContain('[level met · buy Mystic Aura ~50.0M coin (est.)]');

        // A Revive book in the bag: owned, nothing to buy
        game.inventory = [
            { itemHrid: '/items/revive', count: 1, itemLocationHrid: '/item_locations/inventory', enhancementLevel: 0 },
        ];
        finisher.readinessChanged();
        vi.advanceTimersByTime(1500);
        expect(lineOf('Gifted').textContent).toContain('[level met · book owned: Revive]');
        expect(goOf('Gifted')).toBeNull();

        // Any ability counts for Student too
        expect(lineOf('Student').textContent).toContain('book owned: Revive');
        game.inventory = [];
        game.ironCow = true;
        finisher.readinessChanged();
        vi.advanceTimersByTime(1500);
        expect(lineOf('Student').textContent).toContain('[level met · no book owned]');
        expect(goOf('Student')).toBeNull();
    });

    test('ability cards before the abilities load say so; learning one recomputes', () => {
        game.detail = ABILITY_ACHIEVEMENTS;
        game.clientData = { ...ABILITY_DATA, achievementDetailMap: ABILITY_ACHIEVEMENTS };
        game.learned = null;
        game.prices = { '/items/scratch': 4000 };
        achievementsTab(ABILITY_ACHIEVEMENTS);
        finisher.initialize();
        expect(lineOf('Student').textContent).toBe('[abilities not loaded]');
        game.learned = [{ abilityHrid: '/abilities/scratch' }];
        game.handlers.abilities_updated.forEach((fn) => fn());
        vi.advanceTimersByTime(1500);
        expect(lineOf('Student').textContent).toContain('[level met · no price for any book]');
    });
    test('enhancer cards: the cheapest piece and level, Go opens that listing; an estimate is no listing; Iron Cow gets nothing', () => {
        game.detail = ENHANCE_ACHIEVEMENTS;
        game.clientData = { ...ENHANCE_DATA, achievementDetailMap: ENHANCE_ACHIEVEMENTS };
        game.prices = {
            '/items/cheese_gloves': 500,
            '/items/cheese': 50,
            // Only a value-map estimate at +3: nobody lists it
            '/items/cheese_gloves+3': 10,
            '/items/magnetic_gloves+10': 2_000_000,
            '/items/chrono_gloves': 90_000_000,
        };
        game.estimated = new Set(['/items/cheese_gloves+3']);
        achievementsTab(ENHANCE_ACHIEVEMENTS);
        finisher.initialize();
        // +3 at 10 coins would win if an estimate counted as a listing
        expect(lineOf('Enhancer I').textContent).toContain(
            '[buy Cheese Gloves +0 & enhance ~1.9K coin · protect with Cheese]'
        );
        goOf('Enhancer I').click();
        expect(nav.navigateToMarketplace).toHaveBeenLastCalledWith('/items/cheese_gloves', 0);
        expect(lineOf('Enhancer IV').textContent).toContain('[buy Magnetic Gloves +10 & enhance ~2.');
        goOf('Enhancer IV').click();
        expect(nav.navigateToMarketplace).toHaveBeenLastCalledWith('/items/magnetic_gloves', 10);

        // Three Enhancer rows, one listing scan: Cheese Gloves +3 was priced once
        const at3 = nav.getItemPriceInfo.mock.calls.filter(
            ([hrid, opts]) => hrid === '/items/cheese_gloves' && opts?.enhancementLevel === 3
        );
        expect(at3).toHaveLength(1);

        game.ironCow = true;
        finisher.readinessChanged();
        vi.advanceTimersByTime(1500);
        expect(lineOf('Enhancer I')).toBeNull();
        expect(lineOf('Enhancer IV')).toBeNull();
    });

    test('enhancer cards with no listing, or before skills load, say so with no Go', () => {
        game.detail = ENHANCE_ACHIEVEMENTS;
        game.clientData = { ...ENHANCE_DATA, achievementDetailMap: ENHANCE_ACHIEVEMENTS };
        game.prices = {};
        achievementsTab(ENHANCE_ACHIEVEMENTS);
        finisher.initialize();
        expect(lineOf('Enhancer III').textContent).toBe('[no listing for any piece to take to +10]');
        expect(goOf('Enhancer III')).toBeNull();
        game.skills = null;
        game.prices = { '/items/cheese_gloves': 500 };
        finisher.readinessChanged();
        vi.advanceTimersByTime(1500);
        expect(lineOf('Enhancer III').textContent).toBe('[enhancing stats not loaded]');
        expect(goOf('Enhancer III')).toBeNull();
    });
});
