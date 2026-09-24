/**
 * Tests for the settings schema.
 *
 * Only the defaults that are a judgement call get pinned here — a default that
 * quietly flips changes what every new install does, and there is nothing else
 * in the codebase that would notice.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { describe, test, expect } from 'vitest';
import { getSettingDefinition } from './settings-schema.js';

describe('guild trial defaults', () => {
    test('the raw diagnostic trace is opt-in, and its help states the cost plainly', () => {
        const setting = getSettingDefinition('guildTrialDiagnosticTrace');
        // A default-on trace would have every player holding a large buffer of
        // raw combat data — with participant names in it — that almost none of
        // them will ever export
        expect(setting.default).toBe(false);
        expect(setting.help).toMatch(/large/i);
        expect(setting.help).toMatch(/participant names/i);
    });
});

describe('labyrinth defaults', () => {
    test('the path planner assumes the worst about a room it cannot see', () => {
        const setting = getSettingDefinition('labyrinthPathUnknownMode');
        // An optimistic default routes you through rooms that turn out to need
        // a shroud you did not bring; the pessimistic one only ever overpays
        expect(setting.default).toBe('shroud');
        expect(setting.options.map((o) => o.value)).toContain('shroud');
    });

    test('replaying the live fight is opt-in, not something every player pays for', () => {
        // It runs the real combat engine hundreds of times mid-fight
        expect(getSettingDefinition('labyrinthLiveCombatSim').default).toBe(false);
    });

    test('the sim precision help describes the stopping rule it actually governs', () => {
        const help = getSettingDefinition('labyrinthSimPrecision').help;
        expect(help).toContain('percentage points');
        expect(help).toMatch(/confidence interval/i);
    });
});

describe('enhancement simulator defaults', () => {
    test('the base item is priced at the cheaper of crafting and buying, as it always has been', () => {
        // It shipped `false` but behaved as `true`: its only readers go through
        // `config.isFeatureEnabled`, which answered `true` for any key outside
        // the legacy features map. Honouring the schema without moving the
        // default would have changed every enhancement path's base-item cost.
        expect(getSettingDefinition('enhanceSim_baseItemCraftingCost').default).toBe(true);
    });
});

describe('net worth and auto-all sub-settings name their parent', () => {
    test('the net worth sub-settings all require the net worth master switch', () => {
        const ids = [
            'invWorth',
            'networth_includeCowbells',
            'networth_includeTaskTokens',
            'networth_abilityBooksAsInventory',
            'networth_historyChart',
            'networth_goldSources',
        ];
        for (const id of ids) {
            expect(getSettingDefinition(id).requires, id).toBe('networth');
        }
    });

    test('excluding seals from the auto-all click requires the auto-all button itself', () => {
        expect(getSettingDefinition('autoAllButton_excludeSeals').requires).toBe('autoAllButton');
    });
});

describe('marketplace autofill strategy defaults', () => {
    test('buy and sell both default to matching the best price, not outbidding or undercutting it', () => {
        // A default of 'outbid'/'undercut' quietly escalates or discounts every
        // fresh install's listings; matching is the only default that cannot
        // itself move the market. A saved explicit choice is untouched either way.
        expect(getSettingDefinition('market_autoFillBuyStrategy').default).toBe('match');
        expect(getSettingDefinition('market_autoFillSellStrategy').default).toBe('match');
    });
});

describe('time format defaults', () => {
    test('new installs follow the device clock, and the help text covers every date/time display', () => {
        const setting = getSettingDefinition('market_listingTimeFormat');
        // 'auto' only ever applies to a fresh install; an existing user's stored
        // '24hour'/'12hour' choice is untouched (see settings-storage.test.js).
        expect(setting.default).toBe('auto');
        expect(setting.options.map((o) => o.value)).toEqual(['auto', '24hour', '12hour']);
        // The help text used to claim it only covered listings and completion times, full stop;
        // 16 other views print through the same setting, so the text now says it governs
        // everything and only mentions listings/completions as one example among many.
        expect(setting.help).not.toMatch(/^time format used in marketplace listings/i);
        expect(setting.help).toMatch(/every date and time/i);
    });
});

describe('the Buy and Sell pricing rows', () => {
    test('each row is a view over the pricing settings and stores nothing itself', () => {
        for (const [id, side] of [
            ['profitCalc_pricingSideBuy', 'buy'],
            ['profitCalc_pricingSideSell', 'sell'],
        ]) {
            const setting = getSettingDefinition(id);
            expect(setting.type, id).toBe('pricingSide');
            expect(setting.side, id).toBe(side);
            // No default: the choice lives in the three keys below, and a
            // default here would invent a fourth stored preference
            expect(setting.default, id).toBe(undefined);
        }
    });

    test('the three settings behind them are untouched, with their rows hidden rather than dropped', () => {
        // Hidden, not deleted: the schema entry is what gives a key its default
        // and its stored shape, so removing it would move everybody's saved value
        const mode = getSettingDefinition('profitCalc_pricingMode');
        expect(mode.type).toBe('select');
        expect(mode.default).toBe('hybrid');
        expect(mode.hidden).toBe(true);
        expect(mode.options.map((o) => o.value)).toEqual(['conservative', 'hybrid', 'optimistic', 'patientBuy']);

        for (const id of ['profitCalc_patientTickBuy', 'profitCalc_patientTickSell']) {
            const tick = getSettingDefinition(id);
            expect(tick.type, id).toBe('checkbox');
            expect(tick.default, id).toBe(false);
            expect(tick.hidden, id).toBe(true);
        }
    });

    test('the words the old rows were searched by still appear on the new ones', () => {
        // The settings search matches label + help, and these two rows replaced
        // a mode dropdown and two "+1 tick" / "−1 tick" checkboxes
        const buy = getSettingDefinition('profitCalc_pricingSideBuy');
        const sell = getSettingDefinition('profitCalc_pricingSideSell');
        const buyText = `${buy.label} ${buy.help}`.toLowerCase();
        const sellText = `${sell.label} ${sell.help}`.toLowerCase();

        for (const term of ['patient', 'instant', 'ask', 'bid', 'pricing mode']) {
            expect(buyText, term).toContain(term);
            expect(sellText, term).toContain(term);
        }
        expect(buyText).toContain('+1 tick');
        expect(sellText).toContain('−1 tick');
    });
});

describe('listing age and value badge defaults', () => {
    test('listing age defaults to showing on both the order book and My Listings', () => {
        const setting = getSettingDefinition('market_listingAge');
        expect(setting.default).toBe('both');
        // Iron Cow "disabled" still has to mean off, now that off is no longer the default
        expect(setting.offValue).toBe('off');
    });

    test('value badges default to stack value while sorting by Ask/Bid', () => {
        const setting = getSettingDefinition('inv_valueBadges');
        expect(setting.default).toBe('sorting');
        expect(setting.offValue).toBe('off');
    });
});

describe('the switches whose only reader is the feature-registry gate', () => {
    /**
     * Keys read by nothing but the feature registry's gate. The registry
     * re-checks gates on every setting change and starts what a change opens
     * (`setupLiveFeatureStart` — see feature-registry.test.js, "a setting
     * switched on mid-session"), so switching any of these on takes effect at
     * once. `labyrinthMonsterStatCheck` stops itself on its own listener
     * (outside the `liveStop` mechanism below) and is not one of the 18.
     */
    const REGISTRY_GATED_ONLY = [
        'goalPlanner',
        'damageTracker',
        'damageTakenTracker',
        'taskInventoryHighlighter',
        'sessionBriefing',
        'ironCowFarm',
        'overlayTabButton',
        'labyrinthMonsterStatCheck',
    ];

    /**
     * The 18 settings whose registry entry now opts into `liveStop: true`
     * (feature-registry.js: `runLiveStops`) — a setting change that closes the
     * gate now disables the feature through its existing `disable()`/`cleanup()`
     * live, the same teardown a character switch already exercised, instead of
     * only ever starting things. None of them need `requiresRefresh` any more.
     */
    const LIVE_STOP_SETTINGS = [
        'requiredMaterials',
        'skillRemainingXP',
        'drinkTimer',
        'skillingOptimizer',
        'damageTracker',
        'damageTakenTracker',
        'stunPersistenceWatch',
        'waveGapWatch',
        'tickPeriodWatch',
        'taskRerollTracker',
        'taskSorter',
        'taskInventoryHighlighter',
        'overlayPanel',
        'overlayTabButton',
        'commandPalette',
        'goalPlanner',
        'ironCowFarm',
        'sessionBriefing',
    ];

    test('each one is gated by its own registry entry, which a setting change now re-checks', () => {
        const entrypoint = readFileSync(resolve(process.cwd(), 'src/entrypoint.js'), 'utf8');
        for (const id of REGISTRY_GATED_ONLY) {
            expect(entrypoint, id).toContain(`key: '${id}',`);
        }
    });

    test('none of them still say they need a reload — labyrinthMonsterStatCheck never did either', () => {
        for (const id of REGISTRY_GATED_ONLY) {
            expect(Boolean(getSettingDefinition(id)?.requiresRefresh), id).toBe(false);
        }
    });

    test('each of the 18 has a liveStop registry entry, and none is tagged requiresRefresh', () => {
        const entrypoint = readFileSync(resolve(process.cwd(), 'src/entrypoint.js'), 'utf8');
        for (const id of LIVE_STOP_SETTINGS) {
            // Slice from this entry's `key:` line to the next one, so the
            // `liveStop: true` this test finds is this entry's own and not a
            // later feature's.
            const start = entrypoint.indexOf(`key: '${id}',`);
            expect(start, id).toBeGreaterThan(-1);
            const nextKey = entrypoint.indexOf("key: '", start + 1);
            const entry = entrypoint.slice(start, nextKey === -1 ? undefined : nextKey);
            expect(entry, id).toContain('liveStop: true');
            expect(Boolean(getSettingDefinition(id)?.requiresRefresh), id).toBe(false);
        }
    });
});

