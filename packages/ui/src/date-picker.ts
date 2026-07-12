import type { BaseOrVagueReference, VagueDayCode, VagueMonthCode, VagueYearCode, WeekModeCode } from './date';

export interface DatePickerValue {
  d?: BaseOrVagueReference<VagueDayCode, number>;
  m?: BaseOrVagueReference<VagueMonthCode, number>;
  w?: BaseOrVagueReference<string, number>;
  y?: BaseOrVagueReference<VagueYearCode, number>;
  wm?: WeekModeCode;
  ws?: number;
}
