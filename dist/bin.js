#!/usr/bin/env node
// bin.ts: the entry point. It refuses an old Node with one clear line before
// anything else loads (nodeVersion.ts), then loads the command (cli.ts).
// The command is loaded by a dynamic import because static imports run
// before this file's own code, and the relay client's imports would crash on
// an old Node before the check could speak.
import { nodeTooOld } from './nodeVersion.js';
const tooOld = nodeTooOld(process.versions.node);
if (tooOld) {
    process.stderr.write(`${tooOld}\n`);
    process.exit(1);
}
await import('./cli.js');
//# sourceMappingURL=bin.js.map