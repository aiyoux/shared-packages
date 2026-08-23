export type HostDisk = { name: string; used: number; total: number };

export type HostSnapshot = {
	cpu_pct: number;
	mem_used: number;
	mem_total: number;
	disks: HostDisk[];
};

export function memPct(s: HostSnapshot): number {
	if (!s.mem_total) return 0;
	return (s.mem_used / s.mem_total) * 100;
}

export function diskPct(s: HostSnapshot): number {
	let used = 0;
	let total = 0;
	for (const d of s.disks) {
		used += d.used;
		total += d.total;
	}
	if (!total) return 0;
	return (used / total) * 100;
}

export function pct(n: number): string {
	return `${n.toFixed(1)}%`;
}
