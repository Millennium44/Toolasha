/** @vitest-environment happy-dom */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseTrialStatsModal, headerKey, guildTrialStatsModal, linkMemberNames } from './guild-trial-stats-modal.js';

// The shared profile opener — the one game action a name click is allowed to
// perform. Mocked so the tests can assert it is the mechanism reused, without
// needing the game's React core.
const profile = vi.hoisted(() => ({ opened: [] }));
vi.mock('../../utils/profile-command.js', () => ({
    openPlayerProfile: (name, options) => {
        profile.opened.push({ name, options });
        return true;
    },
    VALID_PLAYER_NAME_RE: /^[A-Za-z0-9_]+$/,
}));
// The observer is driven by hand, the way the other guild feature tests drive it
const observers = vi.hoisted(() => ({ byClass: {} }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (id, className, callback) => {
            observers.byClass[className] = callback;
            return () => delete observers.byClass[className];
        },
    },
}));

// The real "Combat Trial - Stats" modal, captured from the game (Jellyfish tab
// active, Swarm tab hidden and empty). Abbreviated figures, data-name on the
// member cell, three value columns in header order.
const MODAL_HTML = `
<div class="GuildPanel_trialStatsModal__2yLP_">
  <div class="GuildPanel_name__3U6Th">Combat Trial - Stats</div>
  <div class="GuildPanel_trialStatsTabsContainer__3rN3r">
    <div class="TabsComponent_tabsComponent__3PqGp"><div class="MuiTabs-flexContainer" role="tablist">
      <button role="tab" aria-selected="true"><span class="TabsComponent_badge__1Du26">Trial Jellyfish</span></button>
      <button role="tab" aria-selected="false"><span class="TabsComponent_badge__1Du26">Trial Swarm</span></button>
    </div></div>
    <div class="TabsComponent_tabPanelsContainer__26mzo">
      <div class="TabPanel_tabPanel__tXMJF"><div class="GuildPanel_trialStatsPanel__3eYMs">
        <div class="GuildPanel_trialStatsTableContainer__3eefO">
          <table class="GuildPanel_trialStatsTable__1SDKf">
            <thead><tr><th class="GuildPanel_member__1scjk">Member</th><th>Damage</th><th>Healing</th><th>Damage Taken</th></tr></thead>
            <tbody>
              <tr><td class="GuildPanel_member__1scjk"><div class="CharacterName_characterName__2FqyZ"><div class="CharacterName_name__1amXp CharacterName_coral__2HCZw" data-name="Tib"><span>Tib</span></div></div></td><td><div>1213K</div></td><td><div>0</div></td><td><div>175K</div></td></tr>
              <tr><td class="GuildPanel_member__1scjk"><div class="CharacterName_characterName__2FqyZ"><div class="CharacterName_name__1amXp" data-name="chocstest"><span>chocstest</span></div></div></td><td><div>584K</div></td><td><div>0</div></td><td><div>167K</div></td></tr>
              <tr><td class="GuildPanel_member__1scjk"><div class="CharacterName_characterName__2FqyZ"><div class="CharacterName_name__1amXp" data-name="Orven"><span>Orven</span></div></div></td><td><div>318K</div></td><td><div>64577</div></td><td><div>174K</div></td></tr>
              <tr><td class="GuildPanel_member__1scjk"><div class="CharacterName_characterName__2FqyZ"><div class="CharacterName_name__1amXp CharacterName_coral__2HCZw" data-name="MillenniumTest"><span>MillenniumTest</span></div></div></td><td><div>288K</div></td><td><div>0</div></td><td><div>372K</div></td></tr>
            </tbody>
          </table>
        </div>
      </div></div>
      <div class="TabPanel_tabPanel__tXMJF TabPanel_hidden__26UM3"><div></div></div>
    </div>
  </div>
</div>`;

// The skilling stats modal draws a single contribution column, not the combat
// Damage/Healing/Damage-Taken trio — the scraper must read its header, not assume.
const SKILLING_HTML = `
<div class="GuildPanel_trialStatsModal__2yLP_">
  <div class="GuildPanel_trialStatsTabsContainer__3rN3r"><div role="tablist">
    <button role="tab" aria-selected="true"><span class="TabsComponent_badge__1Du26">Enhancing</span></button>
  </div>
  <div class="TabsComponent_tabPanelsContainer__26mzo"><div class="TabPanel_tabPanel__tXMJF">
    <table class="GuildPanel_trialStatsTable__1SDKf">
      <thead><tr><th class="GuildPanel_member__1scjk">Member</th><th>Work</th></tr></thead>
      <tbody>
        <tr><td class="GuildPanel_member__1scjk"><div class="CharacterName_name__1amXp" data-name="MillenniumTest"><span>MillenniumTest</span></div></td><td><div>124K</div></td></tr>
        <tr><td class="GuildPanel_member__1scjk"><div class="CharacterName_name__1amXp" data-name="Orven"><span>Orven</span></div></td><td><div>68376</div></td></tr>
      </tbody>
    </table>
  </div></div></div>
</div>`;

