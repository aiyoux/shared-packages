<script lang="ts">
  import Primitive from '@shared-packages/design-system/Select.svelte';
  import type { ComponentProps } from 'svelte';
  let { value = $bindable(null), ...rest }: ComponentProps<typeof Primitive> = $props();
</script>

<Primitive bind:value {...rest} />
