import { join } from 'node:path';
import type { LibraryPaths } from '../../src/shared/paths.ts';
import { asLibraryId } from '../../src/shared/identity.ts';
import { PDFDocument } from 'pdf-lib';

export async function archiveTestPdf(title = 'Archive fixture'): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(title); doc.setCreationDate(new Date('2026-01-01')); doc.setModificationDate(new Date('2026-01-01'));
  doc.addPage();
  return Buffer.from(await doc.save());
}

export function archiveContext(root: string) {
  const libraryPaths: LibraryPaths = { dataRoot: root, workRoot: join(root, 'work'), archiveRoot: join(root, 'archive'),
    operationsRoot: join(root, 'operations'), runsRoot: join(root, 'runs'), databasePath: join(root, 'library.sqlite'),
    backupRoot: join(root, 'backup'), vaultRoot: join(root, 'vault') };
  return { libraryPaths, libraryId: asLibraryId('fsd'), mineruVersion: '3.1.0', expectedVersion: '3.1.0' };
}
