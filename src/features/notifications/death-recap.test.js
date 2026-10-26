/** @vitest-environment happy-dom */
/**
 * Tests for the death recap.
 *
 * Shapes follow the game's: `pMap` is keyed by seat ("0", "1"), each entry has `cHP`/`cMP`/`dmgCounter`;
 * `new_battle.players` has `character.id` and the cumulative `deathCount`.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    battleData: null,
    actions: [],
    party: [],
    settings: {},
    characterId: 'me',
    ws: {},
    dm: {},
    clientData: {},
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => !!game.settings[key] },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        get battleData() {
            return game.battleData;
        },
        getPartyMembers: () => ({ members: game.party }),
        getCurrentActions: () => game.actions,
        getCurrentCharacterName: () => game.characterId,
        getInitClientData: () => game.clientData,
        on: (e, h) => {
            game.dm[e] = h;
        },
        off: (e, h) => {
            if (game.dm[e] === h) delete game.dm[e];
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (e, h) => {
            game.ws[e] = h;
        },
        off: (e, h) => {
            if (game.ws[e] === h) delete game.ws[e];
        },
    },
}));

const recap = await import('./death-recap.js');
const feature = recap.default;

/** new_battle: seat order = argument order; the monster sits at slot 0 */
function battle(players, battleId = 1) {
    return {
        battleId,
        players: players.map(([id, deathCount, hp]) => ({
            character: { id, name: id },
            deathCount,
            currentHitpoints: hp ?? 1000,
        })),
        monsters: [{ name: 'Golem', combatMonsterHrid: '/monsters/golem', currentHitpoints: 5000 }],
    };
}

let atkCounter = 0;
const dmg = {};
/** battle_updated: hp per seat; a drop in hp bumps that seat's dmgCounter and the monster's atkCounter */
function tick(hps, { battleId = 1, mp = 500, ability } = {}) {
    const pMap = {};
    hps.forEach((hp, i) => {
        if (hp === null) return; // partial tick: the seat is omitted, meaning unchanged
        const prev = dmg[`${battleId}:${i}`];
        const lastHp = dmg[`hp${battleId}:${i}`];
        if (lastHp !== undefined && hp < lastHp) dmg[`${battleId}:${i}`] = (prev || 0) + 1;
        dmg[`hp${battleId}:${i}`] = hp;
        pMap[i] = {
            cHP: hp,
            mHP: 1600,
            mMP: 1600,
            ...(hp <= 0
                ? { isActive: false, leftCombat: false, respawnTime: '2026-10-19T09:00:15.000Z' }
                : { isActive: true }),
            cMP: mp,
            dmgCounter: dmg[`${battleId}:${i}`] || 0,
            ...(ability && i === 0 ? { abilityHrid: ability } : {}),
        };
    });
    atkCounter += 1;
    return { battleId, pMap, mMap: { 0: { atkCounter, cMP: 0, dmgCounter: 0 } } };
}

const SOLO = [{ actionHrid: '/actions/combat/golem_cave', partyID: 0, ordinal: 1, isDone: false }];

const send = (event, payload) => game.ws[event](payload);

