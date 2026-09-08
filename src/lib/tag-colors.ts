/**
 * 标签预设颜色，全项目唯一来源。
 * 标签设置页的选择面板与账户导入模板「标签」sheet 的说明都从这里取值，
 * 新增/调整颜色时两处自动保持一致。
 */
export const TAG_COLORS = [
  "#EF4444", "#F97316", "#F59E0B", "#EAB308", "#22C55E",
  "#14B8A6", "#3B82F6", "#6366F1", "#8B5CF6", "#EC4899",
  "#64748B", "#0EA5E9",
] as const;

export type TagColor = (typeof TAG_COLORS)[number];

/** 每个预设色的颜色名 i18n key（导入模板说明等需要文字描述颜色的场景共用）。 */
export const TAG_COLOR_NAME_KEYS: Record<TagColor, string> = {
  "#EF4444": "settings.tags.colorName.red",
  "#F97316": "settings.tags.colorName.orange",
  "#F59E0B": "settings.tags.colorName.amber",
  "#EAB308": "settings.tags.colorName.yellow",
  "#22C55E": "settings.tags.colorName.green",
  "#14B8A6": "settings.tags.colorName.teal",
  "#3B82F6": "settings.tags.colorName.blue",
  "#6366F1": "settings.tags.colorName.indigo",
  "#8B5CF6": "settings.tags.colorName.purple",
  "#EC4899": "settings.tags.colorName.pink",
  "#64748B": "settings.tags.colorName.gray",
  "#0EA5E9": "settings.tags.colorName.sky",
};
