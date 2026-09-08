export type LibraryId = string & { readonly __libraryId: unique symbol };

export function assertLibraryId(value: unknown): asserts value is LibraryId {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(value)) {
    throw Object.assign(new Error('INVALID_REQUEST'), { code: 'INVALID_REQUEST' });
  }
}

export function asLibraryId(value: unknown): LibraryId {
  assertLibraryId(value);
  return value;
}