function modalEl(html = MODAL_HTML) {
    const host = document.createElement('div');
    host.innerHTML = html.trim();
    return host.firstElementChild;
}

describe('headerKey', () => {
    test('normalises the combat columns and slugs anything else', () => {
        expect(headerKey('Member')).toBe('member');
        expect(headerKey('Damage')).toBe('damage');
        expect(headerKey('Healing')).toBe('healing');
        expect(headerKey('Damage Taken')).toBe('damageTaken');
        expect(headerKey('Work')).toBe('work');
    });
});

describe('parseTrialStatsModal', () => {
    test('reads the active tab name and every member row, keyed by header, abbreviations expanded', () => {
        const parsed = parseTrialStatsModal(modalEl());
        expect(parsed.trialName).toBe('Trial Jellyfish');
        expect(parsed.kind).toBe('combat');
        expect(parsed.columns).toEqual(['damage', 'healing', 'damageTaken']);
        expect(parsed.members).toEqual([
            { name: 'Tib', values: { damage: 1_213_000, healing: 0, damageTaken: 175_000 } },
            { name: 'chocstest', values: { damage: 584_000, healing: 0, damageTaken: 167_000 } },
            { name: 'Orven', values: { damage: 318_000, healing: 64_577, damageTaken: 174_000 } },
            { name: 'MillenniumTest', values: { damage: 288_000, healing: 0, damageTaken: 372_000 } },
        ]);
    });

    test('a skilling modal is read by its own header, not mislabelled as damage', () => {
        const parsed = parseTrialStatsModal(modalEl(SKILLING_HTML));
        expect(parsed.kind).toBe('skilling');
        expect(parsed.columns).toEqual(['work']);
        expect(parsed.members[0]).toEqual({ name: 'MillenniumTest', values: { work: 124_000 } });
    });

    test('takes the member name from data-name, not the (possibly truncated) span', () => {
        const parsed = parseTrialStatsModal(modalEl());
        expect(parsed.members.map((m) => m.name)).toContain('MillenniumTest');
    });

    test('reads only the visible tab, never the hidden one', () => {
        // The hidden Swarm panel carries no table, so a stray row there must not leak in.
        const parsed = parseTrialStatsModal(modalEl());
        expect(parsed.members).toHaveLength(4);
    });

    test('returns null for a missing or empty modal', () => {
        expect(parseTrialStatsModal(null)).toBeNull();
        expect(parseTrialStatsModal(modalEl('<div class="GuildPanel_trialStatsModal__x"></div>'))).toBeNull();
    });
});

describe('the capture singleton', () => {
    beforeEach(() => guildTrialStatsModal.statsByTrial.clear());
    afterEach(() => guildTrialStatsModal.statsByTrial.clear());

    test('capture stores the reading under its trial name', () => {
        vi.setSystemTime(new Date('2026-08-07T16:14:58Z'));
        guildTrialStatsModal.capture(modalEl());
        const stats = guildTrialStatsModal.getStats('Trial Jellyfish');
        expect(stats.members).toHaveLength(4);
        expect(stats.kind).toBe('combat');
        expect(stats.at).toBe(new Date('2026-08-07T16:14:58Z').getTime());
        expect(guildTrialStatsModal.snapshot()['Trial Jellyfish']).toBeTruthy();
        vi.useRealTimers();
    });

    test('getCombatStats flattens a combat capture and returns null for skilling', () => {
        guildTrialStatsModal.capture(modalEl());
        guildTrialStatsModal.capture(modalEl(SKILLING_HTML));
        expect(guildTrialStatsModal.getCombatStats('Trial Jellyfish')).toEqual([
            { name: 'Tib', damage: 1_213_000, healing: 0, damageTaken: 175_000 },
            { name: 'chocstest', damage: 584_000, healing: 0, damageTaken: 167_000 },
            { name: 'Orven', damage: 318_000, healing: 64_577, damageTaken: 174_000 },
            { name: 'MillenniumTest', damage: 288_000, healing: 0, damageTaken: 372_000 },
        ]);
        expect(guildTrialStatsModal.getCombatStats('Enhancing')).toBeNull();
    });

    test('a modal that parses to nothing is ignored rather than stored', () => {
        guildTrialStatsModal.capture(modalEl('<div class="GuildPanel_trialStatsModal__x"></div>'));
        expect(guildTrialStatsModal.snapshot()).toEqual({});
    });
});

