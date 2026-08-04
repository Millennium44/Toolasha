/** @vitest-environment happy-dom */

/**
 * Reading the In Progress tab.
 *
 * The fixtures below are built from the one card that has actually been
 * observed: a "Trial Chameleon" at Lv.140 with a small falling number over a
 * large one (30,857 / 618,000) and a second, larger pair beside it
 * (582,115 / 600,000). Two things are worth pinning down and both are here — a
 * bar reading must survive commas and abbreviations, and which of two readings
 * is the boss must be decided by which one *falls*, never by which comes first.
 */

import { describe, test, expect } from 'vitest';

import {
    classifyReadings,
    isCombatTrialName,
    matchTrialHrid,
    parseAmount,
    parseBarReadings,
    parseClockMs,
    parseTrialLevel,
    readTrialTiles,
    textLines,
} from './guild-trials-scrape.js';

describe('parseAmount', () => {
    test('plain and comma-grouped numbers', () => {
        expect(parseAmount('618000')).toBe(618_000);
        expect(parseAmount('618,000')).toBe(618_000);
        expect(parseAmount('  30,857 ')).toBe(30_857);
        expect(parseAmount('0')).toBe(0);
    });

    test('the abbreviations the game renders in bars', () => {
        expect(parseAmount('618K')).toBe(618_000);
        expect(parseAmount('1.2M')).toBe(1_200_000);
        expect(parseAmount('3b')).toBe(3_000_000_000);
        expect(parseAmount('2.5 T')).toBe(2.5e12);
    });

    test('anything that is not a number is not one', () => {
        expect(parseAmount('Trial Chameleon')).toBeNull();
        expect(parseAmount('')).toBeNull();
        expect(parseAmount(null)).toBeNull();
        expect(parseAmount('12x')).toBeNull();
    });
});

describe('parseBarReadings', () => {
    test('finds every current-over-max pair, in order', () => {
        expect(parseBarReadings('Trial Chameleon Lv.140 30,857 / 618,000 582,115 / 600,000')).toEqual([
            { current: 30_857, max: 618_000 },
            { current: 582_115, max: 600_000 },
        ]);
    });

    test('tolerates spacing and abbreviation', () => {
        expect(parseBarReadings('12.5K/1.2M')).toEqual([{ current: 12_500, max: 1_200_000 }]);
        expect(parseBarReadings('0  /  900')).toEqual([{ current: 0, max: 900 }]);
    });

    test('a bar with no maximum is not a reading', () => {
        expect(parseBarReadings('5 / 0')).toEqual([]);
    });

    test('text with no bars yields nothing', () => {
        expect(parseBarReadings('Waiting for the trial to begin')).toEqual([]);
        expect(parseBarReadings(null)).toEqual([]);
    });
});

describe('parseTrialLevel', () => {
    test('reads the level off the tile summary', () => {
        expect(parseTrialLevel('Lv.140')).toBe(140);
        expect(parseTrialLevel('Trial Chameleon Lv. 200 ')).toBe(200);
        expect(parseTrialLevel('lv100')).toBe(100);
    });

    test('a tile with no level marker has no level', () => {
        expect(parseTrialLevel('Trial Chameleon')).toBeNull();
        expect(parseTrialLevel(undefined)).toBeNull();
    });
});

describe('parseClockMs', () => {
    test('mm:ss and h:mm:ss', () => {
        expect(parseClockMs('42:15 remaining')).toBe((42 * 60 + 15) * 1000);
        expect(parseClockMs('1:00:00')).toBe(3_600_000);
        expect(parseClockMs('0:09')).toBe(9000);
    });

    test('text with no clock in it', () => {
        expect(parseClockMs('In progress')).toBeNull();
        expect(parseClockMs(null)).toBeNull();
    });
});

