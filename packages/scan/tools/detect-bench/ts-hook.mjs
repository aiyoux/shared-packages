import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
    const url = new URL(specifier, context.parentURL);
    const ts = fileURLToPath(url).replace(/\.js$/, '.ts');
    if (fs.existsSync(ts)) return next(pathToFileURL(ts).href, context);
  }
  return next(specifier, context);
}
