// ===========================
// seedLogic.js
// ===========================
// Pure assignment/seeding logic extracted from the server. No DB, no Express.
// Ensures:
//  1) For each tier, every participant gives exactly one gift and receives exactly one gift.
//  2) No self-assignments.
//  3) Cross-tier uniqueness: a giver never gifts to the same recipient more than once.
//  4) Throws if constraints are impossible (e.g., tiers > participants - 1).

const { randomUUID } = require("crypto");

/** Fisher-Yates shuffle (in place). */
function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

/**
 * Return a random derangement of ids (no element remains at its original index).
 * Throws after too many attempts (should be fine for small N).
 */
function derange(ids, maxAttempts = 2000) {
  const a = ids.slice();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    shuffleInPlace(a);
    let ok = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === ids[i]) { ok = false; break; }
    }
    if (ok) return a.slice();
  }
  throw new Error("Failed to create derangement");
}

/**
 * Core seeding function.
 * @param {Array<{id:string,name?:string}>} participants
 * @param {Array<{id:string,name?:string}>} tiers
 * @returns {Array<{tier_id:string,giver_id:string,recipient_id:string}>}
 */
function seedAssignments(participants, tiers) {
  if (!Array.isArray(participants) || participants.length < 2) {
    throw new Error("Need at least 2 participants");
  }
  if (!Array.isArray(tiers) || tiers.length < 1) {
    throw new Error("Need at least 1 tier");
  }
  // Cross-tier uniqueness requires at most P-1 unique recipients per giver.
  if (tiers.length > participants.length - 1) {
    throw new Error(
      `Impossible constraints: tiers (${tiers.length}) must be <= participants - 1 (${participants.length - 1})`
    );
  }

  const giverIds = participants.map(p => p.id);
  const alreadyForGiver = new Map(giverIds.map(g => [g, new Set()]));
  const assignments = [];

  for (const t of tiers) {
    // Find a derangement that ALSO avoids reusing recipients for any giver across tiers.
    let perm;
    attempt: for (let tries = 0; tries < 500; tries++) {
      perm = derange(giverIds, 3000);
      for (let i = 0; i < giverIds.length; i++) {
        const g = giverIds[i];
        const r = perm[i];
        if (alreadyForGiver.get(g).has(r)) {
          continue attempt; // reject and try again
        }
      }
      break; // acceptable perm found
    }
    if (!perm) {
      throw new Error("Failed to find cross-tier-unique derangement");
    }

    for (let i = 0; i < giverIds.length; i++) {
      const giver = giverIds[i];
      const recip = perm[i];
      if (giver === recip) throw new Error("Self-assignment detected (should be impossible)");
      assignments.push({ tier_id: t.id, giver_id: giver, recipient_id: recip });
      alreadyForGiver.get(giver).add(recip);
    }
  }

  return assignments;
}

/**
 * Verify all constraints hold for produced assignments.
 * Throws an Error if any violation is found.
 */
function verifyAssignments(participants, tiers, assignments) {
  const P = participants.map(p => p.id);
  const T = tiers.map(t => t.id);

  // 1) For each tier: one outgoing and one incoming per participant.
  for (const tid of T) {
    const byTier = assignments.filter(a => a.tier_id === tid);
    if (byTier.length !== P.length) {
      throw new Error(`Tier ${tid}: expected ${P.length} assignments, got ${byTier.length}`);
    }

    // outgoing per giver
    const out = new Map(P.map(id => [id, 0]));
    // incoming per recipient
    const inc = new Map(P.map(id => [id, 0]));

    for (const a of byTier) {
      if (a.giver_id === a.recipient_id) {
        throw new Error(`Tier ${tid}: self-assignment for ${a.giver_id}`);
      }
      out.set(a.giver_id, (out.get(a.giver_id) || 0) + 1);
      inc.set(a.recipient_id, (inc.get(a.recipient_id) || 0) + 1);
    }

    for (const id of P) {
      if (out.get(id) !== 1) throw new Error(`Tier ${tid}: ${id} gives ${out.get(id)} (expected 1)`);
      if (inc.get(id) !== 1) throw new Error(`Tier ${tid}: ${id} receives ${inc.get(id)} (expected 1)`);
    }
  }

  // 2) Cross-tier uniqueness: a given giver never has the same recipient twice across tiers.
  const seenPair = new Set();
  for (const a of assignments) {
    const key = `${a.giver_id}->${a.recipient_id}`;
    if (seenPair.has(key)) {
      throw new Error(`Cross-tier duplicate pair detected: ${key}`);
    }
    seenPair.add(key);
  }
}

module.exports = {
  seedAssignments,
  verifyAssignments,
  derange,
};

