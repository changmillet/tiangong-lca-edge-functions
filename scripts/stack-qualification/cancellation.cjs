'use strict';
const assert = require('node:assert/strict');

function cancellationEvidence({ stdout, stderr }, nonce) {
  assert.match(nonce, /^[A-Za-z0-9_-]{22}$/u, 'Expected the current signed request nonce');
  const events = [];
  for (const [stream, output] of Object.entries({ stdout, stderr })) {
    assert.equal(typeof output, 'string');
    for (const line of output.split(/\r?\n/u)) {
      const value = line.trim();
      let record;
      try {
        record = JSON.parse(value.startsWith('[Info] ') ? value.slice(7) : value);
      } catch {
        continue;
      }
      if (
        record === null ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        Object.keys(record).length !== 2 ||
        record.nonce !== nonce ||
        !['stack.request.abort', 'stack.response.cancel'].includes(record.event)
      )
        continue;
      if (!events.some((event) => event.stream === stream && event.event === record.event))
        events.push({ stream, event: record.event, nonce });
    }
  }
  return {
    nonce,
    requestAbort: events.some(({ event }) => event === 'stack.request.abort'),
    responseCancel: events.some(({ event }) => event === 'stack.response.cancel'),
    events,
  };
}

module.exports = { cancellationEvidence };
