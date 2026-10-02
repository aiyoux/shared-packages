<script lang="ts">
  import Primitive from '@shared-packages/design-system/Input.svelte';
  import type { ComponentProps } from 'svelte';
  let { value = $bindable(''), ...rest }: ComponentProps<typeof Primitive> = $props();
</script>

<Primitive bind:value {...rest} />
