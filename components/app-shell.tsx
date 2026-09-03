"use client";

import type { CSSProperties, ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

type AppShellProps = {
  otaUrl: string;
  wsUrl: string;
  children: ReactNode;
};

export function AppShell({ otaUrl, wsUrl, children }: AppShellProps) {
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "18rem",
        } as CSSProperties
      }
    >
      <AppSidebar otaUrl={otaUrl} wsUrl={wsUrl} />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-4" />
          <h1 className="text-sm font-medium tracking-tight">小智本地服务</h1>
          <Badge variant="live" className="ml-auto">
            <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
            服务运行中
          </Badge>
        </header>
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-5 py-8">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
