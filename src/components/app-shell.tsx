"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Dashboard", icon: "M3 12l9-8 9 8M5 10v10h14V10" },
  { href: "/speaking", label: "Speaking", icon: "M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3" },
  { href: "/listening", label: "Listening", icon: "M4 14v-2a8 8 0 0116 0v2M4 14h3v6H4zM17 14h3v6h-3z", soon: true },
  { href: "/reading", label: "Reading", icon: "M4 5h7a2 2 0 012 2v12a2 2 0 00-2-2H4zM20 5h-7a2 2 0 00-2 2v12a2 2 0 012-2h7z", soon: true },
  { href: "/writing", label: "Writing", icon: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4", soon: true },
  { href: "/history", label: "History", icon: "M12 8v4l3 2M3 12a9 9 0 1018 0 9 9 0 00-18 0" },
  { href: "/settings", label: "Settings", icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-2.7-1.1l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 004 15H3a2 2 0 110-4h.1A1.6 1.6 0 004.6 8.3l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 0010 4.4V3a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const inExam = path.startsWith("/speaking/exam/");
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  if (inExam) return <>{children}</>;
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-zinc-200 bg-white px-3 py-5 lg:flex">
        <Link href="/" className="mb-8 flex items-center gap-2 px-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-900 text-sm font-bold text-white">B9</span>
          <span className="font-semibold tracking-tight">Band Nine</span>
        </Link>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${active(n.href) ? "bg-zinc-100 font-medium text-zinc-900" : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900"}`}>
              <Icon d={n.icon} />
              <span className="flex-1">{n.label}</span>
              {n.soon && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">Soon</span>}
            </Link>
          ))}
        </nav>
        <div className="mt-auto px-3 text-xs leading-5 text-zinc-400">Band estimates are AI-generated practice feedback, not official IELTS scores.</div>
      </aside>
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-zinc-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-zinc-900 text-xs font-bold text-white">B9</span>
          <span className="font-semibold">Band Nine</span>
        </Link>
        <Link href="/settings" className="text-zinc-500" aria-label="Settings">
          <Icon d={NAV[6].icon} />
        </Link>
      </header>
      <main className="pb-24 lg:pb-10 lg:pl-60">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">{children}</div>
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-zinc-200 bg-white lg:hidden">
        {NAV.slice(0, 6).filter((n) => n.href !== "/history").map((n) => (
          <Link key={n.href} href={n.href} className={`flex flex-col items-center gap-1 py-2.5 text-[11px] ${active(n.href) ? "text-zinc-900" : "text-zinc-400"}`}>
            <Icon d={n.icon} />
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
