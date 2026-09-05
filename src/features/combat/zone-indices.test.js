/** @vitest-environment happy-dom
 *
 * The task-index span must only touch the DOM when something changed. The
 * old always-remove-then-reinsert pass was its own mutation source: the
 * observer fired on the reinsert, which reinserted, forever — and every
 * cycle yanked a React-owned node out from under a pending click.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: {
        SCRIPT_COLOR_MAIN: '#8bc34a',
        getSetting: () => true,
        onSettingChange: () => {},
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => null } }));
vi.mock('../../core/dom-observer.js', () => ({
    default: { register: () => () => {}, onClass: () => () => {}, onReady: () => () => {} },
}));
vi.mock('../../core/websocket.js', () => {
    const handlers = new Map();
    return {
        default: {
            on: (type, fn) => {
                if (!handlers.has(type)) handlers.set(type, new Set());
                handlers.get(type).add(fn);
            },
            off: (type, fn) => handlers.get(type)?.delete(fn),
            _emit: (type, data) => {
                for (const fn of handlers.get(type) ?? []) fn(data);
            },
            _count: (type) => handlers.get(type)?.size ?? 0,
        },
    };
});

import zoneIndices from './zone-indices.js';
import webSocketHook from '../../core/websocket.js';

/** A task card name element as the game draws it. */
function nameEl(text) {
    const el = document.createElement('div');
    el.className = 'RandomTask_name_x';
    el.textContent = text;
    document.body.appendChild(el);
    return el;
}

describe('addTaskIndices', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        zoneIndices.monsterZoneCache = new Map([
            ['jerry', 3],
            ['sherlock', 2],
        ]);
    });

    it('adds the zone index to a combat task once', () => {
        const el = nameEl('Defeat - Jerry');
        zoneIndices.addTaskIndices();
        expect(el.querySelector('span.script_taskMapIndex').textContent).toBe('Z3');
    });

    it('a second pass changes nothing — same node, no churn', () => {
        const el = nameEl('Defeat - Jerry');
        zoneIndices.addTaskIndices();
        const span = el.querySelector('span.script_taskMapIndex');
        zoneIndices.addTaskIndices();
        expect(el.querySelectorAll('span.script_taskMapIndex')).toHaveLength(1);
        expect(el.querySelector('span.script_taskMapIndex')).toBe(span);
    });

    it('its own span never feeds back into the monster-name parse', () => {
        const el = nameEl('Defeat - Jerry');
        zoneIndices.addTaskIndices();
        zoneIndices.addTaskIndices();
        // "Jerry Z3" would miss the cache and remove the index
        expect(el.querySelector('span.script_taskMapIndex').textContent).toBe('Z3');
    });

    it('a rerolled task gets its index replaced', () => {
        const el = nameEl('Defeat - Jerry');
        zoneIndices.addTaskIndices();
        el.childNodes[0].textContent = 'Defeat - Sherlock';
        zoneIndices.addTaskIndices();
        expect(el.querySelector('span.script_taskMapIndex').textContent).toBe('Z2');
        expect(el.querySelectorAll('span.script_taskMapIndex')).toHaveLength(1);
    });

    it('a non-combat task gets no span, and loses a stale one', () => {
        const el = nameEl('Defeat - Jerry');
        zoneIndices.addTaskIndices();
        el.childNodes[0].textContent = 'Tailoring - Linen Hat';
        zoneIndices.addTaskIndices();
        expect(el.querySelector('span.script_taskMapIndex')).toBeNull();
    });

    it('an unknown monster gets no span', () => {
        const el = nameEl('Kill - Unmapped Beast');
        zoneIndices.addTaskIndices();
        expect(el.querySelector('span.script_taskMapIndex')).toBeNull();
    });
});

