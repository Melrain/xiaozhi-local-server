import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <h1 className="text-sm font-medium tracking-tight">小智本地服务</h1>
        <Badge variant="live" className="ml-auto">
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          服务运行中
        </Badge>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:overflow-hidden">
        {children}
      </div>
    </div>
  );
}
