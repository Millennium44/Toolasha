/**
 * Who has shown their kit this trial, and which auras the party actually has.
 *
 * A guild trial runs for an hour with up to fifty participants, and the only
 * source of a member's equipped abilities is their Battle Info popup —
 * captured one click at a time through `guild-loadout-capture.js`. This module
 * keeps the *session*: which participants have produced an authoritative kit
 * this hour, which are still owed a click, and what that means for the party's
 * aura coverage.
 *
 * ## The session and when it resets
 *
 * There is no server trial-session id, so a session is the guild plus an
 * observed start, the same way `guild-trial-recorder.js` models one. The rule
 * is deliberately blunt: a session resets only when
 *
 * - a capture arrives more than {@link SESSION_MAX_AGE_MS} after the session
 *   started — a trial lasts an hour, so anything past ~65 minutes is the next
 *   trial;
 * - {@link GuildTrialAbilities#noteTrialStart} is called for a session older
 *   than {@link TRIAL_START_GRACE_MS} — the explicit signal, debounced so the
 *   two auto-start signals arriving together cannot wipe a capture in progress;
 * - {@link GuildTrialAbilities#recapture} is called — the button;
 * - the guild changes ({@link GuildTrialAbilities#setGuildName}) — another
 *   guild's captures say nothing about this one's trial.
 *
 * Nothing else resets it. Slot order, tier and wave all change *during* a
 * trial, and a captured player stays captured through every one of them.
 *
 * ## What counts as captured
 *
 * Only a snapshot whose payload itself carried a `combatAbilities` array
 * (`abilitiesAuthoritative === true`, empty array included — an authoritative
 * empty kit is a genuinely empty kit). A stat-only sighting proves the player
 * exists and says nothing about their abilities, so it leaves them outstanding:
 * "abilities unavailable" is a different claim from "no abilities equipped",
 * and coverage must not treat the first as the second.
 *
 * Socket-free on purpose: the roster and the tier are fed in by the caller,
 * captures are fed in as snapshots, and everything downstream of them is pure
 * and testable without a connection.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { isAuraAbility } from '../../utils/party-lint.js';

/** Object store the session lives in — shared with the rest of the guild history */
export const SESSION_STORE = 'guildHistory';

/** Key prefix; the guild name is appended, as the trial record's key is */
export const SESSION_KEY_PREFIX = 'guildTrialAbilities';

/** A session older than this belongs to the previous trial hour */
export const SESSION_MAX_AGE_MS = 65 * 60 * 1000;

/** An explicit trial-start signal younger than this is the same trial starting */
export const TRIAL_START_GRACE_MS = 5 * 60 * 1000;

/**
 * Storage key for a guild's capture session.
 * @param {string|null} guildName - Guild name, or null before it is known
 * @returns {string} Storage key
 */
export function sessionStorageKey(guildName) {
    return `${SESSION_KEY_PREFIX}_${guildName || 'default'}`;
}

/**
 * The key a player is filed under.
 *
 * `characterId` when the snapshot carries one — the only key a rename or a
 * party-slot reorder cannot move — and the normalized name only when it does
 * not (a modal scrape has no id).
 *
 * @param {{characterId?: string|number|null, name?: string|null}} entry - A snapshot or roster member
 * @returns {string} Stable key
 */
export function playerKey(entry) {
    const id = entry?.characterId;
    if (id !== null && id !== undefined) return `id:${id}`;
    return `name:${String(entry?.name || '')
        .trim()
        .toLowerCase()}`;
}

/**
 * A roster as fed in — names or `{characterId, name}` objects — normalized.
 * @param {Array<string|{characterId?: string|number|null, name?: string}>} list - The participants
 * @returns {Array<{characterId: string|number|null, name: string}>} Deduplicated roster
 */
