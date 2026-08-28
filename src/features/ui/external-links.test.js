/** @vitest-environment happy-dom
 *
 * The external tool links in the minor nav each name a real destination, but
 * the label is the tool's own name ("Milkonomy", "mwilinks") which says
 * nothing about it leaving milkywayidle.com. The tooltip is what discloses
 * that before the click does.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, COLOR_ACCENT: '#fff' } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../combat/combat-sim-targets.js', () => ({
    COMBAT_SIM_TARGETS: [{ id: 'test-sim', label: 'Test Sim', url: 'https://sim.example.com/import' }],
}));

const externalLinks = (await import('./external-links.js')).default;

beforeEach(() => {
    document.body.innerHTML = '';
});

/** A bare stand-in for the minor-nav container the game renders */
function navContainer() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

describe('external link tooltips', () => {
    test('each link says which site it opens', () => {
        const container = navContainer();
        externalLinks.addLinks(container);

        const links = [...container.querySelectorAll('.mwi-external-link')];
        expect(links.length).toBeGreaterThan(0);
        for (const link of links) {
            expect(link.title).toMatch(/^Opens .+ in a new tab\.$/);
        }
    });

    test('names the actual host, not just "a new tab"', () => {
        const container = navContainer();
        externalLinks.addLinks(container);

        const milkonomy = [...container.querySelectorAll('.mwi-external-link')].find(
            (link) => link.textContent === 'Milkonomy'
        );
        expect(milkonomy.title).toBe('Opens hyhfish.github.io in a new tab.');
    });

    test('a combat sim target from the shared list gets a tooltip too', () => {
        const container = navContainer();
        externalLinks.addLinks(container);

        const sim = [...container.querySelectorAll('.mwi-external-link')].find(
            (link) => link.textContent === 'Test Sim'
        );
        expect(sim.title).toBe('Opens sim.example.com in a new tab.');
    });

    test('a link that will not parse as a URL still gets a tooltip, not a thrown error', () => {
        expect(externalLinks.hostnameOf('not a url')).toBe('not a url');
    });
});
