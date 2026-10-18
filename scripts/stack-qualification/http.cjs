'use strict';
const assert = require('node:assert/strict');
async function boundedBody(response, limit = 16384) {
  assert.ok(Number.isInteger(limit) && limit > 0);
  const reader = response.body?.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = limit - bytes;
        chunks.push(value.subarray(0, remaining));
        bytes += Math.min(value.byteLength, remaining);
        if (value.byteLength > remaining) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  return { body: Buffer.concat(chunks).toString('utf8'), bytes, truncated };
}
async function waitForFixture(
  url,
  {
    fetchImpl = fetch,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    record = () => {},
  } = {},
) {
  for (let attempt = 1; attempt <= 150; attempt++) {
    let observation = { attempt };
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(1000) });
      observation.status = response.status;
      const body = await boundedBody(response);
      let data;
      try {
        data = JSON.parse(body.body);
      } catch {
        /* Not the fixture response. */
      }
      const ready =
        response.status === 400 &&
        !body.truncated &&
        data?.ok === false &&
        data?.code === 'portal_hmac_method_invalid' &&
        Object.keys(data).length === 2;
      observation = { ...observation, status: response.status, ...body, ready };
      if (ready) {
        record(observation);
        return observation;
      }
    } catch (error) {
      observation.error = error.code ?? error.name;
    }
    record(observation);
    await pause(200);
  }
  throw new Error('Owned gateway fixture did not become ready');
}
module.exports = { boundedBody, waitForFixture };
