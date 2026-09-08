-- Keep the persisted NAV date offset binary without deriving it from latest NAV availability.
UPDATE "FundProfile"
SET "navDateOffset" = CASE WHEN "navDateOffset" = 1 THEN 1 ELSE 0 END;

ALTER TABLE "FundProfile"
  ADD CONSTRAINT "FundProfile_navDateOffset_binary_check"
  CHECK ("navDateOffset" IN (0, 1));
