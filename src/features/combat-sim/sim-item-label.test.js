/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetSpriteSheetCache } from '../../utils/overlay-format.js';
import { simItemLabelHtml, simCandidateLabelHtml } from './sim-item-label.js';

vi.mock('../../core/data-manager.js', () => ({ default: { getItemDetails: () => null } }));
const sheet = '/static/media/items_sprite.current.svg';
function render(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
}
function ids(host) {
    return [...host.querySelectorAll('[data-sim-item-icon]')].map((icon) => icon.dataset.simItemIcon);
}
beforeEach(() => {
    resetSpriteSheetCache();
    document.body.innerHTML = `<svg><use xlink:href="${sheet}#coin"></use></svg>`;
});
afterEach(() => {
    document.body.innerHTML = '';
    resetSpriteSheetCache();
});

describe('sim item labels', () => {
    test('reuses the hashed game sprite from an xlink-only icon and keeps a translated label', () => {
        const host = render(simItemLabelHtml('/items/cheese', '奶酪 +12'));
        expect(host.textContent).toBe('奶酪 +12');
        expect(host.querySelector('use').getAttribute('href')).toBe(`${sheet}#cheese`);
        expect(host.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
        expect(host.querySelector('svg').getAttribute('focusable')).toBe('false');
    });

    test('keeps a spacer before assets arrive and resolves artwork on the next render', () => {
        document.body.innerHTML = '';
        const first = render(simItemLabelHtml('/items/cheese', 'Cheese'));
        expect(first.textContent).toBe('Cheese');
        expect(first.querySelector('svg')).toBeNull();
        expect(first.querySelector('[data-sim-item-icon]').style.width).toBe('18px');
        document.body.innerHTML = `<svg><use href="${sheet}#coin"></use></svg>`;
        expect(render(simItemLabelHtml('/items/cheese', 'Cheese')).querySelector('use')).not.toBeNull();
    });

    test.each([null, '', '/abilities/fireball', '/items/cheese"><img src=x onerror=alert(1)>'])(
        'never invents an item for %s',
        (hrid) => {
            const host = render(simItemLabelHtml(hrid, '<img src=x> & Empty'));
            expect(host.textContent).toBe('<img src=x> & Empty');
            expect(host.children).toHaveLength(0);
        }
    );

    test('an unknown but valid item retains its label and identity without needing a name lookup', () => {
        const host = render(simItemLabelHtml('/items/new_item', 'new_item'));
        expect(ids(host)).toEqual(['/items/new_item']);
        expect(host.textContent).toBe('new_item');
    });
});

describe('upgrade descriptions', () => {
    const items = {
        '/items/sword': { name: 'Sword' },
        '/items/sword_star': { name: 'Sword ★' },
        '/items/shield': { name: 'Shield' },
        '/items/long_sword': { name: 'Long Sword' },
    };
    test('icons follow every piece of a multi-slot swap with nonzero levels, without mutating the candidate', () => {
        const candidate = {
            currentHrid: '/items/long_sword',
            upgradeHrid: '/items/sword_star',
            removedItems: [{ hrid: '/items/long_sword', enhancementLevel: 12 }],
            addedSlots: {
                '/equipment_types/main_hand': { hrid: '/items/sword_star', enhancementLevel: 12 },
                '/equipment_types/off_hand': { hrid: '/items/shield', enhancementLevel: 9 },
            },
            description: 'Long Sword +12 → Sword ★ +12 + Shield +9 (attack)',
        };
        const original = structuredClone(candidate);
        const host = render(simCandidateLabelHtml(candidate, items));
        expect(host.textContent).toBe(candidate.description);
        expect(ids(host)).toEqual(['/items/long_sword', '/items/sword_star', '/items/shield']);
        expect(candidate).toEqual(original);
    });

    test('same-named items on opposite sides retain their identities', () => {
        const host = render(
            simCandidateLabelHtml(
                {
                    currentHrid: '/items/sword',
                    upgradeHrid: '/items/sword_star',
                    description: 'Sword +7 → Sword +9',
                },
                { ...items, '/items/sword_star': { name: 'Sword' } }
            )
        );
        expect(ids(host)).toEqual(['/items/sword', '/items/sword_star']);
    });

    test('repeated copies stay repeated and longest item names win', () => {
        const candidate = {
            currentHrid: '/items/sword',
            upgradeHrid: '/items/sword_star',
            removedItems: [{ hrid: '/items/sword_star' }],
            description: 'Sword +3 / Sword +5 / Sword ★ +7 → Sword ★ +9',
        };
        expect(ids(render(simCandidateLabelHtml(candidate, items)))).toEqual([
            '/items/sword',
            '/items/sword',
            '/items/sword_star',
            '/items/sword_star',
        ]);
    });

    test('unknown metadata uses the raw HRID slug and text never becomes markup', () => {
        const text = 'Add new_item <img src=x> & more';
        const host = render(simCandidateLabelHtml({ upgradeHrid: '/items/new_item', description: text }, {}));
        expect(host.textContent).toBe(text);
        expect(ids(host)).toEqual(['/items/new_item']);
        expect(host.querySelector('img')).toBeNull();
    });

    test('non-item, empty, stopped and unpriced descriptions stay readable without an icon', () => {
        for (const description of ['', 'Attack 100 → 101', 'No upgrades found', 'Stopped', 'Cost unknown']) {
            const host = render(simCandidateLabelHtml({ description }, items));
            expect(host.textContent).toBe(description);
            expect(ids(host)).toEqual([]);
        }
        expect(simCandidateLabelHtml(null, items)).toBe('');
    });
});
