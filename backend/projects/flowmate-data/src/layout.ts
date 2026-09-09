/** Machine data paths stay flat; only the Obsidian projection uses Evidence. */
export const vaultEvidenceRoot = 'Evidence';
export const vaultIndexesRoot = `${vaultEvidenceRoot}/indexes`;
export const vaultIndexPath = `${vaultIndexesRoot}/overview.md`;
export const vaultInvoicesRoot = `${vaultEvidenceRoot}/invoices`;
export const vaultKnowledgeRoot = `${vaultEvidenceRoot}/knowledge`;
export const vaultReleasesRoot = `${vaultEvidenceRoot}/releases`;

export function datasetAlias(id: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('INVALID_DATASET_ID');
  return id === 'voxel51-hq-invoice-ocr' ? 'voxel51' : id;
}
export function sampleDirectory(datasetId: string, sampleId: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sampleId)) throw new Error('INVALID_SAMPLE_ID');
  return `${datasetAlias(datasetId)}/${sampleId}`;
}
export function datasetTasks(datasetId: string): string { return `tasks/${datasetAlias(datasetId)}`; }
