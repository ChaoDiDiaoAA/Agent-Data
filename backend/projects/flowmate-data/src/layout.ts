/** Display paths are deliberately independent of full source identities. */
export function datasetAlias(id: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('INVALID_DATASET_ID');
  return id === 'voxel51-hq-invoice-ocr' ? 'voxel51' : id;
}
export function sampleDirectory(datasetId: string, sampleId: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sampleId)) throw new Error('INVALID_SAMPLE_ID');
  return `${datasetAlias(datasetId)}/${sampleId}`;
}
export function datasetTasks(datasetId: string): string { return `tasks/${datasetAlias(datasetId)}`; }
