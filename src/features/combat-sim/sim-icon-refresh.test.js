/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import domObserver from '../../core/dom-observer.js';
import { resetSpriteSheetCache } from '../../utils/overlay-format.js';
import { simEntityLabelHtml } from './sim-entity-label.js';
import { watchSimIconRefresh, registerSimIconPopup } from './sim-icon-refresh.js';

vi.mock('../../utils/performance-monitor.js', () => ({ default: { enabled: false } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => ({}) } }));

const stops = [];
const pending = '[data-sim-icon-pending]';
function panel(html = '') {
    const node = document.createElement('section');
    node.innerHTML = html;
    document.body.append(node);
    return node;
}
function watch(node) {
    const stop = watchSimIconRefresh(node);
    stops.push(stop);
    return stop;
}
function source(sheet, { xlink = false, nested = false } = {}) {
    const node = document.createElement('div');
    node.innerHTML = `<svg><use ${xlink ? 'xlink:href' : 'href'}="/static/media/${sheet}_sprite.late.svg#seed"></use></svg>`;
    document.body.append(node);
    domObserver.dispatch(nested ? node : node.querySelector('use'));
    return node;
}
async function settle() {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    document.body.replaceChildren();
    resetSpriteSheetCache();
});
afterEach(async () => {
    domObserver.stop();
    for (const stop of stops.splice(0)) stop();
    await settle();
    document.body.replaceChildren();
    resetSpriteSheetCache();
    vi.restoreAllMocks();
});

describe('simulator late sprite refresh', () => {
    test('the real shared observer hydrates native sheet insertions without a manual redraw', async () => {
        const host = panel(simEntityLabelHtml('/abilities/heal', 'Heal'));
        domObserver.start();
        watch(host);
        const native = document.createElement('div');
        native.innerHTML = '<svg><use href="/static/media/abilities_sprite.native.svg#water_strike"></use></svg>';
        document.body.append(native);
        await settle();
        expect(host.querySelector('use')?.getAttribute('href')).toBe('/static/media/abilities_sprite.native.svg#heal');
    });

    test('hydrates already-mounted ability rows after native Combat inserts its sheet, preserving edits and focus', async () => {
        const host = panel(
            [
                simEntityLabelHtml('/abilities/water_strike', 'Water Strike L75'),
                simEntityLabelHtml('/abilities/water_strike', '同名技能 L1'),
                simEntityLabelHtml('/abilities/ice_spear', '同名技能 L90'),
                '<input type="number" value="75"><button>Run</button>',
            ].join('')
        );
        expect(host.querySelectorAll(pending)).toHaveLength(3);
        const level = host.querySelector('input');
        level.value = '91';
        level.focus();
        const onRun = vi.fn();
        host.querySelector('button').addEventListener('click', onRun);
        const text = host.textContent;
        watch(host);
        source('abilities', { xlink: true, nested: true });
        await settle();
        expect(host.querySelectorAll(pending)).toHaveLength(0);
        expect([...host.querySelectorAll('use')].map((use) => use.getAttribute('href'))).toEqual([
            '/static/media/abilities_sprite.late.svg#water_strike',
            '/static/media/abilities_sprite.late.svg#water_strike',
            '/static/media/abilities_sprite.late.svg#ice_spear',
        ]);
        expect(host.textContent).toBe(text);
        expect(host.querySelector('input')).toBe(level);
        expect(level.value).toBe('91');
        expect(document.activeElement).toBe(level);
        host.querySelector('button').click();
        expect(onRun).toHaveBeenCalledOnce();
    });

    test('notices an editor rendered asynchronously after opening, then its late sheet', async () => {
        const host = panel();
        watch(host);
        host.innerHTML = simEntityLabelHtml('/abilities/ice_spear', 'Ice Spear');
        domObserver.dispatch(host.firstElementChild);
        await settle();
        source('abilities');
        await settle();
        expect(host.querySelector('use')?.getAttribute('href')).toBe(
            '/static/media/abilities_sprite.late.svg#ice_spear'
        );
    });

    test('one existing observer subscription serves both panels and batches an insertion burst', async () => {
        const register = vi.spyOn(domObserver, 'register');
        const start = vi.spyOn(domObserver, 'start');
        const one = panel(simEntityLabelHtml('/abilities/heal', 'Heal'));
        const two = panel(simEntityLabelHtml('/abilities/ice_spear', 'Ice Spear'));
        watch(one);
        watch(two);
        const scan = vi.spyOn(one, 'querySelectorAll');
        source('abilities');
        source('abilities');
        source('abilities');
        await settle();
        expect(register).toHaveBeenCalledTimes(1);
        expect(start).not.toHaveBeenCalled();
        expect(scan).toHaveBeenCalledTimes(1);
        expect(one.querySelector('use')).not.toBeNull();
        expect(two.querySelector('use')).not.toBeNull();
    });

    test('hydrates each sheet separately without replacing finished icons or scanning for unrelated changes', async () => {
        const host = panel(
            simEntityLabelHtml('/abilities/heal', 'Heal') + simEntityLabelHtml('/items/cheese', 'Cheese')
        );
        watch(host);
        source('abilities');
        await settle();
        expect(host.querySelectorAll(pending)).toHaveLength(1);
        const abilityIcon = host.querySelector('svg');
        const scan = vi.spyOn(host, 'querySelectorAll');
        const unrelated = document.createElement('div');
        unrelated.innerHTML = '<span>Still waiting</span>';
        document.body.append(unrelated);
        domObserver.dispatch(unrelated);
        source('skills');
        await settle();
        expect(scan).not.toHaveBeenCalled();
        source('items', { xlink: true });
        await settle();
        expect(host.querySelectorAll(pending)).toHaveLength(0);
        expect(host.querySelector('svg')).toBe(abilityIcon);
        expect(host.querySelector('[data-sim-item-icon] use').getAttribute('href')).toBe(
            '/static/media/items_sprite.late.svg#cheese'
        );
    });

    test('closing before a queued refresh skips that panel while another stays active', async () => {
        const one = panel(simEntityLabelHtml('/abilities/heal', 'Heal'));
        const two = panel(simEntityLabelHtml('/abilities/ice_spear', 'Ice Spear'));
        const stopOne = watch(one);
        const stopTwo = watch(two);
        source('abilities');
        stopOne();
        stopOne();
        one.style.display = 'none';
        await settle();
        expect(one.querySelector(pending)).not.toBeNull();
        expect(two.querySelector('use')).not.toBeNull();
        expect(domObserver.handlers.filter((handler) => handler.name === 'sim-icon-refresh')).toHaveLength(1);
        stopTwo();
        expect(domObserver.handlers.filter((handler) => handler.name === 'sim-icon-refresh')).toHaveLength(0);
    });

    test('reopening catches a sheet loaded while hidden and later teardown prevents queued work', async () => {
        const host = panel(simEntityLabelHtml('/abilities/heal', 'Heal'));
        const stop = watch(host);
        stop();
        host.style.display = 'none';
        source('abilities');
        await settle();
        expect(host.querySelector(pending)).not.toBeNull();
        host.style.display = 'flex';
        watch(host);
        expect(host.querySelector(pending)).toBeNull();
        expect(host.querySelector('use')).not.toBeNull();
        host.innerHTML = simEntityLabelHtml('/items/cheese', 'Cheese');
        domObserver.dispatch(host.firstElementChild);
        host.remove();
        await settle();
        source('items');
        await settle();
        expect(host.querySelector(pending)).not.toBeNull();
    });

    test('does not modify unowned labels and leaves missing sheets as readable spacers', async () => {
        const owned = panel(simEntityLabelHtml('/abilities/heal', 'Heal'));
        const unowned = panel(simEntityLabelHtml('/abilities/heal', 'Unowned Heal'));
        watch(owned);
        source('skills');
        await settle();
        expect(owned.textContent).toBe('Heal');
        expect(owned.querySelector(pending).style.width).toBe('18px');
        source('abilities');
        await settle();
        expect(owned.querySelector('use')).not.toBeNull();
        expect(unowned.querySelector(pending)).not.toBeNull();
    });
});

