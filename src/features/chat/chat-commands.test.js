/**
 * @vitest-environment happy-dom
 *
 * The slash-command parser and the fuzzy item-name matcher behind it — the
 * part of this feature that is arithmetic rather than DOM wiring.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    setting: true,
    itemDetailMap: {},
    guildBuffDetailMap: {},
    characterGuildBuffMap: {},
    guildBuildingLevelMap: {},
    shrineCapturedAt: null,
    shrineHydrated: false,
    prices: {},
    capturedExchanges: [],
}));

vi.mock('../../core/config.js', () => ({
    // `onSettingChange` is reached through the guild trials feature, which now
    // imports the notification service; the service hooks every notification
    // setting at import time so it can ask for permission on a real gesture
    default: {
        getSetting: () => game.setting,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => {},
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            itemDetailMap: game.itemDetailMap,
            guildBuffDetailMap: game.guildBuffDetailMap,
        }),
        get characterGuildBuffMap() {
            return game.characterGuildBuffMap;
        },
        get guildBuildingLevelMap() {
            return game.guildBuildingLevelMap;
        },
        getGuildShrineCapturedAt: () => game.shrineCapturedAt,
        isGuildShrineHydrated: () => game.shrineHydrated,
        on: () => {},
    },
}));
const observerReady = vi.hoisted(() => ({ handlers: [], domReady: true }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        // Mirrors the real DOMObserver.onReady: immediate when already attached (the default),
        // deferred until the readiness-gap test fires it by hand otherwise.
        onReady: (name, callback) => {
            const handler = { name, callback };
            observerReady.handlers.push(handler);
            if (observerReady.domReady) callback();
            return () => {
                observerReady.handlers = observerReady.handlers.filter((h) => h !== handler);
            };
        },
    },
}));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, clearAll: () => {} }),
}));
// The token valuation the /shrines report now carries a line of. Mocked at its
// two data sources rather than wholesale, so the line is the real arithmetic.
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (itemHrid, { mode } = {}) => game.prices[itemHrid]?.[mode] ?? 0,
    getItemPriceInfo: (itemHrid, { mode } = {}) => {
        const price = game.prices[itemHrid]?.[mode] ?? 0;
        return { price, source: price > 0 ? 'book' : null, estimated: false };
    },
}));
vi.mock('../guild/guild-token-exchange-capture.js', () => ({
    capturedTokenExchanges: () => game.capturedExchanges,
}));

const chatCommandsModule = await import('./chat-commands.js');
const chatCommandsFeature = chatCommandsModule.default;
const { collectShrineDebug, exposeShrineDebug, formatShrineReport } = chatCommandsModule;

/** An item map in which a token buys ten green credits, each worth 100 gold */
function tokenBuysTenGreen() {
    return {
        '/items/bronze_bar': {
            name: 'Bronze Bar',
            guildCreditConversions: [{ creditItemHrid: '/items/green_guild_credit', itemCount: 1, creditCount: 1 }],
        },
        '/items/green_guild_credit': { name: 'Green Guild Credit' },
        '/items/guild_token': {
            name: 'Guild Token',
            guildCreditConversions: [{ creditItemHrid: '/items/green_guild_credit', itemCount: 1, creditCount: 10 }],
        },
    };
}

async function makeInstance() {
    document.body.innerHTML = '';
    return chatCommandsFeature.initialize();
}

describe('parseCommand', () => {
    let cmd;

    beforeEach(async () => {
        game.setting = true;
        game.itemDetailMap = {};
        cmd = await makeInstance();
    });

    test('/item with a name parses to an item command', () => {
        expect(cmd.parseCommand('/item Radiant Fiber')).toEqual({ type: 'item', itemName: 'Radiant Fiber' });
    });

    test('/wiki with a name parses to a wiki command', () => {
        expect(cmd.parseCommand('/wiki Radiant Fiber')).toEqual({ type: 'wiki', itemName: 'Radiant Fiber' });
    });

    test('/market with no enhancement suffix defaults enhancementLevel to 0', () => {
        expect(cmd.parseCommand('/market Radiant Fiber')).toEqual({
            type: 'market',
            itemName: 'Radiant Fiber',
            enhancementLevel: 0,
        });
    });

    test('/market with a +N suffix parses the enhancement level and strips it from the name', () => {
        expect(cmd.parseCommand('/market Steel Sword +7')).toEqual({
            type: 'market',
            itemName: 'Steel Sword',
            enhancementLevel: 7,
        });
    });

    test('the command keyword is matched case-insensitively', () => {
        expect(cmd.parseCommand('/ITEM Radiant Fiber')).toEqual({ type: 'item', itemName: 'Radiant Fiber' });
    });

    test('a command with no item name is not a command', () => {
        expect(cmd.parseCommand('/item ')).toBeNull();
        expect(cmd.parseCommand('/item')).toBeNull();
    });

    test('ordinary chat text is not a command', () => {
        expect(cmd.parseCommand('hello everyone')).toBeNull();
        expect(cmd.parseCommand('/notacommand foo')).toBeNull();
    });

    test('surrounding whitespace on the whole line is trimmed', () => {
        expect(cmd.parseCommand('   /item Radiant Fiber   ')).toEqual({ type: 'item', itemName: 'Radiant Fiber' });
    });
});

