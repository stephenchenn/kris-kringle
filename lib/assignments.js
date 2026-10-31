const { randomInt } = require('node:crypto');

function shuffled(values) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// A shuffled circle and nonzero offsets give a complete permutation for each
// tier. Exhaust all possible recipients before repeating any giver/recipient
// pair. This also handles more gifts than available recipients without retries.
function seedAssignments(participants, tiers) {
  if (!Array.isArray(participants) || participants.length < 2) {
    throw new Error('Need at least 2 participants');
  }
  if (!Array.isArray(tiers) || tiers.length < 1) {
    throw new Error('Need at least 1 tier');
  }
  const ids = participants.map(person => person.id);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
    throw new Error('Participant IDs must be unique');
  }
  const circle = shuffled(ids);
  const offsets = Array.from({ length: ids.length - 1 }, (_, i) => i + 1);
  const assignments = [];
  let round = [];
  for (let index = 0; index < tiers.length; index++) {
    if (index % offsets.length === 0) round = shuffled(offsets);
    const offset = round[index % offsets.length];
    for (let i = 0; i < circle.length; i++) {
      assignments.push({
        tier_id: tiers[index].id,
        giver_id: circle[i],
        recipient_id: circle[(i + offset) % circle.length],
      });
    }
  }
  return assignments;
}

module.exports = { seedAssignments };
