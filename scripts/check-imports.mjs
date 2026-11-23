#!/usr/bin/env node
/**
 * Cheap structural check: every relative import must resolve to a real file,
 * and every `@/…` alias import must resolve inside apps/web/src.
 *
 * This is not a typecheck (that needs the dependency tree installed); it catches
 * the failure mode that large multi-file changes actually hit — a renamed or
 * missing module path.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOTS = ['apps/api/src', 'apps/web/src', 'packages/contracts/src', 'packages/ui/src', 'packages/db/src'];
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.css', ''];
const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/gu;

let checked = 0;
const problems = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(ts|tsx|mjs)$/u.test(entry.name)) continue;
    inspect(full);
  }
}

function resolveSpecifier(spec, fromFile) {
  const candidates = [];
  if (spec.startsWith('@/')) {
    candidates.push(resolve('apps/web/src', spec.slice(2)));
  } else if (spec.startsWith('.')) {
    candidates.push(resolve(dirname(fromFile), spec));
  } else {
    return { external: true };
  }
  for (const base of candidates) {
    for (const extension of EXTENSIONS) {
      const candidate = base.endsWith(extension) && extension ? base : base + extension;
      if (existsSync(candidate) && statSync(candidate).isFile()) return { resolved: candidate };
      if (existsSync(join(base, `index${extension || '.ts'}`))) {
        return { resolved: join(base, `index${extension || '.ts'}`) };
      }
    }
  }
  return { resolved: null };
}

function inspect(file) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (!spec || spec.startsWith('node:') || spec.startsWith('http')) continue;
    checked += 1;
    const result = resolveSpecifier(spec, file);
    if (result.external) continue;
    if (!result.resolved) problems.push(`${file}: cannot resolve "${spec}"`);
  }
}

for (const root of ROOTS) if (existsSync(root)) walk(root);

console.log(`checked ${checked} import specifier(s)`);
if (problems.length > 0) {
  console.error(`\n${problems.length} unresolved import(s):`);
  for (const problem of problems) console.error('  ' + problem);
  process.exit(1);
}
console.log('all relative and @/ imports resolve');
