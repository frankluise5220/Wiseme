export default function SettingsLoading() {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="h-4 w-28 rounded bg-slate-200" />
        <div className="mt-2 h-3 w-56 rounded bg-slate-100" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="h-4 w-20 rounded bg-slate-200" />
          <div className="mt-4 space-y-2">
            <div className="h-10 rounded bg-slate-100" />
            <div className="h-10 rounded bg-slate-100" />
            <div className="h-10 rounded bg-slate-100" />
          </div>
        </div>
        <div className="min-h-[420px] rounded-lg border border-slate-200 bg-white p-4">
          <div className="h-4 w-32 rounded bg-slate-200" />
          <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
            <div className="h-64 rounded bg-slate-100" />
            <div className="h-64 rounded bg-slate-100" />
          </div>
        </div>
      </div>
    </div>
  );
}
