/**
 * Shared create/edit project validation schema.
 *
 * Lives in a plain (non-`'use server'`) module so it can be exported as a value
 * and imported by BOTH the create action (`new/actions.ts`) and the edit action
 * + edit form (`[id]/actions.ts`, `[id]/edit/edit-form.tsx`). A `'use server'`
 * file may only export async functions, so the schema cannot live in an actions
 * file. Edit omits `pools` (it never changes pool selection); otherwise the
 * rules are identical, keeping create + edit in lock-step.
 */

import { z } from 'zod';

const skillSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  proficiency_id: z.number().int().min(23).max(27),
  must_have: z.boolean(),
});

const languageSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
});

export const createProjectSchema = z.object({
  title: z.string().min(2).max(160),
  functionNameId: z.number().int().positive(),
  functionNameLabel: z.string().min(1).max(160),
  // 8vance function-level ids are large (e.g. 29-36), not a 1-8 ordinal.
  functionLevel: z.number().int().positive(),
  // Optional minimum years of experience the role expects (0 = no minimum).
  // NOT persisted (no schema column) — threaded into the immediate match only.
  minYearsExperience: z.number().int().min(0).max(50),
  locationCity: z.string().min(1).max(120),
  locationCountry: z.string().min(1).max(120),
  locationProvince: z.string().max(120).optional().nullable(),
  locationLat: z.string().max(40).optional().nullable(),
  locationLng: z.string().max(40).optional().nullable(),
  skills: z.array(skillSchema).min(3).max(20),
  languages: z.array(languageSchema).max(10),
  educationLevel: z.string().max(40).optional().nullable(),
  pools: z.array(z.string().min(1)).min(1).max(20),
});
