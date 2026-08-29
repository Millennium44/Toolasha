/**
 * @vitest-environment happy-dom
 *
 * The DPS tile, drawn rather than reasoned about.
 *
 * The tile has two shapes — a line per player when the Damage Tracker has
 * attributed something, and a party total when it has not — and the interesting
 * failures are in choosing between them. A tile that silently falls back reports
 * a party figure under a heading that reads as yours.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const tracker = vi.hoisted(() => ({ breakdown: { seconds: 0, startedAt: 0, players: [] } }));
const registered = vi.hoisted(() => ({ row: null }));

vi.mock('./damage-tracker.js', () => ({ damageBreakdown: () => tracker.breakdown }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        // The formatters read this to decide between "488" and "488.0"
        getSettingValue: () => 'full',
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        registered.row = definition;
    },
}));

const combatDPS = (await import('./combat-dps.js')).default;

/** Draw the tile and hand back what it says */
function draw() {
    const container = document.createElement('div');
    registered.row.render(container);
    return container;
}

beforeEach(() => {
    tracker.breakdown = { seconds: 0, startedAt: 0, players: [] };
    combatDPS.reset();
});

describe('with attribution', () => {
    beforeEach(() => {
        tracker.breakdown = {
            seconds: 60,
            startedAt: 0,
            players: [
                { index: '0', name: 'Millennium44', dps: 368, accuracy: 0.94, damage: 22080 },
                { index: '1', name: 'Someone Else', dps: 120, accuracy: null, damage: 7200 },
            ],
        };
    });

    test('a line per player and a total', () => {
        const text = draw().textContent;

        expect(text).toContain('Millennium44');
        expect(text).toContain('Someone Else');
        expect(text).toContain('Total DPS');
    });

    test('the total is the sum of the lines above it', () => {
        // Not this module's own health-diff figure, which counts bleeds nobody
        // cast — a total that did not add up would read as an arithmetic bug
        expect(draw().textContent).toContain('488');
    });

    test('no swings seen reads as unmeasured rather than as missing every one', () => {
        const text = draw().textContent;
        expect(text).toContain('94.0%');
        expect(text).toContain('--');
    });

    test('a player with no measurable rate is left out rather than shown as zero', () => {
        tracker.breakdown.players.push({ index: '2', name: 'Just Joined', dps: null, accuracy: null });
        expect(draw().textContent).not.toContain('Just Joined');
    });

    test('clicking a player name fills "/profile <name>" into chat', () => {
        document.body.innerHTML = '<div class="Chat_chatInputContainer__c"><input /></div>';
        const container = draw();

        const nameCell = [...container.children].find((el) => el.textContent === 'Millennium44');
        expect(nameCell.style.cursor).toBe('pointer');

        nameCell.dispatchEvent(new Event('click', { bubbles: true }));
        expect(document.querySelector('input').value).toBe('/profile Millennium44');

        document.body.innerHTML = '';
    });

    test('a name that is not a single token gets no click handler', () => {
        // "Someone Else" cannot be a real MWI name, and "/profile Someone Else"
        // would be a broken command — so the cell stays an ordinary cell
        document.body.innerHTML = '<div class="Chat_chatInputContainer__c"><input /></div>';
        const container = draw();

        const nameCell = [...container.children].find((el) => el.textContent === 'Someone Else');
        expect(nameCell.style.cursor).not.toBe('pointer');

        nameCell.dispatchEvent(new Event('click', { bubbles: true }));
        expect(document.querySelector('input').value).toBe('');

        document.body.innerHTML = '';
    });

    test('the total line is not clickable', () => {
        const container = draw();
        const totalCell = [...container.children].find((el) => el.textContent === 'Total DPS');
        expect(totalCell.style.cursor).not.toBe('pointer');
    });
});

describe('tracking a health-diff run', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('a battleId that drops back down starts a new run instead of blending into the last one', () => {
        // First run: battleId 5, a monster drops 80 health over one second
        combatDPS._onBattleUpdated({ battleId: 5, mMap: { 0: { cHP: 100 } }, pMap: {} });
        vi.setSystemTime(1000);
        combatDPS._onBattleUpdated({ battleId: 5, mMap: { 0: { cHP: 20 } }, pMap: {} });
        expect(combatDPS.damage).toBe(80);

        // A new run starts and the game's battleId drops back down — the same
        // signal combat-stats-data-collector's shouldResetTracking treats as a
        // reset. A wave change within a run only ever increases battleId, so
        // this is not a false positive on ordinary wave progression.
        vi.setSystemTime(2000);
        combatDPS._onBattleUpdated({ battleId: 1, mMap: { 0: { cHP: 100 } }, pMap: {} });
        vi.setSystemTime(3000);
        combatDPS._onBattleUpdated({ battleId: 1, mMap: { 0: { cHP: 90 } }, pMap: {} });

        // Only the new run's 10 damage over 1 second, not the first run's 80
        // still sitting in the total
        expect(combatDPS.damage).toBe(10);
        expect(combatDPS.seconds).toBeCloseTo(1);
    });
});

describe('without attribution', () => {
    test('nothing measured at all draws nothing', () => {
        expect(draw().textContent).toBe('');
    });

    test('it falls back to the party figure and says which it is', () => {
        // The health-diff path cannot say who struck, so the label must not
        // imply it is yours
        combatDPS.damage = 6000;
        combatDPS.taken = 600;
        combatDPS.seconds = 60;
        combatDPS.partySize = 3;

        const container = draw();
        expect(container.textContent).toContain('Party DPS');
        expect(container.textContent).toContain('Taken');
        expect(container.title).toContain('who struck');
    });
});
