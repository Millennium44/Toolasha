/** @vitest-environment happy-dom
 *
 * The per-player panel for a normal fight.
 *
 * What is worth asserting is which tracker feeds which tab and what each tab
 * claims about its figures — the drawing itself belongs to `damage-board.js`
 * and is tested there. Healing is on two tabs as two different things: Taken
 * carries health *received* beside what was lost, and Healing done credits a
 * player only where the feed shows them causing it — a panel that let either
 * read as the other would be inventing an attribution the run feed cannot make.
 *
 * The rest is the lifecycle: the opener has to survive React rebuilding the
 * battle panel, and switching the feature off has to leave the game's own DOM
 * as it found it.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const opts = vi.hoisted(() => ({
    enabled: true,
    dealt: { seconds: 0, players: [] },
    taken: { seconds: 0, players: [] },
    audit: { tracking: false, fight: null, session: null },
    started: 0,
    stopped: 0,
    handlers: [],
    readyHandlers: [],
    domReady: true,
    stored: new Map(),
}));

// Saved sessions live in IndexedDB; an in-memory map stands in for it
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (opts.stored.has(key) ? opts.stored.get(key) : fallback),
        set: async (key, value) => {
            opts.stored.set(key, value);
            return true;
        },
        delete: async (key) => opts.stored.delete(key),
        ready: Promise.resolve(true),
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => opts.enabled,
        getSettingValue: (_key, fallback) => fallback,
        Z_FLOATING_PANEL: 9000,
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, classNames, callback) => {
            const handler = { name, classNames, callback };
            opts.handlers.push(handler);
            return () => {
                opts.handlers = opts.handlers.filter((entry) => entry !== handler);
            };
        },
        // Mirrors the real DOMObserver.onReady: immediate when already attached (the default),
        // deferred until the readiness-gap test fires it by hand otherwise.
        onReady: (name, callback) => {
            const handler = { name, callback };
            opts.readyHandlers.push(handler);
            if (opts.domReady) callback();
            return () => {
                opts.readyHandlers = opts.readyHandlers.filter((entry) => entry !== handler);
            };
        },
    },
}));
vi.mock('./damage-tracker.js', () => ({
    damageBreakdown: () => opts.dealt,
    // Real ability names need game data; the shape of the label is all the
    // panel is responsible for
    actionLabel: (hrid) => String(hrid).split('/').pop().replace(/_/g, ' '),
}));
vi.mock('./rotation-tracker.js', () => ({
    rotationAudit: () => opts.audit,
    startRotationTracker: () => opts.started++,
    stopRotationTracker: () => opts.stopped++,
}));
vi.mock('./damage-taken-tracker.js', () => ({ takenBreakdown: () => opts.taken }));
// The weapon icon needs game data; what matters here is that a verdict becomes
// a chip and no verdict becomes nothing
vi.mock('../../utils/class-weapon.js', () => ({
    classTagIconHTML: (tag, { title = '' } = {}) =>
        tag?.key ? `<svg data-class="${tag.key}"><title>${title}</title></svg>` : '',
}));
// Geometry lives in IndexedDB and is never what a panel test is about
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: () => {},
    reopenIfLeftOpen: () => {},
    wasCollapsed: async () => false,
    saveCollapsed: () => {},
    savedSize: async () => null,
}));

const {
    BUTTON_ID,
    PANEL_ID,
    TABS,
    ROTATION_SCOPES,
    panelRows,
    panelText,
    rotationVarianceText,
    rotationHistoryText,
    drawBoard,
    getPanel,
    default: feature,
} = await import('./combat-dps-panel.js');

const { newRotationState, noteRotationKit, noteRotationFight, foldRotationTick, summariseRotation } =
    await import('../../utils/rotation-audit.js');

// The real bus, because what the shell's teardown has to release is a real
// subscription on it — a mocked emitter would only prove the mock
const dataManager = (await import('../../core/data-manager.js')).default;

/** The players area as the game builds it, hashed class name and all */
function battlePanel() {
    const area = document.createElement('div');
    area.className = 'BattlePanel_playersArea__2b3c4';
    document.body.appendChild(area);
    return area;
}

const button = () => document.getElementById(BUTTON_ID);

/** The board drawn into a bare div, which is all `drawBoard` needs */
function board() {
    const body = document.createElement('div');
    document.body.appendChild(body);
    drawBoard(body);
    return body;
}

beforeEach(() => {
    opts.enabled = true;
    opts.dealt = { seconds: 0, players: [] };
    opts.taken = { seconds: 0, players: [] };
    opts.audit = { tracking: false, fight: null, session: null };
    opts.started = 0;
    opts.stopped = 0;
    opts.handlers = [];
    opts.readyHandlers = [];
    opts.domReady = true;
    document.body.replaceChildren();
    feature._resetTab();
});

afterEach(() => {
    feature.cleanup();
    document.body.replaceChildren();
});

