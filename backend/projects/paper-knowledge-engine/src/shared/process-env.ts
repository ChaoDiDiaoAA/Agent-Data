/** Windows environment names are case-insensitive; never emit duplicate aliases. */
export function mergeProcessEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const source of [inherited, overrides]) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) env[platform === 'win32' ? key.toUpperCase() : key] = value;
    }
  }
  return env;
}