describe('addMapIndices', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    // The selector's last segment is `span.MuiBadge-root` — the code's
    // `buttons` collection is actually these badge spans, and the label is
    // inserted into the badge itself (`button.insertAdjacentHTML(...)` where
    // `button` is one of these spans), not into the enclosing <button>.
    /** One combat-zone tab, in the DOM shape the selector/insert targets. */
    function zoneBadge() {
        const button = document.createElement('button');
        button.className = 'MuiButtonBase-root MuiTab-root';
        const badge = document.createElement('span');
        badge.className = 'MuiBadge-root';
        button.appendChild(badge);
        return badge;
    }

    /** The wrapper chain the selector requires, holding the given badges. */
    function tabPanel(badges) {
        const outer = document.createElement('div');
        outer.className = 'MainPanel_subPanelContainer__1i-H9';
        const mid = document.createElement('div');
        mid.className = 'CombatPanel_tabsComponentContainer__GsQlg';
        const tabs = document.createElement('div');
        tabs.className = 'MuiTabs-root MuiTabs-vertical';
        for (const badge of badges) tabs.appendChild(badge.closest('button'));
        mid.appendChild(tabs);
        outer.appendChild(mid);
        document.body.appendChild(outer);
        return outer;
    }

    it('numbers every zone tab in order', () => {
        const badges = [zoneBadge(), zoneBadge(), zoneBadge()];
        tabPanel(badges);
        zoneIndices.addMapIndices();
        const labels = badges.map((b) => b.querySelector('span.script_mapIndex').textContent);
        expect(labels).toEqual(['1. ', '2. ', '3. ']);
    });

    it('a re-render that appends a new tab after already-labelled ones numbers it by position, not by how many are new', () => {
        // Two zones already labelled from an earlier pass (their DOM nodes
        // survived the re-render, spans and all); a third zone just appeared
        // at the end with no span yet — the shape the observer sees when the
        // game adds a zone tab mid-session.
        const already1 = zoneBadge();
        already1.insertAdjacentHTML('afterbegin', '<span class="script_mapIndex">1. </span>');
        const already2 = zoneBadge();
        already2.insertAdjacentHTML('afterbegin', '<span class="script_mapIndex">2. </span>');
        const fresh = zoneBadge();
        tabPanel([already1, already2, fresh]);

        zoneIndices.addMapIndices();

        // The new tab is third in the row — it must read "3.", not repeat "1."
        expect(fresh.querySelector('span.script_mapIndex').textContent).toBe('3. ');
    });
});

describe('quests_updated', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        zoneIndices.disable();
        zoneIndices.initialize();
        zoneIndices.monsterZoneCache = new Map([
            ['jerry', 3],
            ['sherlock', 2],
        ]);
    });

    afterEach(() => {
        zoneIndices.disable();
        vi.useRealTimers();
    });

    // The regression: a reroll rewrites the card's text in place, so no node
    // carrying a watched class is inserted and the class-filtered shared
    // observer never re-fires. Nothing here touches childList.
    it('relabels a rerolled card with no DOM insertion at all', () => {
        vi.useFakeTimers();
        const el = nameEl('Defeat - Jerry');
        zoneIndices.addTaskIndices();
        expect(el.querySelector('span.script_taskMapIndex').textContent).toBe('Z3');

        el.childNodes[0].textContent = 'Defeat - Sherlock';
        webSocketHook._emit('quests_updated', {});
        vi.advanceTimersByTime(2000);

        expect(el.querySelector('span.script_taskMapIndex').textContent).toBe('Z2');
        expect(el.querySelectorAll('span.script_taskMapIndex')).toHaveLength(1);
    });

    it('does not relabel at event time — the game has not redrawn yet', () => {
        vi.useFakeTimers();
        const el = nameEl('Defeat - Jerry');
        zoneIndices.addTaskIndices();

        webSocketHook._emit('quests_updated', {});
        // The card still reads the old name at this point, exactly as it does
        // in the game; relabelling now would just rewrite Z3.
        expect(el.querySelector('span.script_taskMapIndex').textContent).toBe('Z3');
        el.childNodes[0].textContent = 'Defeat - Sherlock';
        vi.advanceTimersByTime(250);
        expect(el.querySelector('span.script_taskMapIndex').textContent).toBe('Z2');
    });

    it('unsubscribes and drops pending passes on disable', () => {
        vi.useFakeTimers();
        const el = nameEl('Defeat - Jerry');
        zoneIndices.addTaskIndices();

        webSocketHook._emit('quests_updated', {});
        zoneIndices.disable();
        expect(webSocketHook._count('quests_updated')).toBe(0);

        el.textContent = 'Defeat - Sherlock';
        vi.advanceTimersByTime(2000);
        expect(el.querySelector('span.script_taskMapIndex')).toBeNull();
    });
});
