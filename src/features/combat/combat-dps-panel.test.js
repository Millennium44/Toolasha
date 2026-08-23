/** @vitest-environment happy-dom
 *
 * The per-player panel for a normal fight.
 *
 * What is worth asserting is which tracker feeds which tab and what each tab
 * claims about its figures — the drawing itself belongs to `damage-board.js`
 * and is tested there. The third tab is the one to watch: it ranks health
 * *restored*, which is not healing done, and a panel that let that read as a
 * healer's scoreboard would be inventing an attribution the run feed cannot
 * make.
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
    panelRows,
    panelText,
    drawBoard,
    getPanel,
    default: feature,
} = await import('./combat-dps-panel.js');

const { newRotationState, noteRotationKit, noteRotationFight, foldRotationTick, summariseRotation } =
    await import('../../utils/rotation-audit.js');

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

    test('healed ranks health restored, not damage', () => {
        const { rows } = panelRows('healed');

        expect(rows[0]).toMatchObject({ name: 'Alice', value: 900, perSecond: 9 });
        expect(rows[1].value).toBe(100);
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
        expect(text).toContain('shared between them');
        expect(text).toContain('Alice');
    });

    test('the healed tab refuses to read as a healer’s scoreboard', () => {
        const body = board();
        [...body.querySelectorAll('[data-tab]')].find((tab) => tab.dataset.tab === 'healed').click();

        const text = body.textContent;
        expect(text).toContain('received, not healing done');
        // The absent thing said outright rather than left to be inferred
        expect(text).toContain('no caster to credit');
    });

    test('the taken tab says its figure is a floor, not the game’s own', () => {
        const body = board();
        [...body.querySelectorAll('[data-tab]')].find((tab) => tab.dataset.tab === 'taken').click();

        expect(body.textContent).toContain('after mitigation');
        expect(body.textContent).toContain('floor');
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

    test('is a tab of its own, after the party ones', () => {
        expect(TABS.map((entry) => entry.key)).toEqual(['damage', 'taken', 'healed', 'rotation']);
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
