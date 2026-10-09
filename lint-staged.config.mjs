// Restrict tasks to package files; local server/demo files are outside this repo.
export default {
  '{src,scripts,test}/**/*.{js,mjs,ts}': [
    'node node_modules/prettier/bin/prettier.cjs --write',
    'node node_modules/eslint/bin/eslint.js --max-warnings=0',
  ],
  '*.{md,json,yml,yaml}': 'node node_modules/prettier/bin/prettier.cjs --write --ignore-unknown',
  '{eslint.config,lint-staged.config,commitlint.config}.mjs': [
    'node node_modules/prettier/bin/prettier.cjs --write',
    'node node_modules/eslint/bin/eslint.js --max-warnings=0',
  ],
  '.husky/*.mjs': [
    'node node_modules/prettier/bin/prettier.cjs --write',
    'node node_modules/eslint/bin/eslint.js --max-warnings=0',
  ],
};
