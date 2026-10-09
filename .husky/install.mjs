import { existsSync } from 'node:fs';

// Hooks are for source contributors, never for CI or production consumers.
if (
  process.env.HUSKY !== '0' &&
  !process.env.CI &&
  process.env.NODE_ENV !== 'production' &&
  existsSync('.git')
) {
  const { default: husky } = await import('husky');
  const error = husky();
  if (error) throw new Error(error);
}
