/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ORB_ITEMS, REROLL_MODIFIERS, TALISMAN_INFO, talismanRow } from '../../__fixtures__/talisman-reroll.js';

const game = vi.hoisted(() => ({
    server: true,
    setting: true,
    talismans: [],
    shown: null,
    prices: {},
    onClass: null,
    handlers: new Map(),
}));

vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => game.server,
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => game.setting } }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _cls, callback) => {
            game.onClass = callback;
            return () => {
                game.onClass = null;
            };
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 32030,
        getCharacterTalismans: () => game.talismans,
        getInitClientData: () => ({
            talismanInfo: TALISMAN_INFO,
            talismanModifierDetailMap: REROLL_MODIFIERS,
            itemDetailMap: ORB_ITEMS,
        }),
        on: (event, handler) => game.handlers.set(event, handler),
        off: (event) => game.handlers.delete(event),
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid) => game.prices[hrid] || { price: null, source: null, estimated: false },
}));
// The window's React component carries the talisman as a prop, a few fibers above the window element
vi.mock('../../utils/react-click.js', () => ({
    clickThroughReact: () => 'none',
    fiberFor: () => ({
        memoizedProps: { className: 'x' },
        return: { memoizedProps: {}, return: { memoizedProps: { talisman: game.shown }, return: null } },
    }),
}));

const {
    default: feature,
    orbWeights,
    coinCost,
    describeAdvice,
    ADVISOR_HELP,
    setRerollTarget,
} = await import('./talisman-reroll-advisor.js');

const M = (name) => `/talisman_modifiers/${name}`;
const line = (name, grade) => ({ hrid: M(name), grade });
const ORBS = Object.keys(ORB_ITEMS);

function openWindow(talisman) {
    game.talismans = [talisman];
    game.shown = talisman;
    document.body.innerHTML =
        '<div class="TalismanModal_talismanModal__1ocVR"><section></section><div class="TalismanModal_footer__23MOl"></div></div>';
    const modal = document.body.firstElementChild;
    feature.initialize();
    game.onClass?.(modal);
    vi.advanceTimersByTime(200);
    return modal;
}

const panel = () => document.querySelector('.toolasha-reroll-advisor');
const moveText = () => panel()?.querySelector('.toolasha-reroll-advisor-move')?.textContent;
const detailText = () => panel()?.querySelector('.toolasha-reroll-advisor-detail')?.textContent;

function pick(row, hrid, grade) {
    const types = panel().querySelectorAll('.toolasha-reroll-advisor-type');
    const grades = panel().querySelectorAll('.toolasha-reroll-advisor-grade');
    types[row].value = hrid;
    grades[row].value = String(grade);
    types[row].dispatchEvent(new Event('change'));
    vi.advanceTimersByTime(200);
    // The solve runs in slices; let them and the redraw finish
    vi.runAllTimers();
}

beforeEach(() => {
    vi.useFakeTimers();
    game.server = true;
    game.setting = true;
    game.prices = {};
});