export function normalizeRoster(list) {
    const roster = [];
    const seen = new Set();
    for (const entry of list || []) {
        const member = typeof entry === 'string' ? { characterId: null, name: entry } : entry;
        const name = String(member?.name || '').trim();
        const characterId = member?.characterId ?? null;
        if (!name && characterId === null) continue;
        const key = playerKey({ characterId, name });
        if (seen.has(key)) continue;
        seen.add(key);
        roster.push({ characterId, name });
    }
    return roster;
}

/**
 * The stored capture for a roster member, if any.
 *
 * Id first, then the name key, then a name match against id-keyed entries —
 * because the roster and the capture do not always both know the id.
 *
 * @param {Object} players - The session's players, keyed by {@link playerKey}
 * @param {{characterId?: string|number|null, name?: string}} member - A roster member
 * @returns {Object|null} The capture entry
 */
export function captureFor(players, member) {
    if (!players || !member) return null;
    if (member.characterId !== null && member.characterId !== undefined) {
        const byId = players[`id:${member.characterId}`];
        if (byId) return byId;
    }
    const wanted = String(member.name || '')
        .trim()
        .toLowerCase();
    if (!wanted) return null;
    const byName = players[`name:${wanted}`];
    if (byName) return byName;
    return Object.values(players).find((entry) => String(entry?.name || '').toLowerCase() === wanted) || null;
}

/**
 * Every aura hrid the game data declares, detected off the ability shape.
 *
 * `isAuraAbility` reads the effect structure the engine itself keys off, so
 * nothing here is a hardcoded list — a new aura in the game data appears in
 * the expected set without a code change.
 *
 * @param {Object} abilityDetailMap - Game data
 * @returns {string[]} Aura hrids
 */
export function expectedAuraHrids(abilityDetailMap = {}) {
    return Object.keys(abilityDetailMap).filter((hrid) => isAuraAbility(abilityDetailMap[hrid]));
}

/**
 * The auras the captured players actually carry, per aura hrid.
 *
 * Only authoritative captures contribute. The highest-level copy names the
 * provider — "highest equipped", never "effective", because nothing here knows
 * which copy would cast. Lower-level copies of the *same* hrid are redundant
 * providers: listed, counted in `duplicateCount`, never double-counted as
 * coverage. Different aura hrids are different auras and never duplicates of
 * each other. A player equipping the same hrid twice counts once, as
 * `duplicateAuraWarnings` counts it.
 *
 * @param {Array<Object>} entries - Captured players (`abilities`, `abilitiesAuthoritative`)
 * @param {Object} abilityDetailMap - Game data
 * @returns {Object} hrid → `{hrid, name, highestLevel, provider, providers, duplicateCount}`
 */
export function aggregateAuras(entries, abilityDetailMap = {}) {
    const auras = {};
    for (const entry of entries || []) {
        if (entry?.abilitiesAuthoritative !== true) continue;
        const seen = new Set();
        for (const ability of entry.abilities || []) {
            const hrid = ability?.hrid;
            if (!hrid || seen.has(hrid)) continue;
            seen.add(hrid);
            const detail = abilityDetailMap[hrid];
            if (!isAuraAbility(detail)) continue;

            const level = Number(ability?.level);
            const slot = (auras[hrid] ||= {
                hrid,
                name: detail?.name || hrid.split('/').pop().replace(/_/g, ' '),
                highestLevel: null,
                provider: null,
                providers: [],
                duplicateCount: 0,
            });
            slot.providers.push({
                name: entry.name || null,
                characterId: entry.characterId ?? null,
                level: Number.isFinite(level) ? level : null,
            });
        }
    }

    for (const slot of Object.values(auras)) {
        slot.providers.sort((a, b) => (b.level ?? -1) - (a.level ?? -1));
        slot.highestLevel = slot.providers[0]?.level ?? null;
        slot.provider = slot.providers[0]?.name ?? null;
        slot.duplicateCount = Math.max(0, slot.providers.length - 1);
    }
    return auras;
}

