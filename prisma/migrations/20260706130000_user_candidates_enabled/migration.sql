-- Whether an account may access the Candidates surface. NEW signups default
-- false (Projects only) so a random account can't browse/contact talent and
-- bypass the reveal-credit economics. Grandfather every EXISTING user to true so
-- current customers keep their access. ADMIN is always allowed in code.
ALTER TABLE "User" ADD COLUMN "candidatesEnabled" BOOLEAN NOT NULL DEFAULT false;
UPDATE "User" SET "candidatesEnabled" = true;
