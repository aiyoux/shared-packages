<script lang="ts">
  import Primitive from '@shared-packages/design-system/Badge.svelte';
  import type { ComponentProps } from 'svelte';
  let props: ComponentProps<typeof Primitive> = $props();
</script>

<Primitive {...props} />
