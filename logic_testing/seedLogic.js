// ===========================
// seedLogic.js
// ===========================
// Pure assignment/seeding logic extracted from the server. No DB, no Express.
// Ensures:
//  1) For each tier, every participant gives exactly one gift and receives exactly one gift.
//  2) No self-assignments.
//  3) Cross-tier uniqueness: a giver never gifts to the same recipient more than once.
//  4) Production supports extra tiers with balanced repeats; this legacy smoke test uses unique-recipient cases.

const { seedAssignments } = require('../lib/assignments');

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
};

