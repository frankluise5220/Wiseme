export default function InvestmentsLoading() {
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-transparent p-4 md:p-5">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-8 w-8 rounded-lg border border-slate-200 bg-white" />
            <div>
              <div className="h-5 w-24 rounded bg-slate-200" />
              <div className="mt-2 h-3 w-40 rounded bg-slate-100" />
            </div>
          </div>
          <div className="h-8 w-72 rounded-lg bg-slate-100" />
        </div>

        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
              <div className="h-3 w-16 rounded bg-slate-100" />
              <div className="mt-3 h-5 w-28 rounded bg-slate-200" />
            </div>
          ))}
        </div>

        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, groupIndex) => (
            <section key={groupIndex} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
                <div>
                  <div className="h-4 w-28 rounded bg-slate-200" />
                  <div className="mt-2 h-3 w-16 rounded bg-slate-100" />
                </div>
                <div className="grid grid-cols-3 gap-5">
                  <div className="h-8 w-20 rounded bg-slate-100" />
                  <div className="h-8 w-20 rounded bg-slate-100" />
                  <div className="h-8 w-16 rounded bg-slate-100" />
                </div>
              </div>
              <div className="divide-y divide-slate-100">
                {Array.from({ length: 2 }).map((_, rowIndex) => (
                  <div key={rowIndex} className="grid grid-cols-[minmax(0,1fr)_120px_120px_86px] items-center gap-3 px-4 py-3">
                    <div>
                      <div className="h-4 w-44 rounded bg-slate-200" />
                      <div className="mt-2 h-3 w-60 rounded bg-slate-100" />
                    </div>
                    <div className="ml-auto h-8 w-20 rounded bg-slate-100" />
                    <div className="ml-auto h-8 w-20 rounded bg-slate-100" />
                    <div className="ml-auto h-4 w-14 rounded bg-slate-100" />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
