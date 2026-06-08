-- Migration: dealer vertical support
-- Run this in the Supabase SQL editor for project rszagzirtmwutfmntqrz

-- Add vertical column to hotels (if not already present)
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS vertical TEXT DEFAULT 'hotel';

-- Add dealer-specific profile columns
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS brands  JSONB DEFAULT '[]';
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS services JSONB DEFAULT '[]';

-- analyses table: dealer KPI columns stored in existing JSONB (no schema change needed)
-- sales_experience_index, aftersales_experience_index, sale_service_gap are returned
-- in the analysis JSON and displayed on the frontend; they are NOT stored as separate columns
-- (they are derived from categories.comercial / categories.taller).
-- If you want to persist them, add:
-- ALTER TABLE analyses ADD COLUMN IF NOT EXISTS sales_experience_index DECIMAL;
-- ALTER TABLE analyses ADD COLUMN IF NOT EXISTS aftersales_experience_index DECIMAL;
-- ALTER TABLE analyses ADD COLUMN IF NOT EXISTS sale_service_gap DECIMAL;
