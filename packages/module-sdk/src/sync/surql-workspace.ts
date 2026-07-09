/**
 * Locates the modular-app checkout that owns `surql/manifest.toml` for
 * integration tests that need to load the server runtime into a scratch DB.
 *
 * The surql sources live in the app repo, not in this package. Historically
 * the shared packages were nested inside the app repo (`repos/shared-packages/…`)
 * and tests reached the manifest with a fixed number of `..` segments; after
 * the move to a standalone checkout that walk landed outside any repo.
 *
 * Resolution order:
 *   1. MODULAR_APP_ROOT env var (explicit override, e.g. CI).
 *   2. Walk up from this file looking for `surql/manifest.toml` (covers any
 *      layout where the package is vendored inside the app repo).
 *   3. A `modular-app` checkout sitting next to this shared-packages repo.
 *
 * Returns null when none match — callers should skip their suite, mirroring
 * the unreachable-DB skip, so runs without the app checkout stay green.
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_REL = 'surql/manifest.toml';

export function resolveSurqlWorkspaceRoot(fromDir: string): string | null {
  const override = process.env.MODULAR_APP_ROOT;
  if (override && existsSync(path.join(override, MANIFEST_REL))) {
    return override;
  }

  let dir = fromDir;
  for (;;) {
    if (existsSync(path.join(dir, MANIFEST_REL))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // packages/module-sdk/src/sync -> shared-packages root, then the sibling app checkout.
  const sibling = path.resolve(fromDir, '../../../..', '../modular-app');
  if (existsSync(path.join(sibling, MANIFEST_REL))) return sibling;

  return null;
}

/**
 * Applies every `[[runtime]]` module from the manifest, in manifest order,
 * through the caller-supplied sql executor. Other sections ([[test]],
 * [[maintenance]], …) are ignored — they are not loadable definitions.
 */
export async function loadManifestRuntime(
  workspaceRoot: string,
  sql: (query: string) => Promise<unknown>
): Promise<void> {
  const toml = await fs.readFile(path.join(workspaceRoot, MANIFEST_REL), 'utf8');
  const paths: string[] = [];
  let inRuntime = false;
  for (const line of toml.split('\n')) {
    const section = line.match(/^\s*\[\[(\w+)\]\]/);
    if (section) { inRuntime = section[1] === 'runtime'; continue; }
    if (!inRuntime) continue;
    const m = line.match(/^\s*path\s*=\s*"([^"]+)"/);
    if (m) paths.push(m[1]);
  }
  for (const rel of paths) {
    const body = await fs.readFile(path.join(workspaceRoot, rel), 'utf8').catch(() => null);
    if (body) await sql(body);
  }
}
