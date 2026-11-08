ALTER TABLE discard_explanations ADD COLUMN commentary TEXT CHECK (commentary IS NULL OR json_valid(commentary));
