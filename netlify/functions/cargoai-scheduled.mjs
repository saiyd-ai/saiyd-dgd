import { createTrackingService } from './_lib/cargoai.mjs';

// Netlify scheduled functions do not accept public HTTP invocations in deployed sites.
// Keep this declaration when deploying; do not turn this into a public HTTP route.
export const config = { schedule: '@hourly' };

export default async () => {
  if (process.env.CONTEXT !== 'production' || process.env.CARGOAI_AUTO_SYNC_ENABLED !== 'true') return;
  const service = createTrackingService();
  if (!service.config.liveEnabled) return;
  await service.sync();
};
