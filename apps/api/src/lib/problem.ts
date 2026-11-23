import { ERROR_CODES, PROBLEM_CONTENT_TYPE, httpStatusFor } from '@attend/contracts';
import type { ErrorCode, Problem } from '@attend/contracts';

/**
 * Every failure the API returns is an `ApiError`, rendered as RFC 9457 problem
 * details with a stable `code`. Route handlers throw; the error hook renders.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string;
  readonly errors?: { path: string; message: string }[];

  constructor(code: ErrorCode, detail?: string, errors?: { path: string; message: string }[]) {
    super(detail ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = httpStatusFor(code);
    this.detail = detail ?? defaultDetail(code);
    if (errors) this.errors = errors;
  }
}

function defaultDetail(code: ErrorCode): string {
  return code
    .toLowerCase()
    .split('_')
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

export function problemFor(error: ApiError, instance: string, requestId?: string): Problem {
  const problem: Problem = {
    type: `https://attend.local/problems/${error.code.toLowerCase()}`,
    title: titleFor(error.code),
    status: error.status,
    code: error.code,
    detail: error.detail,
    instance,
  };
  if (requestId) problem.requestId = requestId;
  if (error.errors) problem.errors = error.errors;
  return problem;
}

function titleFor(code: ErrorCode): string {
  return code
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export const PROBLEM_TYPE = PROBLEM_CONTENT_TYPE;
export { ERROR_CODES };
