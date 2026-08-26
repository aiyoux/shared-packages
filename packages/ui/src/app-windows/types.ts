export type AppWindowRoleDef<R extends string = string> = {
	id: R;
	label: string;
	/** At least one leaf of this role must remain (canvas, document). */
	required?: boolean;
	/** When false, splitting never auto-picks this role (timeline, git). */
	autoPick?: boolean;
};

export type AppWindowLeaf<R extends string = string> = {
	role: R;
};