describe('naming', () => {
    test('the five encounters are recognised as combat trials', () => {
        for (const name of ['Trial Badger', 'trial chameleon', 'Trial Jellyfish', 'Hedgehog', 'The Swarm']) {
            expect(isCombatTrialName(name)).toBe(true);
        }
    });

    test('anything else is a skilling trial', () => {
        expect(isCombatTrialName('Trial Milking')).toBe(false);
        expect(isCombatTrialName('')).toBe(false);
    });

    test('a displayed name is matched to the hrid the socket reports', () => {
        const hrids = ['/guild_trials/chameleon', '/guild_trials/milking', '/guild_trials/cheesesmithing'];
        expect(matchTrialHrid('Trial Chameleon', hrids)).toBe('/guild_trials/chameleon');
        expect(matchTrialHrid('Milking', hrids)).toBe('/guild_trials/milking');
        expect(matchTrialHrid('Cheesesmithing', hrids)).toBe('/guild_trials/cheesesmithing');
    });

    test('a name matching nothing matches nothing', () => {
        expect(matchTrialHrid('Trial Badger', ['/guild_trials/milking'])).toBeNull();
        expect(matchTrialHrid('', ['/guild_trials/milking'])).toBeNull();
        expect(matchTrialHrid('Milking', [])).toBeNull();
    });
});

describe('readTrialTiles', () => {
    /**
     * The observed card, as markup.
     * @param {Array<{name: string, level: number, bars: string}>} cards - Cards to build
     * @returns {Element} A trials-content root
     */
    function buildTab(cards) {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__abc';
        for (const card of cards) {
            const tile = document.createElement('div');
            tile.className = 'GuildPanel_tile__xyz';
            tile.innerHTML =
                `<div class="GuildPanel_tileName__q1">${card.name}</div>` +
                `<div class="GuildPanel_tileSummary__p2">Lv.${card.level}</div>` +
                `<div class="ProgressBar_text__r3">${card.bars}</div>`;
            root.appendChild(tile);
        }
        document.body.appendChild(root);
        return root;
    }

    test('reads the observed Trial Chameleon card', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bars: '30,857 / 618,000 582,115 / 600,000' }]);
        const tiles = readTrialTiles(root);

        expect(tiles).toHaveLength(1);
        expect(tiles[0]).toMatchObject({
            name: 'Trial Chameleon',
            level: 140,
            tier: 5,
            kind: 'combat',
            readings: [
                { current: 30_857, max: 618_000 },
                { current: 582_115, max: 600_000 },
            ],
        });
        expect(tiles[0].element.className).toContain('GuildPanel_tile');
    });

    test('a skilling card is read as one', () => {
        const root = buildTab([{ name: 'Trial Milking', level: 110, bars: '1.2M / 4M' }]);
        const tiles = readTrialTiles(root);

        expect(tiles[0]).toMatchObject({ name: 'Trial Milking', tier: 2, kind: 'skilling' });
        expect(tiles[0].readings).toEqual([{ current: 1_200_000, max: 4_000_000 }]);
    });

    test('several cards come back in document order', () => {
        const root = buildTab([
            { name: 'Trial Milking', level: 100, bars: '0 / 100' },
            { name: 'Trial Swarm', level: 130, bars: '5 / 500' },
        ]);
        expect(readTrialTiles(root).map((tile) => tile.name)).toEqual(['Trial Milking', 'Trial Swarm']);
    });

    test('a card with no level is not a trial', () => {
        document.body.innerHTML =
            '<div class="GuildPanel_trialsContent__a">' +
            '<div class="GuildPanel_tile__b"><div class="GuildPanel_tileSummary__c">Not started</div></div>' +
            '</div>';
        expect(readTrialTiles(document.querySelector('[class*="GuildPanel_trialsContent"]'))).toEqual([]);
    });

    test('a summary nested inside a tile still yields one tile, not two', () => {
        document.body.innerHTML =
            '<div class="GuildPanel_trialsContent__a"><div class="GuildPanel_tile__b">' +
            '<div><div class="GuildPanel_tileSummary__c">Lv.150</div></div>' +
            '<div class="GuildPanel_tileName__d">Trial Badger</div>' +
            '<div>10 / 100</div></div></div>';
        const tiles = readTrialTiles(document.querySelector('[class*="GuildPanel_trialsContent"]'));

        expect(tiles).toHaveLength(1);
        expect(tiles[0]).toMatchObject({ name: 'Trial Badger', level: 150, tier: 6, kind: 'combat' });
    });

    test('a name is recovered from the card text when there is no name element', () => {
        document.body.innerHTML =
            '<div class="GuildPanel_trialsContent__a"><div class="GuildPanel_tile__b">' +
            '<div class="GuildPanel_tileSummary__c">Trial Jellyfish Lv.170 4 / 40</div></div></div>';
        const tiles = readTrialTiles(document.querySelector('[class*="GuildPanel_trialsContent"]'));

        expect(tiles[0].name).toBe('Trial Jellyfish');
        expect(tiles[0].kind).toBe('combat');
    });

    test('a level element beside a bar element is not welded into one number', () => {
        // `textContent` on the card gives `Trial MilkingLv.1101.2M / 4M`, which
        // parses as level 1,101 and a current of 1,101,200,000 if the card is
        // read as one string. Both readings are plausible-looking and wrong.
        const root = buildTab([{ name: 'Trial Milking', level: 110, bars: '1.2M / 4M' }]);
        const tiles = readTrialTiles(root);

        expect(tiles[0].level).toBe(110);
        expect(tiles[0].readings).toEqual([{ current: 1_200_000, max: 4_000_000 }]);
    });

    test('nothing to read is an empty list, not a throw', () => {
        expect(readTrialTiles(null)).toEqual([]);
        expect(readTrialTiles({})).toEqual([]);
    });
});

