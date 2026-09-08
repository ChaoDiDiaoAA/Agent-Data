import { expect, test } from 'bun:test';
import { BunWindowsProcessAdapter } from '../src/platform/windows-process.ts';

test('process adapter rejects shell-like malformed command vectors', async () => { const adapter = new BunWindowsProcessAdapter(); await expect(adapter.launch([''], {})).rejects.toThrow(); });
