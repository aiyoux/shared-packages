import type { DateInformation } from './date';

export type DateDisplayStyle = 'mj' | 'mi' | 'sm' | 'n';

export interface DateAnchorAdditionalData {
  date_info: DateInformation;
  source_additional_id?: string;
  [key: string]: unknown;
}
