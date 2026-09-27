const EVENT_WEIGHTS = {
  foreclosure: 100,
  note_sale: 95,
  permit_ready_sale: 92,
  developer_exit: 88,
  jv_solicitation: 84,
  sale: 78,
  recapitalization: 72,
  listing: 65,
  valuation: 45,
};

export function calculateResetPct(priorBasis, currentBasis) {
  if (priorBasis == null || currentBasis == null || String(priorBasis).trim() === "" || String(currentBasis).trim() === "") return null;
  const prior = Number(priorBasis);
  const current = Number(currentBasis);
  if (!Number.isFinite(prior) || !Number.isFinite(current) || prior <= 0 || current < 0) return null;
  return Math.round(((prior - current) / prior) * 1000) / 10;
}

function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function resetMagnitudeScore(resetPct) {
  if (resetPct == null) return 20;
  if (resetPct <= 0) return 5;
  return clamp(10 + resetPct * 1.15);
}

export function readinessScore({ permitCount = 0, projectCount = 0, hasIssuedPermit = false, demolitionComplete = false } = {}) {
  let score = 10;
  score += Math.min(permitCount, 4) * 9;
  score += Math.min(projectCount, 2) * 10;
  if (hasIssuedPermit) score += 22;
  if (demolitionComplete) score += 12;
  return clamp(score);
}

export function signalStrengthScore({ eventType, confidence = 70, ageDays = 0 } = {}) {
  const typeWeight = EVENT_WEIGHTS[eventType] ?? 40;
  const recency = Math.max(20, 100 - Math.max(0, ageDays) * 0.22);
  return clamp(typeWeight * 0.5 + Number(confidence) * 0.3 + recency * 0.2);
}

export function scoreBasisReset(input) {
  const resetPct = calculateResetPct(input.priorBasis, input.currentBasis);
  const reset = resetMagnitudeScore(resetPct);
  const readiness = readinessScore(input);
  const signal = signalStrengthScore(input);
  const basisVerified = resetPct != null;
  const opportunity = clamp(reset * 0.45 + readiness * 0.35 + signal * 0.20);
  return {
    basisVerified,
    resetPct,
    resetScore: reset,
    readinessScore: readiness,
    signalScore: signal,
    opportunityScore: opportunity,
    explanation: [
      resetPct == null ? "Basis unverified — reset magnitude unknown" : `Basis reset ${resetPct}%`,
      `readiness ${readiness}/100`,
      `signal ${signal}/100`,
    ].join("; "),
  };
}

export const BASIS_RESET_EVENT_TYPES = Object.freeze(Object.keys(EVENT_WEIGHTS));