describe('simulator popup sprite ownership', () => {
    function popup(owner, html) {
        const node = panel(html);
        registerSimIconPopup(node, owner);
        return node;
    }

    test('hydrates owned body portals and their panel, but not another or unowned editor', async () => {
        const one = panel(simEntityLabelHtml('/abilities/heal', 'Panel heal'));
        const editor = document.createElement('div');
        one.append(editor);
        watch(one);
        const owned = popup(editor, simEntityLabelHtml('/abilities/ice_spear', 'Picker ice'));
        const otherPanel = panel();
        const other = popup(otherPanel, simEntityLabelHtml('/abilities/heal', 'Other editor'));
        const unowned = panel(simEntityLabelHtml('/abilities/heal', 'Unowned'));
        unowned.setAttribute('data-sim-icon-popup', '');
        await settle();
        source('abilities');
        await settle();
        expect(one.querySelectorAll('use')).toHaveLength(1);
        expect(owned.querySelectorAll('use')).toHaveLength(1);
        expect(owned.querySelector(pending)).toBeNull();
        expect(other.querySelector(pending)).not.toBeNull();
        expect(unowned.querySelector(pending)).not.toBeNull();
    });

    test('notices popup-only sheets and late filtered rows without another panel render', async () => {
        const owner = panel();
        watch(owner);
        const owned = popup(owner, simEntityLabelHtml('/items/cheese', 'Cheese'));
        await settle();
        owned.innerHTML = simEntityLabelHtml('/abilities/heal', 'Heal');
        domObserver.dispatch(owned.firstElementChild);
        await settle();
        source('abilities', { xlink: true });
        await settle();
        expect(owned.querySelector('use')?.getAttribute('href')).toBe('/static/media/abilities_sprite.late.svg#heal');
    });

    test('popup removal and owner hide/destroy invalidate queued work; reused IDs do not transfer ownership', async () => {
        const owner = panel();
        owner.id = 'same-panel';
        const stop = watch(owner);
        const removed = popup(owner, simEntityLabelHtml('/abilities/heal', 'Removed popup'));
        const lingering = popup(owner, simEntityLabelHtml('/abilities/heal', 'Old owner popup'));
        removed.remove();
        await settle();
        source('abilities');
        stop();
        owner.remove();
        const replacement = panel();
        replacement.id = 'same-panel';
        watch(replacement);
        await settle();
        expect(removed.querySelector(pending)).not.toBeNull();
        expect(lingering.querySelector(pending)).not.toBeNull();
        expect(domObserver.handlers.filter((handler) => handler.name === 'sim-icon-refresh')).toHaveLength(1);
    });

    test('reopening the same owner catches portal art loaded while hidden without altering popup controls', async () => {
        const owner = panel();
        const stop = watch(owner);
        const owned = popup(owner, simEntityLabelHtml('/abilities/heal', 'Heal') + '<input value="75">');
        const input = owned.querySelector('input');
        input.value = '91';
        await settle();
        stop();
        owner.style.display = 'none';
        source('abilities');
        await settle();
        expect(owned.querySelector(pending)).not.toBeNull();
        owner.style.display = 'flex';
        watch(owner);
        expect(owned.querySelector(pending)).toBeNull();
        expect(owned.querySelector('input')).toBe(input);
        expect(input.value).toBe('91');
    });
});
