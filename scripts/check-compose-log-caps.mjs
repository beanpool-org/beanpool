#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let candidates = args.map(f => path.resolve(process.cwd(), f));

if (candidates.length === 0) {
  let tracked = [], others = [];
  try { tracked = execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim().split('\n'); } catch {}
  try { others = execSync('git ls-files --others --exclude-standard', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim().split('\n'); } catch {}
  candidates = [...tracked, ...others].filter(Boolean).map(f => path.resolve(REPO_ROOT, f));
}
const composeFiles = [...new Set(candidates)]
  .filter(f => /(?:^|\/)(?:docker-compose[^\/]*\.ya?ml|[^\/]*\.compose\.ya?ml)$/.test(f))
  .filter(f => existsSync(f));

const errors = [];
for (const file of composeFiles) {
  const lines = readFileSync(file, 'utf-8').split('\n');
  const anchorsWithMaxSize = new Set();

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/&([a-zA-Z0-9_-]+)/);
    if (!m) continue;
    const indent = lines[i].match(/^\s*/)[0].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim() || lines[j].trim().startsWith('#')) continue;
      if (lines[j].match(/^\s*/)[0].length <= indent) break;
      if (/max-size:\s*["']?\w+["']?/.test(lines[j])) anchorsWithMaxSize.add(m[1]);
    }
  }

  const rel = path.relative(REPO_ROOT, file);
  const displayPath = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
  let inServices = false, currentService = null, serviceHasCap = false, inLogging = false, loggingIndent = -1;
  const endService = () => {
    if (currentService && !serviceHasCap) errors.push(`${displayPath}: service "${currentService}" missing log cap`);
    currentService = null; serviceHasCap = false; inLogging = false; loggingIndent = -1;
  };

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent === 0) {
      if (inServices) endService();
      inServices = /^services:\s*$/.test(line.trim());
      continue;
    }
    if (!inServices) continue;
    if (indent === 2 && line.trim().endsWith(':')) {
      endService();
      currentService = line.trim().slice(0, -1);
      continue;
    }
    if (currentService) {
      const aliasMatch = line.match(/logging:\s*\*([a-zA-Z0-9_-]+)/);
      if (aliasMatch && anchorsWithMaxSize.has(aliasMatch[1])) serviceHasCap = true;
      if (/^logging:\s*$/.test(line.trim())) {
        inLogging = true; loggingIndent = indent;
      } else if (inLogging) {
        if (indent <= loggingIndent) inLogging = false;
        else if (/max-size:\s*["']?\w+["']?/.test(line)) serviceHasCap = true;
      }
    }
  }
  endService();
}

if (errors.length > 0) {
  console.error('❌ Compose log cap check failed:');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}
console.log('✓ All compose services have log caps configured');
