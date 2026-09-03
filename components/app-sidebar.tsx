"use client";

import { Cable, Wifi } from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

type Step = {
  id: string;
  title: string;
  body: string;
};

type GuideGroup = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  hint: string;
  steps: Step[];
};

type AppSidebarProps = {
  otaUrl: string;
  wsUrl: string;
};

export function AppSidebar({ otaUrl, wsUrl }: AppSidebarProps) {
  const groups = useMemo<GuideGroup[]>(
    () => [
      {
        id: "provision",
        label: "进入配网",
        icon: Wifi,
        hint: "开机后直接按住 BOOT，或连不上旧 Wi-Fi 失败 3 次，也会进配网。",
        steps: [
          {
            id: "provision-1",
            title: "按 RST 重启",
            body: "通电后按一下 RST（复位），或拔掉 USB 再插上。等屏幕亮起、蓝灯开始闪，表示正在连上次的 Wi-Fi。",
          },
          {
            id: "provision-2",
            title: "立刻按 BOOT",
            body: "蓝灯闪的时候按一下 BOOT 再松开。听到提示音后，板子不再连旧网络，会自己开配网热点。",
          },
          {
            id: "provision-3",
            title: "连 Xiaozhi 热点",
            body: "用手机或电脑连上名为 Xiaozhi-XXXX 的热点，没有密码。浏览器打开 http://192.168.4.1。",
          },
          {
            id: "provision-4",
            title: "填 2.4G Wi-Fi",
            body: "只支持 2.4G，不支持 5G 和要二次认证的网络。选好名称、输入密码后点连接。成功后大约 3 秒会自己重启。",
          },
        ],
      },
      {
        id: "connect",
        label: "开机连后端",
        icon: Cable,
        hint: "只有 OTA、没有「在线」就再短按 BOOT，或查 8000。连 OTA 都没有则查 8002。",
        steps: [
          {
            id: "connect-1",
            title: "确认服务已开",
            body: "这台电脑上 npm run dev 要在跑，板子和电脑在同一个局域网。",
          },
          {
            id: "connect-2",
            title: "正常开机，别进配网",
            body: "按 RST 或重新上电。蓝灯闪的时候不要按 BOOT，否则会重新配网。等它连上已经配好的 Wi-Fi。",
          },
          {
            id: "connect-3",
            title: "等它自动打 OTA",
            body: `连上 Wi-Fi 后，固件会自己请求 ${otaUrl}，拿回 WebSocket 地址。右侧「最近 OTA」出现设备，说明已经找到这台机器。`,
          },
          {
            id: "connect-4",
            title: "短按 BOOT 连 WS",
            body: `按一下 BOOT 再松开，打开音频通道，连上 ${wsUrl}。右侧变成「1 台在线」就成功了。`,
          },
        ],
      },
    ],
    [otaUrl, wsUrl],
  );

  const [activeId, setActiveId] = useState(groups[0].steps[0].id);
  const activeGroup = groups.find((group) =>
    group.steps.some((step) => step.id === activeId),
  );
  const activeStep = activeGroup?.steps.find((step) => step.id === activeId);

  return (
    <Sidebar>
      <SidebarHeader className="px-3 py-3">
        <p className="text-[11px] tracking-[0.18em] uppercase text-sidebar-foreground/60">
          XiaoZhi · ESP32-S3
        </p>
        <p className="text-sm font-medium text-sidebar-foreground">操作说明</p>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((group) => {
          const Icon = group.icon;
          return (
            <SidebarGroup key={group.id}>
              <SidebarGroupLabel>
                <Icon className="mr-2" />
                {group.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.steps.map((step, index) => (
                    <SidebarMenuItem key={step.id}>
                      <SidebarMenuButton
                        type="button"
                        isActive={step.id === activeId}
                        onClick={() => setActiveId(step.id)}
                        tooltip={step.title}
                      >
                        <span>{step.title}</span>
                      </SidebarMenuButton>
                      <SidebarMenuBadge>{index + 1}</SidebarMenuBadge>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter>
        <div className="rounded-md bg-sidebar-accent px-3 py-3 text-xs leading-6 text-sidebar-accent-foreground">
          <p className="font-medium">{activeStep?.title}</p>
          <p className="mt-1 break-all text-sidebar-foreground/70">
            {activeStep?.body}
          </p>
          {activeGroup ? (
            <p className="mt-2 text-sidebar-foreground/55">{activeGroup.hint}</p>
          ) : null}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
