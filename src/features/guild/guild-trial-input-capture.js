/** A user-driven checklist for the inputs needed to replay a guild trial. */
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { guildXPTracker } from './guild-xp-tracker.js';
import {
    captureTrialSimulationInputs,
    startTrialSimulationCapture,
    trialSimulationProfiles,
} from './guild-trial-simulation-inputs.js';
import { createPanel, panelNote } from '../../utils/simple-panel.js';
import { openPlayerProfile, VALID_PLAYER_NAME_RE } from '../../utils/profile-command.js';
import { fetchLoadout, getLoadouts, onLoadoutCaptured, VIEW_LOADOUT_CONTEXT } from '../../utils/view-loadout.js';
import { scriptVersion } from '../../utils/script-version.js';
import { isTestServer } from '../../utils/game-server.js';

const KINDS = ['combat', 'skilling'];
const PROFILE_TIMEOUT_MS = 8000;

/** The current week's participants, with one loadout request per signed-up kind. */
export function trialInputRoster(tracker = guildXPTracker) {
    const week = tracker.getCurrentWeekStartAt?.();
    if (!week) return [];
    const roster = [];
    for (const member of tracker.getMemberList?.() || []) {
        const meta = tracker.getMemberMeta?.(member.characterID) || member;
        if (meta.signupWeekStartAt !== week || !VALID_PLAYER_NAME_RE.test(meta.name || '')) continue;
        const trials = {};
        if (meta.signedUpCombatTrialHrid) trials.combat = meta.signedUpCombatTrialHrid;
        if (meta.signedUpSkillingTrialHrid) trials.skilling = meta.signedUpSkillingTrialHrid;
        if (Object.keys(trials).length && member.characterID != null)
            roster.push({ characterId: String(member.characterID), name: meta.name, trials });
    }
    return roster.sort((a, b) => a.name.localeCompare(b.name));
}

/** Join fresh captures to the signup roster; unrelated or unknown-kind loadouts never satisfy a step. */
export function trialInputCoverage(roster, { owner, since, loadouts = [], profiles = [] }) {
    return roster.map((member) => {
        const captured = {};
        for (const kind of KINDS.filter((entry) => member.trials[entry])) {
            const entry = loadouts
                .filter(
                    (item) =>
                        item.ownerCharacterId === String(owner) &&
                        String(item.characterId) === member.characterId &&
                        item.context === VIEW_LOADOUT_CONTEXT.GuildTrial &&
                        item.kind === kind &&
                        item.capturedAt >= since
                )
                .sort((a, b) => b.capturedAt - a.capturedAt)[0];
            captured[kind] = entry ? (entry.hasLoadout === false ? 'no_loadout' : 'captured') : 'needed';
        }
        const profile = profiles.find(
            (entry) =>
                String(entry.characterID) === member.characterId &&
                entry.timestamp >= since &&
                Array.isArray(entry.profile?.characterSkills) &&
                entry.profile.characterSkills.length > 0
        );
        return { ...member, captured, profile: profile ? 'captured' : 'needed' };
    });
}

function scopeNow() {
    return JSON.stringify([
        dataManager.getCurrentCharacterId?.() ?? null,
        guildXPTracker.getOwnGuildID?.() ?? null,
        guildXPTracker.getOwnGuildName?.() ?? null,
        guildXPTracker.getCurrentWeekStartAt?.() ?? null,
    ]);
}

let scope = null;
let since = 0;
let selection = '';
let pending = null;
let notice = '';
let offLoadout = null;
let profileHandler = null;
const skipped = new Set();

function adoptScope() {
    const next = scopeNow();
    if (next === scope) return;
    cancelPending();
    scope = next;
    since = Date.now();
    selection = '';
    notice = '';
    skipped.clear();
}

function cancelPending() {
    if (pending?.timer) clearTimeout(pending.timer);
    pending = null;
}

function rowsNow() {
    adoptScope();
    return trialInputCoverage(trialInputRoster(), {
        owner: dataManager.getCurrentCharacterId?.(),
        since,
        loadouts: getLoadouts(),
        profiles: trialSimulationProfiles(),
    });
}

function visibleRows(rows) {
    if (!selection) return rows;
    return rows
        .filter((row) => Object.values(row.trials).includes(selection))
        .map((row) => ({
            ...row,
            trials: Object.fromEntries(Object.entries(row.trials).filter(([, hrid]) => hrid === selection)),
        }));
}

const stepKey = (row, kind) => `${row.characterId}:${kind}`;

function nextStep(rows) {
    for (const row of rows) {
        for (const kind of [...KINDS.filter((entry) => row.trials[entry]), 'profile']) {
            const status = kind === 'profile' ? row.profile : row.captured[kind];
            if (status === 'needed' && !skipped.has(stepKey(row, kind))) return { row, kind };
        }
    }
    return null;
}

