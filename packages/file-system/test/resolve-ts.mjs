import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function resolve(specifier, context, nextResolve) {
	if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('/'))) {
		const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
		const base = path.dirname(parent);
		const abs = path.resolve(base, specifier);
		const asTs = abs.replace(/\.js$/, '.ts');
		if (existsSync(asTs)) {
			return nextResolve(pathToFileURL(asTs).href, context);
		}
	}
	return nextResolve(specifier, context);
}
