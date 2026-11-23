import { z } from 'zod';
import { ERROR_CODES } from './errors.ts';

const errorCodeValues = Object.keys(ERROR_CODES) as [string, ...string[]];

/** RFC 9457 problem details, extended with a stable `code` and optional field errors. */
export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.enum(errorCodeValues),
  detail: z.string(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z
    .array(
      z.object({
        path: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});

export type Problem = z.infer<typeof ProblemSchema>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