describe('normalizeItemName', () => {
    let cmd;

    beforeEach(async () => {
        game.setting = true;
        game.itemDetailMap = {
            '/items/radiant_fiber': { name: 'Radiant Fiber' },
            '/items/radiant_fabric': { name: 'Radiant Fabric' },
            '/items/coin': { name: 'Coin' },
        };
        cmd = await makeInstance();
    });

    test('an exact match (case-insensitive) resolves to the underscored proper name', () => {
        expect(cmd.normalizeItemName('radiant fiber')).toBe('Radiant_Fiber');
        expect(cmd.normalizeItemName('RADIANT FIBER')).toBe('Radiant_Fiber');
    });

    test('a single fuzzy substring match resolves unambiguously', () => {
        expect(cmd.normalizeItemName('coin')).toBe('Coin');
    });

    test('an ambiguous fuzzy match returns null rather than guessing', () => {
        expect(cmd.normalizeItemName('radiant')).toBeNull();
    });

    test('no match at all falls back to a best-effort title-cased, underscored name', () => {
        expect(cmd.normalizeItemName('mystery item')).toBe('Mystery_Item');
    });

    test('without item data loaded, resolution always fails', async () => {
        game.itemDetailMap = {};
        const noData = await makeInstance();
        noData.itemData = null;

        expect(noData.normalizeItemName('coin')).toBeNull();
    });
});

describe('executeCommand', () => {
    let cmd;
    let openSpy;

    beforeEach(async () => {
        game.setting = true;
        game.itemDetailMap = {
            '/items/radiant_fiber': { name: 'Radiant Fiber' },
        };
        cmd = await makeInstance();
        openSpy = vi.spyOn(window, 'open').mockImplementation(() => {});
    });

    test('/item on a known item opens the item dictionary via the game core', () => {
        cmd.gameCore = { handleOpenItemDictionary: vi.fn() };

        cmd.executeCommand({ type: 'item', itemName: 'Radiant Fiber' });

        expect(cmd.gameCore.handleOpenItemDictionary).toHaveBeenCalledWith('/items/radiant_fiber');
    });

    test('/item on an unknown item reports an error instead of opening anything', () => {
        cmd.gameCore = { handleOpenItemDictionary: vi.fn() };
        const errorSpy = vi.spyOn(cmd, 'showError').mockImplementation(() => {});

        cmd.executeCommand({ type: 'item', itemName: 'Nonexistent Thing' });

        expect(cmd.gameCore.handleOpenItemDictionary).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found in game data'));
    });

    test('/item with no game core available (post-2/21/26) reports feature-unavailable', () => {
        cmd.gameCore = null;
        const errorSpy = vi.spyOn(cmd, 'showError').mockImplementation(() => {});

        cmd.executeCommand({ type: 'item', itemName: 'Radiant Fiber' });

        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('2/21/26'));
    });

    test('/wiki always opens a URL, even for an item not in game data', () => {
        cmd.executeCommand({ type: 'wiki', itemName: 'Totally Made Up' });

        expect(openSpy).toHaveBeenCalledWith('https://milkywayidle.wiki.gg/wiki/Totally_Made_Up', '_blank');
    });

    test('/market on a known item opens the marketplace with the parsed enhancement level', () => {
        cmd.gameCore = { handleGoToMarketplace: vi.fn() };

        cmd.executeCommand({ type: 'market', itemName: 'Radiant Fiber', enhancementLevel: 4 });

        expect(cmd.gameCore.handleGoToMarketplace).toHaveBeenCalledWith('/items/radiant_fiber', 4);
    });

    test('an ambiguous item name shows the multiple-matches message and executes nothing', () => {
        game.itemDetailMap = {
            '/items/radiant_fiber': { name: 'Radiant Fiber' },
            '/items/radiant_fabric': { name: 'Radiant Fabric' },
        };
        cmd.loadItemData();
        cmd.gameCore = { handleOpenItemDictionary: vi.fn() };
        const multiSpy = vi.spyOn(cmd, 'showMultipleMatches').mockImplementation(() => {});

        cmd.executeCommand({ type: 'item', itemName: 'radiant' });

        expect(multiSpy).toHaveBeenCalled();
        expect(cmd.gameCore.handleOpenItemDictionary).not.toHaveBeenCalled();
    });
});

