import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateResetPct,
  readinessScore,
  signalStrengthScore,
  scoreBasisReset,
} from "../basis_reset.js";

test("calculates the Plaza 600-style basis reset correctly", () => {
  assert.equal(calculateResetPct(97_000_000, 12_000_000), 87.6);
});

test("rejects missing or invalid prior basis instead of inventing a reset", () => {
  assert.equal(calculateResetPct(null, 12_000_000), null);
  assert.equal(calculateResetPct(0, 12_000_000), null);
});

test("issued permits and demolition materially increase readiness", () => {
  const cold = readinessScore({ permitCount: 0, projectCount: 0 });
  const ready = readinessScore({ permitCount: 2, projectCount: 1, hasIssuedPermit: true, demolitionComplete: true });
  assert.ok(ready > cold + 50);
});

test("distress events outrank generic valuations at equal confidence and age", () => {
  assert.ok(
    signalStrengthScore({ eventType: "foreclosure", confidence: 80, ageDays: 10 }) >
    signalStrengthScore({ eventType: "valuation", confidence: 80, ageDays: 10 })
  );
});

test("large reset plus project readiness produces a high opportunity score", () => {
  const result = scoreBasisReset({
    priorBasis: 97_000_000,
    currentBasis: 12_000_000,
    eventType: "sale",
    confidence: 90,
    ageDays: 1,
    permitCount: 3,
    projectCount: 1,
    hasIssuedPermit: true,
  });
  assert.equal(result.resetPct, 87.6);
  assert.ok(result.opportunityScore >= 80);
  assert.match(result.explanation, /Basis reset 87\.6%/);
});
