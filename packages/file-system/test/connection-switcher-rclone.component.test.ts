/**
 * Multi-backend ConnectionSwitcher: rclone chips + stable conn-b2* testids.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ConnectionSwitcher from '../src/b2/ConnectionSwitcher.svelte';

describe('ConnectionSwitcher multi-backend', () => {
	it('switcher.menu: local/disk options and rclone settings when showRclone and zero profiles', () => {
		render(ConnectionSwitcher, {
			props: {
				activeId: 'local',
				profiles: [],
				rcloneProfiles: [],
				showRclone: true
			}
		});
		expect(screen.getByTestId('connection-switcher')).toBeTruthy();
		expect(screen.getByTestId('conn-trigger')).toBeTruthy();
		expect(screen.getByTestId('conn-settings')).toBeTruthy();
		expect(screen.getByTestId('conn-local')).toBeTruthy();
		expect(screen.getByTestId('conn-disk')).toBeTruthy();
		expect(screen.getByTestId('conn-disk-config')).toBeTruthy();
		expect(screen.getByTestId('conn-rclone')).toBeTruthy();
		expect(screen.getByTestId('conn-rclone-config')).toBeTruthy();
	});

	it('switcher.chips: conn-rclone-profile with data-profile-id', () => {
		render(ConnectionSwitcher, {
			props: {
				activeId: 'r1',
				activeKind: 'rclone',
				rcloneProfiles: [{ id: 'r1', name: 'Home', detail: 'home:' }],
				showRclone: true
			}
		});
		const chip = screen.getByTestId('conn-rclone-profile');
		expect(chip.getAttribute('data-profile-id')).toBe('r1');
		expect(chip.classList.contains('active')).toBe(true);
		expect(screen.queryByTestId('conn-rclone')).toBeNull();
	});

	it('switcher.b2Stable: conn-b2* unchanged with rclone present', () => {
		render(ConnectionSwitcher, {
			props: {
				activeId: 'b1',
				activeKind: 'b2',
				profiles: [{ id: 'b1', name: 'Bucket', detail: 'my-bucket' }],
				rcloneProfiles: [{ id: 'r1', name: 'RC', detail: 'remote:' }],
				showRclone: true
			}
		});
		expect(screen.getByTestId('connection-switcher')).toBeTruthy();
		expect(screen.getByTestId('conn-local')).toBeTruthy();
		expect(screen.getByTestId('conn-b2-profile')).toBeTruthy();
		expect(screen.getByTestId('conn-b2-profile').getAttribute('data-profile-id')).toBe('b1');
		expect(screen.getByTestId('conn-b2-config')).toBeTruthy();
		// Placeholder only when zero B2 profiles
		expect(screen.queryByTestId('conn-b2')).toBeNull();
		// rclone chips also present
		expect(screen.getByTestId('conn-rclone-profile')).toBeTruthy();
		expect(screen.getByTestId('conn-rclone-config')).toBeTruthy();
	});

	it('switcher.b2Stable: zero B2 profiles still exposes conn-b2 + conn-b2-config', () => {
		render(ConnectionSwitcher, {
			props: {
				activeId: 'local',
				profiles: [],
				rcloneProfiles: [],
				showRclone: true
			}
		});
		expect(screen.getByTestId('conn-b2')).toBeTruthy();
		expect(screen.getByTestId('conn-b2-config')).toBeTruthy();
	});

	it('switcher.busy: busy disables all chips; ignore re-entrant select', async () => {
		const onSelect = vi.fn();
		const onConfigureB2 = vi.fn();
		const onConfigureRclone = vi.fn();
		render(ConnectionSwitcher, {
			props: {
				activeId: 'local',
				busy: true,
				profiles: [{ id: 'b1', name: 'B2' }],
				rcloneProfiles: [{ id: 'r1', name: 'RC' }],
				showRclone: true,
				onSelect,
				onConfigureB2,
				onConfigureRclone
			}
		});

		const local = screen.getByTestId('conn-local') as HTMLButtonElement;
		const b2 = screen.getByTestId('conn-b2-profile') as HTMLButtonElement;
		const rc = screen.getByTestId('conn-rclone-profile') as HTMLButtonElement;
		const b2Cfg = screen.getByTestId('conn-b2-config') as HTMLButtonElement;
		const rcCfg = screen.getByTestId('conn-rclone-config') as HTMLButtonElement;

		expect(local.disabled).toBe(true);
		expect(b2.disabled).toBe(true);
		expect(rc.disabled).toBe(true);
		expect(b2Cfg.disabled).toBe(true);
		expect(rcCfg.disabled).toBe(true);

		await fireEvent.click(local);
		await fireEvent.click(b2);
		await fireEvent.click(rc);
		await fireEvent.click(b2Cfg);
		await fireEvent.click(rcCfg);

		expect(onSelect).not.toHaveBeenCalled();
		expect(onConfigureB2).not.toHaveBeenCalled();
		expect(onConfigureRclone).not.toHaveBeenCalled();
	});

	it('switcher.featureOff: hide rclone; local + B2 remain', () => {
		render(ConnectionSwitcher, {
			props: {
				activeId: 'local',
				profiles: [],
				rcloneProfiles: [{ id: 'r1', name: 'Hidden' }],
				showRclone: false
			}
		});
		expect(screen.getByTestId('conn-local')).toBeTruthy();
		expect(screen.getByTestId('conn-b2')).toBeTruthy();
		expect(screen.getByTestId('conn-b2-config')).toBeTruthy();
		expect(screen.queryByTestId('conn-rclone')).toBeNull();
		expect(screen.queryByTestId('conn-rclone-profile')).toBeNull();
		expect(screen.queryByTestId('conn-rclone-config')).toBeNull();
	});

	it('info control lists enabled and disabled caps for the active connection', () => {
		render(ConnectionSwitcher, {
			props: {
				activeId: 'local',
				activeKind: 'local',
				capabilities: {
					supportsTrash: true,
					supportsSoftDelete: true,
					supportsRename: true,
					supportsMove: true,
					supportsCopy: true,
					supportsMkdir: true,
					supportsUpload: false,
					supportsDownload: true,
					supportsSiblingOrder: true,
					supportsDragOut: true
				}
			}
		});
		expect(screen.getByTestId('conn-caps-info')).toBeTruthy();
		const tip = screen.getByTestId('conn-caps-tooltip');
		expect(tip.textContent).toMatch(/Trash/);
		expect(tip.textContent).toMatch(/Select file \/ drop from PC/);
		expect(tip.textContent).toMatch(/Drag to reorder/);
		const trash = [...tip.querySelectorAll('li')].find((el) => el.textContent?.includes('Trash'));
		const upload = [...tip.querySelectorAll('li')].find((el) =>
			el.textContent?.includes('Select file')
		);
		expect(trash?.getAttribute('data-on')).toBe('1');
		expect(upload?.getAttribute('data-on')).toBe('0');
	});

	it('tooltip documents the live copy path for the current pane pair', () => {
		render(ConnectionSwitcher, {
			props: {
				activeId: 'p1',
				activeKind: 'b2',
				profiles: [{ id: 'p1', name: 'photos' }],
				copyOtherLabel: 'Monitor · home',
				copyOut: {
					kind: 'dual-phase',
					summary: 'Dual-phase: B2 · photos → this device → Monitor · home',
					detail: 'Download first, then upload. A confirm popup appears before it starts.'
				},
				copyIn: {
					kind: 'dual-phase',
					summary: 'Dual-phase: Monitor · home → this device → B2 · photos',
					detail: 'Download first, then upload.'
				}
			}
		});
		const path = screen.getByTestId('conn-copy-path');
		expect(path.textContent).toMatch(/Copy path/);
		expect(path.textContent).toMatch(/To Monitor · home/);
		expect(path.textContent).toMatch(/Dual-phase/);
		expect(path.querySelector('[data-copy-kind="dual-phase"]')).toBeTruthy();
	});

	it('onSelect / onConfigureRclone fire when not busy', async () => {
		const onSelect = vi.fn();
		const onConfigureRclone = vi.fn();
		render(ConnectionSwitcher, {
			props: {
				activeId: 'local',
				rcloneProfiles: [{ id: 'r1', name: 'Home' }],
				showRclone: true,
				onSelect,
				onConfigureRclone
			}
		});
		await fireEvent.click(screen.getByTestId('conn-rclone-profile'));
		expect(onSelect).toHaveBeenCalledWith('r1');
		await fireEvent.click(screen.getByTestId('conn-rclone-config'));
		expect(onConfigureRclone).toHaveBeenCalled();
	});
});
