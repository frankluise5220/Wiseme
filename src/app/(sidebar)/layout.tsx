import { Sidebar } from "@/components/layout/Sidebar";
import { AIPanel } from "@/components/layout/AIPanel";
import { BackgroundTaskStatusBar } from "@/components/BackgroundTaskStatusBar";
import { FirstUseGuide } from "@/components/FirstUseGuide";
import { MobileNavigation } from "@/components/layout/MobileNavigation";
import { MobilePullToRefresh } from "@/components/layout/MobilePullToRefresh";
import { getCurrentUser } from "@/lib/server/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function SidebarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/login");
  const cookieStore = await cookies();
  const aiPanelCollapsed = (() => {
    const value = cookieStore.get("mmh_ai_panel_collapsed")?.value;
    return value === "1" || value === "true";
  })();
  const sidebarCollapsed = cookieStore.get("sidebar_collapsed")?.value === "true";

  return (
    <div className="flex h-dvh overflow-x-hidden overflow-y-hidden">
      <BackgroundTaskStatusBar />
      <div className="hidden h-dvh shrink-0 md:block">
        <Suspense
          fallback={
            <div
              className={
                sidebarCollapsed
                  ? "h-dvh w-14 shrink-0 border-r border-foreground/5 bg-background"
                  : "h-dvh w-72 shrink-0 border-r border-foreground/5 bg-background"
              }
            />
          }
        >
          <Sidebar />
        </Suspense>
      </div>
      <main className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-hidden bg-background pb-[calc(5.75rem+env(safe-area-inset-bottom))] pt-[env(safe-area-inset-top)] md:p-0">
        <FirstUseGuide>{children}</FirstUseGuide>
      </main>
      <div className="hidden h-dvh shrink-0 xl:block">
        <AIPanel initialCollapsed={aiPanelCollapsed} />
      </div>
      <Suspense fallback={null}>
        <MobilePullToRefresh />
        <MobileNavigation />
      </Suspense>
    </div>
  );
}