function statusLabel(status, row, kind) {
    if (status === 'captured') return 'Captured';
    if (status === 'no_loadout') return 'No trial loadout';
    return skipped.has(stepKey(row, kind)) ? 'Skipped — still missing' : 'Needed';
}

function button(label, action, disabled = false) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.disabled = disabled;
    element.style.cssText =
        'padding:5px 8px;margin:3px;border:1px solid #8fb4ff66;border-radius:5px;background:#222b3c;color:#e8ecf5;cursor:pointer;';
    element.addEventListener('click', action);
    return element;
}

async function requestStep(row, kind) {
    adoptScope();
    if (pending) return;
    // A stale button cannot ask for a member who left the current signup roster.
    const current = rowsNow().find((entry) => entry.characterId === row.characterId);
    if (!current || (kind !== 'profile' && !current.trials[kind])) return;
    const request = { scope, row: current, kind };
    pending = request;
    skipped.delete(stepKey(row, kind));
    notice = '';
    try {
        if (kind === 'profile') {
            request.timer = setTimeout(() => {
                if (pending !== request) return;
                cancelPending();
                notice = `No profile reply for ${row.name}. Retry or skip this step.`;
                trialInputCapturePanel.render();
            }, PROFILE_TIMEOUT_MS);
            // Called synchronously from the user's click. Nothing queues another request.
            if (!openPlayerProfile(current.name, { logPrefix: 'TrialInputCapture' })) {
                cancelPending();
                notice = 'The profile could not be opened. Open it from the game roster, or retry.';
            }
        } else {
            const result = await fetchLoadout(current, VIEW_LOADOUT_CONTEXT.GuildTrial, kind);
            if (pending !== request || scopeNow() !== request.scope) return;
            cancelPending();
            if (result.status !== 'done') notice = `Loadout not captured (${result.status}). Retry or skip this step.`;
            else if (result.entry?.hasLoadout === false) notice = `${row.name} has no ${kind} trial loadout.`;
        }
    } catch (error) {
        if (pending === request) {
            cancelPending();
            notice = `Capture failed: ${error.message}. Retry this step.`;
        }
    } finally {
        trialInputCapturePanel.render();
    }
}

/** Build a standalone input export, rejecting a character, guild or week change during the storage read. */
export async function buildTrialInputExport() {
    const rows = rowsNow();
    const expected = scope;
    if (!rows.length) throw new Error('No current trial signups are available. Open Guild first.');
    const owner = dataManager.getCurrentCharacterId();
    const roster = rows.map((row) => ({ characterID: row.characterId, name: row.name }));
    const guildName = guildXPTracker.getOwnGuildName?.() ?? null;
    const weekStartAt = guildXPTracker.getCurrentWeekStartAt?.() ?? null;
    const capturedSince = since;
    const simulationInputs = await captureTrialSimulationInputs(owner, roster);
    if (!simulationInputs || scopeNow() !== expected || scope !== expected)
        throw new Error('Guild, character or capture round changed. Export again.');
    const coverage = trialInputCoverage(rows, {
        owner,
        since: capturedSince,
        loadouts: simulationInputs.viewLoadouts,
        profiles: simulationInputs.profiles,
    });
    const host = typeof location === 'undefined' ? null : location.hostname;
    return {
        format: 'toolasha-guild-trial-inputs',
        version: 1,
        toolashaVersion: scriptVersion(),
        exportedAt: new Date().toISOString(),
        host,
        isTestServer: host ? isTestServer(host) : null,
        guildName,
        weekStartAt,
        capturedSince,
        coverage,
        simulationInputs,
    };
}

