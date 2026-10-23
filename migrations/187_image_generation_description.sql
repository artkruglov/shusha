-- What was asked for a generated picture (19 October 2026), for the Mini App gallery «Мои картинки и файлы».
--
-- Until now only a hash of the request was kept: the gallery could show a date and nothing about the picture, and
-- a person could not find «чёрный апельсин» among twenty. The request's own words, cut to 300 characters, stay
-- with the operation in the same workspace as the picture, and go with it when the workspace is deleted.
ALTER TABLE image_generation_operations
  ADD COLUMN description text CHECK (description IS NULL OR char_length(description) <= 300);
