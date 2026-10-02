/**
 * Scale SVG path data by independent x/y factors. Shared by the bake utils
 * (render-projection scaling) and sticker bake (viewBox → on-page size) in
 * svg-sketcher, which carried verbatim copies.
 */
import { parsePath, stringifyPath } from './path.ts';
export function scalePathData(d: string, scaleX: number, scaleY: number): string {
    const commands = parsePath(d);

    for (const command of commands) {
        const type = command.type.toUpperCase();
        const args = command.args;

        if (type === 'H') {
            for (let i = 0; i < args.length; i++) args[i] *= scaleX;
            continue;
        }
        if (type === 'V') {
            for (let i = 0; i < args.length; i++) args[i] *= scaleY;
            continue;
        }
        if (type === 'A') {
            for (let i = 0; i + 6 < args.length; i += 7) {
                args[i] *= scaleX;
                args[i + 1] *= scaleY;
                args[i + 5] *= scaleX;
                args[i + 6] *= scaleY;
            }
            continue;
        }

        for (let i = 0; i + 1 < args.length; i += 2) {
            args[i] *= scaleX;
            args[i + 1] *= scaleY;
        }
    }

    return stringifyPath(commands);
}