describe('textLines', () => {
    test('one entry per element that holds text, in document order', () => {
        document.body.innerHTML = '<div id="t"><span>Trial Badger</span><span>Lv.150</span><i>10 / 100</i></div>';
        expect(textLines(document.getElementById('t'))).toEqual(['Trial Badger', 'Lv.150', '10 / 100']);
    });

    test('an element that is only text is one line', () => {
        document.body.innerHTML = '<div id="t">Trial Badger Lv.150</div>';
        expect(textLines(document.getElementById('t'))).toEqual(['Trial Badger Lv.150']);
    });

    test('empty elements contribute nothing', () => {
        document.body.innerHTML = '<div id="t"><span></span><span>  </span><span>Lv.100</span></div>';
        expect(textLines(document.getElementById('t'))).toEqual(['Lv.100']);
    });
});

describe('classifyReadings', () => {
    const sample = (...pairs) => pairs.map(([current, max]) => ({ current, max }));

    test('the reading that falls is the boss and the one that rises is the pool', () => {
        const history = [
            sample([618_000, 618_000], [500_000, 600_000]),
            sample([400_000, 618_000], [540_000, 600_000]),
            sample([30_857, 618_000], [582_115, 600_000]),
        ];
        expect(classifyReadings(history, 'combat')).toEqual({ bossIndex: 0, poolIndex: 1 });
    });

    test('the same card with the columns swapped is read the same way', () => {
        const history = [
            sample([500_000, 600_000], [618_000, 618_000]),
            sample([540_000, 600_000], [400_000, 618_000]),
            sample([582_115, 600_000], [30_857, 618_000]),
        ];
        expect(classifyReadings(history, 'combat')).toEqual({ bossIndex: 1, poolIndex: 0 });
    });

    test('a single unmoved reading is called by the trial kind', () => {
        expect(classifyReadings([sample([100, 1000])], 'combat')).toEqual({ bossIndex: 0, poolIndex: null });
        expect(classifyReadings([sample([100, 1000])], 'skilling')).toEqual({ bossIndex: null, poolIndex: 0 });
    });

    test('two readings that have not moved are left unclassified rather than guessed', () => {
        const history = [sample([1, 10], [2, 20]), sample([1, 10], [2, 20])];
        expect(classifyReadings(history, 'combat')).toEqual({ bossIndex: null, poolIndex: null });
    });

    test('nothing to classify', () => {
        expect(classifyReadings([], 'combat')).toEqual({ bossIndex: null, poolIndex: null });
        expect(classifyReadings(undefined, 'skilling')).toEqual({ bossIndex: null, poolIndex: null });
    });
});
