import { win32 } from 'node:path';

import { assertLibraryId, type LibraryId } from './identity.ts';
import type { MachineConfig } from '../types/config.ts';

export interface LibraryPaths {
  pdfRoot?: string;
  dataRoot: string;
  databasePath: string;
  archiveRoot: string;
  runsRoot: string;
  operationsRoot: string;
  workRoot: string;
  backupRoot: string;
  vaultRoot: string;
}

function safeRoot(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`INVALID_LIBRARY_PATH: ${field}`);
  }
  const windowsPath = value.replaceAll('/', '\\');
  const driveAbsolute = /^[A-Za-z]:\\/.test(windowsPath);
  const unc = windowsPath.startsWith('\\\\');
  const segments = driveAbsolute ? windowsPath.slice(3).split('\\') : unc ? windowsPath.slice(2).split('\\') : [];
  const invalidSegment = (segment: string) => segment === '.' || segment === '..' || /[<>:"|?*]/.test(segment);
  const missingUncAuthority = unc && (segments.length < 2 || !segments[0] || !segments[1]);
  const emptyInteriorSegment = segments.some((segment, index) => !segment && index < segments.length - 1);
  if ((!driveAbsolute && !unc) || missingUncAuthority || emptyInteriorSegment || segments.some(invalidSegment)) {
    throw new Error(`INVALID_LIBRARY_PATH: ${field}`);
  }
  return win32.normalize(windowsPath);
}

export function deriveLibraryPaths(machine: MachineConfig, libraryId: LibraryId): LibraryPaths {
  assertLibraryId(libraryId);
  const dataRoot = win32.join(safeRoot(machine.roots.dataLibrariesRoot, 'dataLibrariesRoot'), libraryId);

  return {
    dataRoot,
    pdfRoot: machine.roots.pdfLibrariesRoot === undefined
      ? win32.join(dataRoot, 'work', 'downloads')
      : win32.join(safeRoot(machine.roots.pdfLibrariesRoot, 'pdfLibrariesRoot'), libraryId),
    databasePath: win32.join(dataRoot, 'library.sqlite'),
    archiveRoot: win32.join(dataRoot, 'archive'),
    runsRoot: win32.join(dataRoot, 'runs'),
    operationsRoot: win32.join(dataRoot, 'operations'),
    workRoot: win32.join(dataRoot, 'work'),
    backupRoot: win32.join(safeRoot(machine.roots.backupLibrariesRoot, 'backupLibrariesRoot'), libraryId),
    vaultRoot: win32.join(safeRoot(machine.roots.vaultsRoot, 'vaultsRoot'), libraryId),
  };
}
