import { createTrackingService, errorResponse, HttpError, json, readRawBody } from './_lib/cargoai.mjs';

export function makeHandler(dependencies) {
  return async request => {
    try {
      if (request.method !== 'POST') throw new HttpError(405, 'Use POST.');
      const service = createTrackingService(dependencies);
      const raw = await readRawBody(request);
      return json(await service.webhook(raw, request.headers.get('cargoai-api-key')));
    } catch (error) { return errorResponse(error); }
  };
}

export default makeHandler();
