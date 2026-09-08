"use client";

import { Leaf, ArrowUpRight, Search, Plus } from "lucide-react";
import { IntelligentDataEntry } from "./IntelligentDataEntry";

interface DashboardOverviewProps {
  totalNetWorth?: number;
  monthGrowth?: number;
  alphaPerformance?: number;
  goalPercentage?: number;
  isRedUp?: boolean;
  createAction?: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * DashboardOverview - The main Japandi-style dashboard content.
 * Features a Bento Grid layout for high-level financial metrics and trends.
 */
export function DashboardOverview({
  totalNetWorth = 0,
  monthGrowth = 0,
  alphaPerformance = 18.2,
  goalPercentage = 68,
  isRedUp = true,
  createAction
}: DashboardOverviewProps) {
  const pnlCls = monthGrowth > 0 ? (isRedUp ? "text-accent-green" : "text-accent-clay") : (isRedUp ? "text-accent-clay" : "text-accent-green");
  const pnlBgCls = monthGrowth > 0 ? "bg-accent-green/10 border-accent-green/10" : "bg-accent-clay/10 border-accent-clay/10";

  return (
    <div className="flex-1 min-w-0 bg-[#F8F8FF]/50 overflow-y-auto custom-scrollbar relative">
      {/* ... [Rest of JSX] ... */}
      <div className="p-12 pb-32 max-w-7xl mx-auto">
        {/* ... [Hero/Bento] ... */}
        {/* Entry Section */}
        <IntelligentDataEntry createAction={createAction} />
      </div>
    </div>
  );
}
