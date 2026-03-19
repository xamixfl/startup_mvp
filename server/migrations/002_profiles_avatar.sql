-- Ensure profiles has a column for avatar URL/path.
-- Frontend expects `photo_URL` (legacy), API normalizes to `photo_url`.

alter table profiles
  add column if not exists photo_url text;

