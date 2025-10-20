
// ===========================
// testSeed.js
// ===========================
// Runs the seeding logic 100 times with randomized inputs and verifies constraints.

const { seedAssignments, verifyAssignments } = require("./seedLogic");
const { randomUUID: uuid } = require("crypto");

function makeParticipants(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `P${i + 1}-${uuid()}` }));
}
function makeTiers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}-${uuid()}` }));
}

function runOneTrial({ numParticipants, numTiers }) {
  const participants = makeParticipants(numParticipants);
  const tiers = makeTiers(numTiers);
  const assignments = seedAssignments(participants, tiers);
  verifyAssignments(participants, tiers, assignments);
}

(async function main() {
  let trials = 100;
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (let t = 1; t <= trials; t++) {
    // Randomize sizes while keeping constraints feasible.
    const numParticipants = Math.floor(Math.random() * 10) + 3; // 3..12
    const maxTiers = Math.max(1, numParticipants - 1);
    const numTiers = Math.floor(Math.random() * Math.min(4, maxTiers)) + 1; // 1..min(4, P-1)

    try {
      runOneTrial({ numParticipants, numTiers });
      passed++;
      if (t % 10 === 0) console.log(`Trial ${t} OK (P=${numParticipants}, T=${numTiers})`);
    } catch (e) {
      failed++;
      failures.push({ trial: t, error: e.message });
      console.error(`Trial ${t} FAILED (P=${numParticipants}, T=${numTiers}):`, e.message);
    }
  }

  console.log("\n===========================");
  console.log(`Total: ${trials}, Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    console.log("Failures:", failures);
    process.exitCode = 1;
  }
})();

// ===========================
// How to run
// ===========================
// 1) Save both files (seedLogic.js and testSeed.js) in the same folder.
// 2) Run:   node testSeed.js
// 3) You should see periodic OK logs and a final summary with all tests passed.
