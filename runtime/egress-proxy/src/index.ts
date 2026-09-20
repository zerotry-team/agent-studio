import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { addressIsPublic, hostnameAllowed, parseConnectTarget } from "./policy.js";

const port = Number(process.env.PORT ?? 3128);
const allowedDomains = [...new Set((process.env.ALLOWED_DOMAINS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
/** 公開Webサイト全般を許可する設定。IP 直指定と private アドレスは、この場合も拒否する */
const allowPublicWeb = process.env.ALLOW_PUBLIC_WEB === "true";
if (!allowPublicWeb && allowedDomains.length === 0) {
  throw new Error("ALLOWED_DOMAINSが空です。deny-allではなく設定不備として起動を停止します");
}

async function resolveAllowed(hostname: string): Promise<{ address: string; family: number }> {
  if (!hostnameAllowed(hostname, allowedDomains, allowPublicWeb)) throw new Error("domain_not_allowed");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => !addressIsPublic(item.address))) throw new Error("address_not_allowed");
  return addresses[0]!;
}

function respond(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  res.end(message);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const started = Date.now();
  try {
    const target = new URL(req.url ?? "");
    if (target.protocol !== "http:") return respond(res, 400, "Only HTTP proxy requests are supported");
    if (target.port && target.port !== "80") return respond(res, 403, "Target port denied by egress policy");
    const resolved = await resolveAllowed(target.hostname);
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: target.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = httpRequest(
      {
        host: resolved.address,
        family: resolved.family,
        port: target.port ? Number(target.port) : 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );
    upstream.on("error", () => respond(res, 502, "Upstream connection failed"));
    req.pipe(upstream);
    res.on("finish", () => console.log(JSON.stringify({ method: req.method, origin: target.origin, status: res.statusCode, duration_ms: Date.now() - started })));
  } catch (error) {
    console.warn(JSON.stringify({ method: req.method, decision: "denied", reason: error instanceof Error ? error.message : "invalid_target" }));
    respond(res, 403, "Target denied by egress policy");
  }
});

server.on("connect", async (req, client, head) => {
  const started = Date.now();
  try {
    const target = parseConnectTarget(req.url ?? "");
    const resolved = await resolveAllowed(target.hostname);
    const upstream = connect({ host: resolved.address, family: resolved.family, port: target.port });
    upstream.setTimeout(120_000, () => upstream.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: agent-studio-egress\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      console.log(JSON.stringify({ method: "CONNECT", origin: `${target.hostname}:${target.port}`, decision: "allowed", duration_ms: Date.now() - started }));
    });
    upstream.once("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
  } catch (error) {
    console.warn(JSON.stringify({ method: "CONNECT", decision: "denied", reason: error instanceof Error ? error.message : "invalid_target" }));
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  }
});

server.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ level: "info", message: "Egress Proxy started", port, allowed_domains: allowedDomains, allow_public_web: allowPublicWeb })));
const shutdown = () => server.close(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