describe('which tracker feeds which tab', () => {
    beforeEach(() => {
        opts.dealt = {
            seconds: 100,
            players: [
                { name: 'Alice', damage: 7500, dps: 75 },
                { name: 'Bob', damage: 2500, dps: 25 },
            ],
        };
        opts.taken = {
            seconds: 100,
            players: [
                { name: 'Alice', damage: 400, dps: 4, regen: 900, hps: 9 },
                { name: 'Bob', damage: 1600, dps: 16, regen: 100, hps: 1 },
            ],
        };
    });

    test('a class verdict on the dealt row becomes a weapon chip, on every tab', () => {
        opts.dealt.players[0].classTag = { key: 'fireMage', short: 'FIRE' };

        expect(panelRows('damage').rows.find((row) => row.name === 'Alice')?.classTag?.key).toBe('fireMage');
        // The taken tracker has no casts; the class is borrowed by name
        expect(panelRows('taken').rows.find((row) => row.name === 'Alice')?.classTag?.key).toBe('fireMage');
        expect(panelRows('healed').rows.find((row) => row.name === 'Bob')?.classTag).toBeNull();

        const html = board().innerHTML;
        expect(html).toContain('data-class="fireMage"');
        expect(html).toContain('seen casting this run');
        // One chip — Bob has no verdict and gets no placeholder
        expect(html.match(/data-class=/g)).toHaveLength(1);
    });

    test('damage comes from the damage tracker, ranked', () => {
        const { rows, total } = panelRows('damage');

        expect(rows.map((row) => row.name)).toEqual(['Alice', 'Bob']);
        expect(total).toBe(10_000);
        expect(rows[0].share).toBeCloseTo(75, 9);
    });

    test('taken comes from the damage-taken tracker, and ranks the other way round', () => {
        // The point of the tab: the biggest dealer is not the biggest taker
        expect(panelRows('taken').rows.map((row) => row.name)).toEqual(['Bob', 'Alice']);
    });

    test('taken rows carry the healing each player received and the net', () => {
        const board = panelRows('taken');

        expect(board.rows[0]).toMatchObject({ name: 'Bob', value: 1600, received: 100, net: -1500 });
        expect(board.rows[0].detail).toBe('received 100 · net −1.5K');
        expect(board.rows[1]).toMatchObject({ name: 'Alice', value: 400, received: 900, net: 500 });
        expect(board.rows[1].detail).toBe('received 900 · net +500');
        expect(board.received).toBe(1000);
        expect(board.net).toBe(-1000);
    });

    test('a caller still naming the old Healed tab gets Taken', () => {
        expect(panelRows('healed')).toEqual(panelRows('taken'));
    });

    test('a rate the tracker refused to state is not invented', () => {
        // Under the tracker's floor `dps` is null — too early for a rate,
        // which is not the same as a rate of nothing
        opts.dealt = { seconds: 2, players: [{ name: 'Alice', damage: 100, dps: null }] };
        expect(panelRows('damage').rows[0].perSecond).toBeNull();
    });

    test('no fight yet is an empty board rather than a crash', () => {
        opts.dealt = null;
        opts.taken = null;
        for (const entry of TABS) expect(panelRows(entry.key).rows).toEqual([]);
    });
});

describe('what the board says about its figures', () => {
    beforeEach(() => {
        opts.dealt = { seconds: 100, players: [{ name: 'Alice', damage: 7500, dps: 75 }] };
        opts.taken = { seconds: 100, players: [{ name: 'Alice', damage: 400, dps: 4, regen: 900, hps: 9 }] };
    });

    test('the damage tab names where the figures came from and what shares them', () => {
        const text = board().textContent;

        expect(text).toContain('own battle feed');
        expect(text).toContain('split evenly only in a crowd');
        expect(text).toContain('Alice');
    });

    test('there is no Healed tab; Taken shows received and net, and does not claim who healed', () => {
        const body = board();
        expect(body.querySelector('[data-tab="healed"]')).toBeNull();
        body.querySelector('[data-tab="taken"]').click();

        const text = body.textContent;
        expect(text).toContain('received 900 · net +500');
        expect(text).toContain('Healing received: 900 · Net: +500');
        expect(text).toContain('Healing done says who healed');
        expect(text).not.toContain('could not be drawn');
        expect(panelText('taken')).toContain('Healing received: 900\nNet: +500');
    });

    test('the taken tab says its figure is a floor, not the game’s own', () => {
        const body = board();
        [...body.querySelectorAll('[data-tab]')].find((tab) => tab.dataset.tab === 'taken').click();

        expect(body.textContent).toContain('after mitigation');
        expect(body.textContent).toContain('floor');
    });

    test('a remembered Healed tab draws as Taken', () => {
        feature._setTab('healed');
        const body = board();

        expect(body.querySelector('[data-expand], [data-tab="taken"]')).not.toBeNull();
        expect(body.textContent).toContain('Healing received: 900');
        expect(body.textContent).not.toContain('could not be drawn');
    });

    test('a run with nothing in it explains itself rather than sitting blank', () => {
        opts.dealt = { seconds: 0, players: [] };
        expect(board().textContent).toContain('Nothing measured yet');
    });

    test('the clipboard text is the same table', () => {
        const text = panelText('damage');

        expect(text).toContain('Party damage');
        expect(text).toContain('1. Alice — 7,500');
        expect(text).toContain('100s');
    });

    test('nothing measured copies a sentence rather than an empty heading', () => {
        opts.dealt = { seconds: 0, players: [] };
        expect(panelText('damage')).toBe('Party damage: nothing measured yet.');
    });
});

