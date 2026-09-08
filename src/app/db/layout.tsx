export default function DbLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="h-screen flex flex-col">
      <header className="h-10 border-b border-slate-200 bg-slate-50 flex items-center px-4">
        <a href="/" className="text-sm font-bold text-slate-800">MMH</a>
        <span className="ml-2 text-xs text-slate-400">/ db</span>
      </header>
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}