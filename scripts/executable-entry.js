import { main } from '../src/main.js';

// Bundled as CommonJS for Node 22 SEA. The build banner installs a file-based
// require before bundled modules execute; only native/logging assets stay external.
void main().catch(error => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
