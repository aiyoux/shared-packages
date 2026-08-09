<script lang="ts">
  import { cn } from './utils.ts';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';

  type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
  type Size = 'sm' | 'md' | 'lg' | 'icon';

  let {
    type = 'button',
    variant = 'primary',
    size = 'md',
    class: className = '',
    disabled = false,
    loading = false,
    onclick,
    children,
    ...rest
  }: {
    type?: 'button' | 'submit' | 'reset';
    variant?: Variant;
    size?: Size;
    class?: string;
    disabled?: boolean;
    loading?: boolean;
    onclick?: (event: MouseEvent) => void;
    children?: import('svelte').Snippet;
    [key: string]: any;
  } = $props();

  const variantClasses: Record<Variant, string> = {
    primary:
      'border border-white/15 bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 hover:border-white/30 hover:shadow-indigo-500/20 active:scale-[0.99]',
    secondary:
      'border border-white/10 bg-white/5 text-white hover:bg-white/10 hover:border-white/20 active:scale-[0.99]',
    ghost:
      'border border-white/8 bg-transparent text-zinc-300 hover:bg-white/5 hover:text-white hover:border-white/15 active:scale-[0.99]',
    danger:
      'border border-white/15 bg-red-600 text-white shadow-sm hover:bg-red-500 hover:border-white/30 hover:shadow-red-500/20 active:scale-[0.99]'
  };

  const sizeClasses: Record<Size, string> = {
    md: 'h-9 px-4 py-1.5 text-xs font-medium rounded-[6px]',
    sm: 'h-7 rounded-[4px] px-2.5 text-[11px] font-medium',
    lg: 'h-11 rounded-[8px] px-5 text-sm font-semibold',
    icon: 'h-9 w-9 rounded-[6px]'
  };
</script>


{#if rest.href}
  <a
    {...rest}
    {onclick}
    class={cn(
      'inline-flex appearance-none items-center justify-center gap-2 whitespace-nowrap rounded-[6px] font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400 disabled:pointer-events-none disabled:opacity-45 select-none',
      variantClasses[variant],
      sizeClasses[size],
      className
    )}
  >
    {#if children}
      {@render children()}
    {/if}
  </a>
{:else}
  <button
    {type}
    disabled={disabled || loading}
    {onclick}
    class={cn(
      'inline-flex appearance-none items-center justify-center gap-2 whitespace-nowrap rounded-[6px] font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400 disabled:pointer-events-none disabled:opacity-45 select-none',
      variantClasses[variant],
      sizeClasses[size],
      className
    )}
    {...rest}
  >
    {#if loading}
      <LoaderCircle class="size-4 animate-spin" />
    {/if}
    {#if children}
      {@render children()}
    {/if}
  </button>
{/if}
