import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DATASET_RELEASE,
  countLabel,
  displayName,
  formatCalendarDate,
  formatCount,
  isClosedPermitStatus,
  latestSourceEventDate,
  renderAlertCta,
  renderDatasetCta,
  roleLabel,
  roleList,
  statusLabel,
} from "../site_content.js";

const root = new URL("../gumroad/", import.meta.url);

// Minimal RFC 4180 reader: quoted fields may hold commas, quotes and newlines.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

test("DATASET_RELEASE matches the committed gumroad release files (update on every release)", () => {
  const version = readFileSync(new URL("VERSION.txt", root), "utf8");
  const field = (name) => version.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
  assert.equal(DATASET_RELEASE.version, field("Version"));
  assert.equal(DATASET_RELEASE.records, Number(field("Records").replace(/,/g, "")));
  assert.equal(DATASET_RELEASE.columns, Number(field("Columns")));
  assert.equal(DATASET_RELEASE.neighborhoods, Number(field("Neighborhoods")));
  assert.equal(DATASET_RELEASE.countedValue, Number(field("Total value").match(/\$([\d,]+)/)[1].replace(/,/g, "")));
  assert.equal(DATASET_RELEASE.declaredValue, Number(field("Declared value \\(raw sum\\)").match(/\$([\d,]+)/)[1].replace(/,/g, "")));
  assert.equal(new Date(`${DATASET_RELEASE.exportDate}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }), field("Export date"));

  const permits = parseCsv(readFileSync(new URL("buildingseattle_permits.csv", root), "utf8"));
  const header = permits[0];
  assert.equal(header.length, DATASET_RELEASE.columns);
  assert.equal(permits.length - 1, DATASET_RELEASE.records);
  const applied = header.indexOf("applied_date");
  const dates = permits.slice(1).map((row) => row[applied]).filter(Boolean).map((value) => value.slice(0, 10)).sort();
  assert.equal(DATASET_RELEASE.appliedFrom, dates[0]);
  assert.equal(DATASET_RELEASE.appliedThrough, dates.at(-1));

  const contractors = parseCsv(readFileSync(new URL("contractors.csv", root), "utf8"));
  assert.equal(DATASET_RELEASE.contractors, contractors.length - 1);
  assert.equal(parseCsv(readFileSync(new URL("buildingseattle_sample.csv", root), "utf8")).length - 1, DATASET_RELEASE.sampleRows);
});

test("countLabel pluralizes and adds thousands separators (audit E18)", () => {
  assert.equal(countLabel(1, "permit", "permits"), "1 permit");
  assert.equal(countLabel(0, "permit", "permits"), "0 permits");
  assert.equal(countLabel(1276, "permit"), "1,276 permits");
  assert.equal(countLabel("2", "address", "addresses"), "2 addresses");
  assert.equal(formatCount(1276), "1,276");
  assert.equal(formatCount("15581"), "15,581");
  assert.equal(formatCount("$4,000"), "$4,000");
});

test("displayName gives one display form for names and addresses (audit E17/G8)", () => {
  assert.equal(displayName("BELOTTI MCHUGH DSN\\CNST SR LLC"), "Belotti Mchugh Dsn/Cnst Sr LLC");
  assert.equal(displayName("BELOTTI MCHUGH DSN\\\\CNST SR LLC"), "Belotti Mchugh Dsn/Cnst Sr LLC");
  assert.equal(displayName("100 PINE ST, SEATTLE, WA"), "100 Pine St, Seattle, WA");
  assert.equal(displayName("SELLEN CONSTR CO INC"), "Sellen Constr CO INC");
  assert.equal(displayName("McKinstry Co"), "McKinstry Co");
  assert.equal(displayName("<img src=x>"), "<img src=x>");
  assert.equal(displayName("  "), "");
});

test("status and role enums become human labels (audit E16/E17)", () => {
  assert.equal(statusLabel("active"), "Active");
  assert.equal(statusLabel("COMPLETED"), "Completed");
  assert.equal(statusLabel("in_review"), "In review");
  assert.equal(statusLabel(""), "Unknown");
  assert.equal(roleLabel("owner"), "Owner");
  assert.equal(roleLabel(""), "Participant");
  assert.equal(roleList([{ role: "contractor" }, { role: "owner" }, { role: "contractor" }]), "Contractor, Owner");
  for (const status of ["completed", "Expired", "canceled", "closed"]) assert.equal(isClosedPermitStatus(status), true, status);
  for (const status of ["active", "pending", "new", ""]) assert.equal(isClosedPermitStatus(status), false, status);
});

test("formatCalendarDate keeps date-only values on their calendar day (audit E13)", () => {
  assert.equal(formatCalendarDate("2026-09-18"), "Sep 18, 2026");
  assert.equal(formatCalendarDate("2026-09-18", { month: "long" }), "September 18, 2026");
  // A UTC timestamp just after midnight is still the previous evening in Seattle.
  assert.equal(formatCalendarDate("2026-09-18 03:00:00"), "Sep 17, 2026");
  assert.equal(formatCalendarDate(null), "");
  assert.equal(formatCalendarDate("not a date"), "");
});

test("latestSourceEventDate ignores row-touch timestamps and placeholder dates (audit E14)", () => {
  assert.equal(latestSourceEventDate([
    { applied_date: "2026-01-02", updated_at: "2026-11-27 13:00:00" },
    { issued_date: "1900-01-01", completed_date: "2026-03-04" },
  ]), "2026-03-04");
  assert.equal(latestSourceEventDate([{ created_at: "2026-11-27" }]), null);
});

test("entity CTAs link the dataset with attribution and point alerts at an open permit (audit E5)", () => {
  const data = renderDatasetCta({ context: "neighborhood", subject: "Ballard permits", count: 771 });
  assert.match(data, /href="\/data\?utm_source=buildingseattle&amp;utm_medium=site&amp;utm_campaign=entity_cta&amp;utm_content=neighborhood"/);
  assert.match(data, /771 permits like the ones on this page/);
  assert.match(data, /15,581 records/);

  const open = renderAlertCta({ permits: [{ permit_number: "P-DONE", status: "completed" }, { permit_number: "P-OPEN", status: "active" }], subject: "1 Main St" });
  assert.match(open, /href="\/permits\/P-OPEN#permit-alerts"/);
  assert.doesNotMatch(open, /P-DONE/);
  assert.match(open, /href="\/alerts"/);

  const closed = renderAlertCta({ permits: [{ permit_number: "P-DONE", status: "completed" }] });
  assert.doesNotMatch(closed, /#permit-alerts/);
  assert.match(closed, /No open permits/);
  assert.match(closed, /href="\/alerts"/);
  assert.doesNotMatch(renderAlertCta({ permits: [], subject: "<b>x</b>" }), /<b>/);
});
