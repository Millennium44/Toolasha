/**
 * Tests for the settings schema.
 *
 * Only the defaults that are a judgement call get pinned here — a default that
 * quietly flips changes what every new install does, and there is nothing else
 * in the codebase that would notice.
 */

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
     * Keys nothing reads but `config.isFeatureEnabled`, which the feature
     * registry consults at start-up and on a character switch — and nowhere
     * else. None of these modules watches its own key from module scope, so
     * the registry's answer is the only one that is ever taken.
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

    test('each one says it needs a reload, because switching it on mid-session starts nothing', () => {
        // Until these keys were honoured at all they did nothing either way, so
        // the omission cost nothing. Now that the gate reads them, a player who
        // ticks one and watches for the feature is owed the reload tag: the
        // registry will not run again until the page does. Five of the eight
        // shipped without the flag.
        for (const id of REGISTRY_GATED_ONLY) {
            expect(getSettingDefinition(id)?.requiresRefresh, id).toBe(true);
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
        expect(setting.help).toMatch(/RNG/i);
    });
});
