/**
 * Common loading skeleton for sidebar pages.
 * Renders immediately on view switch to reduce perceived blank-screen time.
 */
export default function Loading() {
  return (
    <div className="flex-1 min-h-0 flex flex-col p-4 md:p-5 animate-pulse">
      {/* Header bar skeleton */}
      <div className="flex h-14 items-center justify-between px-4 md:px-5 mb-4">
        <div className="flex items-center gap-3">
          <div className="h-5 w-32 bg-slate-100 rounded" />
          <div className="h-5 w-24 bg-slate-50 rounded" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-8 w-16 bg-slate-100 rounded-lg" />
        </div>
      </div>

      {/* Content area skeleton */}
      <div className="panel-surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-100">
        <div className="panel-header shrink-0 px-4 py-3 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="h-4 w-20 bg-slate-100 rounded" />
            <div className="h-4 w-32 bg-slate-50 rounded" />
          </div>
        </div>
        <div className="flex-1 p-4 space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <div className="h-3 w-24 bg-slate-50 rounded" />
              <div className="h-3 w-20 bg-slate-50 rounded" />
              <div className="h-3 flex-1 bg-slate-50 rounded" />
              <div className="h-3 w-16 bg-slate-50 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
