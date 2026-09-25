/** @vitest-environment happy-dom */

/**
 * Combat Statistics popup: the session picker.
 *
 * The popup always answered "how is this run going"; the archive already held
 * the runs before it. These test the join — an archived session rendered
 * through the same calculator as the live view, with its stored duration,
 * clearly headed as archived, and Live restored on the way back. Read-only
 * over the archive throughout.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    /** What the collector says the run in progress is; null = nothing live */
    live: null,
    /** The archive, newest first */
    sessions: [],
    /** The `combatStatsChatMessage` setting; null = never edited */
    template: null,
    /** combatDropLuck.lastResult */
    luck: null,
    /** combatDropLuck.dungeonChestLuckFor's answer, `{actionHrid, difficultyTier, result}` */
    chest: null,
    /** dataManager.getCurrentActions() — the zone(s) actually being fought */
    currentActions: [],
    /** damageBreakdown() */
    damage: null,
    /** combatBossEta.getEtaText() */
    bossEta: null,
}));

/** Per-character storage, keyed as character-key would key it */
const store = vi.hoisted(() => ({ values: new Map(), charId: 'char-1', charName: 'LiveGuy' }));

/**
 * The schema default `chatTemplateDefault()` reads. A real module export, so a
 * test can mutate `.default` in place to simulate a future build changing it
 * out from under a value Reset stored earlier.
 */
const schemaMocks = vi.hoisted(() => ({
    chatMessageSetting: { default: [{ type: 'text', value: 'Combat Stats: ' }] },
}));
vi.mock('../../core/settings-schema.js', () => ({
    settingsGroups: {
        combat: { settings: { combatStatsChatMessage: schemaMocks.chatMessageSetting } },
    },
}));

