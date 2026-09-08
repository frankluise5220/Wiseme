import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadReadableTagsByRecentUse } from "@/lib/server/tag-scope";
import SettingsTagsClient from "./client";

export default async function TagsPage() {
  const { householdId } = await getHouseholdScope();
  const tags = await loadReadableTagsByRecentUse(householdId);

  return <SettingsTagsClient initialTags={tags} initialLoaded />;
}
