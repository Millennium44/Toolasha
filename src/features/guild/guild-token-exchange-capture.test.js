/**
 * @vitest-environment happy-dom
 *
 * Reading the token exchange off the Guild Shop dialog.
 *
 * A DOM test because the thing under test is a reading of markup, and the only
 * interesting failures are misreadings: a dialog that is exchanging ordinary
 * items and not tokens, a batch size of seven that must not turn a rate of ten
 * into seventy, and this script's own injected arrows being read back as if the
 * game had written them.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {}, writes: 0, failWrite: false, failRead: false }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, storeName, fallback) => {
            if (store.failRead) throw new Error('storage is gone');
            return key in store.data ? store.data[key] : fallback;
        },
        set: async (key, value) => {
            store.writes += 1;
            if (store.failWrite) throw new Error('storage is full');
            store.data[key] = value;
        },
    },
}));

const {
    CAPTURE_KEY,
    _resetCapturedTokenExchanges,
    captureTokenExchangeFromModal,
    capturedTokenExchange,
    capturedTokenExchanges,
    hydrateCapturedTokenExchanges,
    readTokenExchangeFromModal,
    rememberTokenExchange,
} = await import('./guild-token-exchange-capture.js');

const GREEN = '/items/green_guild_credit';

/** The context the exchange modal observer hands over for a green-credit dialog */
const greenContext = {
    creditItemHrid: GREEN,
    creditName: 'Green Guild Credit',
    selectedItemName: 'Guild Token',
    tokenName: 'Guild Token',
};

/**
 * A modal built from raw markup.
 * @param {string} html - Modal contents
 * @returns {Element} The modal element
 */
function modal(html) {
    document.body.innerHTML = `<div class="GuildPanel_exchangeModalContent__ab1">${html}</div>`;
    return document.querySelector('[class*="GuildPanel_exchangeModalContent"]');
}

/**
 * An item tile the way the game draws one.
 * @param {string} name - Item name, as the sprite's aria-label
 * @param {number|null} count - Displayed count, or null for a tile with none
 * @returns {string} Markup
 */
function tile(name, count) {
    const countEl = count === null ? '' : `<div class="Item_count__x">${count}</div>`;
    return `<div class="Item_itemContainer__q"><svg aria-label="${name}"></svg>${countEl}</div>`;
}

beforeEach(() => {
    store.data = {};
    store.writes = 0;
    store.failWrite = false;
    store.failRead = false;
    _resetCapturedTokenExchanges();
    document.body.innerHTML = '';
});

describe('reading the dialog', () => {
    test('the arrow the game writes is the rate', () => {
        const el = modal('<div class="GuildPanel_header__z">Green Guild Credit</div><div>1 → 10</div>');

        expect(readTokenExchangeFromModal(el, greenContext)).toEqual({
            creditItemHrid: GREEN,
            creditsPerToken: 10,
            tokensPerExchange: 1,
            creditsPerExchange: 10,
            via: 'arrow',
        });
    });

    test('the batches input scales both sides, so the rate is unchanged', () => {
        const el = modal('<div>7 → 70</div>');

        expect(readTokenExchangeFromModal(el, greenContext).creditsPerToken).toBe(10);
    });

    test('thousands separators are read as numbers, not as decimal points', () => {
        const el = modal('<div>100 → 1,000</div>');

        expect(readTokenExchangeFromModal(el, greenContext).creditsPerToken).toBe(10);
    });

    test('with no arrow, the two item tiles say it instead', () => {
        const el = modal(tile('Guild Token', 1) + tile('Green Guild Credit', 10));

        expect(readTokenExchangeFromModal(el, greenContext)).toMatchObject({ creditsPerToken: 10, via: 'tiles' });
    });

    test('a tile with no count shown is showing one of the item', () => {
        const el = modal(tile('Guild Token', null) + tile('Green Guild Credit', 10));

        expect(readTokenExchangeFromModal(el, greenContext).tokensPerExchange).toBe(1);
    });

    test("this script's own injected arrows are not read back as game data", () => {
        const el = modal('<div class="mwi-guild-credit-value">Beast Hide 4 → 1</div><div>1 → 10</div>');

        expect(readTokenExchangeFromModal(el, greenContext).creditsPerToken).toBe(10);
    });

    test('a dialog exchanging something other than a token states no token rate', () => {
        const el = modal('<div>4 → 1</div>');

        expect(readTokenExchangeFromModal(el, { ...greenContext, selectedItemName: 'Beast Hide' })).toBeNull();
    });

    test('a dialog whose credit is not a credit is not an exchange', () => {
        const el = modal('<div>1 → 10</div>');

        expect(readTokenExchangeFromModal(el, { ...greenContext, creditItemHrid: '/items/coin' })).toBeNull();
    });

    test('a dialog saying nothing numeric is read as nothing rather than as zero', () => {
        expect(readTokenExchangeFromModal(modal('<div>Exchange</div>'), greenContext)).toBeNull();
    });

    test('an absurd ratio is a misread tile, not an exchange', () => {
        const el = modal('<div>1 → 999999</div>');

        expect(readTokenExchangeFromModal(el, greenContext)).toBeNull();
    });

    test('a missing modal is not an exchange', () => {
        expect(readTokenExchangeFromModal(null, greenContext)).toBeNull();
    });
});