describe('death recap', () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        game.settings = { [recap.SETTING]: true };
        game.characterId = 'me';
        game.battleData = null;
        game.actions = [];
        game.party = [];
        game.ws = {};
        game.dm = {};
        for (const k of Object.keys(dmg)) delete dmg[k];
        atkCounter = 0;
        feature.disable();
        await feature.initialize();
    });

    afterEach(() => {
        feature.disable();
        document.body.innerHTML = '';
        vi.useRealTimers();
    });

    const run = (hps, opts) => {
        vi.advanceTimersByTime(700);
        send('battle_updated', tick(hps, opts));
    };

    test('setting off wires nothing', async () => {
        feature.disable();
        game.settings = {};
        await feature.initialize();
        expect(game.ws.new_battle).toBeUndefined();
        expect(game.ws.battle_updated).toBeUndefined();
    });

    test('HP reaching 0 freezes an unconfirmed recap holding the last ten seconds', () => {
        send('new_battle', battle([['me', 0]]));
        for (let i = 0; i < 30; i++) run([1000 - i * 10]);
        run([0]);

        const [r] = recap.recapHistory();
        expect(recap.recapHistory()).toHaveLength(1);
        expect(r.confirmed).toBe(false);
        expect(r.source).toBe('hp');
        expect(r.samples.at(-1).hp).toBe(0);
        expect(r.samples.length).toBeLessThanOrEqual(Math.ceil(recap.SHOWN_MS / 700) + 1);
        expect(Math.min(...r.samples.map((s) => s.rel))).toBeGreaterThanOrEqual(-recap.SHOWN_MS);
        expect(r.sources[0].name).toBe('Golem');
        expect(r.insufficient).toBe(false);
    });

    test('a zero-HP tick is held once however many zero ticks follow', () => {
        send('new_battle', battle([['me', 0]]));
        run([100]);
        run([0]);
        run([0]);
        run([0]);
        expect(recap.recapHistory()).toHaveLength(1);
    });

    test('deathCount rising on the next new_battle freezes the previous tail when no zero tick was seen', () => {
        send('new_battle', battle([['me', 0]]));
        run([900]);
        run([500]);
        run([200]);
        send('new_battle', battle([['me', 1]], 2));

        const [r] = recap.recapHistory();
        expect(recap.recapHistory()).toHaveLength(1);
        expect(r.confirmed).toBe(true);
        expect(r.source).toBe('count');
        expect(r.samples.map((s) => s.hp)).toEqual([900, 500, 200]);
    });

    test('both signals produce one recap, confirmed', () => {
        send('new_battle', battle([['me', 0]]));
        run([500]);
        run([0]);
        send('new_battle', battle([['me', 1]], 2));

        expect(recap.recapHistory()).toHaveLength(1);
        expect(recap.recapHistory()[0]).toMatchObject({ confirmed: true, source: 'both' });
    });

    test('a solo death with no new_battle at all is recorded from the tick, once, and respawn is not a death', () => {
        send('new_battle', battle([['me', 0]]));
        for (const hp of [1591, 982, 451, 231, 95]) run([hp]);
        run([0]);
        run([0]);
        run([0]);
        expect(recap.recapHistory()).toHaveLength(1);
        expect(recap.recapHistory()[0]).toMatchObject({ source: 'hp', confirmed: false });
        expect(recap.recapHistory()[0].samples.map((s) => s.hp)).toEqual([1591, 982, 451, 231, 95, 0]);

        // respawn inside the same battle, then a second death
        run([1600]);
        run([700]);
        run([0]);
        expect(recap.recapHistory()).toHaveLength(2);
        // the second tail holds only post-respawn ticks, not the first death or the time spent dead
        expect(recap.recapHistory()[0].samples.map((s) => s.hp)).toEqual([1600, 700, 0]);
    });

    test('the next battle with an unchanged count keeps the tick-observed death', () => {
        send('new_battle', battle([['me', 0]]));
        run([100]);
        run([0]);
        send('new_battle', battle([['me', 0]], 2));
        expect(recap.recapHistory()).toHaveLength(1);
    });

    test('two solo deaths later counted by the server stay two recaps, both count-confirmed', () => {
        send('new_battle', battle([['me', 0]]));
        run([100]);
        run([0]);
        run([1600]);
        run([50]);
        run([0]);
        send('new_battle', battle([['me', 2]], 2));
        expect(recap.recapHistory()).toHaveLength(2);
        expect(recap.recapHistory().every((r) => r.source === 'both' && r.confirmed)).toBe(true);
    });

    test('a tick that omits the player is unchanged: never a zero, never a death, nothing recorded', () => {
        send('new_battle', battle([['me', 0]]));
        run([900]);
        run([null]);
        run([null]);
        run([800]);
        run([0]);
        const [r] = recap.recapHistory();
        expect(recap.recapHistory()).toHaveLength(1);
        expect(r.samples.map((s) => s.hp)).toEqual([900, 800, 0]);
    });

    test('isActive going false marks the death even before HP reads zero', () => {
        send('new_battle', battle([['me', 0]]));
        run([400]);
        const t = tick([300]);
        t.pMap[0].isActive = false;
        vi.advanceTimersByTime(300);
        send('battle_updated', t);
        expect(recap.recapHistory()).toHaveLength(1);
    });

    test('no death means no recap and no button', () => {
        send('new_battle', battle([['me', 0]]));
        run([900]);
        send('new_battle', battle([['me', 0]], 2));
        expect(recap.recapHistory()).toHaveLength(0);
        expect(document.getElementById('toolasha-death-recap-button')).toBeNull();
    });

    test('the first deathCount reading is a baseline and a lower one resets it', () => {
        send('new_battle', battle([['me', 5]]));
        expect(recap.recapHistory()).toHaveLength(0);
        run([100]);
        send('new_battle', battle([['me', 0]], 2));
        expect(recap.recapHistory()).toHaveLength(0);
    });

    test('several unseen deaths in one rise make one labelled recap, not several', () => {
        send('new_battle', battle([['me', 0]]));
        run([300]);
        send('new_battle', battle([['me', 3]], 2));

        expect(recap.recapHistory()).toHaveLength(1);
        expect(recap.recapHistory()[0].deaths).toBe(3);
    });

    test('party: only the local seat is recorded, and a friend dying is nothing', () => {
        send(
            'new_battle',
            battle([
                ['friend', 0],
                ['me', 0],
            ])
        );
        run([800, 700]);
        run([0, 650]);
        send(
            'new_battle',
            battle(
                [
                    ['friend', 1],
                    ['me', 0],
                ],
                2
            )
        );
        expect(recap.recapHistory()).toHaveLength(0);

        run([100, 900], { battleId: 2 });
        send(
            'new_battle',
            battle(
                [
                    ['friend', 1],
                    ['me', 1],
                ],
                3
            )
        );
        const [r] = recap.recapHistory();
        // Only the local seat (1 in both battles); the pre-wave ticks are still inside the window
        expect(r.samples.map((s) => s.hp)).toEqual([700, 650, 900]);
    });

    test('no entry for the local character records nothing', () => {
        send('new_battle', battle([['stranger', 0]]));
        run([0]);
        expect(recap.recapHistory()).toHaveLength(0);
    });

    test('the buffer is capped by count and by window', () => {
        send('new_battle', battle([['me', 0]]));
        for (let i = 0; i < 200; i++) {
            vi.advanceTimersByTime(100);
            send('battle_updated', tick([1000]));
        }
        run([0]);
        const [r] = recap.recapHistory();
        expect(r.samples.length).toBeLessThanOrEqual(recap.MAX_SAMPLES);
    });

    test('a busy fight keeps the whole window: 52 ticks in 15 s are not cut short by the count cap', () => {
        send('new_battle', battle([['me', 0]]));
        for (let i = 0; i < 70; i++) {
            vi.advanceTimersByTime(290);
            send('battle_updated', tick([1000]));
        }
        run([0]);
        const [r] = recap.recapHistory();
        expect(r.insufficient).toBe(false);
        expect(r.samples[r.samples.length - 1].t - r.samples[0].t).toBeGreaterThan(14000);
    });

    test('only the last few recaps are kept', () => {
        for (let n = 0; n < recap.MAX_RECAPS + 3; n++) {
            send('new_battle', battle([['me', n]], n + 1));
            run([100], { battleId: n + 1 });
            run([0], { battleId: n + 1 });
        }
        expect(recap.recapHistory().length).toBe(recap.MAX_RECAPS);
    });

    test('a cast is listed once, not once per tick', () => {
        send('new_battle', battle([['me', 0]]));
        run([900], { ability: '/abilities/fireball' });
        run([800], { ability: '/abilities/fireball' });
        run([0], { ability: '/abilities/fireball' });
        expect(recap.recapHistory()[0].casts).toHaveLength(1);
    });

    test('a character switch clears the buffer, recaps, listeners and nodes', () => {
        send('new_battle', battle([['me', 0]]));
        run([0]);
        expect(document.getElementById('toolasha-death-recap-button')).not.toBeNull();
        game.dm.character_switching();

        expect(recap.recapHistory()).toHaveLength(0);
        expect(game.ws.new_battle).toBeUndefined();
        expect(game.ws.battle_updated).toBeUndefined();
        expect(document.getElementById('toolasha-death-recap-button')).toBeNull();
    });

    test('disable() clears an open modal as well', () => {
        send('new_battle', battle([['me', 0]]));
        run([0]);
        expect(recap.openRecap()).toBe(true);
        expect(document.getElementById('toolasha-death-recap-modal')).not.toBeNull();
        feature.disable();
        expect(document.getElementById('toolasha-death-recap-modal')).toBeNull();
    });

    test('the button opens the recap, saying so when it is unconfirmed or short', () => {
        send('new_battle', battle([['me', 0]]));
        run([0]);
        document.getElementById('toolasha-death-recap-button').click();
        const text = document.getElementById('toolasha-death-recap-modal').textContent;
        expect(text).toContain('has not reported it yet');
        expect(text).toContain('Insufficient recording');
        expect(text).not.toContain('NaN');
    });

    describe('walking through several recaps', () => {
        const die = (n) => {
            send('new_battle', battle([['me', 0]], n));
            run([500], { battleId: n });
            run([0], { battleId: n });
        };
        const modalEl = () => document.getElementById('toolasha-death-recap-modal');
        const navButtons = () => [...modalEl().querySelectorAll('[data-role="recap-nav"] button')];
        const navText = () => modalEl().querySelector('[data-role="recap-nav"]').textContent;

        test('one recap shows no navigation', () => {
            die(1);
            recap.openRecap();
            expect(modalEl().querySelector('[data-role="recap-nav"]')).toBeNull();
        });

        test('Older and Newer step through, disabled at the bounds', () => {
            die(1);
            vi.advanceTimersByTime(60_000);
            die(2);
            vi.advanceTimersByTime(60_000);
            die(3);
            const [newest, middle, oldest] = recap.recapHistory();
            recap.openRecap();
            expect(navText()).toContain('1 of 3');
            let [older, newer] = navButtons();
            expect(newer.disabled).toBe(true);
            expect(older.disabled).toBe(false);

            older.click();
            expect(navText()).toContain('2 of 3');
            expect(modalEl().textContent).toContain(new Date(middle.at).toLocaleTimeString());
            [older, newer] = navButtons();
            older.click();
            expect(navText()).toContain('3 of 3');
            [older, newer] = navButtons();
            expect(older.disabled).toBe(true);
            expect(newer.disabled).toBe(false);
            expect(document.querySelectorAll('#toolasha-death-recap-modal')).toHaveLength(1);

            newer.click();
            newer = navButtons()[1];
            newer.click();
            expect(navText()).toContain('1 of 3');
            expect(newest.id).not.toBe(oldest.id);
        });

        test('closing removes the modal; the open-by-id path still works', () => {
            die(1);
            die(2);
            const second = recap.recapHistory()[1];
            expect(recap.openRecap(second.id)).toBe(true);
            expect(navText()).toContain('2 of 2');
            [...modalEl().querySelectorAll('button')].find((b) => b.textContent === 'Close').click();
            expect(modalEl()).toBeNull();
        });
    });

    describe('a new battle that is not a new death', () => {
        test('a death inside the window of a new wave keeps the pre-wave ticks', () => {
            send('new_battle', battle([['me', 0]]));
            for (let i = 0; i < 20; i++) run([1000 - i * 10]);
            send('new_battle', battle([['me', 0]], 2));
            run([800], { battleId: 2 });
            run([0], { battleId: 2 });
            const [r] = recap.recapHistory();
            expect(r.samples.length).toBe(22);
            expect(r.samples[0].hp).toBe(1000);
            expect(r.insufficient).toBe(false);
            expect(r.deaths).toBe(1);
        });

        test('history older than the window is still dropped across a wave', () => {
            send('new_battle', battle([['me', 0]]));
            run([900]);
            vi.advanceTimersByTime(20_000);
            send('new_battle', battle([['me', 0]], 2));
            run([800], { battleId: 2 });
            run([0], { battleId: 2 });
            expect(recap.recapHistory()[0].samples.map((s) => s.hp)).toEqual([800, 0]);
        });

        test('a wave while dead is still one death', () => {
            send('new_battle', battle([['me', 0]]));
            run([500]);
            run([0]);
            send('new_battle', battle([['me', 0, 0]], 2));
            send('new_battle', battle([['me', 1]], 3));
            expect(recap.recapHistory()).toHaveLength(1);
            expect(recap.recapHistory()[0].confirmed).toBe(true);
        });

        test('a counter-made recap does not leak its tail into the next death', () => {
            send('new_battle', battle([['me', 0]]));
            run([900]);
            send('new_battle', battle([['me', 1]], 2));
            expect(recap.recapHistory()).toHaveLength(1);
            run([700], { battleId: 2 });
            run([0], { battleId: 2 });
            expect(recap.recapHistory()[0].samples.map((s) => s.hp)).toEqual([700, 0]);
        });

        test('a battle with no seat of ours drops the history', () => {
            send('new_battle', battle([['me', 0]]));
            run([900]);
            send('new_battle', battle([['friend', 0]], 2));
            send('new_battle', battle([['me', 0]], 3));
            run([0], { battleId: 3 });
            expect(recap.recapHistory()[0].samples.map((s) => s.hp)).toEqual([0]);
        });
    });

    test('opening with nothing kept shows nothing', () => {
        expect(recap.openRecap()).toBe(false);
    });

    test('a battle with an unchanged counter keeps the tick recap owed; the later rise confirms it, no duplicate', () => {
        send('new_battle', battle([['me', 0]]));
        run([100]);
        run([0]);
        send('new_battle', battle([['me', 0]], 2));
        send('new_battle', battle([['me', 1]], 3));
        expect(recap.recapHistory()).toHaveLength(1);
        expect(recap.recapHistory()[0]).toMatchObject({ source: 'both', confirmed: true });
    });

    test('a first counter reading is only a baseline: the tick recap stays pending; a rise consumes it first, an excess is a new recap', () => {
        game.actions = SOLO;
        run([1500]);
        run([0]);
        run([1600]);
        send('new_battle', battle([['me', 1]], 2));
        expect(recap.recapHistory()).toHaveLength(1);
        expect(recap.recapHistory()[0]).toMatchObject({ source: 'hp', confirmed: false });

        run([900], { battleId: 2 });
        send('new_battle', battle([['me', 3]], 3));
        expect(recap.recapHistory()).toHaveLength(2);
        expect(recap.recapHistory()[1]).toMatchObject({ source: 'both', confirmed: true });
        expect(recap.recapHistory()[0]).toMatchObject({ source: 'count', deaths: 1 });
    });

    test('a new wave while still dead is the same death: one recap; a respawn and genuine death is a second', () => {
        send('new_battle', battle([['me', 0]]));
        run([100]);
        run([0]);
        send('new_battle', battle([['me', 0, 0]], 2));
        run([0], { battleId: 2 });
        run([0], { battleId: 2 });
        expect(recap.recapHistory()).toHaveLength(1);
        run([1600], { battleId: 2 });
        run([300], { battleId: 2 });
        run([0], { battleId: 2 });
        expect(recap.recapHistory()).toHaveLength(2);
        expect(recap.recapHistory()[0].samples.length).toBeGreaterThan(0);
    });

    test('the opening cast is recorded when new_battle states the action counter and prepared ability', () => {
        const b = battle([['me', 0]]);
        b.players[0].atkCounter = 5;
        b.players[0].preparingAbilityHrid = '/abilities/fireball';
        send('new_battle', b);
        vi.advanceTimersByTime(500);
        const t = tick([800]);
        t.pMap[0].atkCounter = 6;
        send('battle_updated', t);
        run([0]);
        expect(recap.recapHistory()[0].casts.map((c) => c.ability)).toEqual(['/abilities/fireball']);
    });

    test('the recap covers the full 15 s window, not just 10 s', () => {
        send('new_battle', battle([['me', 0]]));
        for (let i = 0; i < 14; i++) {
            vi.advanceTimersByTime(1000);
            send('battle_updated', tick([1500 - i]));
        }
        run([0]);
        const [r] = recap.recapHistory();
        expect(Math.min(...r.samples.map((s) => s.rel))).toBeLessThan(-12000);
        expect(r.insufficient).toBe(false);
    });

    test('a baseline of 0 leaves a tick recap pending; a later rise of 1 confirms it, no new recap', () => {
        game.actions = SOLO;
        run([1500]);
        run([0]);
        run([1600]);
        send('new_battle', battle([['me', 0]], 2));
        expect(recap.recapHistory()).toHaveLength(1);
        expect(recap.recapHistory()[0]).toMatchObject({ source: 'hp', confirmed: false });

        send('new_battle', battle([['me', 1]], 3));
        expect(recap.recapHistory()).toHaveLength(1);
        expect(recap.recapHistory()[0]).toMatchObject({ source: 'both', confirmed: true });
    });

    test('repeated casts of one ability are each recorded from the action counter', () => {
        send('new_battle', battle([['me', 0]]));
        const swing = (hp, atk) => {
            vi.advanceTimersByTime(500);
            const t = tick([hp]);
            t.pMap[0].atkCounter = atk;
            t.pMap[0].abilityHrid = '/abilities/fireball';
            send('battle_updated', t);
        };
        swing(900, 1);
        swing(800, 2);
        swing(700, 3);
        swing(0, 3);
        expect(recap.recapHistory()[0].casts).toHaveLength(2);
    });

    describe('after a reload with no new_battle', () => {
        test('a solo fight (no party, one pMap key) records the death', () => {
            game.actions = SOLO;
            run([1591]);
            run([95]);
            run([0]);
            expect(recap.recapHistory()).toHaveLength(1);
            expect(recap.recapHistory()[0].samples.map((s) => s.hp)).toEqual([1591, 95, 0]);
        });

        test('a party of only us counts as solo', () => {
            game.actions = SOLO;
            game.party = [{ characterID: 'me', characterName: 'me' }];
            run([100]);
            run([0]);
            expect(recap.recapHistory()).toHaveLength(1);
        });

        test('an empty roster alone is not solo: with no affirmative solo action nothing is guessed', () => {
            run([100]);
            run([0]);
            expect(recap.recapHistory()).toHaveLength(0);
        });

        test('a party action is not solo even with an empty roster', () => {
            game.actions = [{ actionHrid: '/actions/combat/golem_cave', partyID: 7, ordinal: 1, isDone: false }];
            run([100]);
            run([0]);
            expect(recap.recapHistory()).toHaveLength(0);
        });

        test('a party with no roster is never guessed at: nothing until a new_battle names the seat', () => {
            game.party = [
                { characterID: 'me', characterName: 'me' },
                { characterID: 'friend', characterName: 'friend' },
            ];
            run([100]);
            run([0]);
            expect(recap.recapHistory()).toHaveLength(0);

            send(
                'new_battle',
                battle(
                    [
                        ['friend', 0],
                        ['me', 0],
                    ],
                    2
                )
            );
            run([100, 700], { battleId: 2 });
            run([100, 0], { battleId: 2 });
            expect(recap.recapHistory()).toHaveLength(1);
        });

        test('a solo guess is dropped once the tick names more than one seat', () => {
            game.actions = SOLO;
            run([100]);
            run([100, 100]);
            run([100, 0]);
            expect(recap.recapHistory()).toHaveLength(0);
        });

        test('the data manager cached new_battle names the seat in a party', () => {
            game.party = [
                { characterID: 'me', characterName: 'me' },
                { characterID: 'friend', characterName: 'friend' },
            ];
            game.battleData = battle([
                ['friend', 0],
                ['me', 0],
            ]);
            run([700, 100]);
            run([700, 0]);
            expect(recap.recapHistory()).toHaveLength(1);
            expect(recap.recapHistory()[0].samples.map((s) => s.hp)).toEqual([100, 0]);
        });

        test("the cached new_battle names the monsters, so hits are not 'Unknown Enemy'", () => {
            game.actions = SOLO;
            game.battleData = battle([['me', 0]]);
            run([1000]);
            run([400]);
            run([0]);
            const [r] = recap.recapHistory();
            expect(r.sources[0].name).toBe('Golem');
        });

        test("a live hrid-only monster is named with the game's own name", () => {
            game.actions = SOLO;
            game.clientData = {
                combatMonsterDetailMap: { '/monsters/granite_golem': { name: 'Granite Golem' } },
            };
            try {
                game.battleData = { ...battle([['me', 0]]), monsters: [{ hrid: '/monsters/granite_golem' }] };
                run([1000]);
                run([400]);
                run([0]);
                expect(recap.recapHistory()[0].sources[0].name).toBe('Granite Golem');
            } finally {
                game.clientData = {};
            }
        });

        test('a solo fight with no cached battle still records, with the source unnamed', () => {
            game.actions = SOLO;
            run([1000]);
            run([400]);
            run([0]);
            const [r] = recap.recapHistory();
            expect(recap.recapHistory()).toHaveLength(1);
            expect(r.sources[0].name).not.toBe('Golem');
        });

        test('a new_battle that does not name us is not a gap to guess across', () => {
            send('new_battle', battle([['stranger', 0]]));
            run([0]);
            expect(recap.recapHistory()).toHaveLength(0);
        });
    });
    describe('observed deaths beyond the display cap stay owed a counter rise (#563)', () => {
        const die = (n) => {
            for (let i = 0; i < n; i++) {
                run([1500]);
                run([0]);
                vi.advanceTimersByTime(21_000);
            }
        };
        const start = () => {
            game.actions = SOLO;
            send('new_battle', battle([['me', 0]]));
        };
        const confirmedIds = () =>
            recap
                .recapHistory()
                .filter((r) => r.confirmed)
                .map((r) => r.id);

        test.each([4, 5, 6])('%i observed deaths then a matching rise create no fallback', (n) => {
            start();
            die(n);
            const before = recap.recapHistory().map((r) => r.id);
            expect(before).toHaveLength(Math.min(n, recap.MAX_RECAPS));
            send('new_battle', battle([['me', n]], 2));
            const after = recap.recapHistory();
            expect(after.map((r) => r.id)).toEqual(before);
            expect(after.every((r) => r.source === 'both' && r.confirmed)).toBe(true);
        });

        test('catch-up in several increments consumes the oldest first', () => {
            start();
            die(8);
            const ids = recap.recapHistory().map((r) => r.id);
            expect(ids).toHaveLength(5);
            // 3 evicted (1-3), pending holds 4-8
            send('new_battle', battle([['me', 2]], 2));
            send('new_battle', battle([['me', 3]], 3));
            expect(confirmedIds()).toEqual([]);
            expect(recap.recapHistory().map((r) => r.id)).toEqual(ids);
            send('new_battle', battle([['me', 4]], 4));
            expect(confirmedIds()).toEqual([ids[4]]);
            send('new_battle', battle([['me', 8]], 5));
            expect(recap.recapHistory().map((r) => r.id)).toEqual(ids);
            expect(recap.recapHistory().every((r) => r.confirmed)).toBe(true);
        });

        test('6 observed then a rise of 7 makes exactly one fallback', () => {
            start();
            die(6);
            send('new_battle', battle([['me', 7]], 2));
            const h = recap.recapHistory();
            expect(h).toHaveLength(5);
            expect(h[0]).toMatchObject({ source: 'count', deaths: 1 });
            expect(h.slice(1).every((r) => r.confirmed)).toBe(true);
        });

        test('an unchanged or repeated counter creates nothing', () => {
            start();
            die(6);
            send('new_battle', battle([['me', 6]], 2));
            send('new_battle', battle([['me', 6]], 3));
            expect(recap.recapHistory().map((r) => r.source)).toEqual(Array(5).fill('both'));
            const ids = recap.recapHistory().map((r) => r.id);
            expect(ids).toEqual([ids[0], ids[0] - 1, ids[0] - 2, ids[0] - 3, ids[0] - 4]);
        });

        test('a counter decrease clears the evicted accounting', () => {
            start();
            send('new_battle', battle([['me', 3]], 2));
            die(6);
            send('new_battle', battle([['me', 0]], 3));
            send('new_battle', battle([['me', 1]], 4));
            // pending was cleared with the evicted count: the rise of 1 is unseen, not owed to a stale death
            expect(recap.recapHistory()[0]).toMatchObject({ source: 'count', deaths: 1 });
        });

        test('a character switch and disable clear the evicted accounting', async () => {
            for (const reset of [() => game.dm.character_switching(), () => feature.disable()]) {
                feature.disable();
                await feature.initialize();
                start();
                die(6);
                reset();
                await feature.initialize();
                send('new_battle', battle([['me', 0]], 2));
                send('new_battle', battle([['me', 1]], 3));
                expect(recap.recapHistory()).toHaveLength(1);
                expect(recap.recapHistory()[0]).toMatchObject({ source: 'count' });
            }
        });
    });

    describe('a row that omits single fields means unchanged', () => {
        const row = (fields, atk) => ({
            battleId: 1,
            pMap: { 0: { cMP: 500, isActive: true, ...fields } },
            mMap: { 0: { atkCounter: atk, cMP: 0, dmgCounter: 0 } },
        });
        const recapHits = (counter = 3) => {
            send('battle_updated', row({ cHP: 0, dmgCounter: counter }, 9));
            return recap.recapHistory()[0].samples.flatMap((s) => s.hits);
        };

        test('a missed swing with cHP omitted is a miss, not a hit of NaN damage', () => {
            send('new_battle', battle([['me', 0]]));
            vi.advanceTimersByTime(700);
            send('battle_updated', row({ cHP: 1000, dmgCounter: 1 }, 1));
            vi.advanceTimersByTime(700);
            send('battle_updated', row({ dmgCounter: 2 }, 2));
            vi.advanceTimersByTime(700);
            send('battle_updated', row({ cHP: 700, dmgCounter: 3 }, 3));
            vi.advanceTimersByTime(700);
            const hits = recapHits();
            expect(hits.every((h) => Number.isFinite(h.amount))).toBe(true);
            // The omitted tick kept the 1000 baseline, so the 300 loss lands whole on the next tick
            expect(hits.filter((h) => !h.miss).map((h) => h.amount)).toEqual([300]);
            expect(recap.recapHistory()[0].sources[0].amount).toBe(300);
        });

        test('an omitted dmgCounter does not turn the next reading into a new hit', () => {
            send('new_battle', battle([['me', 0]]));
            vi.advanceTimersByTime(700);
            send('battle_updated', row({ cHP: 1000, dmgCounter: 5 }, 1));
            vi.advanceTimersByTime(700);
            send('battle_updated', row({ cHP: 1000 }, 2));
            vi.advanceTimersByTime(700);
            send('battle_updated', row({ cHP: 1000, dmgCounter: 5 }, 3));
            vi.advanceTimersByTime(700);
            // Only the first swing (counter 5 against the seeded 0) is a miss
            expect(recapHits(5).filter((h) => h.miss)).toHaveLength(1);
        });
    });

    describe('an open recap follows the kept list', () => {
        const die = (n) => {
            send('new_battle', battle([['me', 0]], n));
            run([500], { battleId: n });
            run([0], { battleId: n });
        };
        const modalEl = () => document.getElementById('toolasha-death-recap-modal');
        const navText = () => modalEl().querySelector('[data-role="recap-nav"]')?.textContent ?? '';

        test('a death while viewing redraws the position and enables Newer', () => {
            die(1);
            vi.advanceTimersByTime(60_000);
            die(2);
            recap.openRecap(recap.recapHistory()[0].id);
            expect(navText()).toContain('1 of 2');
            vi.advanceTimersByTime(60_000);
            die(3);
            expect(navText()).toContain('2 of 3');
            const newer = modalEl().querySelectorAll('[data-role="recap-nav"] button')[1];
            expect(newer.disabled).toBe(false);
        });

        test('the viewed recap evicted by newer deaths leaves no dead navigation', () => {
            for (let n = 1; n <= recap.MAX_RECAPS; n++) {
                die(n);
                vi.advanceTimersByTime(60_000);
            }
            const oldest = recap.recapHistory()[recap.MAX_RECAPS - 1];
            recap.openRecap(oldest.id);
            die(99);
            expect(recap.recapHistory().some((r) => r.id === oldest.id)).toBe(false);
            expect(modalEl()).not.toBeNull();
            expect(navText()).toBe('');
        });
    });
});
