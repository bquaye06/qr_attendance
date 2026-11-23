#!/usr/bin/env node
/**
 * Verifies that every named import from a workspace package actually exists in
 * that package's barrel. Catches the failure mode a typechecker would catch:
 * importing a symbol that was renamed or never exported.
 *
 * Usage: node scripts/check-exports.mjs
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = {
  '@attend/contracts': 'packages/contracts/src',
  '@attend/db': 'packages/db/src',
  '@attend/ui': 'packages/ui/src',
};

const SEARCH_ROOTS = ['apps/api/src', 'apps/web/src', 'packages/db/src', 'packages/contracts/src', 'packages/ui/src'];

function walk(dir, sink = []) {
  if (!existsSync(dir)) return sink;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, sink);
    else if (/\.(ts|tsx)$/u.test(entry.name)) sink.push(full);
  }
  return sink;
}

function exportedNames(root) {
  const names = new Set();
  for (const file of walk(root)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /^export\s+(?:declare\s+)?(?:const|let|type|function|class|interface|enum)\s+([A-Za-z0-9_]+)/gmu,
    )) {
      names.add(match[1]);
    }
    // `export * from './x.ts'` is followed because walk() covers the whole tree.
  }
  return names;
}

const exportsByPackage = Object.fromEntries(
  Object.entries(PACKAGES).map(([name, root]) => [name, exportedNames(root)]),
);

const IMPORT_RE = /import\s+(?:type\s+)?(?:([A-Za-z0-9_]+)\s*,\s*)?\{([^}]*)\}\s*from\s*['"](@attend\/[a-z]+)['"]/gsu;
const NAMESPACE_RE = /import\s+\*\s+as\s+[A-Za-z0-9_]+\s+from\s*['"](@attend\/[a-z]+)['"]/gsu;

let checked = 0;
const problems = [];

for (const root of SEARCH_ROOTS) {
  for (const file of walk(root)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const clause = match[2] ?? '';
      const pkg = match[3];
      const known = exportsByPackage[pkg];
      if (!known) {
        problems.push(`${file}: unknown workspace package ${pkg}`);
        continue;
      }
      for (const raw of clause.split(',')) {
        const name = raw.trim().split(/\s+as\s+/u)[0]?.trim();
        if (!name) continue;
        checked += 1;
        if (!known.has(name)) problems.push(`${file}: ${pkg} has no export named "${name}"`);
      }
    }
    for (const match of source.matchAll(NAMESPACE_RE)) {
      checked += 1;
      if (!exportsByPackage[match[1]]) problems.push(`${file}: unknown workspace package ${match[1]}`);
    }
  }
}

console.log(`checked ${checked} named import(s) from workspace packages`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error('  ' + problem);
  process.exit(1);
}
console.log('all named imports exist in their package barrels');
