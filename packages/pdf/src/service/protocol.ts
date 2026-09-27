import type { PdfInterpretResult, PdfPageSize } from '../types.js';
import type { EngineAssets, PdfEngineId, RenderFormat } from './engines.js';

export type PdfServiceRequest =
	| {
			type: 'open';
			reqId: number;
			docId: string;
			bytes: Uint8Array;
			engine: PdfEngineId;
			assets: EngineAssets;
	  }
	| { type: 'close'; docId: string }
	| { type: 'render'; reqId: number; docId: string; index: number; width: number; format?: RenderFormat }
	| {
			type: 'interpret';
			reqId: number;
			docId: string;
			index: number;
			target: { targetWidth: number; targetHeight: number };
	  };

export type PdfServiceResponse =
	| { type: 'opened'; reqId: number; sizes: PdfPageSize[] }
	| { type: 'rendered'; reqId: number; blob: Blob }
	| { type: 'interpreted'; reqId: number; result: PdfInterpretResult }
	| { type: 'failed'; reqId: number; message: string };
