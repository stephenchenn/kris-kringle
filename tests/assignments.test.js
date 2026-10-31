const { test } = require('node:test');
const assert = require('node:assert/strict');
const { seedAssignments } = require('../lib/assignments');

test('each budget has one gift given and received, with balanced recipient reuse', () => {
  for (let size = 2; size <= 15; size++) {
    const people = Array.from({ length: size }, (_, i) => ({ id: `person-${i}` }));
    for (let count = 1; count <= size * 2; count++) {
      const tiers = Array.from({ length: count }, (_, i) => ({ id: `tier-${i}` }));
      for (let trial = 0; trial < 5; trial++) {
        const assignments = seedAssignments(people, tiers);
        assert.equal(assignments.length, size * count);
        for (const tier of tiers) {
          const rows = assignments.filter(row => row.tier_id === tier.id);
          assert.equal(new Set(rows.map(row => row.giver_id)).size, size);
          assert.equal(new Set(rows.map(row => row.recipient_id)).size, size);
          assert(rows.every(row => row.giver_id !== row.recipient_id));
        }
        for (const giver of people) {
          const given = assignments.filter(row => row.giver_id === giver.id);
          const counts = people.filter(person => person.id !== giver.id).map(recipient =>
            given.filter(row => row.recipient_id === recipient.id).length);
          assert.equal(new Set(given.map(row => row.recipient_id)).size, Math.min(count, size - 1));
          assert(Math.max(...counts) - Math.min(...counts) <= 1);
        }
      }
    }
  }
});

test('reject impossible participant lists and missing tiers', () => {
  assert.throws(() => seedAssignments([{ id: 'one' }], [{ id: 'gift' }]));
  assert.throws(() => seedAssignments([{ id: 'one' }, { id: 'one' }], [{ id: 'gift' }]));
  assert.throws(() => seedAssignments([{ id: 'one' }, { id: 'two' }], []));
});
