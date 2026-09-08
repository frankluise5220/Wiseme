-- Add a second anchor for twice-per-month and twice-per-year scheduled tasks.
ALTER TABLE "RegularInvestPlan" ADD COLUMN "secondaryExecutionDay" INTEGER;