async function exportInputs() {
    try {
        const bundle = await buildTrialInputExport();
        const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `toolasha-trial-inputs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        link.click();
        URL.revokeObjectURL(url);
        notice = 'Inputs exported. The file includes missing-input coverage.';
    } catch (error) {
        notice = `Export failed: ${error.message}`;
    }
    trialInputCapturePanel.render();
}

function trialName(hrid) {
    const name = String(hrid).split('/').pop().replace(/_/g, ' ');
    return name.charAt(0).toUpperCase() + name.slice(1);
}

function draw(body) {
    const allRows = rowsNow();
    const trials = [...new Set(allRows.flatMap((row) => Object.values(row.trials)))];
    if (selection && !trials.includes(selection)) selection = '';
    const rows = visibleRows(allRows);
    const controls = document.createElement('div');
    controls.style.cssText = 'position:sticky;top:0;background:#10141e;padding-bottom:8px;z-index:1;';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Trial to capture');
    for (const hrid of ['', ...trials]) {
        const option = document.createElement('option');
        option.value = hrid;
        option.textContent = hrid ? trialName(hrid) : 'All signed-up trials';
        option.selected = selection === hrid;
        select.appendChild(option);
    }
    select.addEventListener('change', () => {
        selection = select.value;
        notice = '';
        trialInputCapturePanel.render();
    });
    controls.appendChild(select);
    const step = nextStep(rows);
    controls.appendChild(
        button(
            pending
                ? `Waiting for ${pending.row.name}…`
                : step
                  ? `Capture next: ${step.row.name} · ${step.kind === 'profile' ? 'profile' : `${step.kind} loadout`}`
                  : 'No unskipped steps left',
            () => requestStep(step.row, step.kind),
            Boolean(pending) || !step
        )
    );
    controls.appendChild(
        button(
            'Skip for now',
            () => {
                skipped.add(stepKey(step.row, step.kind));
                notice = '';
                trialInputCapturePanel.render();
            },
            Boolean(pending) || !step
        )
    );
    controls.appendChild(button('Export inputs', exportInputs, Boolean(pending) || !allRows.length));
    controls.appendChild(
        button(
            'Start fresh captures',
            () => {
                since = Date.now();
                skipped.clear();
                notice = 'Older captures stay in the export, but each step now needs a fresh response.';
                trialInputCapturePanel.render();
            },
            Boolean(pending)
        )
    );
    body.appendChild(controls);
    const loadoutStatuses = rows.flatMap((row) => Object.keys(row.trials).map((kind) => row.captured[kind]));
    body.appendChild(
        panelNote(
            `${loadoutStatuses.filter((status) => status === 'captured').length}/${loadoutStatuses.length} loadouts · ` +
                `${rows.filter((row) => row.profile === 'captured').length}/${rows.length} profiles captured this round.`
        )
    );
    body.appendChild(
        panelNote(
            'One click requests one loadout or profile. Close a profile popup to continue. Export before refreshing.'
        )
    );
    if (notice) body.appendChild(panelNote(notice));
    if (!rows.length)
        body.appendChild(panelNote('No current trial signups found. Open Guild to load the roster and current week.'));
    for (const row of rows) {
        const card = document.createElement('div');
        card.style.cssText = 'padding:8px 0;border-top:1px solid #ffffff22;';
        const heading = document.createElement('strong');
        heading.textContent = `${row.name} — ${Object.values(row.trials).map(trialName).join(', ')}`;
        card.appendChild(heading);
        for (const kind of [...KINDS.filter((entry) => row.trials[entry]), 'profile']) {
            const line = document.createElement('div');
            const status = kind === 'profile' ? row.profile : row.captured[kind];
            const label = kind === 'profile' ? 'Profile' : `${kind === 'combat' ? 'Combat' : 'Skilling'} loadout`;
            line.textContent = `${label}: ${statusLabel(status, row, kind)} `;
            line.style.color = status === 'captured' ? '#8bd99b' : '#edc785';
            const control = button(
                status === 'captured' ? 'Refresh' : 'Capture',
                () => requestStep(row, kind),
                Boolean(pending)
            );
            control.setAttribute('aria-label', `${row.name}: capture ${kind}`);
            line.appendChild(control);
            card.appendChild(line);
        }
        body.appendChild(card);
    }
}

export const trialInputCapturePanel = createPanel({
    id: 'trialInputCapture',
    title: 'Trial Input Capture',
    size: { width: 620, height: 560 },
    draw,
});

/** Open the checklist; listeners record responses, never send requests by themselves. */
export function openTrialInputCapture() {
    startTrialSimulationCapture();
    adoptScope();
    if (!offLoadout) offLoadout = onLoadoutCaptured(() => trialInputCapturePanel.render());
    if (!profileHandler) {
        profileHandler = (message) => {
            const request = pending;
            if (request?.kind === 'profile' && scopeNow() === request.scope) {
                const profile = message?.profile;
                const id =
                    profile?.sharableCharacter?.id ||
                    profile?.characterSkills?.[0]?.characterID ||
                    profile?.character?.id;
                if (String(id) === request.row.characterId) {
                    cancelPending();
                    notice =
                        Array.isArray(profile.characterSkills) && profile.characterSkills.length
                            ? 'Profile captured. Close the game popup to continue.'
                            : 'The profile reply has no skill levels. Close the popup and retry.';
                }
            }
            trialInputCapturePanel.render();
        };
        webSocketHook.on('profile_shared', profileHandler);
    }
    trialInputCapturePanel.show();
}

/** Release the helper when Guild Trials is disabled or the character changes. */
export function closeTrialInputCapture() {
    cancelPending();
    offLoadout?.();
    offLoadout = null;
    if (profileHandler) webSocketHook.off('profile_shared', profileHandler);
    profileHandler = null;
    scope = null;
    since = 0;
    skipped.clear();
    trialInputCapturePanel.hide({ remember: false });
}
