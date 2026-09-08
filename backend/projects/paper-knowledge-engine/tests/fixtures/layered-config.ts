import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

interface LayeredFixtureOptions {
  root: string;
  dataLibrariesRoot?: string;
  backupLibrariesRoot?: string;
  pdfLibrariesRoot?: string;
  vaultsRoot?: string;
  localImportRoots?: { id: string; path: string }[];
  additionalLibraryIds?: string[];
}

/** Writes the real three-layer schema with only machine-owned fixture paths overridden. */
export async function writeLayeredConfigFixture(options: LayeredFixtureOptions) {
  const source = fileURLToPath(new URL('../../config', import.meta.url));
  const configRoot = join(options.root, 'config');
  await mkdir(configRoot, { recursive: true });

  const engine = YAML.parse(await readFile(join(source, 'engine.yaml'), 'utf8'));
  const machine = YAML.parse(await readFile(join(source, 'machine.local.yaml'), 'utf8'));
  const dataLibrariesRoot = resolve(options.dataLibrariesRoot ?? join(options.root, 'data-libraries'));
  const backupLibrariesRoot = resolve(options.backupLibrariesRoot ?? join(options.root, 'backup-libraries'));
  const vaultsRoot = resolve(options.vaultsRoot ?? join(options.root, 'vaults'));

  machine.roots = {
    data_libraries_root: dataLibrariesRoot,
    backup_libraries_root: backupLibrariesRoot,
    pdf_libraries_root: resolve(options.pdfLibrariesRoot ?? join(options.root, 'pdf-libraries')),
    vaults_root: vaultsRoot,
  };
  if (options.localImportRoots) engine.mineru.local_import.roots = options.localImportRoots;

  await Promise.all([
    writeFile(join(configRoot, 'engine.yaml'), YAML.stringify(engine)),
    writeFile(join(configRoot, 'machine.local.yaml'), YAML.stringify(machine)),
    ...['fsd', ...(options.additionalLibraryIds ?? [])].map(async (libraryId) => {
      await mkdir(join(configRoot, libraryId), { recursive: true });
      for (const name of ['library.yaml', 'query-matrix.yaml', 'paper-policy.yaml', 'categories.yaml']) {
        const body = await readFile(join(source, 'fsd', name), 'utf8');
        await writeFile(join(configRoot, libraryId, name), name === 'library.yaml'
          ? body.replace('library_id: fsd', `library_id: ${libraryId}`) : body);
      }
    }),
  ]);

  const dataRoot = win32.join(dataLibrariesRoot, 'fsd');
  return {
    dataRoot,
    pdfRoot: win32.join(machine.roots.pdf_libraries_root, 'fsd'),
    archiveRoot: win32.join(dataRoot, 'archive'),
    workRoot: win32.join(dataRoot, 'work'),
    backupRoot: win32.join(backupLibrariesRoot, 'fsd'),
    vaultRoot: win32.join(vaultsRoot, 'fsd'),
  };
}

export async function configureLayeredRuntimeFixture<T extends {
  projectRoot: string;
  paths: { pdfRoot: string; vaultRoot: string; stateRoot: string; tempRoot: string; backupRoot: string };
}>(fixture: T): Promise<T> {
  const layered = await writeLayeredConfigFixture({ root: fixture.projectRoot });
  Object.assign(fixture.paths, {
    pdfRoot: layered.pdfRoot,
    vaultRoot: layered.vaultRoot,
    stateRoot: layered.dataRoot,
    tempRoot: layered.workRoot,
    backupRoot: layered.backupRoot,
  });
  await Promise.all(Object.values(fixture.paths).map((path) => mkdir(path, { recursive: true })));
  return fixture;
}