/**
 * Coverage state per expected aura.
 *
 * `missing` is the strong claim and it is only made when it can be proven:
 * every current participant authoritatively captured and none of them equips
 * the aura. Anything less is `unknown` — a partial capture must never
 * masquerade as proof of absence.
 *
 * @param {Object} auras - From {@link aggregateAuras}, current participants only
 * @param {Object} abilityDetailMap - Game data
 * @param {boolean} allCurrentCaptured - Every current participant has an authoritative capture
 * @returns {Object} hrid → `'covered' | 'unknown' | 'missing'`
 */
export function auraCoverage(auras, abilityDetailMap = {}, allCurrentCaptured = false) {
    const coverage = {};
    for (const hrid of expectedAuraHrids(abilityDetailMap)) {
        if (auras?.[hrid]?.providers?.length) coverage[hrid] = 'covered';
        else coverage[hrid] = allCurrentCaptured ? 'missing' : 'unknown';
    }
    return coverage;
}

class GuildTrialAbilities {
    constructor() {
        this.initialized = false;
        this.guildName = null;
        /** `{startedAt, guildName, captureTier, capturedTiers, completedAt, players}` or null */
        this.session = null;
        /** Current trial participants, fed in by the caller */
        this.roster = [];
        /** Tier as last fed in; stamped onto captures, never subscribed for */
        this.currentTier = null;
    }

    /**
     * Load the persisted session, keeping it only when it is this guild's and
     * still inside the trial hour.
     *
     * @param {string|null} [guildName] - The key the session is stored under
     * @returns {Promise<void>}
     */
    async initialize(guildName = null) {
        this.guildName = guildName || null;
        this.initialized = true;
        try {
            const stored = await storage.get(sessionStorageKey(this.guildName), SESSION_STORE, null);
            const fresh = Number.isFinite(stored?.startedAt) && Date.now() - stored.startedAt <= SESSION_MAX_AGE_MS;
            const sameGuild = !stored?.guildName || !this.guildName || stored.guildName === this.guildName;
            if (fresh && sameGuild) {
                this.session = { ...stored, capturedTiers: [...(stored.capturedTiers || [])] };
            }
        } catch (error) {
            console.error('[GuildTrialAbilities] Reading the stored session failed:', error);
        }
    }

    cleanup() {
        this.initialized = false;
    }

    /**
     * The guild changed, or became known. A session recorded under a
     * *different* guild is dropped outright — wrong-guild captures must not
     * pose as this trial's.
     *
     * @param {string|null} name - The guild's name, or null to forget
     */
    setGuildName(name) {
        const next = name || null;
        if (this.session && this.session.guildName && next && this.session.guildName !== next) {
            this.session = null;
        }
        this.guildName = next;
    }

    /**
     * The current trial participants, fed in by the orchestrator.
     *
     * Joining adds one outstanding capture; leaving keeps the capture and
     * merely marks its player not-current. The roster never resets a session.
     *
     * @param {Array<string|{characterId?: string|number|null, name?: string}>} list - Participants
     */
    setRoster(list) {
        this.roster = normalizeRoster(list);
        if (this.session) {
            this._recheckComplete(Date.now());
            this._persist();
        }
    }

    /**
     * The tier the trial is currently on, fed in by the orchestrator.
     * @param {number|string|null} tier - e.g. `4`
     */
    setTier(tier) {
        this.currentTier = tier ?? null;
    }

    /**
     * An explicit "a trial just started" signal, when the caller has one.
     *
     * Debounced by {@link TRIAL_START_GRACE_MS}: the signal routinely fires
     * more than once for the same trial, and a repeat must not wipe the
     * captures the first firing started collecting.
     *
     * @param {number} [at] - Clock
     */
    noteTrialStart(at = Date.now()) {
        if (this.session && at - this.session.startedAt <= TRIAL_START_GRACE_MS) return;
        this._start(at);
        this._persist();
    }

    /**
     * Throw the session away and start collecting again. The button.
     * @param {number} [at] - Clock
     * @returns {Object} The fresh session
     */
    recapture(at = Date.now()) {
        this._start(at);
        this._persist();
        return this.session;
    }

