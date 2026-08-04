/**
 * @vitest-environment happy-dom
 *
 * The slash-command parser and the fuzzy item-name matcher behind it — the
 * part of this feature that is arithmetic rather than DOM wiring.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ setting: true, itemDetailMap: {} }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => game.setting },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: game.itemDetailMap }),
        on: () => {},
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, clearAll: () => {} }),
}));

const chatCommandsFeature = (await import('./chat-commands.js')).default;

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
});
