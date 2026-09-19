// Shared web-ext options for build, lint, run and sign, so that every command
// packages exactly the same set of files.
module.exports = {
  ignoreFiles: [
    'README.md',
    'package.json',
    'package-lock.json',
    'test',
    'scripts',
    'web-ext-config.cjs',
  ],
  build: {
    overwriteDest: true,
    filename: 'sci-hub-opener.xpi',
  },
};