    /**
     * Fold a loadout snapshot (the `extractLoadout` shape) into the session.
     *
     * Keyed by `characterId` when the snapshot has one, so a party-slot
     * reorder cannot transplant one player's abilities onto another; the
     * normalized name is the fallback key. Only an authoritative snapshot
     * makes a player captured; a stat-only sighting is kept for its name but
     * never erases an authoritative kit and never counts as one.
     *
     * @param {Object} snapshot - `{characterId, name, abilities, abilitiesAuthoritative, source, at}`
     * @param {Object} [options] - Context
     * @param {number|string|null} [options.tier] - Tier at capture; defaults to the fed tier
     * @param {number} [options.at] - Clock
     * @returns {Object|null} The player's entry, or null for an unusable snapshot
     */
    recordCapture(snapshot, { tier = this.currentTier, at } = {}) {
        if (!snapshot || (!snapshot.name && (snapshot.characterId === null || snapshot.characterId === undefined))) {
            return null;
        }

        const when = Number.isFinite(at) ? at : Number.isFinite(snapshot.at) ? snapshot.at : Date.now();
        if (this.session && when - this.session.startedAt > SESSION_MAX_AGE_MS) this._start(when);
        if (!this.session) this._start(when);

        const key = playerKey(snapshot);
        let existing = this.session.players[key] || null;

        // An id-carrying snapshot adopts an earlier id-less sighting of the
        // same name, so the player does not appear twice under two keys
        if (snapshot.characterId !== null && snapshot.characterId !== undefined) {
            const nameKey = playerKey({ characterId: null, name: snapshot.name });
            if (nameKey !== key && this.session.players[nameKey]) {
                existing = existing || this.session.players[nameKey];
                delete this.session.players[nameKey];
            }
        }

        const authoritative = snapshot.abilitiesAuthoritative === true;
        const entry = {
            characterId: snapshot.characterId ?? existing?.characterId ?? null,
            name: snapshot.name || existing?.name || null,
            capturedAt: authoritative ? when : (existing?.capturedAt ?? null),
            capturedTier: authoritative ? (tier ?? null) : (existing?.capturedTier ?? null),
            source: snapshot.source ?? existing?.source ?? null,
            abilitiesAuthoritative: authoritative || existing?.abilitiesAuthoritative === true,
            abilities: authoritative
                ? (snapshot.abilities || []).map((ability) => ({
                      hrid: ability?.hrid ?? null,
                      level: Number.isFinite(Number(ability?.level)) ? Number(ability.level) : null,
                  }))
                : (existing?.abilities ?? null),
        };
        this.session.players[key] = entry;

        if (authoritative && tier !== null && tier !== undefined) {
            if (this.session.captureTier === null) this.session.captureTier = tier;
            if (!this.session.capturedTiers.includes(tier)) this.session.capturedTiers.push(tier);
        }

        this._recheckComplete(when);
        this._persist();
        return entry;
    }

    /**
     * The roster joined against the captures, one row per current participant.
     * @returns {Array<{characterId: string|number|null, name: string, capture: Object|null, captured: boolean}>}
     */
    participants() {
        const players = this.session?.players || {};
        return this.roster.map((member) => {
            const capture = captureFor(players, member);
            return {
                characterId: member.characterId ?? capture?.characterId ?? null,
                name: member.name || capture?.name || '',
                capture,
                captured: capture?.abilitiesAuthoritative === true,
            };
        });
    }

