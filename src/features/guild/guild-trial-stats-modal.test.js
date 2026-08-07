/** @vitest-environment happy-dom */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseTrialStatsModal, headerKey, guildTrialStatsModal } from './guild-trial-stats-modal.js';

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
