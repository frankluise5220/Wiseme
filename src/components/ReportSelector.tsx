'use client';

import { ChevronDown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

export interface ReportItem {
  value: string;
  label: string;
  href: string;
}

interface ReportSelectorProps {
  currentType: string;
  items: ReportItem[];
}

export function ReportSelector({ currentType, items }: ReportSelectorProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const currentReport = items.find((item) => item.value === currentType) ?? items[0];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex h-8 items-center gap-1.5 rounded-full bg-blue-600 px-4 text-xs font-medium text-white shadow-sm transition hover:bg-blue-700"
      >
        <span>{currentReport.label}</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
            {items.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => {
                  setOpen(false);
                  startTransition(() => router.push(item.href, { scroll: false }));
                }}
                disabled={isPending}
                className={`block w-full px-4 py-2 text-left text-xs transition disabled:cursor-wait disabled:opacity-60 ${
                  item.value === currentReport.value
                    ? "bg-blue-50 font-medium text-blue-700"
                    : "text-slate-700 hover:bg-slate-50"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
