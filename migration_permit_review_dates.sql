-- Capture SDCI plan-review milestone dates that the feed already exposes but we
-- previously discarded: when plan review completed and when the permit became
-- ready to issue. Used by the Construction Permit Timeline to show "when reviews
-- were completed" precisely instead of inferring it.
ALTER TABLE permits ADD COLUMN plan_review_complete_date DATE;
ALTER TABLE permits ADD COLUMN ready_to_issue_date DATE;

CREATE INDEX IF NOT EXISTS idx_permits_plan_review_complete_date ON permits(plan_review_complete_date);
