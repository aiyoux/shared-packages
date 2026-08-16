import { createDocument } from './schema.js';
import type { IgfxDocument, MotionTrack } from './types.js';

export const TEMPLATE_IDS = ['stat-trio', 'bar-compare', 'line-trend'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface TemplateInfo {
	id: TemplateId;
	name: string;
	description: string;
}

const TEMPLATE_INFO: TemplateInfo[] = [
	{ id: 'stat-trio', name: 'Stat trio', description: 'Three KPI stats with a title' },
	{ id: 'bar-compare', name: 'Bar comparison', description: 'Categorical bars with axis and legend' },
	{ id: 'line-trend', name: 'Line trend', description: 'Twelve-point series with an axis' }
];

function progressTrack(id: string, markId: string): MotionTrack {
	return {
		id,
		target: `mark:${markId}.progress`,
		keyframes: [
			{ tMs: 0, value: 0, easing: 'easeOut' },
			{ tMs: 800, value: 1 }
		]
	};
}

function titleOpacityTrack(): MotionTrack {
	return {
		id: 'title-in',
		target: 'mark:title.opacity',
		keyframes: [
			{ tMs: 0, value: 0 },
			{ tMs: 400, value: 1 }
		]
	};
}

function statTrio(): IgfxDocument {
	const doc = createDocument('Quarterly snapshot');
	doc.scalars = [
		{ id: 's-title', label: 'Title', type: 'string', value: 'Quarterly snapshot' },
		{ id: 's-a', label: 'Revenue', type: 'number', value: 128 },
		{ id: 's-b', label: 'NPS', type: 'number', value: 42 },
		{ id: 's-c', label: 'Retention', type: 'number', value: 96 }
	];
	doc.marks = [
		{
			id: 'title',
			kind: 'text',
			layout: { x: 80, y: 72, w: 1760, h: 80 },
			bindings: { text: { ref: 'scalar:s-title' } },
			style: { fontSize: 56 }
		},
		{
			id: 'kpi-a',
			kind: 'stat',
			layout: { x: 80, y: 280, w: 540, h: 400 },
			bindings: {
				value: { ref: 'scalar:s-a' },
				label: 'Revenue',
				prefix: '$',
				suffix: 'k'
			}
		},
		{
			id: 'kpi-b',
			kind: 'stat',
			layout: { x: 690, y: 280, w: 540, h: 400 },
			bindings: {
				value: { ref: 'scalar:s-b' },
				label: 'NPS'
			}
		},
		{
			id: 'kpi-c',
			kind: 'stat',
			layout: { x: 1300, y: 280, w: 540, h: 400 },
			bindings: {
				value: { ref: 'scalar:s-c' },
				label: 'Retention',
				suffix: '%'
			}
		}
	];
	doc.timeline.tracks = [
		progressTrack('grow-a', 'kpi-a'),
		progressTrack('grow-b', 'kpi-b'),
		progressTrack('grow-c', 'kpi-c'),
		titleOpacityTrack()
	];
	return doc;
}

function barCompare(): IgfxDocument {
	const doc = createDocument('Regional sales');
	doc.scalars = [{ id: 's-title', label: 'Title', type: 'string', value: 'Regional sales' }];
	doc.datasets = [
		{
			id: 'sales',
			label: 'Sales',
			columns: [
				{ id: 'cat', label: 'Region', type: 'string' },
				{ id: 'n', label: 'Amount', type: 'number' }
			],
			rows: [
				{ cat: 'North', n: 42 },
				{ cat: 'South', n: 31 },
				{ cat: 'East', n: 55 },
				{ cat: 'West', n: 28 },
				{ cat: 'Central', n: 37 },
				{ cat: 'APAC', n: 49 }
			]
		}
	];
	doc.marks = [
		{
			id: 'title',
			kind: 'text',
			layout: { x: 80, y: 48, w: 1760, h: 72 },
			bindings: { text: { ref: 'scalar:s-title' } },
			style: { fontSize: 48 }
		},
		{
			id: 'axis',
			kind: 'axis',
			layout: { x: 160, y: 200, w: 1600, h: 720 },
			bindings: { forMark: 'bars' }
		},
		{
			id: 'bars',
			kind: 'bar',
			layout: { x: 160, y: 200, w: 1600, h: 720 },
			bindings: {
				category: { ref: 'dataset:sales.cat' },
				value: { ref: 'dataset:sales.n' }
			}
		},
		{
			id: 'legend',
			kind: 'legend',
			layout: { x: 80, y: 140, w: 400, h: 40 },
			bindings: { forMark: 'bars' }
		}
	];
	doc.timeline.tracks = [progressTrack('grow', 'bars'), titleOpacityTrack()];
	return doc;
}

function lineTrend(): IgfxDocument {
	const doc = createDocument('Monthly trend');
	doc.scalars = [{ id: 's-title', label: 'Title', type: 'string', value: 'Monthly trend' }];
	const values = [12, 18, 15, 22, 28, 25, 31, 36, 34, 40, 44, 48];
	doc.datasets = [
		{
			id: 'series',
			label: 'Series',
			columns: [
				{ id: 't', label: 'Month', type: 'number' },
				{ id: 'n', label: 'Value', type: 'number' }
			],
			rows: values.map((n, i) => ({ t: i + 1, n }))
		}
	];
	doc.marks = [
		{
			id: 'title',
			kind: 'text',
			layout: { x: 80, y: 48, w: 1760, h: 72 },
			bindings: { text: { ref: 'scalar:s-title' } },
			style: { fontSize: 48 }
		},
		{
			id: 'axis',
			kind: 'axis',
			layout: { x: 160, y: 200, w: 1600, h: 720 },
			bindings: { forMark: 'trend' }
		},
		{
			id: 'trend',
			kind: 'line',
			layout: { x: 160, y: 200, w: 1600, h: 720 },
			bindings: {
				x: { ref: 'dataset:series.t' },
				y: { ref: 'dataset:series.n' }
			}
		}
	];
	doc.timeline.tracks = [progressTrack('grow', 'trend'), titleOpacityTrack()];
	return doc;
}

const BUILDERS: Record<TemplateId, () => IgfxDocument> = {
	'stat-trio': statTrio,
	'bar-compare': barCompare,
	'line-trend': lineTrend
};

export function listTemplates(): TemplateInfo[] {
	return TEMPLATE_INFO.map((t) => ({ ...t }));
}

export function instantiateTemplate(id: TemplateId): IgfxDocument {
	const build = BUILDERS[id];
	if (!build) throw new Error(`Unknown template "${id}"`);
	return structuredClone(build());
}