describe('remembering what was read', () => {
    test('a reading is kept in memory and written down', async () => {
        const el = modal('<div>1 → 10</div>');

        await captureTokenExchangeFromModal(el, greenContext);

        expect(capturedTokenExchange(GREEN)).toMatchObject({ creditsPerToken: 10 });
        expect(store.data[CAPTURE_KEY].exchanges[GREEN].creditsPerToken).toBe(10);
        expect(store.writes).toBe(1);
    });

    test('the same reading twice is written once', async () => {
        const el = modal('<div>1 → 10</div>');

        await captureTokenExchangeFromModal(el, greenContext);
        await captureTokenExchangeFromModal(el, greenContext);

        expect(store.writes).toBe(1);
    });

    test('a changed rate overwrites the old one', async () => {
        await captureTokenExchangeFromModal(modal('<div>1 → 10</div>'), greenContext);
        await captureTokenExchangeFromModal(modal('<div>1 → 12</div>'), greenContext);

        expect(capturedTokenExchange(GREEN).creditsPerToken).toBe(12);
        expect(store.writes).toBe(2);
    });

    test('each credit colour is remembered separately', async () => {
        await captureTokenExchangeFromModal(modal('<div>1 → 10</div>'), greenContext);
        await captureTokenExchangeFromModal(modal('<div>60 → 1</div>'), {
            creditItemHrid: '/items/gold_guild_credit',
            creditName: 'Gold Guild Credit',
            selectedItemName: 'Guild Token',
        });

        expect(capturedTokenExchanges().map((e) => [e.creditItemHrid, e.creditsPerToken])).toEqual([
            [GREEN, 10],
            ['/items/gold_guild_credit', 1 / 60],
        ]);
    });

    test('a dialog that says nothing leaves the table alone', async () => {
        expect(await captureTokenExchangeFromModal(modal('<div>Exchange</div>'), greenContext)).toBeNull();
        expect(capturedTokenExchanges()).toEqual([]);
        expect(store.writes).toBe(0);
    });

    test('a rate that is not a rate is refused', async () => {
        expect(await rememberTokenExchange({ creditItemHrid: GREEN, creditsPerToken: 0 })).toBe(false);
        expect(await rememberTokenExchange(null)).toBe(false);
    });

    test('storage failing loses the write but not the reading', async () => {
        store.failWrite = true;

        await captureTokenExchangeFromModal(modal('<div>1 → 10</div>'), greenContext);

        expect(capturedTokenExchange(GREEN).creditsPerToken).toBe(10);
    });
});

describe('hydrating what an earlier session read', () => {
    test('a stored table is read back into memory, once', async () => {
        store.data[CAPTURE_KEY] = { exchanges: { [GREEN]: { creditsPerToken: 10, capturedAt: 1 } } };

        expect(await hydrateCapturedTokenExchanges()).toMatchObject({ [GREEN]: { creditsPerToken: 10 } });

        // A second call does not go back to storage, so a later reading survives
        store.data[CAPTURE_KEY] = { exchanges: {} };
        await hydrateCapturedTokenExchanges();
        expect(capturedTokenExchange(GREEN).creditsPerToken).toBe(10);
    });

    test('stored junk is not believed', async () => {
        store.data[CAPTURE_KEY] = {
            exchanges: { '/items/coin': { creditsPerToken: 5 }, [GREEN]: { creditsPerToken: 0 } },
        };

        expect(await hydrateCapturedTokenExchanges()).toEqual({});
    });

    test('nothing stored is not an error', async () => {
        expect(await hydrateCapturedTokenExchanges()).toEqual({});
    });

    test('storage failing leaves the table empty rather than throwing', async () => {
        store.failRead = true;

        expect(await hydrateCapturedTokenExchanges()).toEqual({});
    });
});
