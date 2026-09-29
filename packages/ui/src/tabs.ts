export interface TabItem {
  value: string;
  label: string;
  icon?: any;
  disabled?: boolean;
  onClose?: () => void;
  /** Optional stable test hook on the tab button (e2e/testid routing). */
  testId?: string;
}
