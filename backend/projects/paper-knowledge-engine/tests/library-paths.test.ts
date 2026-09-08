import test from 'node:test';
import assert from 'node:assert/strict';

import { asLibraryId } from '../src/shared/identity.ts';
import { deriveLibraryPaths } from '../src/shared/paths.ts';
import type { LibraryId } from '../src/shared/identity.ts';
import type { MachineConfig } from '../src/types/config.ts';

const machine = {
  roots: {
    dataLibrariesRoot: 'D:\\agent-data\\data\\paper-libraries',
    backupLibrariesRoot: 'D:\\agent-data\\backups\\paper-libraries',
    vaultsRoot: 'D:\\paper',
  },
  mineru: {},
} as MachineConfig;

test('derives the flat fsd runtime layout', () => {
  const paths = deriveLibraryPaths(machine, asLibraryId('fsd'));

  assert.equal(paths.dataRoot, 'D:\\agent-data\\data\\paper-libraries\\fsd');
  assert.equal(paths.databasePath, 'D:\\agent-data\\data\\paper-libraries\\fsd\\library.sqlite');
  assert.equal(paths.archiveRoot, 'D:\\agent-data\\data\\paper-libraries\\fsd\\archive');
  assert.equal(paths.runsRoot, 'D:\\agent-data\\data\\paper-libraries\\fsd\\runs');
  assert.equal(paths.operationsRoot, 'D:\\agent-data\\data\\paper-libraries\\fsd\\operations');
  assert.equal(paths.workRoot, 'D:\\agent-data\\data\\paper-libraries\\fsd\\work');
  assert.equal(paths.backupRoot, 'D:\\agent-data\\backups\\paper-libraries\\fsd');
  assert.equal(paths.vaultRoot, 'D:\\paper\\fsd');
});

test('rejects a forged library identity before it can escape configured roots', () => {
  assert.throws(
    () => deriveLibraryPaths(machine, '..\\escape' as LibraryId),
    /INVALID_REQUEST/,
  );
});

test('rejects unsafe configured roots instead of normalizing an escape', () => {
  const unsafeRoots = [
    'relative\\libraries',
    '\\paper-libraries',
    'D:paper-libraries',
    'D:\\agent-data\\.\\paper-libraries',
    'D:\\agent-data\\data\\..\\escape',
    `D:\\agent-data\\${String.fromCharCode(0)}paper-libraries`,
    '\\\\server',
    '\\\\?\\D:\\paper-libraries',
  ];
  for (const field of ['dataLibrariesRoot', 'backupLibrariesRoot', 'vaultsRoot', 'pdfLibrariesRoot'] as const) {
    for (const value of unsafeRoots) {
      const unsafeMachine = {
        ...machine,
        roots: { ...machine.roots, [field]: value },
      } as MachineConfig;
      assert.throws(
        () => deriveLibraryPaths(unsafeMachine, asLibraryId('fsd')),
        /INVALID_LIBRARY_PATH/,
        `${field} accepted ${JSON.stringify(value)}`,
      );
    }
  }
});

test('accepts complete UNC machine roots with a server and share', () => {
  const uncMachine = {
    ...machine,
    roots: {
      dataLibrariesRoot: '\\\\data-server\\paper-data',
      backupLibrariesRoot: '\\\\backup-server\\paper-backups',
      vaultsRoot: '\\\\vault-server\\paper-vaults',
    },
  } as MachineConfig;

  assert.deepEqual(deriveLibraryPaths(uncMachine, asLibraryId('fsd')), {
    pdfRoot: '\\\\data-server\\paper-data\\fsd\\work\\downloads',
    dataRoot: '\\\\data-server\\paper-data\\fsd',
    databasePath: '\\\\data-server\\paper-data\\fsd\\library.sqlite',
    archiveRoot: '\\\\data-server\\paper-data\\fsd\\archive',
    runsRoot: '\\\\data-server\\paper-data\\fsd\\runs',
    operationsRoot: '\\\\data-server\\paper-data\\fsd\\operations',
    workRoot: '\\\\data-server\\paper-data\\fsd\\work',
    backupRoot: '\\\\backup-server\\paper-backups\\fsd',
    vaultRoot: '\\\\vault-server\\paper-vaults\\fsd',
  });
});
