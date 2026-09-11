import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { run } = require('./eval.cjs');
const A = await import('../../src/detect/algorithm.ts');

// A document scene passes when the detected quad overlaps the labelled one by
// at least this much; a document-free scene passes only when nothing is found.
const THRESHOLD = 0.85;
const { pass, total } = await run('detect', A.detectQuad, THRESHOLD);
process.exitCode = pass === total ? 0 : 1;
