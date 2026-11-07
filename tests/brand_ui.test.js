import assert from "node:assert/strict";
import test from "node:test";
import { bsIcon, bsStatusPill, bsStatusSlug, bsTransition } from "../brand_ui.js";

test("bsStatusSlug accepts only the five source statuses", () => {
  for (const status of ["new", "pending", "active", "completed", "expired"]) {
    assert.equal(bsStatusSlug(status), status);
  }
  assert.equal(bsStatusSlug(" Active "), "active");
  assert.equal(bsStatusSlug("withdrawn"), "");
  assert.equal(bsStatusSlug(null), "");
});

test("bsStatusPill always renders the word and escapes it", () => {
  assert.equal(bsStatusPill("active", "Active"), '<span class="bs-status" data-status="active">Active</span>');
  assert.equal(bsStatusPill("withdrawn", "<b>x</b>"), '<span class="bs-status">&lt;b&gt;x&lt;/b&gt;</span>');
  assert.equal(bsStatusPill(null), '<span class="bs-status">Unknown</span>');
});

test("bsTransition joins two pills with a decorative arrow and an accessible label", () => {
  const html = bsTransition("pending", "active", "Pending", "Active");
  assert.match(html, /^<span class="bs-transition" role="img" aria-label="Pending to Active">/);
  assert.match(html, /data-status="pending">Pending<\/span><svg[^>]*aria-hidden="true"/);
  assert.match(html, /data-status="active">Active<\/span><\/span>$/);
});

test("bsIcon is decorative by default, labelled on request, empty for unknown names", () => {
  assert.match(bsIcon("search", 16), /^<svg class="bs-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"/);
  assert.match(bsIcon("search", 20, "Search"), /role="img" aria-label="Search"/);
  assert.equal(bsIcon("nope"), "");
});