describe('the opener, and the lifecycle', () => {
    test('the button lands on the battle panel and opens the board', () => {
        const area = battlePanel();
        feature.initialize();

        expect(button()).not.toBeNull();
        expect(area.style.position).toBe('relative');

        button().click();
        expect(document.getElementById(`toolasha-${PANEL_ID}-panel`)).not.toBeNull();
    });

    test('a battle panel mounted before the shared observer is ready gets its button at readiness', () => {
        opts.domReady = false;
        battlePanel();

        feature.initialize();
        expect(button()).toBeNull();

        opts.readyHandlers.forEach((h) => h.callback());
        expect(button()).not.toBeNull();
    });

    test('leaving the Combat tab and coming back re-injects it', () => {
        // React throws the battle panel away and builds a new one, taking every
        // injected node with it; an anchor captured once is stale
        battlePanel();
        feature.initialize();
        expect(button()).not.toBeNull();

        document.body.replaceChildren();
        const rebuilt = battlePanel();
        expect(button()).toBeNull();

        expect(opts.handlers).toHaveLength(1);
        for (const handler of opts.handlers) handler.callback(rebuilt);

        expect(button()).not.toBeNull();
    });

    test('the guild trial’s battle panel gets no button — it has a scoreboard of its own', () => {
        // The In Progress tab renders the same players area inside the Guild panel
        const guild = document.createElement('div');
        guild.className = 'GuildPanel_guildPanel__1abcd';
        const trialArea = document.createElement('div');
        trialArea.className = 'BattlePanel_playersArea__2b3c4';
        guild.appendChild(trialArea);
        document.body.appendChild(guild);

        feature.initialize();
        for (const handler of opts.handlers) handler.callback(trialArea);
        expect(button()).toBeNull();

        // The party's own battle, elsewhere on the page, still gets it
        const own = battlePanel();
        for (const handler of opts.handlers) handler.callback(own);
        expect(button()).not.toBeNull();
        expect(own.contains(button())).toBe(true);
    });

    test('one button however many times the observer fires', () => {
        const area = battlePanel();
        feature.initialize();
        for (const handler of opts.handlers) handler.callback(area);

        expect(document.querySelectorAll(`#${BUTTON_ID}`)).toHaveLength(1);
    });

    test('the setting off injects nothing and watches nothing', () => {
        opts.enabled = false;
        battlePanel();
        feature.initialize();

        expect(button()).toBeNull();
        expect(opts.handlers).toHaveLength(0);
    });

    test('cleanup leaves the game’s own DOM as it found it, and runs twice safely', () => {
        const area = battlePanel();
        feature.initialize();
        getPanel().show();

        feature.cleanup();

        expect(button()).toBeNull();
        expect(opts.handlers).toHaveLength(0);
        expect(document.getElementById(`toolasha-${PANEL_ID}-panel`)).toBeNull();
        // The positioning context was ours; it must not outlive the button
        expect(area.style.position).toBe('');
        expect(() => feature.cleanup()).not.toThrow();
        expect(area.isConnected).toBe(true);
    });

    test('initialising with no battle panel on screen is not an error', () => {
        expect(() => feature.initialize()).not.toThrow();
        expect(button()).toBeNull();
    });
});

