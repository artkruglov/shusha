-- Monthly model budget of a family (18 October 2026), before the friends beta.
--
-- A family that joins with a signup word costs the installation money on every message, and nothing
-- stopped one busy family from spending the whole beta budget. Each call of a family's turn now leaves a
-- row with its cost here (the model resolver names the family, as it names the chat of a group without a
-- family in migration 177); before a turn the UTC month's sum is compared with the family's budget, and
-- once it is used up the chat hears one notice a month and then silence.
--
-- NULL means no budget. New families get 5 dollars (about five times what the first family spent in
-- October 2026); the families already here keep no budget, so the installation's own family is never cut
-- off by this migration.
ALTER TABLE families ADD COLUMN monthly_model_budget_usd numeric(8, 2) DEFAULT 5.00
  CHECK (monthly_model_budget_usd IS NULL OR monthly_model_budget_usd >= 0);
UPDATE families SET monthly_model_budget_usd = NULL;

-- One row per billed call of a family's turn; kept as long as the familyless rows (40 days), so a whole
-- UTC month is always covered. A call the price table cannot price has a NULL cost.
CREATE TABLE family_model_spend (
  id bigserial PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  cost_usd numeric(12, 6)
);

CREATE INDEX family_model_spend_family_created ON family_model_spend (family_id, created_at);

-- The family already heard that this UTC month's budget is used up. Kept two months, then purged.
CREATE TABLE family_budget_notices (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  notified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, month)
);

ALTER TABLE family_model_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_model_spend FORCE ROW LEVEL SECURITY;
CREATE POLICY osinara_family_scope ON family_model_spend
  USING (osinara_family_row_visible(family_id)) WITH CHECK (osinara_family_row_visible(family_id));

ALTER TABLE family_budget_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_budget_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY osinara_family_scope ON family_budget_notices
  USING (osinara_family_row_visible(family_id)) WITH CHECK (osinara_family_row_visible(family_id));
