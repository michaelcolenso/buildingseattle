// Counting rule for aggregated permit value.
//
// SDCI attaches a redevelopment's whole valuation to each of its demolition
// permits: twelve "-DM" permits at 4747 30th Ave NE each declare the same
// $129,000,000, which summed to $1.548B. Totals therefore count a demolition
// permit's value only when no other permit at the same address already
// carries that exact value:
//
//   - a "-DM" permit whose value matches a non-demolition permit at the same
//     address is not counted (the construction permit carries it);
//   - among "-DM" permits sharing one value at an address, only the one with
//     the lowest id is counted;
//   - every other permit counts its declared value. Construction permits are
//     never de-duplicated: identical values there are usually separate
//     buildings (e.g. one permit per townhouse).
//
// Each permit's own page and API row keep SDCI's declared value; only sums
// use this rule. Keep the SQL and JS forms in step (tests/value_counting.test.js).

/**
 * SQL expression for one permit's counted value, for use inside SUM().
 * `alias` is the permits table alias in the surrounding query.
 */
export function countedValueSql(alias = "p") {
  return `(CASE WHEN ${alias}.permit_number LIKE '%-DM' AND ${alias}.address_id IS NOT NULL AND ${alias}.value > 0 AND EXISTS (
      SELECT 1 FROM permits dup
      WHERE dup.address_id = ${alias}.address_id AND dup.value = ${alias}.value AND dup.id <> ${alias}.id
        AND (dup.permit_number NOT LIKE '%-DM' OR dup.id < ${alias}.id))
    THEN 0 ELSE COALESCE(${alias}.value, 0) END)`;
}

function isDemolition(permit) {
  return /-DM$/i.test(String(permit?.permit_number || ""));
}

/**
 * Pure mirror of countedValueSql over in-memory permits. Returns a Map of
 * permit id -> counted value. `addressKey` picks the grouping key (address_id
 * by default; the Gumroad build groups by normalized address text).
 */
export function countedValues(permits, addressKey = (p) => p.address_id) {
  const rows = Array.isArray(permits) ? permits : [];
  const groups = new Map();
  for (const p of rows) {
    const key = addressKey(p);
    const value = Number(p.value) || 0;
    if (key == null || key === "" || value <= 0) continue;
    const groupKey = `${key}\u0000${value}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(p);
  }
  const counted = new Map();
  for (const p of rows) {
    const value = Number(p.value) || 0;
    const key = addressKey(p);
    let skip = false;
    if (isDemolition(p) && key != null && key !== "" && value > 0) {
      const peers = groups.get(`${key}\u0000${value}`) || [];
      skip = peers.some((q) => q !== p && q.id !== p.id && (!isDemolition(q) || Number(q.id) < Number(p.id)));
    }
    counted.set(p.id, skip ? 0 : value);
  }
  return counted;
}

/** Sum of counted values for a list of permits. */
export function countedTotal(permits, addressKey) {
  let total = 0;
  for (const v of countedValues(permits, addressKey).values()) total += v;
  return total;
}
