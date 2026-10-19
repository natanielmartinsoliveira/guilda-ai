import { guild } from './guild';
import { studio } from './studio';
import { pipeline } from './pipeline';
export type { OfficeThemeId, OfficeTheme, OfficePalette, RoomPainter } from './types';
export const themes = { guild, studio, pipeline };
export function themeFor(id: string | undefined) {
  return id === 'studio' ? studio : id === 'pipeline' ? pipeline : guild;
}
