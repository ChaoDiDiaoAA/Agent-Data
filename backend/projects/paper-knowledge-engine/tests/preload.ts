import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Keep ordinary tests independent of production config and isolated per worktree.
// 96 hash bits distinguish worktrees without exhausting Windows' nested path budget.
const projectKey = createHash('sha256').update(resolve(process.cwd())).digest('hex').slice(0, 24);
const testRoot = process.env.FSD_TEST_ROOT !== undefined
  ? resolve(process.env.FSD_TEST_ROOT)
  : resolve(tmpdir(), 'pke-tests', projectKey);
mkdirSync(testRoot, { recursive: true });

process.env.FSD_TEST_ROOT = testRoot;
process.env.TEMP = testRoot;
process.env.TMP = testRoot;
process.env.FSD_OFFLINE_TESTS ??= '1';
