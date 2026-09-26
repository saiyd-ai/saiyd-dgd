import { createTrackingService, errorResponse, HttpError, json, parseJson, readRawBody } from './_lib/cargoai.mjs';

export function makeHandler(dependencies) {
  return async request => {
    try {
      if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405, 'Use GET or POST.');
      const service = createTrackingService(dependencies);
      await service.authenticate(request);
      if (request.method === 'POST') {
        const origin = request.headers.get('origin');
        if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'Cross-site requests are not accepted.');
        const body = parseJson(await readRawBody(request, 1024));
        if (body.action !== 'sync' || Object.keys(body).some(key => !['action', 'awb'].includes(key))) throw new HttpError(400, 'Only sync with an optional saved AWB is supported. Callback URLs cannot be supplied.');
        const sync = await service.sync(body.awb);
        return json({ ...await service.list(), message: sync.message, sync });
      }
      return json(await service.list());
    } catch (error) { return errorResponse(error); }
  };
}

export default makeHandler();