// Real subscribe/unsubscribe bookkeeping, unlike a no-op stub, so a test can
// prove a cleanup+initialize cycle does not accumulate listeners.
const settingListeners = vi.hoisted(() => ({}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_TEXT_PRIMARY: '#eee',
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_TOOLTIP_PROFIT: '#5f5',
        getSetting: () => true,
        getSettingValue: (key, fallback) => (key === 'combatStatsChatMessage' ? mocks.template : (fallback ?? null)),
        setSettingValue: vi.fn((key, value) => {
            if (key === 'combatStatsChatMessage') mocks.template = value;
        }),
        getPricingModeLabel: () => 'Hybrid',
        getPricingModeDisplayLabel: () => 'Hybrid',
        onSettingChange: (key, callback) => {
            (settingListeners[key] ??= []).push(callback);
            return () => {
                settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
            };
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => ({ name: hrid.split('/').pop(), rarity: 0 }),
        getActionDetails: (hrid) => (hrid === '/actions/combat/chimerical_den' ? { name: 'Chimerical Den' } : null),
        getCurrentCharacterId: () => store.charId,
        getCurrentCharacterName: () => store.charName,
        // The zone actually being fought, for chatContext to look up the
        // difficulty tier `combatDropLuck.resultFor` needs
        getCurrentActions: () => mocks.currentActions,
    },
}));
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_${store.charId}`,
    readScoped: async (base, _storeName, fallback) => {
        const key = `${base}_${store.charId}`;
        return store.values.has(key) ? store.values.get(key) : fallback;
    },
    writeScoped: async (base, value) => {
        store.values.set(`${base}_${store.charId}`, value);
        return true;
    },
}));
vi.mock('../../utils/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../combat/damage-tracker.js', () => ({ damageBreakdown: () => mocks.damage }));
vi.mock('../combat/combat-drop-luck.js', () => ({
    default: {
        get lastResult() {
            return mocks.luck;
        },
        resultFor({ actionHrid, difficultyTier = 0 } = {}) {
            const result = mocks.luck;
            if (!result || !actionHrid) return null;
            if (result.actionHrid !== actionHrid) return null;
            if ((result.difficultyTier || 0) !== difficultyTier) return null;
            return result;
        },
        dungeonChestLuckFor({ actionHrid, difficultyTier = 0 } = {}) {
            const chest = mocks.chest;
            if (!chest || !actionHrid) return null;
            if (chest.actionHrid !== actionHrid) return null;
            if ((chest.difficultyTier || 0) !== difficultyTier) return null;
            return chest.result;
        },
    },
}));
vi.mock('../combat/combat-boss-eta.js', () => ({ default: { getEtaText: () => mocks.bossEta } }));
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: async () => ({}), getPrice: () => null },
}));
vi.mock('./combat-stats-data-collector.js', () => ({
    default: {
        getLatestData: () => mocks.live,
        loadLatestData: async () => null,
        resetConsumableTracking: async () => {},
    },
}));
vi.mock('./combat-session-history.js', () => ({
    loadSessions: async () => mocks.sessions,
}));
vi.mock('../../utils/key-cost.js', () => ({
    formatKeyCostNote: () => '',
    describeKeyCost: () => ({ unitCost: null }),
    getKeyPricingMode: () => 'ask',
    resolveKeyPricing: () => ({ setting: 'ask', priceSide: 'ask', basis: 'market' }),
}));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        isInitialized: false,
        getCachedValue: () => null,
        calculateSingleContainer: () => null,
        calculateExpectedValue: () => null,
    },
}));

const {
    default: combatStatsUI,
    archivedSessionLabel,
    combatSessionText,
    SHARE_TO_CHAT_COMMAND,
} = await import('./combat-stats-ui.js');
const { registeredCommands, resetCommands } = await import('../../utils/command-registry.js');
const { showToast } = await import('../../utils/toast.js');
const { utf8Length } = await import('../../utils/chat-fill.js');
const config = (await import('../../core/config.js')).default;

/** Coins only, so the real calculator prices the run without a market */
const player = (name, coins, isCurrentPlayer = false) => ({
    name,
    isCurrentPlayer,
    deathCount: 0,
    loot: { 1: { itemHrid: '/items/coin', count: coins } },
    experience: {},
    consumables: [],
});

const ARCHIVED = {
    key: 'A,B,C,D,E|2026-08-05T10:00:00Z',
    combatStartTime: '2026-08-05T10:00:00Z',
    durationSeconds: 22_320, // 6h 12m
    actionHrid: '/actions/combat/chimerical_den',
    battleId: 100,
    players: ['A', 'B', 'C', 'D', 'E'].map((name, index) => player(name, 1000 * (index + 1), index === 0)),
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const popup = () => document.querySelector('.toolasha-combat-stats-popup');
const picker = () => document.querySelector('.toolasha-combat-stats-session-picker');

beforeEach(() => {
    mocks.live = {
        battleId: 5,
        combatStartTime: null,
        durationSeconds: 600,
        actionHrid: '/actions/combat/chimerical_den',
        players: [player('LiveGuy', 5000, true)],
    };
    mocks.sessions = [ARCHIVED];
    mocks.currentActions = [{ actionHrid: '/actions/combat/chimerical_den', difficultyTier: 0 }];
    vi.stubGlobal('alert', vi.fn());
});

afterEach(() => {
    combatStatsUI.closePopup();
    combatStatsUI.viewing = 'live';
    combatStatsUI.chatFields = null;
    combatStatsUI.chatUseCheckboxes = false;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    mocks.template = null;
    schemaMocks.chatMessageSetting.default = [{ type: 'text', value: 'Combat Stats: ' }];
    mocks.luck = null;
    mocks.chest = null;
    mocks.damage = null;
    mocks.bossEta = null;
    mocks.currentActions = [];
    store.values.clear();
    store.charId = 'char-1';
    store.charName = 'LiveGuy';
    showToast.mockClear();
});

describe('naming an archived run in the picker', () => {
    test('duration, zone and party size, in one line', () => {
        const label = archivedSessionLabel(ARCHIVED, { zoneNameOf: () => 'Chimerical Den' });
        expect(label).toContain('6h 12m · Chimerical Den · party of 5');
    });

    test('a zone the archive never recorded goes unnamed rather than guessed', () => {
        const label = archivedSessionLabel({ ...ARCHIVED, actionHrid: null }, { zoneNameOf: () => null });
        expect(label).toContain('6h 12m · party of 5');
    });

    test('one player is solo, and a missing date says so', () => {
        const label = archivedSessionLabel({ durationSeconds: 60, players: [player('A', 1)] });
        expect(label).toContain('Unknown date');
        expect(label).toContain('solo');
    });
});

describe('the session picker on the popup', () => {
    test('defaults to Live, with every archived run on offer', async () => {
        await combatStatsUI.showPopup();

        expect(popup().textContent).toContain('Combat Statistics');
        expect(popup().textContent).not.toContain('Archived Session');
        expect(popup().textContent).toContain('LiveGuy');

        expect(picker().value).toBe('live');
        const labels = [...picker().options].map((option) => option.textContent);
        expect(labels[0]).toBe('Live session');
        expect(labels[1]).toContain('Chimerical Den · party of 5');
    });

    test('choosing an archived run renders it, headed as archived, at its stored duration', async () => {
        await combatStatsUI.showPopup();

        picker().value = ARCHIVED.key;
        picker().dispatchEvent(new Event('change'));
        await flush();

        const text = popup().textContent;
        expect(text).toContain('Combat Statistics — Archived Session');
        expect(text).toContain('Archived session —');
        // The archived duration, through the same calculator the live view uses
        expect(text).toContain('6h 12m');
        // Every member of the archived party, priced
        for (const name of ['A', 'B', 'C', 'D', 'E']) expect(text).toContain(name);
        // Consumable tracking is live-only, so its reset is not offered here
        expect(text).not.toContain('Reset Consumable Tracking');
    });

    test('switching back to Live restores the run in progress', async () => {
        await combatStatsUI.showPopup();
        picker().value = ARCHIVED.key;
        picker().dispatchEvent(new Event('change'));
        await flush();

        picker().value = 'live';
        picker().dispatchEvent(new Event('change'));
        await flush();

        const text = popup().textContent;
        expect(text).not.toContain('Archived Session');
        expect(text).toContain('LiveGuy');
        expect(text).toContain('Reset Consumable Tracking');
    });

    test('a remembered session that fell off the archive falls back to Live', async () => {
        combatStatsUI.viewing = 'gone|2026-01-01T00:00:00Z';
        await combatStatsUI.showPopup();

        expect(combatStatsUI.viewing).toBe('live');
        expect(popup().textContent).not.toContain('Archived Session');
    });

    test('no live run but a stocked archive still opens the popup', async () => {
        mocks.live = null;
        await combatStatsUI.showPopup();

        expect(globalThis.alert).not.toHaveBeenCalled();
        expect(popup().textContent).toContain('pick an archived session');
    });

    test('nothing live and nothing archived still alerts, as before', async () => {
        mocks.live = null;
        mocks.sessions = [];
        await combatStatsUI.showPopup();

        expect(globalThis.alert).toHaveBeenCalled();
        expect(popup()).toBeNull();
    });
});

describe('combatSessionText', () => {
    const stats = (name, overrides = {}) => ({
        name,
        durationFormatted: '1h 0m',
        encountersPerHour: 10,
        income: { ask: 1000, bid: 900 },
        dailyIncome: { ask: 24000, bid: 21600 },
        consumableCosts: { ask: 50, bid: 50 },
        dailyProfit: { ask: 23000, bid: 20600 },
        totalExp: 500,
        expPerHour: 500,
        deathCount: 1,
        deathsPerHour: 1,
        ...overrides,
    });

    test('one block per player, under the header, priced by the chosen key', () => {
        const text = combatSessionText([stats('A'), stats('B')], {
            header: 'Combat Statistics — Live',
            priceKey: 'bid',
        });
        expect(text.startsWith('Combat Statistics — Live')).toBe(true);
        expect(text).toContain('A');
        expect(text).toContain('B');
        expect(text).toContain('Income (bid): 900');
        expect(text).toContain('Daily profit: 20600/d');
    });

    test('no players says so rather than printing an empty header', () => {
        expect(combatSessionText([])).toContain('No data.');
        expect(combatSessionText(null)).toContain('No data.');
    });

    test('the formatter passed in is what renders every number', () => {
        const text = combatSessionText([stats('A')], { formatNum: (n) => `<${n}>` });
        expect(text).toContain('Encounters/hour: <10>');
        expect(text).toContain('Total EXP: <500>');
        // The calculator hands consumables over as {ask, bid}, like income
        expect(text).toContain('Consumable costs: <50>');
    });
});

describe('the Copy button on the popup', () => {
    const copyButton = () => [...popup().querySelectorAll('button')].find((b) => b.textContent.includes('Copy'));

    test('is offered for a live run with data, and copies every player', async () => {
        await combatStatsUI.showPopup();

        const written = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation((value) => {
            written.push(value);
            return Promise.resolve();
        });

        const btn = copyButton();
        expect(btn).toBeTruthy();
        btn.click();
        await flush();

        expect(written[0]).toContain('LiveGuy');
        expect(written[0]).not.toContain('Archived Session');
    });

    test('switches to a checkmark, then back, after copying', async () => {
        vi.useFakeTimers();
        await combatStatsUI.showPopup();
        vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

        const btn = copyButton();
        btn.click();
        await Promise.resolve();
        expect(btn.textContent).toContain('Copied');

        vi.advanceTimersByTime(1200);
        expect(btn.textContent).toContain('Copy');
        expect(btn.textContent).not.toContain('Copied');
        vi.useRealTimers();
    });

    test('an archived session copies headed as archived', async () => {
        await combatStatsUI.showPopup();
        picker().value = ARCHIVED.key;
        picker().dispatchEvent(new Event('change'));
        await flush();

        const written = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation((value) => {
            written.push(value);
            return Promise.resolve();
        });
        copyButton().click();
        await flush();

        expect(written[0]).toContain('Archived Session');
        for (const name of ['A', 'B', 'C', 'D', 'E']) expect(written[0]).toContain(name);
    });

    test('a popup open with nothing measured yet offers no Copy button', async () => {
        mocks.live = null;
        await combatStatsUI.showPopup();

        expect(popup()).toBeTruthy();
        expect(copyButton()).toBeUndefined();
    });
});

describe('the Chat button on the popup', () => {
    const chatButton = () => popup().querySelector('.toolasha-combat-chat-btn');
    const chatInput = () => {
        const container = document.createElement('div');
        container.className = 'Chat_chatInputContainer__x';
        container.innerHTML = '<form><input /></form>';
        document.body.appendChild(container);
        return container.querySelector('input');
    };

    test('fills the chat box with this character’s stats — focused, never sent', async () => {
        const input = chatInput();
        let sent = false;
        input.addEventListener('keydown', () => (sent = true));
        mocks.luck = { percentile: 0.73, players: [], actionHrid: '/actions/combat/chimerical_den', difficultyTier: 0 };

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(input.value.startsWith('Combat Stats: 10m duration')).toBe(true);
        expect(input.value).toContain('0 deaths | 73rd pct luck');
        expect(input.value).not.toContain('\n');
        expect(document.activeElement).toBe(input);
        expect(sent).toBe(false);
        expect(showToast).not.toHaveBeenCalled();
    });

    test('luck measured for a different zone is left out, not shown as this one’s', async () => {
        // The scenario the zone stamp exists for: the tracker's last reading is
        // still the zone that was just left, and the character is now fighting
        // somewhere else — sharing it here would attribute it to the wrong zone
        const input = chatInput();
        mocks.luck = { percentile: 0.73, players: [], actionHrid: '/actions/combat/somewhere_else', difficultyTier: 0 };

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(input.value).not.toContain('luck');
    });

    test('luck for the same zone but a different difficulty tier is also left out', async () => {
        const input = chatInput();
        mocks.luck = { percentile: 0.73, players: [], actionHrid: '/actions/combat/chimerical_den', difficultyTier: 3 };

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(input.value).not.toContain('luck');
    });

    test('a dungeon with no per-monster model falls back to the chest reading for this zone and tier', async () => {
        const input = chatInput();
        mocks.luck = null; // the model has nothing to say about a dungeon
        mocks.chest = {
            actionHrid: '/actions/combat/chimerical_den',
            difficultyTier: 0,
            result: { players: [{ name: 'LiveGuy', luck: { percentile: 0.62 } }] },
        };

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(input.value).toContain('chest luck 62nd pct');
    });

    test('a chest reading for a different zone or tier is left out, same as the model’s guard', async () => {
        const input = chatInput();
        mocks.luck = null;
        mocks.chest = {
            actionHrid: '/actions/combat/chimerical_den',
            difficultyTier: 3,
            result: { players: [{ name: 'LiveGuy', luck: { percentile: 0.62 } }] },
        };

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(input.value).not.toContain('luck');
    });

    test('a dungeon with no chests measured yet leaves luck out entirely', async () => {
        const input = chatInput();
        mocks.luck = null;
        mocks.chest = null;

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(input.value).not.toContain('luck');
    });

    test('a solo run’s luck is paired with how far the take sat over the modelled mean', async () => {
        const input = chatInput();
        // Solo: the session figures (players: []) are this player's own
        mocks.luck = {
            percentile: 0.73,
            income: 1200,
            expected: 1000,
            players: [],
            actionHrid: '/actions/combat/chimerical_den',
            difficultyTier: 0,
        };

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(input.value).toContain('73rd pct luck (+20% vs expected)');
    });

    test('a solo run below the modelled mean gets an explicit minus sign', async () => {
        const input = chatInput();
        mocks.luck = {
            percentile: 0.12,
            income: 500,
            expected: 1000,
            players: [],
            actionHrid: '/actions/combat/chimerical_den',
            difficultyTier: 0,
        };

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(input.value).toContain('12th pct luck (-50% vs expected)');
    });

    test('a party member’s luck has no over-expected bracket — only the session total is known, not their own share', async () => {
        const input = chatInput();
        // A party: `players` is non-empty, so the placed-player branch is used,
        // which only ever carries a percentile — never a per-player income and
        // expectation to pair it with (see combat-stats-ui.js chatContext)
        mocks.luck = {
            percentile: 0.73,
            income: 1200,
            expected: 1000,
            players: [{ name: 'LiveGuy', percentile: 0.73 }],
            actionHrid: '/actions/combat/chimerical_den',
            difficultyTier: 0,
        };

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(input.value).toContain('73rd pct luck');
        expect(input.value).not.toContain('vs expected');
    });

    test('dungeon chest luck carries the same bracket, live numbers', async () => {
        const input = chatInput();
        mocks.luck = null;
        // MillenniumTest, Pirate Cove T2, live on the test server: 892 chests
        // against 878 expected — about +1.6%, rounding to +2%.
        mocks.chest = {
            actionHrid: '/actions/combat/chimerical_den',
            difficultyTier: 0,
            result: { players: [{ name: 'LiveGuy', luck: { percentile: 0.89, chests: 892, expected: 878 } }] },
        };

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(input.value).toContain('chest luck 89th pct (+2% vs expected)');
    });

    test('a chest reading with nothing to compare against keeps today’s bare text', async () => {
        const input = chatInput();
        mocks.luck = null;
        mocks.chest = {
            actionHrid: '/actions/combat/chimerical_den',
            difficultyTier: 0,
            result: { players: [{ name: 'LiveGuy', luck: { percentile: 0.62, chests: 5, expected: 0 } }] },
        };

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(input.value).toContain('chest luck 62nd pct');
        expect(input.value).not.toContain('vs expected');
    });

    test('with chat hidden, copies the message instead and says so', async () => {
        const written = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (value) => written.push(value));

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(written[0]).toContain('Combat Stats: 10m duration');
        expect(showToast).toHaveBeenCalledWith('chat not visible — copied', expect.anything());
    });

    test('Ctrl+click on a card still shares that player, and the card says so', async () => {
        const input = chatInput();
        await combatStatsUI.showPopup();

        const cards = [...popup().querySelectorAll('div')].filter((el) => el.title?.startsWith('Ctrl+click'));
        expect(cards).toHaveLength(1);
        expect(cards[0].title).toContain('LiveGuy');

        cards[0].dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
        await flush();
        expect(input.value).toContain('Combat Stats:');
    });

    test('text already in the box shrinks the message by whole fields, not by a raw cut', async () => {
        // 370 bytes typed leaves 30: room for "Combat Stats: 10m duration" and
        // nothing more, so the builder drops fields rather than the fill
        // slicing the full message mid-word
        const input = chatInput();
        const typed = `/w ${'x'.repeat(366)} `;
        input.value = typed;
        input.setSelectionRange(typed.length, typed.length);

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(input.value).toBe(`${typed}Combat Stats: 10m duration`);
        expect(utf8Length(input.value)).toBeLessThanOrEqual(400);
        expect(showToast).not.toHaveBeenCalled();
    });

    test('a chat box already full is copied and said to be full, not hidden', async () => {
        const input = chatInput();
        input.value = 'z'.repeat(400);
        vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

        await combatStatsUI.showPopup();
        chatButton().click();
        await flush();

        expect(showToast).toHaveBeenCalledWith('chat is full — copied', expect.anything());
    });

    test('a second click inside the flash still restores the button’s own label', async () => {
        chatInput();
        await combatStatsUI.showPopup();
        vi.useFakeTimers();
        try {
            chatButton().click();
            await vi.advanceTimersByTimeAsync(100);
            chatButton().click();
            await vi.advanceTimersByTimeAsync(100);
            expect(chatButton().textContent).toBe('✓ Filled');

            await vi.advanceTimersByTimeAsync(1500);
            expect(chatButton().textContent).toBe('💬 Chat');
        } finally {
            vi.useRealTimers();
        }
    });

    test('an archived run leaves the live-only readings out', async () => {
        const input = chatInput();
        mocks.luck = { percentile: 0.73, players: [] };
        mocks.damage = { players: [{ name: 'A', dps: 500, kills: 3 }] };
        store.charName = 'A';
        store.values.set('combatStatsChatFields_char-1', ['zone', 'luck', 'dps', 'kills']);

        await combatStatsUI.showPopup();
        picker().value = ARCHIVED.key;
        picker().dispatchEvent(new Event('change'));
        await flush();
        chatButton().click();
        await flush();

        expect(input.value).toBe('Combat Stats: Chimerical Den');
    });
});

describe('the chat field picker', () => {
    const caret = () => popup().querySelector('.toolasha-combat-chat-caret');
    const popover = () => popup().querySelector('.toolasha-combat-chat-popover');
    const box = (key) => popover().querySelector(`input[data-field="${key}"]`);
    const preview = () => popover().querySelector('.toolasha-combat-chat-preview').textContent;

    test('opens with the defaults ticked, a live preview and a byte count', async () => {
        await combatStatsUI.showPopup();
        caret().click();

        expect(box('duration').checked).toBe(true);
        expect(box('luck').checked).toBe(true);
        expect(box('dps').checked).toBe(false);
        expect(preview().startsWith('Combat Stats: 10m duration')).toBe(true);
        expect(popover().querySelector('.toolasha-combat-chat-count').textContent).toBe(
            `${utf8Length(preview())} / 400 bytes`
        );
    });

    test('the preview shows the same over-expected bracket the fill puts in the chat box', async () => {
        const container = document.createElement('div');
        container.className = 'Chat_chatInputContainer__x';
        container.innerHTML = '<form><input /></form>';
        document.body.appendChild(container);
        const input = container.querySelector('input');

        mocks.luck = {
            percentile: 0.73,
            income: 1200,
            expected: 1000,
            players: [],
            actionHrid: '/actions/combat/chimerical_den',
            difficultyTier: 0,
        };

        await combatStatsUI.showPopup();
        caret().click();
        const previewText = preview();
        expect(previewText).toContain('(+20% vs expected)');

        popup().querySelector('.toolasha-combat-chat-btn').click();
        await flush();

        expect(input.value).toBe(previewText);
    });

    test('the count turns red if the message it is handed is over the limit', async () => {
        // The builder itself always trims to fit, so this proves the counter's
        // own defensive check reacts rather than trusting that can never happen
        const over = vi.spyOn(combatStatsUI, 'buildChatMessageFor').mockReturnValue('x'.repeat(500));
        await combatStatsUI.showPopup();
        caret().click();

        const counter = popover().querySelector('.toolasha-combat-chat-count');
        expect(counter.textContent).toBe('500 / 400 bytes');
        expect(counter.style.color).not.toBe('rgb(153, 153, 153)');

        over.mockRestore();
    });

    test('ticking a field updates the preview and is saved for this character only', async () => {
        mocks.damage = { players: [{ name: 'LiveGuy', dps: 1234, kills: 9 }] };
        await combatStatsUI.showPopup();
        caret().click();

        box('dps').checked = true;
        box('dps').dispatchEvent(new Event('change'));
        expect(preview()).toContain('1,234 DPS');
        expect(store.values.get('combatStatsChatFields_char-1')).toContain('dps');

        // Another character has their own selection
        combatStatsUI.closePopup();
        store.charId = 'char-2';
        await combatStatsUI.showPopup();
        caret().click();
        expect(box('dps').checked).toBe(false);

        // And the first one's is still there
        combatStatsUI.closePopup();
        store.charId = 'char-1';
        await combatStatsUI.showPopup();
        caret().click();
        expect(box('dps').checked).toBe(true);
    });

    test('a custom template is named, previewed, and can be traded back for the checkboxes', async () => {
        mocks.template = [
            { type: 'text', value: 'Mine: ' },
            { type: 'variable', key: '{exp}' },
        ];
        await combatStatsUI.showPopup();
        caret().click();

        expect(popover().querySelector('.toolasha-combat-chat-template-note')).toBeTruthy();
        expect(box('duration')).toBeNull();
        expect(preview()).toBe('Mine: 0');

        popover().querySelector('.toolasha-combat-chat-use-fields').click();

        expect(config.setSettingValue).toHaveBeenCalledWith('combatStatsChatMessage', expect.any(Array));
        expect(box('duration').checked).toBe(true);
        expect(preview().startsWith('Combat Stats:')).toBe(true);
    });

    test('the caret toggles the popover closed again', async () => {
        await combatStatsUI.showPopup();
        caret().click();
        expect(popover()).toBeTruthy();
        caret().click();
        expect(popover()).toBeNull();
    });
});

describe('the checkboxes-vs-template flag', () => {
    const caret = () => popup().querySelector('.toolasha-combat-chat-caret');
    const popover = () => popup().querySelector('.toolasha-combat-chat-popover');
    const box = (key) => popover().querySelector(`input[data-field="${key}"]`);
    const templateNote = () => popover().querySelector('.toolasha-combat-chat-template-note');
    const useFieldsButton = () => popover().querySelector('.toolasha-combat-chat-use-fields');
    const CUSTOM_TEMPLATE = [
        { type: 'text', value: 'Mine: ' },
        { type: 'variable', key: '{exp}' },
    ];

    test('with no flag stored, a custom template wins as before', async () => {
        mocks.template = CUSTOM_TEMPLATE;
        await combatStatsUI.showPopup();
        caret().click();

        expect(templateNote()).toBeTruthy();
        expect(box('duration')).toBeNull();
    });

    test('Reset keeps the checkboxes winning even after the schema default changes later', async () => {
        mocks.template = CUSTOM_TEMPLATE;
        await combatStatsUI.showPopup();
        caret().click();
        useFieldsButton().click();

        // The flag is what was persisted, not just today's default text
        expect(store.values.get('combatStatsChatUseCheckboxes_char-1')).toBe(true);
        expect(templateNote()).toBeNull();
        expect(box('duration').checked).toBe(true);

        // A later build changes what the schema default is
        schemaMocks.chatMessageSetting.default = [{ type: 'text', value: 'New Default: ' }];

        combatStatsUI.closePopup();
        await combatStatsUI.showPopup();
        caret().click();

        // Reset stored the *old* default text, which no longer equals the new
        // one — comparing text alone would read this character as custom again
        expect(templateNote()).toBeNull();
        expect(box('duration').checked).toBe(true);
    });

    test('the flag is scoped per character', async () => {
        mocks.template = CUSTOM_TEMPLATE;
        store.values.set('combatStatsChatUseCheckboxes_char-1', true);

        await combatStatsUI.showPopup();
        caret().click();
        expect(box('duration')).toBeTruthy();

        combatStatsUI.closePopup();
        store.charId = 'char-2';
        await combatStatsUI.showPopup();
        caret().click();
        // char-2 never reset, so the still-custom template decides for it
        expect(templateNote()).toBeTruthy();
    });

    describe('editing the template in Settings', () => {
        afterEach(() => {
            combatStatsUI.cleanup();
            for (const key of Object.keys(settingListeners)) delete settingListeners[key];
        });

        test('a genuine edit clears the flag; rewriting the default text does not', async () => {
            store.values.set('combatStatsChatUseCheckboxes_char-1', true);
            combatStatsUI.initialize();
            combatStatsUI.chatUseCheckboxes = true;

            // Reset itself rewrites the setting to the default text — must not
            // undo the flag it just set
            for (const cb of settingListeners.combatStatsChatMessage) cb(schemaMocks.chatMessageSetting.default);
            expect(combatStatsUI.chatUseCheckboxes).toBe(true);

            // An actual template edit in Settings — must clear it
            const edited = [{ type: 'text', value: 'Edited: ' }];
            for (const cb of settingListeners.combatStatsChatMessage) cb(edited);
            expect(combatStatsUI.chatUseCheckboxes).toBe(false);

            await flush();
            expect(store.values.get('combatStatsChatUseCheckboxes_char-1')).toBe(false);
        });
    });
});

describe('a character switch while the popup is loading', () => {
    /** loadChatFields resolves, and the switch lands before showPopup resumes */
    const switchDuringLoad = () => {
        const original = combatStatsUI.loadChatFields.bind(combatStatsUI);
        vi.spyOn(combatStatsUI, 'loadChatFields').mockImplementation(async () => {
            const fields = await original();
            store.charId = 'char-2';
            return fields;
        });
    };

    test('draws nothing, rather than the departing character’s run for the arriving one', async () => {
        store.values.set('combatStatsChatFields_char-1', ['dps']);
        switchDuringLoad();

        await combatStatsUI.showPopup();

        expect(popup()).toBeNull();
        // Not left holding char-1's selection for a later popup to save as char-2's
        expect(combatStatsUI.chatFields).toBeNull();
    });

    test('the palette verb fills nothing into the arriving character’s chat', async () => {
        const container = document.createElement('div');
        container.className = 'Chat_chatInputContainer__x';
        container.innerHTML = '<input />';
        document.body.appendChild(container);
        switchDuringLoad();

        const result = await combatStatsUI.shareLatestToChat();

        expect(container.querySelector('input').value).toBe('');
        expect(result).toMatch(/character switched/);
    });
});

describe('the "Share combat stats to chat" palette verb', () => {
    afterEach(() => {
        combatStatsUI.cleanup();
        resetCommands();
        for (const key of Object.keys(settingListeners)) delete settingListeners[key];
    });

    const command = () => registeredCommands().find((c) => c.name === SHARE_TO_CHAT_COMMAND);

    test('is registered as a verb on initialize and withdrawn on cleanup', () => {
        combatStatsUI.initialize();
        expect(command()?.kind).toBe('verb');

        combatStatsUI.cleanup();
        expect(command()).toBeUndefined();
    });

    test('is only offered once there is combat data', () => {
        combatStatsUI.initialize();
        mocks.live = null;
        expect(command()).toBeUndefined();
        mocks.live = { battleId: 1, durationSeconds: 60, players: [player('LiveGuy', 1, true)] };
        expect(command()).toBeTruthy();
    });

    test('fills chat and answers with what it did', async () => {
        const container = document.createElement('div');
        container.className = 'Chat_chatInputContainer__x';
        container.innerHTML = '<input />';
        document.body.appendChild(container);

        combatStatsUI.initialize();
        const result = await command().run();

        const value = container.querySelector('input').value;
        expect(value.startsWith('Combat Stats:')).toBe(true);
        expect(result).toBe(`filled chat (${value.length} chars)`);
    });

    test('with chat hidden, answers that it copied', async () => {
        vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
        combatStatsUI.initialize();
        expect(await command().run()).toMatch(/^chat not visible — copied \(\d+ chars\)$/);
    });

    test('a message too long for chat is trimmed to fit, and says so', async () => {
        // The builder already trims to the game's limit, so this proves
        // `fillChatInput`'s own safety-net trim — the one that accounts for
        // whatever the box already had in it — rather than the builder's
        const over = vi.spyOn(combatStatsUI, 'buildChatMessageFor').mockReturnValue('x'.repeat(500));

        const container = document.createElement('div');
        container.className = 'Chat_chatInputContainer__x';
        container.innerHTML = '<input />';
        document.body.appendChild(container);

        combatStatsUI.initialize();
        const result = await command().run();

        const value = container.querySelector('input').value;
        expect(utf8Length(value)).toBeLessThanOrEqual(400);
        expect(result).toMatch(/^filled chat — trimmed to fit/);

        over.mockRestore();
    });
});

describe('cleanup unregisters the setting-change listener it registered', () => {
    afterEach(() => {
        combatStatsUI.cleanup();
        for (const key of Object.keys(settingListeners)) delete settingListeners[key];
    });

    test('a character-switch cycle does not accumulate listeners', () => {
        // Every character switch runs cleanup() then initialize() again
        // (feature-registry.js). If the unregister function onSettingChange
        // hands back is discarded, each cycle leaves one more copy of the
        // same callback on config's per-key list.
        combatStatsUI.initialize();
        for (let i = 0; i < 3; i++) {
            combatStatsUI.cleanup();
            combatStatsUI.initialize();
        }

        expect(settingListeners.combatStats).toHaveLength(1);
    });
});
