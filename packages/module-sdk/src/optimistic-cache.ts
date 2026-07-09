import type { CacheItem } from './cache/types.ts';
import type { FetchedItem } from './types.ts';

export type OptimisticCacheItemOverrides = Partial<
  Pick<CacheItem, 'is_temp' | 'dirty' | 'sync_status' | 'has_parent' | 'settings' | 'version' | 'created' | 'updated'>
>;

export function optimisticCacheItemFromItem(
  item: FetchedItem,
  overrides: OptimisticCacheItemOverrides = {}
): CacheItem {
  return {
    id: String(item.id),
    text: item.text ?? '',
    show_as_header: item.show_as_header,
    custom_color: item.custom_color,
    copied_from_record: item.copied_from_record,
    original_template_id: item.original_template_id,
    is_temp: true,
    dirty: true,
    sync_status: 'pending',
    additionals: item.additionals,
    computed_additionals: item.computed_additionals,
    settings: item.settings as Record<string, unknown> | undefined,
    module_settings: item.module_settings,
    permissions: item.permissions,
    ...overrides
  };
}