    /**
     * Everything the panel needs, computed fresh.
     *
     * @param {Object} [abilityDetailMap] - Game data; defaults to the live map
     * @returns {Object} `{startedAt, guildName, captureTier, capturedTiers, rosterCount, capturedCount,
     *   outstanding, participants, notCurrent, complete, completedAt, auras, coverage}`
     */
    state(abilityDetailMap = this._abilityMap()) {
        const session = this.session;
        const rows = this.participants();
        const outstanding = rows.filter((row) => !row.captured);
        const capturedCount = rows.length - outstanding.length;
        const complete = rows.length > 0 && outstanding.length === 0;

        // Coverage speaks only about the current participants: a departed
        // player's aura left with them, and a stranger's does not fight here
        const currentCaptures = rows.filter((row) => row.captured).map((row) => row.capture);
        const auras = aggregateAuras(currentCaptures, abilityDetailMap);
        const coverage = auraCoverage(auras, abilityDetailMap, complete);

        const currentKeys = new Set(rows.filter((row) => row.capture).map((row) => playerKey(row.capture)));
        const notCurrent = Object.entries(session?.players || {})
            .filter(([key]) => !currentKeys.has(key))
            .map(([, player]) => player);

        return {
            startedAt: session?.startedAt ?? null,
            guildName: session?.guildName ?? this.guildName,
            captureTier: session?.captureTier ?? null,
            capturedTiers: [...(session?.capturedTiers || [])],
            rosterCount: rows.length,
            capturedCount,
            outstanding,
            participants: rows,
            notCurrent,
            complete,
            completedAt: complete ? (session?.completedAt ?? null) : null,
            auras,
            coverage,
        };
    }

    /**
     * The session as the trial export embeds it.
     *
     * Coverage-aware on purpose: `missingAuras` only exists when every current
     * participant is authoritatively captured, so a partial capture exports
     * `unknownAuras` and can never masquerade as proof of absence.
     *
     * @param {Object} [abilityDetailMap] - Game data; defaults to the live map
     * @returns {Object} The export schema
     */
    exportSnapshot(abilityDetailMap = this._abilityMap()) {
        const view = this.state(abilityDetailMap);
        const players = {};
        for (const entry of Object.values(this.session?.players || {})) {
            const key =
                entry.characterId !== null && entry.characterId !== undefined
                    ? String(entry.characterId)
                    : String(entry.name || '')
                          .trim()
                          .toLowerCase();
            players[key] = { ...entry, abilities: entry.abilities ? [...entry.abilities] : null };
        }

        const byState = (wanted) => Object.keys(view.coverage).filter((hrid) => view.coverage[hrid] === wanted);
        const snapshot = {
            startedAt: view.startedAt,
            guildName: view.guildName,
            captureTier: view.captureTier,
            capturedTiers: view.capturedTiers,
            complete: view.complete,
            completedAt: view.completedAt,
            players,
            auras: view.auras,
            unknownAuras: byState('unknown'),
        };
        if (view.complete) snapshot.missingAuras = byState('missing');
        return snapshot;
    }

    /** @returns {Object} The live ability data */
    _abilityMap() {
        return dataManager.getInitClientData?.()?.abilityDetailMap || {};
    }

    /**
     * Begin a fresh session, discarding whatever was held.
     * @param {number} at - Clock
     */
    _start(at) {
        this.session = {
            startedAt: at,
            guildName: this.guildName,
            captureTier: null,
            capturedTiers: [],
            completedAt: null,
            players: {},
        };
    }

    /**
     * Stamp or clear `completedAt` against the current roster: complete the
     * moment the last participant lands, un-complete when a joiner adds an
     * outstanding capture.
     *
     * @param {number} at - Clock
     */
    _recheckComplete(at) {
        if (!this.session) return;
        const rows = this.participants();
        const complete = rows.length > 0 && rows.every((row) => row.captured);
        if (complete && !this.session.completedAt) this.session.completedAt = at;
        if (!complete) this.session.completedAt = null;
    }

    /** Write the session down; never awaited on the capture path */
    _persist() {
        if (!this.session) return;
        storage
            .set(sessionStorageKey(this.guildName), this.session, SESSION_STORE)
            .catch((error) => console.error('[GuildTrialAbilities] Saving the session failed:', error));
    }
}

const guildTrialAbilities = new GuildTrialAbilities();

export default guildTrialAbilities;
export { guildTrialAbilities, GuildTrialAbilities };
