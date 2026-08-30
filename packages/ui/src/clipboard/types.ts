export interface ClipboardItem<T = unknown> {
	id: string;
	type: string;
	label: string;
	data: T;
	textPreview?: string;
	createdAt: number;
}