describe('/shrines', () => {
    let cmd;

    /**
     * A chat history the feature will consider visible: one inside a TabPanel
     * that is not the hidden one.
     * @returns {Element} The history element
     */
    function buildChatHistory() {
        document.body.innerHTML =
            '<div class="TabPanel_x"><div class="inner"><div class="ChatHistory_chatHistory__x"></div></div></div>';
        return document.querySelector('[class*="ChatHistory_chatHistory"]');
    }

    /**
     * The text of everything the feature has echoed locally.
     * @returns {string} Message text
     */
    function echoed() {
        return Array.from(document.querySelectorAll('.mwi-chat-command-message'))
            .map((el) => el.textContent)
            .join('\n');
    }

    beforeEach(async () => {
        game.setting = true;
        game.itemDetailMap = {};
        game.guildBuffDetailMap = {
            '/guild_buffs/force_combat': { shrineHrid: '/guild_shrines/force', isCombat: true },
        };
        game.characterGuildBuffMap = {};
        game.guildBuildingLevelMap = {};
        game.shrineCapturedAt = null;
        game.shrineHydrated = false;
        game.prices = {};
        game.capturedExchanges = [];
        cmd = await makeInstance();
    });

    test('the whole line is the command, with or without a trailing space', () => {
        expect(cmd.parseCommand('/shrines')).toEqual({ type: 'shrines' });
        expect(cmd.parseCommand('  /SHRINES  ')).toEqual({ type: 'shrines' });
        expect(cmd.parseCommand('/shrinesfoo')).toBeNull();
    });

    test('with levels in hand, the report lists both maps and when they were read', () => {
        game.characterGuildBuffMap = { '/guild_buffs/force_combat': { level: 7 } };
        game.guildBuildingLevelMap = { '/guild_shrines/force': 9 };
        game.shrineCapturedAt = Date.parse('2026-08-04T12:00:00Z');
        const history = buildChatHistory();

        cmd.executeCommand({ type: 'shrines' });

        const text = echoed();
        expect(history.querySelectorAll('.mwi-chat-command-message')).toHaveLength(1);
        expect(text).toContain('/guild_buffs/force_combat');
        expect(text).toContain('Lv7');
        expect(text).toContain('[combat]');
        expect(text).toContain('/guild_shrines/force — Lv9');
        expect(text).toContain('read live this session');
        expect(text).toContain(new Date(game.shrineCapturedAt).toLocaleString());
    });

    test('with nothing captured, it says so instead of drawing two empty lists', () => {
        buildChatHistory();

        cmd.executeCommand({ type: 'shrines' });

        expect(echoed()).toContain('no data yet — open the guild page');
    });

    test('levels that came out of storage are labelled as an earlier session’s reading', () => {
        game.characterGuildBuffMap = { '/guild_buffs/force_combat': { level: 3 } };
        game.shrineCapturedAt = Date.parse('2026-07-01T09:00:00Z');
        game.shrineHydrated = true;
        buildChatHistory();

        cmd.executeCommand({ type: 'shrines' });

        const text = echoed();
        expect(text).toContain('hydrated from storage');
        expect(text).toContain('Lv3');
        // A hydrated record with no building levels still reports the map it has
        expect(text).toContain('Shrine/building levels (guildBuildingLevelMap): none');
    });

    test('the report is local only: Enter is cancelled and the input cleared', () => {
        buildChatHistory();
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.value = '/shrines';
        const event = {
            key: 'Enter',
            target: input,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };

        cmd.handleKeydown(event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(event.stopPropagation).toHaveBeenCalled();
        expect(input.value).toBe('');
        expect(echoed()).toContain('Toolasha /shrines');
    });

    test('the same report is available on the page global for the console', () => {
        game.characterGuildBuffMap = { '/guild_buffs/force_combat': { level: 2 } };
        window.Toolasha = { debug: { storage: () => 'kept' } };

        expect(exposeShrineDebug()).toBe(true);
        // Whatever was already on the debug namespace survives
        expect(window.Toolasha.debug.storage()).toBe('kept');
        expect(window.Toolasha.debug.shrines()).toEqual(collectShrineDebug());
        expect(formatShrineReport(window.Toolasha.debug.shrines())).toContain('Lv2');

        delete window.Toolasha;
    });

    test('no page global means nothing is invented for it', () => {
        delete window.Toolasha;

        expect(exposeShrineDebug()).toBe(false);
        expect(window.Toolasha).toBeUndefined();
    });

    test('the report carries what a guild token is worth, since shrine levels cost tokens', () => {
        game.itemDetailMap = tokenBuysTenGreen();
        game.prices = { '/items/bronze_bar': { ask: 100 } };
        game.characterGuildBuffMap = { '/guild_buffs/force_combat': { level: 1 } };
        buildChatHistory();

        cmd.executeCommand({ type: 'shrines' });

        // 10 credits a token at 100 gold each
        expect(echoed()).toContain('Guild token ≈ 1.0Kg via Green Guild Credit');
    });

    test('a token nothing can price is reported as unpriced, not as zero', () => {
        game.characterGuildBuffMap = { '/guild_buffs/force_combat': { level: 1 } };
        buildChatHistory();

        cmd.executeCommand({ type: 'shrines' });

        expect(echoed()).toContain('Guild token ≈ unpriced');
    });
});

describe('Toolasha.debug.tokenExchange', () => {
    beforeEach(async () => {
        game.setting = true;
        game.itemDetailMap = tokenBuysTenGreen();
        game.prices = { '/items/bronze_bar': { ask: 100 } };
        game.capturedExchanges = [];
        await makeInstance();
    });

    test('the helper is on the debug namespace and dumps every credit type', () => {
        window.Toolasha = {};
        expect(exposeShrineDebug()).toBe(true);

        const report = window.Toolasha.debug.tokenExchange();

        expect(report.source).toBe('client');
        expect(report.rows).toEqual([
            expect.objectContaining({
                creditItemHrid: '/items/green_guild_credit',
                name: 'Green Guild Credit',
                creditsPerToken: 10,
                goldPerCredit: 100,
                gold: 1000,
                picked: true,
            }),
        ]);
        expect(report.goldPerToken).toBe(1000);

        delete window.Toolasha;
    });

    test('the pricing side can be asked for', () => {
        window.Toolasha = {};
        game.prices = { '/items/bronze_bar': { ask: 100, bid: 90 } };
        exposeShrineDebug();

        expect(window.Toolasha.debug.tokenExchange('bid').goldPerToken).toBe(900);

        delete window.Toolasha;
    });

    test('the helper logs the printable report as well as returning it', () => {
        window.Toolasha = {};
        exposeShrineDebug();
        const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

        window.Toolasha.debug.tokenExchange();

        expect(logged.mock.calls[0][0]).toContain('Toolasha token exchange');
        expect(logged.mock.calls[0][0]).toContain('Picked Green Guild Credit');

        logged.mockRestore();
        delete window.Toolasha;
    });
});

describe('setupGameCore', () => {
    test('finds the game core by walking the React fiber tree for handleGoToMarketplace/sendPing', async () => {
        document.body.innerHTML = '<div id="root"></div>';
        const gameCoreStateNode = { sendPing: () => {}, handleGoToMarketplace: () => {} };
        document.getElementById('root')._reactRootContainer = {
            current: {
                stateNode: null,
                child: { stateNode: gameCoreStateNode, child: null, sibling: null },
                sibling: null,
            },
        };
        game.setting = true;
        game.itemDetailMap = {};

        const cmd = await chatCommandsFeature.initialize();

        expect(cmd.gameCore).toBe(gameCoreStateNode);
    });

    test('no root element leaves gameCore null rather than throwing', async () => {
        document.body.innerHTML = '';
        const cmd = await chatCommandsFeature.initialize();

        expect(cmd.gameCore).toBeNull();
    });

    test('a chat input mounted before the shared observer is ready is attached at readiness', async () => {
        observerReady.handlers = [];
        observerReady.domReady = false;
        document.body.innerHTML = '<div class="Chat_chatInputContainer__x"><input /></div>';

        const cmd = await chatCommandsFeature.initialize();
        expect(cmd.chatInput).toBeNull();

        observerReady.handlers.forEach((h) => h.callback());
        expect(cmd.chatInput).not.toBeNull();

        cmd.cleanup();
        observerReady.domReady = true;
    });
});
