/**
 * A mock Phoenix for end-to-end tests: an HTTP server that receives OTLP/HTTP protobuf exports (what
 * @opentelemetry/exporter-trace-otlp-proto sends) and decodes the spans. The decoder reads only what the tests need:
 * ExportTraceServiceRequest → ResourceSpans(1) → ScopeSpans(2) → Span(2) → name(5), attributes(9),
 * dropped_attributes_count(10), status(15), span_id(2), parent_span_id(4). Field numbers: opentelemetry-proto
 * trace/v1/trace.proto and common/v1/common.proto.
 */
import http from 'node:http';
import zlib from 'node:zlib';

function readVarint(buf, start) {
  let result = 0n;
  let shift = 0n;
  let pos = start;
  for (;;) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [result, pos];
    }
    shift += 7n;
  }
}

/** Every field of one protobuf message, in order: { no, value } (a Buffer for length-delimited, a BigInt for varint). */
function fields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const no = Number(key >> 3n);
    const wireType = Number(key & 7n);
    let value;
    if (wireType === 0) {
      [value, pos] = readVarint(buf, pos);
    } else if (wireType === 1) {
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wireType === 2) {
      let length;
      [length, pos] = readVarint(buf, pos);
      value = buf.subarray(pos, pos + Number(length));
      pos += Number(length);
    } else if (wireType === 5) {
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
    out.push({ no, value });
  }
  return out;
}

function anyValue(buf) {
  for (const { no, value } of fields(buf)) {
    if (no === 1) {
      return value.toString('utf8');
    }
    if (no === 2) {
      return value !== 0n;
    }
    if (no === 3) {
      return Number(BigInt.asIntN(64, value));
    }
    if (no === 4) {
      return value.readDoubleLE(0);
    }
  }
  return undefined;
}

function decodeSpan(buf) {
  const span = { name: '', spanId: '', parentSpanId: '', attributes: {}, droppedAttributesCount: 0, status: { code: 0, message: '' } };
  for (const { no, value } of fields(buf)) {
    if (no === 2) {
      span.spanId = value.toString('hex');
    } else if (no === 4) {
      span.parentSpanId = value.toString('hex');
    } else if (no === 5) {
      span.name = value.toString('utf8');
    } else if (no === 9) {
      let key = '';
      let attr;
      for (const kv of fields(value)) {
        if (kv.no === 1) {
          key = kv.value.toString('utf8');
        } else if (kv.no === 2) {
          attr = anyValue(kv.value);
        }
      }
      span.attributes[key] = attr;
    } else if (no === 10) {
      span.droppedAttributesCount = Number(value);
    } else if (no === 15) {
      for (const s of fields(value)) {
        if (s.no === 2) {
          span.status.message = s.value.toString('utf8');
        } else if (s.no === 3) {
          span.status.code = Number(s.value);
        }
      }
    }
  }
  return span;
}

export function decodeTraceRequest(buf) {
  const spans = [];
  for (const resourceSpans of fields(buf)) {
    if (resourceSpans.no !== 1) {
      continue;
    }
    for (const scopeSpans of fields(resourceSpans.value)) {
      if (scopeSpans.no !== 2) {
        continue;
      }
      for (const span of fields(scopeSpans.value)) {
        if (span.no === 2) {
          spans.push(decodeSpan(span.value));
        }
      }
    }
  }
  return spans;
}

/** Starts the mock Phoenix; `spans` fills as exports arrive, `requests` counts them. */
export async function startCollector() {
  const spans = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') {
        body = zlib.gunzipSync(body);
      }
      requests.push({ url: req.url, headers: req.headers, bytes: body.length });
      spans.push(...decodeTraceRequest(body));
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/traces`,
    spans,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