describe('a battle panel that the observer missed', () => {
    test('gets its opener from the slow re-inject timer', () => {
        vi.useFakeTimers();
        try {
            // No battle panel yet when the feature comes up — a page loaded
            // before any fight, or a rebuild the observer's scan did not see
            feature.initialize();
            expect(button()).toBeNull();

            battlePanel();
            expect(button()).toBeNull();

            // The two-second tick is the cheap "is my button still there" pass;
            // with no panel in hand the document scan is only worth making every
            // ten seconds, so that is how long the safety net takes
            vi.advanceTimersByTime(2500);
            expect(button()).toBeNull();

            vi.advanceTimersByTime(10_000);
            expect(button()).not.toBeNull();

            // Idempotent: the timer keeps asking and never doubles it
            vi.advanceTimersByTime(10_000);
            expect(document.querySelectorAll(`#${BUTTON_ID}`)).toHaveLength(1);

            feature.cleanup();
            document.body.replaceChildren();
            battlePanel();
            vi.advanceTimersByTime(10_000);
            expect(button()).toBeNull(); // cleanup stopped the timer
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('the rotation tab', () => {
    const CHEAP = '/abilities/cheap_jab';
    const PRICEY = '/abilities/pricey_nova';
    const DETAILS = {
        [CHEAP]: { manaCost: 10, cooldownDuration: 2e9 },
        [PRICEY]: { manaCost: 500, cooldownDuration: 5e9 },
    };

    /** A run where the cheap ability carries the fight and the expensive one never fires */
    function starvedAudit() {
        const state = newRotationState();
        noteRotationKit(state, [CHEAP, PRICEY], DETAILS);
        noteRotationFight(state);

        const start = 1_700_000_000_000;
        for (let index = 0; index < 41; index++) {
            foldRotationTick(state, {
                at: start + index * 500,
                player: { cMP: 100, mMP: 1000, atkCounter: index },
                action: CHEAP,
                events: [{ action: CHEAP, amount: 250 }],
                detailMap: DETAILS,
            });
        }
        const summary = summariseRotation(state);
        return { tracking: true, fight: summary, session: summary };
    }

    test('Copy variances lists the deviations and leaves the working rows off', () => {
        const text = rotationVarianceText(starvedAudit(), 'session');

        // The starved one is a variance, with its verdict on the line
        expect(text).toContain('pricey nova');
        expect(text).toContain('never fired');
        // The one doing its job is not
        expect(text).not.toContain('cheap jab');
        expect(text).toContain('Rotation variances (session)');
    });

    test('an ability seen firing that the bar never stated is called out', () => {
        const state = newRotationState();
        noteRotationKit(state, [CHEAP], DETAILS);
        noteRotationFight(state);
        const start = 1_700_000_000_000;
        for (let index = 0; index < 10; index++) {
            foldRotationTick(state, {
                at: start + index * 500,
                player: { cMP: 900, mMP: 1000, atkCounter: index },
                action: PRICEY,
                events: [{ action: PRICEY, amount: 100 }],
                detailMap: DETAILS,
            });
        }
        const summary = summariseRotation(state);
        const text = rotationVarianceText({ tracking: true, fight: summary, session: summary }, 'session');

        expect(text).toContain('never stated it on the bar');
    });

    test('with no battle named yet the copy says so instead of inventing rows', () => {
        expect(rotationVarianceText({ tracking: false }, 'session')).toContain('waiting for a battle');
    });

    test('the button is on the rotation tab and puts the variances on the clipboard', () => {
        opts.audit = starvedAudit();
        feature._setTab('rotation');

        const button = board().querySelector('[data-action="copy-variance"]');
        expect(button).toBeTruthy();

        const writes = [];
        Object.defineProperty(navigator, 'clipboard', {
            value: {
                writeText: (text) => {
                    writes.push(text);
                    return Promise.resolve();
                },
            },
            configurable: true,
        });
        button.click();

        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain('Rotation variances');
        expect(writes[0]).toContain('pricey nova');
    });

    test('is a tab of its own, after the party ones', () => {
        expect(TABS.map((entry) => entry.key)).toEqual(['damage', 'taken', 'healing', 'rotation']);
    });

    test('says nothing is being watched until a battle names your slot', () => {
        feature._setTab('rotation');
        const text = board().textContent;

        expect(text).toContain('Waiting for a battle to name your slot');
        expect(text).toContain('this tab is about the bar you can change');
        expect(text).not.toContain('could not be drawn');
    });

    test('a kit read before the first battle is still drawn, under the notice', () => {
        // The tracker seeds the equipped bar the moment the panel opens, so
        // rows can exist before a battle names the slot. Hiding them behind the
        // notice threw away the only thing the tab had to show
        const state = newRotationState();
        noteRotationKit(state, [CHEAP, PRICEY], DETAILS);
        const summary = summariseRotation(state);
        opts.audit = { tracking: false, fight: summary, session: summary };

        feature._setTab('rotation');
        const text = board().textContent;

        expect(text).toContain('Waiting for a battle to name your slot');
        expect(text).toContain('cheap jab');
        expect(text).toContain('pricey nova');
        expect(text).not.toContain('could not be drawn');
    });

    test('with nothing seen at all the notice stands alone', () => {
        const summary = summariseRotation(newRotationState());
        opts.audit = { tracking: false, fight: summary, session: summary };

        feature._setTab('rotation');
        const text = board().textContent;

        expect(text).toContain('Waiting for a battle to name your slot');
        expect(text).toContain('Nothing on the bar yet');
    });

    test('draws a row per ability with the verdict on it', () => {
        opts.audit = starvedAudit();
        feature._setTab('rotation');
        const text = board().textContent;

        expect(text).toContain('cheap jab');
        expect(text).toContain('pricey nova');
        // The one that cannot be paid for says so, and says which fix applies
        expect(text).toContain('Effectively never fires');
        expect(text).toContain('drop it or raise regen');
        // The one that works is not dressed up as a problem
        expect(text).toMatch(/Fine: \d+% uptime/);
        expect(text).not.toContain('could not be drawn');
    });

    test('carries the per-cast, per-mana and per-cooldown-second figures', () => {
        opts.audit = starvedAudit();
        feature._setTab('rotation');
        const text = board().textContent;

        expect(text).toContain('/cast');
        expect(text).toContain('/mana');
        expect(text).toContain('/cd-s');
        expect(text).toContain('starved 100% of ready');
    });

    test('summarises mana against regen, seconds starved, and one labelled suggestion', () => {
        opts.audit = starvedAudit();
        feature._setTab('rotation');
        const text = board().textContent;

        expect(text).toContain('mana/min spent');
        expect(text).toContain('per fight under the cheapest cast');
        expect(text).toContain('Suggestion:');
    });

    test('an ability slotted and never cast is marked as such', () => {
        opts.audit = starvedAudit();
        feature._setTab('rotation');

        expect(board().textContent).toContain('slotted');
    });

    test('switching scope redraws against the session figures', () => {
        opts.audit = starvedAudit();
        feature._setTab('rotation');
        const body = board();

        const session = body.querySelector('[data-scope="session"]');
        expect(session).toBeTruthy();
        session.click();
        expect(body.querySelector('[data-scope="session"]').outerHTML).toContain('#8fd3ff');
    });

    test('copies as text rather than as HTML', () => {
        opts.audit = starvedAudit();
        feature._setTab('rotation');

        const text = panelText('rotation');
        expect(text).toContain('Rotation (session)');
        expect(text).toContain('uptime');
        expect(text).not.toContain('<div');
    });

    test('the tracker starts and stops with the panel', () => {
        feature.initialize();
        expect(opts.started).toBe(1);

        feature.cleanup();
        expect(opts.stopped).toBe(1);
    });
});

describe('the rotation tab’s history scope', () => {
    const CHEAP = '/abilities/cheap_jab';
    const PRICEY = '/abilities/pricey_nova';

    /** Two finished fights as the tracker's ring holds them, newest first */
    const HISTORY = [
        {
            at: 1_700_000_020_000,
            seconds: 12,
            casts: 9,
            manaSpent: 600,
            manaRestored: 120,
            starvedSeconds: 2.5,
            abilities: [
                { hrid: CHEAP, casts: 7 },
                { hrid: PRICEY, casts: 2 },
            ],
        },
        {
            at: 1_700_000_000_000,
            seconds: 30,
            casts: 20,
            manaSpent: 200,
            manaRestored: 400,
            starvedSeconds: 0,
            abilities: [{ hrid: CHEAP, casts: 20 }],
        },
    ];

    test('is a third scope, after the fight and the session', () => {
        expect(ROTATION_SCOPES.map((entry) => entry.key)).toEqual(['fight', 'session', 'history']);
    });

    test('lists every fight, newest first, with its per-ability casts on the row', () => {
        opts.audit = { tracking: true, fight: null, session: null, history: HISTORY };
        feature._setTab('rotation', 'history');

        const text = board().textContent;

        expect(text).toContain('12s');
        expect(text).toContain('30s');
        expect(text).toContain('9 casts');
        expect(text).toContain('starved 2.5s');
        // The second line: what fired in that fight, and how often
        expect(text).toContain('cheap jab 7');
        expect(text).toContain('pricey nova 2');
        // Newest first
        expect(text.indexOf('12s')).toBeLessThan(text.indexOf('30s'));
    });

    test('says the buffer is empty rather than drawing nothing', () => {
        opts.audit = { tracking: true, fight: null, session: null, history: [] };
        feature._setTab('rotation', 'history');

        expect(board().textContent).toContain('No finished fights yet');
    });

    test('draws without a slot named, because a recorded fight already had one', () => {
        opts.audit = { tracking: false, fight: null, session: null, history: HISTORY };
        feature._setTab('rotation', 'history');

        const text = board().textContent;
        expect(text).not.toContain('Waiting for a battle to name your slot');
        expect(text).toContain('cheap jab 7');
    });

    test('the copy is one line per fight', () => {
        const text = rotationHistoryText(HISTORY);
        const lines = text.split('\n');

        expect(lines).toHaveLength(3); // a heading and the two fights
        expect(lines[0]).toContain('the last 2 fights, newest first');
        expect(lines[1]).toContain('#1: 12s, 9 casts');
        expect(lines[1]).toContain('starved 2.5s');
        expect(lines[1]).toContain('cheap jab 7, pricey nova 2');
        expect(lines[2]).toContain('#2: 30s, 20 casts');
    });

    test('an empty buffer copies as a heading and a note, not a bare heading', () => {
        expect(rotationHistoryText([])).toContain('No finished fights recorded yet');
        expect(rotationHistoryText(undefined)).toContain('No finished fights recorded yet');
    });

    test('the Copy stats button on this scope puts the history on the clipboard', () => {
        opts.audit = { tracking: true, fight: null, session: null, history: HISTORY };
        feature._setTab('rotation', 'history');

        const writes = [];
        Object.defineProperty(navigator, 'clipboard', {
            value: {
                writeText: (text) => {
                    writes.push(text);
                    return Promise.resolve();
                },
            },
            configurable: true,
        });
        board().querySelector('[data-action="copy"]').click();

        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain('Rotation history');
        expect(writes[0]).toContain('#1: 12s, 9 casts');
    });

    test('panelText routes the rotation tab’s history scope to it', () => {
        opts.audit = { tracking: true, fight: null, session: null, history: HISTORY };
        feature._setTab('rotation', 'history');

        expect(panelText('rotation', { audit: () => opts.audit })).toContain('Rotation history');
    });
});

/**
 * The panel shell the feature builds, and gives back.
 *
 * `createPanel` subscribes to `character_switched` so a panel left open comes
 * back for the arriving character. That subscription belongs to the shell, and
 * `cleanup()` used to drop the handle without releasing it — so every character
 * switch built a second shell over the first one's live listener, and the count
 * climbed for the life of the tab.
 */
describe('player markers on the board', () => {
    test('each row carries a marker in the player’s color that opens the player menu', async () => {
        const { playerColor } = await import('../../utils/player-colors.js');
        opts.dealt = { seconds: 100, players: [{ name: 'Abe', damage: 1000, dps: 10, classTag: null }] };

        const body = board();
        const marker = body.querySelector('[data-toolasha-player="Abe"]');
        expect(marker).not.toBeNull();
        expect(body.innerHTML).toContain(`${playerColor('Abe')}44`);

        marker.click();
        expect(document.querySelector('.toolasha-player-menu')?.textContent).toContain('Abe');
    });

    test('a held Escape closes only the menu, not the panel underneath it too', () => {
        // Reproduces a live report: opening the menu and tapping Escape once
        // closed the menu and, by the time anyone looked, the panel as well.
        // The browser fires a non-repeat keydown for a press and then more
        // with `repeat: true` for as long as the key is down — a hold a
        // fraction of a second too long reaches this listener as two
        // keydowns, and without a repeat guard the second one peels the panel
        // right behind the menu.
        opts.dealt = { seconds: 100, players: [{ name: 'Abe', damage: 1000, dps: 10, classTag: null }] };
        const panel = getPanel();
        panel.show();
        const marker = panel.panel.querySelector('[data-toolasha-player="Abe"]');
        marker.click();
        expect(document.querySelector('.toolasha-player-menu')).not.toBeNull();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(document.querySelector('.toolasha-player-menu')).toBeNull();
        expect(panel.isOpen()).toBe(true);

        document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, repeat: true })
        );
        expect(panel.isOpen()).toBe(true);

        // A second, genuine press still closes it
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(panel.isOpen()).toBe(false);
    });
});

describe('the DPS graph', () => {
    test('sits on the Damage tab only', () => {
        opts.dealt = { seconds: 100, players: [{ name: 'Abe', damage: 1000, dps: 10, classTag: null }] };
        expect(board().querySelector('[data-dps-graph]')).not.toBeNull();

        feature._setTab('taken');
        expect(board().querySelector('[data-dps-graph]')).toBeNull();
    });

    test('its sampler listens for battles while the panel is on, and lets go when it is switched off', async () => {
        const websocket = (await import('../../core/websocket.js')).default;
        const on = vi.spyOn(websocket, 'on');
        const off = vi.spyOn(websocket, 'off');
        try {
            feature.initialize();
            const registered = on.mock.calls.find(([type]) => type === 'new_battle');
            expect(registered).toBeDefined();

            feature.cleanup();
            expect(off).toHaveBeenCalledWith('new_battle', registered[1]);
        } finally {
            on.mockRestore();
            off.mockRestore();
        }
    });
});

describe('the shell the panel is built from', () => {
    const switchListeners = () => dataManager.eventListeners.get('character_switched')?.length ?? 0;

    test('teardown releases the shell’s character-switch subscription', () => {
        const before = switchListeners();

        feature.initialize();
        expect(switchListeners()).toBe(before + 1);

        feature.cleanup();

        expect(switchListeners()).toBe(before);
    });

    test('repeated init/teardown cycles leave the count where it started', () => {
        const before = switchListeners();

        for (let cycle = 0; cycle < 3; cycle++) {
            feature.initialize();
            feature.cleanup();
        }

        expect(switchListeners()).toBe(before);
    });
});

describe('kills on the damage board', () => {
    test('each row says how many killing blows it owned, and the copy says it too', () => {
        opts.dealt = {
            seconds: 100,
            players: [
                { name: 'Alice', damage: 7500, dps: 75, kills: 4 },
                { name: 'Bob', damage: 2500, dps: 25, kills: 1 },
                { name: 'Cara', damage: 1000, dps: 10, kills: 0 },
            ],
        };

        const text = board().textContent;
        expect(text).toContain('4 kills');
        expect(text).toContain('1 kill');
        expect(text).not.toContain('0 kills');
        expect(panelText('damage')).toContain('1. Alice — 7,500 (75/s, 68.2%) · 4 kills');
    });
});

describe('the damage board’s team total', () => {
    test('the headline is the team total and the rows reconcile to it', () => {
        opts.dealt = {
            seconds: 100,
            team: { damage: 11_500, unattributed: 1000, filtered: 500 },
            players: [
                { name: 'Alice', damage: 7500, dps: 75 },
                { name: 'Bob', damage: 2500, dps: 25 },
            ],
        };

        const board = panelRows('damage');
        expect(board.total).toBe(10_000);
        expect(board.team).toBe(11_500);
        expect(board.team).toBe(board.total + board.unattributed + board.filtered);

        const text = boardText();
        expect(text).toContain('Team total 11,500 = the rows 10,000 + unattributed 1,000 + filtered 500');
        expect(text).toContain('party dps');

        const copy = panelText('damage');
        expect(copy).toContain('Party damage — 11,500 total, 115/s');
        expect(copy).toContain('Unattributed: 1,000');
        expect(copy).toContain('Filtered: 500');
    });

    test('with nothing uncredited the note is not drawn', () => {
        opts.dealt = {
            seconds: 100,
            team: { damage: 10_000, unattributed: 0, filtered: 0 },
            players: [{ name: 'Alice', damage: 10_000, dps: 100 }],
        };
        expect(boardText()).not.toContain('Team total');
        expect(panelText('damage')).not.toContain('Unattributed');
    });
});

function boardText() {
    return board().textContent;
}

describe('the restored-after-refresh note', () => {
    test('a live run carried over a refresh says so, with the time it happened', () => {
        opts.dealt = {
            seconds: 30,
            team: { damage: 1000, dps: 33 },
            players: [{ name: 'Alice', damage: 1000, dps: 33 }],
            // Local time, not UTC — formatDateTime draws the house clock in
            // whatever zone the test runs in, and a UTC timestamp would print
            // a different hour on every machine
            restored: { savedAt: 1000, at: new Date(2026, 0, 1, 14, 5).getTime() },
        };
        // config.getSettingValue is mocked to hand back the fallback, which
        // formatDateTime asks for as '24hour' — so the reading is deterministic
        expect(boardText()).toContain('Continued after a page refresh at 14:05.');
    });

    test('a run that was never restored says nothing about it', () => {
        opts.dealt = {
            seconds: 30,
            team: { damage: 1000, dps: 33 },
            players: [{ name: 'Alice', damage: 1000, dps: 33 }],
        };
        expect(boardText()).not.toContain('Continued after a page refresh');
    });

    test('shown on the Rotation tab too — the run it describes is not tab-specific', () => {
        opts.dealt = {
            seconds: 30,
            team: { damage: 1000, dps: 33 },
            players: [],
            restored: { savedAt: 1000, at: new Date(2026, 0, 1, 9, 0).getTime() },
        };
        feature._setTab('rotation');
        expect(boardText()).toContain('Continued after a page refresh at 09:00.');
        feature._resetTab();
    });
});

describe('the healing done tab', () => {
    beforeEach(() => {
        opts.dealt = {
            seconds: 100,
            players: [{ name: 'Tank', damage: 5000, dps: 50, classTag: { key: 'tank', short: 'TANK' } }],
            healing: {
                total: 4000,
                uncredited: 300,
                regen: 900,
                revived: 2000,
                shared: 100,
                players: [
                    { name: 'Healer', healing: 3000, hps: 30, abilities: [] },
                    { name: 'Tank', healing: 1000, hps: 10, abilities: [] },
                ],
            },
        };
    });

    test('sits after Taken and ranks what each player caused', () => {
        expect(TABS.findIndex((entry) => entry.key === 'healing')).toBe(
            TABS.findIndex((entry) => entry.key === 'taken') + 1
        );

        const { rows, total } = panelRows('healing');
        expect(rows.map((row) => [row.name, row.value, row.perSecond])).toEqual([
            ['Healer', 3000, 30],
            ['Tank', 1000, 10],
        ]);
        expect(total).toBe(4000);
        // The class comes from the damage row where the healing row has none
        expect(rows[1].classTag.key).toBe('tank');
    });

    test('draws HPS and says what it leaves out', () => {
        feature._setTab('healing');
        const text = board().textContent;

        expect(text).toContain('party hps');
        expect(text).toContain('credited only where the feed shows who did it');
        expect(text).toContain('life-steal');
        expect(text).toContain('Bloom');
        expect(text).toContain('revives are left out');
        expect(text).toContain('Healer');
        // Regeneration and the uncredited rises, as one line that is nobody's row
        expect(text).toContain('Not from a cast — regeneration, food, unexplained: 1,200');
        expect(text).not.toContain('could not be drawn');
        const copy = panelText('healing');
        expect(copy).toContain('Party healing done — 4,000 total, 40/s');
        expect(copy).toContain('Not from a cast — regeneration, food, unexplained: 1,200');
    });

    test('an older breakdown with no healing is an empty tab, not a crash', () => {
        opts.dealt = { seconds: 100, players: [] };
        expect(panelRows('healing').rows).toEqual([]);
    });

    test('a Bloom proc and a life-steal read as what they are in the breakdown', () => {
        opts.dealt.healing.players = [
            {
                name: 'Healer',
                healing: 3000,
                hps: 30,
                abilities: [
                    { action: 'bloom:/abilities/entangle', healing: 2000 },
                    { action: 'lifesteal', healing: 600 },
                    { action: '/abilities/life_drain', healing: 400 },
                ],
            },
        ];
        feature._setTab('healing');
        const body = board();
        body.querySelector('[data-expand="healing:Healer"]').click();

        const text = body.textContent;
        expect(text).toContain('Bloom (via entangle)');
        expect(text).toContain('Life steal (auto-attacks)');
        expect(text).toContain('life drain');
        expect(text).not.toContain('bloom:');
    });
});

describe('a row opens into its breakdown', () => {
    beforeEach(() => {
        opts.dealt = {
            seconds: 100,
            players: [
                {
                    name: 'Tank',
                    damage: 6000,
                    dps: 60,
                    abilities: [
                        { action: 'auto', damage: 3000, hits: 30, crits: 3, misses: 10 },
                        { action: '/abilities/spike_shell', damage: 2000, hits: 0, crits: 0, misses: 0 },
                        { action: 'dot', damage: 1000, hits: 0, crits: 0, misses: 0 },
                    ],
                },
                {
                    name: 'Dps',
                    damage: 4000,
                    dps: 40,
                    abilities: [{ action: '/abilities/fireball', damage: 4000, hits: 20, crits: 5, misses: 0 }],
                },
            ],
            healing: {
                players: [
                    {
                        name: 'Healer',
                        healing: 900,
                        hps: 9,
                        abilities: [
                            { action: '/abilities/heal', healing: 600 },
                            { action: 'shared', healing: 300 },
                        ],
                    },
                ],
            },
        };
        opts.taken = {
            seconds: 100,
            players: [{ name: 'Tank', damage: 500, dps: 5, regen: 40, hps: 0.4 }],
            enemies: [
                { name: 'Eye', players: [{ name: 'Tank', damage: 300, hits: 3, min: 90, max: 110 }] },
                { name: 'Rat', players: [{ name: 'Tank', damage: 200, hits: 4, min: 40, max: 60 }] },
            ],
        };
    });

    afterEach(() => feature._resetTab());

    const row = (body, key) => body.querySelector(`[data-expand="${key}"]`);

    test('a click lists every ability on its own line and the list survives a repaint', () => {
        const body = board();
        expect(body.textContent).not.toContain('spike shell');
        expect(row(body, 'damage:Tank').getAttribute('aria-expanded')).toBe('false');

        row(body, 'damage:Tank').click();

        const text = body.textContent;
        expect(text).toContain('auto');
        expect(text).toContain('spike shell');
        expect(text).toContain('Damage over time');
        // Share of the player's own damage, and the swing figures where there is a swing
        expect(text).toContain('50.0%');
        expect(text).toContain('30 hits · 10% crit · 75% accuracy');
        expect(text).toContain('no swing behind it');
        expect(row(body, 'damage:Tank').getAttribute('aria-expanded')).toBe('true');
        // Only the row that was opened
        expect(text).not.toContain('fireball');

        // The panel's periodic repaint draws into the same body again
        drawBoard(body);
        expect(body.textContent).toContain('spike shell');
        expect(body.querySelector('[data-breakdown="damage:Tank"]')).not.toBeNull();
        expect(body.textContent).not.toContain('could not be drawn');
    });

    test('the keyboard opens and closes it too', () => {
        const body = board();
        row(body, 'damage:Dps').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(body.textContent).toContain('fireball');

        row(body, 'damage:Dps').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        expect(body.textContent).not.toContain('fireball');
        expect(row(body, 'damage:Dps').getAttribute('role')).toBe('button');
        expect(row(body, 'damage:Dps').getAttribute('tabindex')).toBe('0');
    });

    test('healing done opens into what each heal came from', () => {
        feature._setTab('healing');
        const body = board();
        row(body, 'healing:Healer').click();

        expect(body.textContent).toContain('heal');
        expect(body.textContent).toContain('Split — no caster on the tick');
        expect(body.textContent).toContain('66.7%');
    });

    test('taken opens into what hit them', () => {
        feature._setTab('taken');
        const body = board();
        row(body, 'taken:Tank').click();

        expect(body.textContent).toContain('Eye');
        expect(body.textContent).toContain('3 hits · 90–110 a hit');
        expect(body.textContent).toContain('Rat');
    });

    test('a row with nothing to break down is not offered as a button', () => {
        opts.dealt.healing.players.push({ name: 'Quiet', healing: 100, hps: 1, abilities: [] });
        feature._setTab('healing');
        const body = board();

        expect(body.textContent).toContain('Quiet');
        expect(body.querySelector('[data-expand="healing:Quiet"]')).toBeNull();
        expect(body.querySelector('[data-expand="healing:Healer"]')).not.toBeNull();
    });

    test('a taken row still opens into what hit them, with received and net on the row itself', () => {
        feature._setTab('taken');
        const body = board();
        expect(body.textContent).toContain('received 40 · net −460');
        row(body, 'taken:Tank').click();
        expect(body.textContent).toContain('3 hits · 90–110 a hit');
    });
});

const { buildCombatEntry } = await import('./combat-history.js');
const { saveHistoryEntry, _resetMeterHistory } = await import('./meter-history.js');
const { savedEntryText } = await import('./combat-dps-panel.js');

describe('saved sessions', () => {
    /** A finished run, as the recorder saves one */
    const savedRun = (zone = 'Swamp Planet', startedAt = 1000) =>
        buildCombatEntry(
            {
                at: startedAt + 130_000,
                zone,
                dealt: {
                    seconds: 120,
                    startedAt,
                    team: { damage: 10_000, unattributed: 0, filtered: 0 },
                    players: [
                        {
                            name: 'Tank',
                            damage: 6000,
                            dps: 50,
                            kills: 3,
                            abilities: [
                                { action: 'auto', damage: 4000, hits: 30, crits: 3, misses: 10 },
                                { action: '/abilities/spike_shell', damage: 2000, hits: 0, crits: 0, misses: 0 },
                            ],
                        },
                        { name: 'Dps', damage: 4000, dps: 33, abilities: [] },
                    ],
                    healing: { total: 900, players: [{ name: 'Healer', healing: 900, hps: 7.5, abilities: [] }] },
                },
                taken: {
                    seconds: 120,
                    players: [{ name: 'Tank', damage: 500, dps: 4, regen: 40, hps: 0.3 }],
                    enemies: [{ name: 'Eye', players: [{ name: 'Tank', damage: 500, hits: 5, min: 90, max: 110 }] }],
                },
                audit: null,
            },
            {
                bucketMs: 2000,
                keys: ['0'],
                names: { 0: 'Tank' },
                points: [
                    { t: 0, party: 40, players: { 0: 40 }, boss: false },
                    { t: 2000, party: 60, players: { 0: 60 }, boss: true },
                    { t: 4000, party: 50, players: { 0: 50 }, boss: false },
                ],
            }
        );

    const click = (body, selector) => body.querySelector(selector).click();

    beforeEach(() => {
        opts.stored = new Map();
        _resetMeterHistory();
        // What the trackers say now, which a saved board must not show
        opts.dealt = {
            seconds: 10,
            players: [{ name: 'LiveOne', damage: 50, dps: 5, abilities: [] }],
            // Set on the live run so the saved-session assertion below actually
            // proves something: the note has to be suppressed, not merely absent
            restored: { savedAt: 1000, at: new Date(2026, 0, 1, 12, 0).getTime() },
        };
        opts.taken = { seconds: 10, players: [] };
    });

    afterEach(() => feature._resetTab());

    test('History lists what was saved; one opens as the same board, read-only, on every tab', async () => {
        await saveHistoryEntry(savedRun(), 'default');
        const body = board();
        expect(body.textContent).toContain('LiveOne');
        expect(body.textContent).toContain('Continued after a page refresh at 12:00.');

        click(body, '[data-action="history"]');
        await vi.waitFor(() => expect(body.textContent).toContain('Swamp Planet'));
        expect(body.textContent).toContain('10.0K team damage');

        click(body, '[data-history-open]');
        await vi.waitFor(() => expect(body.querySelector('[data-history-banner]')).not.toBeNull());
        expect(body.textContent).toContain('Viewing saved session');
        expect(body.textContent).toContain('Tank');
        expect(body.textContent).not.toContain('LiveOne');
        // The saved snapshot is not what interrupted this session — the note
        // is the live board's alone, never drawn over a saved one
        expect(body.textContent).not.toContain('Continued after a page refresh');
        expect(body.textContent).toContain('3 kills');
        expect(body.querySelector('[data-dps-graph] svg')).not.toBeNull();
        expect(body.querySelector('[data-dps-graph] rect[data-band]')).not.toBeNull();

        // The per-ability rows open from the snapshot
        click(body, '[data-expand="damage:Tank"]');
        expect(body.textContent).toContain('spike shell');

        // Every tab draws from it, and the banner stays
        click(body, '[data-tab="taken"]');
        click(body, '[data-expand="taken:Tank"]');
        expect(body.textContent).toContain('Eye');
        expect(body.querySelector('[data-history-banner]')).not.toBeNull();
        click(body, '[data-tab="healing"]');
        expect(body.textContent).toContain('Healer');
        click(body, '[data-tab="damage"]');

        click(body, '[data-action="live"]');
        expect(body.querySelector('[data-history-banner]')).toBeNull();
        expect(body.textContent).toContain('LiveOne');
        expect(body.textContent).not.toContain('could not be drawn');
    });

    test('star, rename and delete from the list', async () => {
        await saveHistoryEntry(savedRun('Swamp Planet', 1000), 'default');
        await saveHistoryEntry(savedRun('Aqua Planet', 9000), 'default');
        const body = board();
        click(body, '[data-action="history"]');
        await vi.waitFor(() => expect(body.querySelectorAll('[data-history-row]')).toHaveLength(2));

        click(body, '[data-history-star="combat_1000"]');
        await vi.waitFor(() => expect(body.querySelector('[data-history-star="combat_1000"]').textContent).toBe('★'));

        click(body, '[data-history-rename="combat_9000"]');
        const input = body.querySelector('[data-history-label="combat_9000"]');
        input.value = 'Farm night';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await vi.waitFor(() => expect(body.textContent).toContain('Farm night'));

        click(body, '[data-history-delete="combat_1000"]');
        expect(body.querySelector('[data-history-delete="combat_1000"]').textContent).toBe('Delete?');
        click(body, '[data-history-delete="combat_1000"]');
        await vi.waitFor(() => expect(body.querySelectorAll('[data-history-row]')).toHaveLength(1));
        expect(body.textContent).not.toContain('could not be drawn');
    });

    test('a saved session copies as text: damage, healing done and taken', () => {
        const text = savedEntryText(savedRun(), { name: 'Farm night' });
        expect(text).toContain('Saved session — Farm night');
        expect(text).toContain('Party damage — 10,000 total');
        expect(text).toContain('1. Tank — 6,000');
        expect(text).toContain('Party healing done — 900 total');
        expect(text).toContain('Party damage taken — 500 total');
        expect(text).toContain('received 40 · net −460');
        expect(text).toContain('Healing received: 40');
    });

    test('a session saved before strict healing, viewed from the Healed tab, opens on Taken and Healing done', async () => {
        // Its healing rows carry the retired split and no-cast labels, and it has no uncredited figure
        const old = savedRun('Old Swamp', 5000);
        old.dealt.healing = {
            total: 900,
            regen: 120,
            revived: 0,
            shared: 300,
            players: [
                {
                    name: 'Healer',
                    healing: 900,
                    hps: 7.5,
                    abilities: [
                        { action: '/abilities/heal', healing: 400 },
                        { action: 'shared', healing: 300 },
                        { action: 'other', healing: 200 },
                    ],
                },
            ],
        };
        await saveHistoryEntry(old, 'default');
        feature._setTab('healed');
        const body = board();
        click(body, '[data-action="history"]');
        await vi.waitFor(() => expect(body.textContent).toContain('Old Swamp'));
        click(body, '[data-history-open]');
        await vi.waitFor(() => expect(body.querySelector('[data-history-banner]')).not.toBeNull());

        expect(body.querySelector('[data-tab="taken"]')).not.toBeNull();
        expect(body.textContent).toContain('Healing received: 40 · Net: −460');

        click(body, '[data-tab="healing"]');
        click(body, '[data-expand="healing:Healer"]');
        expect(body.textContent).toContain('Split — no caster on the tick');
        expect(body.textContent).toContain('No cast on the tick');
        expect(body.textContent).toContain('Not from a cast — regeneration, food, unexplained: 120');
        expect(body.textContent).not.toContain('could not be drawn');
        expect(savedEntryText(old)).toContain('Party healing done — 900 total');
    });

    test('with the setting off the live board offers no History', () => {
        opts.enabled = false;
        expect(board().querySelector('[data-action="history"]')).toBeNull();
    });
});
