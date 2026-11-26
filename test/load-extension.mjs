import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));

export async function loadExtension(name) {
  const outfile = path.join(root, 'out-test', `${name}.cjs`);
  await build({
    absWorkingDir: root,
    stdin: {
      contents: `module.exports = {
        ...require('./src/extension'),
        ...require('./src/jupyterApi'),
        ...require('./src/mcpServer'),
        ...require('./src/clusterControl'),
        vscode: require('vscode'),
      };`,
      resolveDir: root,
    },
    alias: { vscode: './test/vscode-stub.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
  });
  return require(outfile);
}

export async function tempHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'jmcp-home-'));
  const key = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const original = process.env[key];
  process.env[key] = home;
  return {
    home,
    async dispose() {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
      await rm(home, { recursive: true, force: true });
    },
  };
}
