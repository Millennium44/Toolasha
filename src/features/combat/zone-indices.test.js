/** @vitest-environment happy-dom
 *
 * The task-index span must only touch the DOM when something changed. The
 * old always-remove-then-reinsert pass was its own mutation source: the
 * observer fired on the reinsert, which reinserted, forever — and every
 * cycle yanked a React-owned node out from under a pending click.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: {
        SCRIPT_COLOR_MAIN: '#8bc34a',
        getSetting: () => true,
        onSettingChange: () => {},
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => null } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { register: () => () => {} } }));

import zoneIndices from './zone-indices.js';

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