afterEach(() => {
    feature.disable();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('where it runs', () => {
    test('on the live server nothing is registered or drawn', () => {
        game.server = false;
        openWindow(talismanRow(1, [line('armor', 2)]));
        expect(game.onClass).toBeNull();
        expect(panel()).toBeNull();
    });

    test('with the setting off nothing is drawn', () => {
        game.setting = false;
        openWindow(talismanRow(1, [line('armor', 2)]));
        expect(panel()).toBeNull();
    });

    test('on the test server the panel sits above the window footer and asks for a target', () => {
        const modal = openWindow(talismanRow(1, [line('armor', 2), line('melee_evasion', 1)]));
        expect(panel()).not.toBeNull();
        expect(panel().nextElementSibling.className).toContain('TalismanModal_footer');
        expect(modal.contains(panel())).toBe(true);
        expect(moveText()).toBe('Pick up to six lines you want.');
    });

    test('turning it off takes the panel out', () => {
        openWindow(talismanRow(1, [line('armor', 2)]));
        feature.disable();
        expect(panel()).toBeNull();
    });
});

describe('every way it ends', () => {
    test('the current lines as the target: met, nothing to do', () => {
        openWindow(talismanRow(1, [line('armor', 2), line('melee_evasion', 1)]));
        panel().querySelector('.toolasha-reroll-advisor-use-current').click();
        vi.advanceTimersByTime(200);
        expect(moveText()).toBe('Target met. Nothing to do.');
        expect(detailText()).toBe('');
    });

    test('a target to work toward, no orb priced: the move and orb counts, no coin cost', () => {
        openWindow(talismanRow(1, [line('melee_evasion', 1), line('melee_accuracy', 1)]));
        pick(0, M('ability_damage'), 3);
        expect(moveText()).toMatch(/^Next: /);
        expect(detailText()).toContain('Expected from here:');
        expect(detailText()).toContain('No coin cost');
        expect(detailText()).toContain('game item value');
        expect(detailText()).not.toMatch(/coins at market/);
    });

    test('every orb priced on the market: a coin cost', () => {
        for (const hrid of ORBS) game.prices[hrid] = { price: 1000, source: 'book', estimated: false };
        openWindow(talismanRow(1, [line('melee_evasion', 1), line('melee_accuracy', 1)]));
        pick(0, M('ability_damage'), 3);
        expect(detailText()).toMatch(/coins at market prices/);
    });

    test('a pending roll that meets the target is taken; a worse one is kept away', () => {
        const pending = [line('ability_damage', 4), line('melee_accuracy', 1)];
        openWindow(
            talismanRow(1, [line('melee_evasion', 1), line('melee_accuracy', 1)], { pendingModifiers: pending })
        );
        pick(0, M('ability_damage'), 3);
        expect(moveText()).toBe('Use New Roll: it meets the target.');

        feature.disable();
        const current = [line('ability_damage', 2), line('melee_accuracy', 6)];
        const worse = [line('melee_evasion', 1), line('melee_accuracy', 1)];
        openWindow(talismanRow(2, current, { pendingModifiers: worse }));
        pick(0, M('ability_damage'), 3);
        expect(moveText()).toBe('Keep Current: the new roll is not better.');
    });

    test('one type twice counts once, so it is a target, not an impossible one', () => {
        openWindow(talismanRow(1, [line('melee_evasion', 1), line('melee_accuracy', 1)]));
        pick(0, M('armor'), 2);
        pick(1, M('armor'), 3);
        expect(moveText()).toMatch(/^Next: /);
    });

    test('an empty talisman', () => {
        openWindow(talismanRow(1, []));
        pick(0, M('armor'), 2);
        expect(moveText()).toBe('This talisman has no lines yet.');
    });

    test('a locked line already in place', () => {
        openWindow(
            talismanRow(1, [line('armor', 3), line('melee_evasion', 1), line('melee_accuracy', 1)], {
                lockedModifierHrid: M('armor'),
            })
        );
        pick(0, M('armor'), 3);
        pick(1, M('ability_damage'), 3);
        expect(moveText()).toMatch(/^Next: /);
        expect(moveText()).not.toMatch(/lock/i);
    });

    test('a skilling talisman offers the skilling pool only', () => {
        openWindow(talismanRow(1, [line('milking_speed', 1)], { talismanTypeHrid: '/talisman_types/skilling' }));
        const options = [...panel().querySelector('.toolasha-reroll-advisor-type').options].map((o) => o.value);
        expect(options).toContain(M('milking_speed'));
        expect(options).not.toContain(M('armor'));
        pick(0, M('milking_speed'), 2);
        expect(moveText()).toMatch(/^Next: /);
    });
});

describe('prices and weights', () => {
    const quote =
        (source, price = 1000) =>
        () => ({ price, source, estimated: source === 'value' });

    test('market prices only when every orb has a live listing', () => {
        expect(orbWeights(TALISMAN_INFO, ORB_ITEMS, quote('book')).scale).toBe('market');
        expect(orbWeights(TALISMAN_INFO, ORB_ITEMS, quote('custom')).scale).toBe('market');
        const partial = orbWeights(TALISMAN_INFO, ORB_ITEMS, (hrid) =>
            hrid === '/items/binding_orb' ? { price: null, source: null } : { price: 5, source: 'book' }
        );
        expect(partial.scale).toBe('itemValue');
        expect(partial.weights['/items/reshaping_orb']).toBe(ORB_ITEMS['/items/reshaping_orb'].sellPrice);
        expect(partial.prices['/items/binding_orb']).toBeUndefined();
    });

    test('an estimate, a vendor or coinify value is not a market price', () => {
        for (const source of ['value', 'vendor', 'coinify']) {
            const result = orbWeights(TALISMAN_INFO, ORB_ITEMS, quote(source));
            expect(result.scale).toBe('itemValue');
            expect(result.prices).toEqual({});
        }
    });

    test('no prices and no item values: one each', () => {
        expect(orbWeights(TALISMAN_INFO, {}, quote(null)).scale).toBe('count');
    });

    test('a coin cost only when every orb used has a market price', () => {
        const counts = { '/items/reshaping_orb': 10, '/items/binding_orb': 1 };
        expect(coinCost(counts, { '/items/reshaping_orb': 100 })).toBeNull();
        expect(coinCost(counts, { '/items/reshaping_orb': 100, '/items/binding_orb': 5000 })).toBe(6000);
        expect(coinCost({}, { '/items/reshaping_orb': 100 })).toBeNull();
    });
});

describe('describeAdvice', () => {
    const names = {
        item: (h) => ORB_ITEMS[h]?.name || h,
        modifier: (h) => REROLL_MODIFIERS[h]?.name || h,
        lineCount: 2,
    };
    const ok = { status: 'ok' };

    test('impossible targets say why', () => {
        const text = (build) => describeAdvice({ build }, names).move;
        expect(text({ status: 'impossible', reason: 'notInPool', hrid: M('milking_speed') })).toContain(
            'cannot roll on this talisman type'
        );
        expect(text({ status: 'impossible', reason: 'gradeAboveCap', hrid: M('armor') })).toContain('G6');
        // Only when no core can add the lines: past the most a talisman holds, or no core in the game data
        expect(text({ status: 'impossible', reason: 'needsMoreLines' })).toContain('lists no core to add more');
        expect(
            describeAdvice(
                { build: { status: 'impossible', reason: 'needsMoreLines', need: 5 } },
                { ...names, maxLines: 4 }
            ).move
        ).toBe('Not reachable. The target needs 5 lines; a talisman holds at most 4.');
    });

    test('a clamped large target says so', () => {
        const text = describeAdvice(
            {
                build: ok,
                scale: 'market',
                prices: {},
                gradeClamped: true,
                clampGrade: 5,
                advice: { status: 'move', move: { kind: 'unlock' }, value: 1, counts: { '/items/focus_orb': 1 } },
            },
            names
        );
        expect(text.detail.join(' ')).toContain('grades above G5 count as G5');
    });

    test('the keeper odds note: shown below 1 in 5, named or not, and only for an orb move', () => {
        const orb = (extra) => ({
            status: 'move',
            value: 1,
            counts: {},
            move: { kind: 'orb', itemHrid: '/items/focus_orb', ...extra },
        });
        const detail = (advice) => describeAdvice({ build: ok, advice }, names).detail.join(' ');
        expect(detail(orb({ keepChance: 1 / 160, keepLineHrid: M('armor') }))).toContain(
            'About 1 roll in 160 is worth keeping (one with Armor); the rest are discarded.'
        );
        expect(detail(orb({ keepChance: 1 / 7 }))).toContain('About 1 roll in 7 is worth keeping; the rest');
        expect(detail(orb({ keepChance: 1 / 7 }))).not.toContain('(one with');
        expect(detail(orb({ keepChance: 0.21 }))).not.toContain('worth keeping');
        expect(detail(orb({ keepChance: 0.5 }))).not.toContain('worth keeping');
        const quiet = [
            { status: 'met', value: 0, counts: {} },
            { status: 'accept', value: 1, counts: {} },
            { status: 'discard', value: 1, counts: {}, keepChance: 0.001 },
            {
                status: 'move',
                value: 1,
                counts: {},
                move: { kind: 'lock', itemHrid: '/items/binding_orb', modifierHrid: M('armor'), keepChance: 0.001 },
            },
            { status: 'move', value: 1, counts: {}, move: { kind: 'unlock', keepChance: 0.001 } },
        ];
        for (const advice of quiet) expect(detail(advice)).not.toContain('worth keeping');
    });

    test('the help says a locked line is not changed by any orb', () => {
        expect(ADVISOR_HELP.join(' ')).toMatch(/locked line is not changed by any orb, Attunement included/);
    });

    test('unreachable, unlock and lock moves', () => {
        expect(describeAdvice({ build: ok, advice: { status: 'unreachable' } }, names).move).toContain('Not reachable');
        const unlock = describeAdvice(
            {
                build: ok,
                scale: 'count',
                prices: {},
                advice: {
                    status: 'move',
                    move: { kind: 'unlock' },
                    value: 100,
                    stayLockedValue: 150,
                    counts: { '/items/focus_orb': 99 },
                },
            },
            names
        );
        expect(unlock.move).toBe('Next: unlock the locked line (free).');
        expect(unlock.detail[0]).toBe('Keeping the lock is expected to cost 50% more.');
        const lock = describeAdvice(
            {
                build: ok,
                scale: 'market',
                prices: {},
                advice: {
                    status: 'move',
                    move: { kind: 'lock', itemHrid: '/items/binding_orb', modifierHrid: M('armor') },
                    value: 10,
                    counts: { '/items/binding_orb': 1 },
                },
            },
            names
        );
        expect(lock.move).toBe('Next: lock Armor with a Binding Orb.');
    });

    test('a huge lock-first gap reads as a multiple, not a five-digit percentage', () => {
        const advise = (lockValue) =>
            describeAdvice(
                {
                    build: ok,
                    scale: 'market',
                    prices: {},
                    advice: {
                        status: 'move',
                        move: { kind: 'orb', itemHrid: '/items/reshaping_orb' },
                        value: 1000,
                        lockFirst: { modifierHrid: M('armor'), value: lockValue },
                        counts: {},
                    },
                },
                names
            ).detail[0];
        // Live: Binding Orb ~510M against a 963.5K plan showed "52845% more"
        expect(advise(529450)).toBe('Locking Armor first is expected to cost about 530× as much.');
        expect(advise(1500)).toBe('Locking Armor first is expected to cost 50% more.');
        expect(advise(11000)).toBe('Locking Armor first is expected to cost 1000% more.');
    });

    test('a focus move names its picks', () => {
        const focus = describeAdvice(
            {
                build: ok,
                scale: 'market',
                prices: {},
                advice: {
                    status: 'move',
                    move: {
                        kind: 'orb',
                        itemHrid: '/items/focus_orb',
                        mode: '/talisman_reroll_modes/types_only',
                        focusHrids: [M('armor')],
                    },
                    value: 10,
                    counts: { '/items/focus_orb': 3 },
                },
            },
            names
        );
        expect(focus.move).toBe('Next: Focus Orb. Focus on Armor.');
    });
});

describe('review fixes', () => {
    const priceAll = (price) => {
        for (const hrid of ORBS) game.prices[hrid] = { price, source: 'book', estimated: false };
    };

    test('a small price tick keeps the advice; a real move shows the old advice as updating', () => {
        priceAll(1000);
        openWindow(talismanRow(1, [line('melee_evasion', 1), line('melee_accuracy', 1)]));
        pick(0, M('ability_damage'), 3);
        const move = moveText();
        expect(move).toMatch(/^Next: /);

        priceAll(1004);
        feature.schedule();
        vi.advanceTimersByTime(100);
        expect(moveText()).toBe(move);
        expect(detailText()).not.toContain('Updating');

        priceAll(2000);
        feature.schedule();
        vi.advanceTimersByTime(81);
        expect(moveText()).toBe(move);
        expect(detailText()).toContain('Updating for new prices');
        vi.runAllTimers();
        expect(moveText()).toBe(move);
        expect(detailText()).not.toContain('Updating');
    });

    test('closing the window cancels the solve and drops the watch', () => {
        const modal = openWindow(talismanRow(1, [line('melee_evasion', 1), line('melee_accuracy', 1)]));
        const types = panel().querySelectorAll('.toolasha-reroll-advisor-type');
        types[0].value = M('ability_damage');
        types[0].dispatchEvent(new Event('change'));
        // Draw now, so the solve is scheduled but has not run
        feature.render();
        expect(feature.sliceTimer).not.toBeNull();
        modal.remove();
        feature.schedule();
        expect(feature.sliceTimer).toBeNull();
        expect(feature.running).toBeNull();
        expect(feature.watchedModal).toBeNull();
        expect(feature.modalObserver).toBeNull();
    });

    test('a met target shows no solver notes', () => {
        const names = { item: (h) => h, modifier: (h) => h, lineCount: 4 };
        const result = {
            build: { status: 'ok' },
            scale: 'itemValue',
            prices: {},
            mutationUsed: false,
            gradeClamped: true,
            clampGrade: 5,
        };
        expect(describeAdvice({ ...result, advice: { status: 'met', counts: {} } }, names).detail).toEqual([]);
        expect(
            describeAdvice({ ...result, advice: { status: 'accept', met: true, counts: {} } }, names).detail
        ).toEqual([]);
    });

    test('the help states what was measured', () => {
        const measured = ADVISOR_HELP.find((entry) => entry.startsWith('Measured')) || '';
        const assumed = ADVISOR_HELP.find((entry) => entry.startsWith('Assumed')) || '';
        expect(measured).toContain('Focus ×5');
        expect(measured).toContain('Attunement 65/20/15');
        expect(assumed).not.toContain('Focus');
        expect(assumed).toContain('Exchange');
        expect(ADVISOR_HELP.join(' ')).toMatch(/Binding Orb, measured/);
        expect(ADVISOR_HELP.join(' ')).toMatch(/average weight/);
    });
});

describe('a target handed in from outside (Aim for this in the line ranking)', () => {
    test('not running: refused', () => {
        expect(setRerollTarget(5, [{ hrid: M('armor'), minGrade: 3 }])).toBe(false);
    });

    test('the open window for that talisman shows the target in its rows', () => {
        const talisman = talismanRow(5, [
            line('armor', 1),
            line('tenacity', 1),
            line('max_hitpoints', 1),
            line('hp_regen', 1),
        ]);
        openWindow(talisman);
        expect(setRerollTarget(5, [{ hrid: M('critical_damage'), minGrade: 3 }])).toBe(true);
        vi.advanceTimersByTime(200);
        vi.runAllTimers();
        const types = panel().querySelectorAll('.toolasha-reroll-advisor-type');
        const grades = panel().querySelectorAll('.toolasha-reroll-advisor-grade');
        expect(types[0].value).toBe(M('critical_damage'));
        expect(grades[0].value).toBe('3');
        expect(moveText()).toBeTruthy();
    });
});

describe('Aim for this, through the path the line ranking button uses', () => {
    afterEach(() => {
        delete globalThis.window.Toolasha;
    });

    test('a target handed in through Toolasha.UI before the window opens shows in its rows when it opens', async () => {
        const { aimRerollAdvisor } = await import('../talismans/talisman-ranking-view.js');
        feature.initialize();
        globalThis.window.Toolasha = { UI: { talismanRerollAdvisor: feature } };
        const talisman = talismanRow(3208, [
            line('fortify', 1),
            line('intelligence_experience', 6),
            line('ranged_experience', 2),
            line('defense_experience', 3),
        ]);
        game.talismans = [talisman];
        // Ids come from characterTalismans as numbers; the window's prop carries the same record
        expect(aimRerollAdvisor(3208, [{ hrid: M('magic_experience'), minGrade: 1 }])).toBe('ok');
        openWindow(
            talismanRow(3208, [
                line('fortify', 1),
                line('intelligence_experience', 6),
                line('ranged_experience', 2),
                line('defense_experience', 3),
            ])
        );
        vi.runAllTimers();
        const types = panel().querySelectorAll('.toolasha-reroll-advisor-type');
        expect(types[0].value).toBe(M('magic_experience'));
        expect(moveText()).not.toBe('Pick up to six lines you want.');
    });
});

describe("aimAt only for this character's talismans", () => {
    test('an id the character does not own is refused and nothing is kept', () => {
        openWindow(talismanRow(5, [line('armor', 1)]));
        expect(setRerollTarget(999, [{ hrid: M('armor'), minGrade: 2 }])).toBe(false);
        expect(feature.getTargets({ id: 999 })).toEqual([]);
        // A string id of an owned one still counts
        expect(setRerollTarget('5', [{ hrid: M('armor'), minGrade: 2 }])).toBe(true);
    });
});

describe('crafting-cost orbs in the advice text', () => {
    const names = { item: (hrid) => hrid.split('/').pop(), modifier: (hrid) => hrid, lineCount: 2 };
    const result = (crafted) => ({
        build: { status: 'ok' },
        scale: 'market',
        prices: { '/items/reshaping_orb': 100, '/items/binding_orb': 1000 },
        crafted,
        advice: {
            status: 'move',
            move: { kind: 'reroll', itemHrid: '/items/reshaping_orb' },
            counts: { '/items/reshaping_orb': 2, '/items/binding_orb': 1 },
        },
    });

    test('a coin line that names the orbs at crafting cost', () => {
        const text = describeAdvice(result(['/items/reshaping_orb']), names).detail.join('\n');
        expect(text).toMatch(/About .* coins \(reshaping_orb at crafting cost, the rest at market prices\)/);
    });

    test('a crafted orb the plan does not use is not named in the coin line', () => {
        const text = describeAdvice(result(['/items/exchange_orb']), names).detail.join('\n');
        expect(text).toMatch(/coins at market prices/);
    });
});
