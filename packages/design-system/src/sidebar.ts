import type { Component } from 'svelte';

export type SidebarNavItem = {
    id: string;
    href: string;
    label: string;
    icon: Component<{ size?: number }>;
    show?: boolean;
    active?: boolean;
    onclick?: (event: MouseEvent) => void;
  };