describe('startup recovery defaults', () => {
    test('automatic recovery ships off, and its help says what turning it on does', () => {
        const setting = getSettingDefinition('startupRecovery_autoReload');
        // Acting on the player's session without being asked is opt-in, even
        // on a page that has already failed to load anything
        expect(setting.default).toBe(false);
        expect(setting.type).toBe('checkbox');
        // Off means "ask me", never "do nothing", and the help has to say so
        expect(setting.help).toMatch(/turn this on/i);
        expect(setting.help).toMatch(/reload button/i);
    });
});

describe('combat task Go count buffer defaults', () => {
    test('defaults to a modest 5% pad, bounded to a sane percentage range', () => {
        const setting = getSettingDefinition('taskCombatGoBuffer');
        expect(setting.type).toBe('number');
        expect(setting.default).toBe(5);
        expect(setting.min).toBe(0);
        expect(setting.max).toBe(100);
        // min <= default <= max, or a fresh install's own default would be
        // outside the range its own settings UI lets you pick
        expect(setting.default).toBeGreaterThanOrEqual(setting.min);
        expect(setting.default).toBeLessThanOrEqual(setting.max);
        // It is a floor now, not the whole padding — the confidence setting
        // usually asks for more — and the help has to say both that and the
        // boss exception, or a player raising it expects it to do something
        // on a boss task that it deliberately will not.
        expect(setting.help).toMatch(/smallest padding|minimum|floor/i);
        expect(setting.help).toMatch(/boss/i);
    });

    test('the confidence setting defaults to 90, in range, and explains the consequence', () => {
        const setting = getSettingDefinition('combatFightConfidence');
        expect(setting.type).toBe('number');
        expect(setting.default).toBe(90);
        expect(setting.min).toBe(0);
        expect(setting.max).toBe(99);
        expect(setting.default).toBeGreaterThanOrEqual(setting.min);
        expect(setting.default).toBeLessThanOrEqual(setting.max);
        // Says what you get, not how the quantile is computed
        expect(setting.help).toMatch(/nine runs in ten|how often/i);
        // And says what zero does, since zero is the off switch
        expect(setting.help).toMatch(/0 turns it off/i);
    });
});