describe('clickable member names', () => {
    beforeEach(() => {
        profile.opened.length = 0;
        guildTrialStatsModal.statsByTrial.clear();
    });
    afterEach(() => {
        guildTrialStatsModal.cleanup();
        guildTrialStatsModal.statsByTrial.clear();
    });

    /** The name cell for `name`, as the game draws it */
    const nameCell = (modal, name) => modal.querySelector(`[class*="CharacterName_name"][data-name="${name}"]`);

    test('every member name in the table becomes clickable', () => {
        const modal = modalEl();
        expect(linkMemberNames(modal)).toBe(4);

        for (const name of ['Tib', 'chocstest', 'Orven', 'MillenniumTest']) {
            const cell = nameCell(modal, name);
            expect(cell.style.cursor).toBe('pointer');
            expect(cell.title).toBe(`Open ${name}'s profile`);
        }
    });

    test('a click opens that player through the shared profile helper, and does nothing else', () => {
        const modal = modalEl();
        linkMemberNames(modal);

        nameCell(modal, 'Orven').dispatchEvent(new MouseEvent('click', { bubbles: true }));

        // Exactly one game action: the profile open, for the name that was clicked
        expect(profile.opened).toEqual([{ name: 'Orven', options: { logPrefix: 'GuildTrialStatsModal' } }]);
    });

    test('the name is taken from data-name, which survives a truncated label', () => {
        const modal = modalEl();
        const cell = nameCell(modal, 'MillenniumTest');
        cell.querySelector('span').textContent = 'Millennium…';
        linkMemberNames(modal);

        cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(profile.opened[0].name).toBe('MillenniumTest');
    });

    test('hovering underlines the name, leaving the game its own colour', () => {
        const modal = modalEl();
        linkMemberNames(modal);
        const cell = nameCell(modal, 'Tib');

        expect(cell.style.textDecoration).toBe('');
        cell.dispatchEvent(new MouseEvent('mouseenter'));
        expect(cell.style.textDecoration).toBe('underline');
        cell.dispatchEvent(new MouseEvent('mouseleave'));
        expect(cell.style.textDecoration).toBe('');
        // The class list is the game's; nothing recolours the cell
        expect(cell.getAttribute('style')).not.toContain('color');
    });

    test('a redraw never double-binds a name it has already wired', () => {
        const modal = modalEl();
        expect(linkMemberNames(modal)).toBe(4);
        expect(linkMemberNames(modal)).toBe(0);

        nameCell(modal, 'Tib').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(profile.opened).toHaveLength(1);
    });

    test('a name that is not a single MWI name token is left alone', () => {
        const modal = modalEl();
        const cell = nameCell(modal, 'Tib');
        cell.setAttribute('data-name', 'Giant Jellyfish');
        cell.querySelector('span').textContent = 'Giant Jellyfish';

        expect(linkMemberNames(modal)).toBe(3);
        expect(cell.style.cursor).toBe('');
    });

    test('the skilling modal gets the same treatment', () => {
        const modal = modalEl(SKILLING_HTML);
        expect(linkMemberNames(modal)).toBe(2);
    });

    test('names outside the stats table are not touched', () => {
        const modal = modalEl();
        const stray = document.createElement('div');
        stray.className = 'CharacterName_name__x';
        stray.setAttribute('data-name', 'Bystander');
        modal.appendChild(stray);

        expect(linkMemberNames(modal)).toBe(4);
        expect(stray.style.cursor).toBe('');
    });

    test('the observer wires the names when the game draws the table', () => {
        guildTrialStatsModal.initialize();
        const modal = modalEl();
        document.body.appendChild(modal);

        observers.byClass['GuildPanel_trialStatsTable'](modal.querySelector('table'));

        // Both jobs done off one fire: the capture, and the decoration
        expect(guildTrialStatsModal.getStats('Trial Jellyfish').members).toHaveLength(4);
        nameCell(modal, 'chocstest').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(profile.opened[0].name).toBe('chocstest');

        modal.remove();
    });

    test('the bare table works too, for a build with no reachable modal wrapper', () => {
        const table = modalEl().querySelector('table');
        expect(linkMemberNames(table)).toBe(4);
    });
});
