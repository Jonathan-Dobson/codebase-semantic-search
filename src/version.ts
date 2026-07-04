/**
 * Single source of truth for the package version.
 *
 * Both the CLI (`codesearch --version`) and the MCP server (its
 * `serverInfo.version` field, which MCP clients use to identify the
 * server) need to report the package version. Hardcoding that string in
 * two places is the bug we're fixing — when the package is bumped in
 * `package.json`, the reported version drifts unless both call sites get
 * edited in lockstep. Reading the value here, at module load, from
 * `package.json` collapses both to a single source.
 *
 * `createRequire` is used (rather than `import pkg from '../package.json'`)
 * because it survives every ESM/TS/Node combination without depending on
 * import-attribute syntax or `resolveJsonModule` emission behaviour.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PackageJson {
  name: string;
  version: string;
}

const pkg = require('../package.json') as PackageJson;

export const version: string = pkg.version;