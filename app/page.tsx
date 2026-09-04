import { AppShell } from '@/components/app-shell';
import { DeviceStatus } from '@/components/device-status';
import { ListenMonitor } from '@/components/listen-monitor';
import { RealtimeTester } from '@/components/realtime-tester';
import { ServiceEndpoints } from '@/components/service-endpoints';
import {
  getOtaUrl,
  getRealtimeConfig,
  getServerConfig,
  getUiUrl,
  getWebsocketUrl,
} from '@/lib/config';

export const dynamic = 'force-dynamic';

export default function Home() {
  const config = getServerConfig();
  const realtime = getRealtimeConfig();
  const otaUrl = getOtaUrl(config);
  const wsUrl = getWebsocketUrl(config);
  const uiUrl = getUiUrl(config);

  return (
    <AppShell>
      <div className='grid grid-cols-1 gap-4 md:h-full md:min-h-0 md:flex-1 md:grid-cols-12 md:grid-rows-[minmax(0,1.1fr)_minmax(0,1fr)_auto]'>
        <DeviceStatus className='md:col-span-7' />
        <ListenMonitor
          className='md:col-span-7'
          wsPort={config.wsPort}
        />
        <RealtimeTester
          className='md:col-span-5 md:col-start-8 md:row-span-2 md:row-start-1'
          wsPort={config.wsPort}
        />
        <ServiceEndpoints
          className='md:col-span-12'
          items={[
            {
              label: 'OTA HTTP',
              value: otaUrl,
              hint: `监听 ${config.otaPort} · /xiaozhi/ota/`,
            },
            {
              label: 'WebSocket',
              value: wsUrl,
              hint: `监听 ${config.wsPort} · /xiaozhi/v1/`,
            },
            {
              label: '界面',
              value: uiUrl,
              hint: 'npm run dev 同时拉起 UI / OTA / WS',
            },
            {
              label: '通告主机',
              value: config.advertiseHost,
              hint: '绑在 0.0.0.0，按局域网地址访问',
            },
            {
              label: 'Qwen-Omni Realtime',
              value: realtime.configured ? realtime.model : '未配置',
              hint: realtime.configured
                ? `音色 ${realtime.voice}`
                : '填 DASHSCOPE_API_KEY 与 WORKSPACE_ID',
            },
          ]}
        />
      </div>
    </AppShell>
  );
}
