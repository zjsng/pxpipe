/**
 * Node entrypoint — `node:http` server + minimal CLI flag parsing.
 *
 * Wraps the runtime-agnostic `createProxy` from src/core/proxy.ts. The
 * heavy lifting (transform, render, PNG) is identical to the Worker
 * version; only the request/response plumbing differs.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createProxy, type ProxyConfig } from './core/proxy.js';
import type { TransformOptions } from './core/transform.js';
import { toTrackEvent, noopTracker, type Tracker, type TrackEvent } from './core/tracker.js';
import { DashboardState, dashboardPath } from './dashboard.js';

interface CliOpts {
  port: number;
  upstream: string;
  compress: boolean;
  compressTools: boolean;
  compressSchemas: boolean;
  compressReminders: boolean;
  compressToolResults: boolean;
  minCompressChars: number;
  minReminderChars: number;
  minToolResultChars: number;
  placement: 'system' | 'user';
  cols: number;
  /** When true, append per-request events to eventsFile. Default-on. */
  track: boolean;
  /** Where to append JSONL events. Default ~/.pixelpipe/events.jsonl. */
  eventsFile: string;
}

function envFlag(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

function parseCli(argv: string[]): CliOpts {
  const o: CliOpts = {
    port: Number(process.env.PORT ?? 47821),
    upstream: process.env.ANTHROPIC_UPSTREAM ?? 'https://api.anthropic.com',
    compress: envFlag('COMPRESS', true),
    compressTools: envFlag('COMPRESS_TOOLS', true),
    compressSchemas: envFlag('COMPRESS_SCHEMAS', true),
    compressReminders: envFlag('COMPRESS_REMINDERS', true),
    compressToolResults: envFlag('COMPRESS_TOOL_RESULTS', true),
    minCompressChars: Number(process.env.MIN_COMPRESS_CHARS ?? 2000),
    minReminderChars: Number(process.env.MIN_REMINDER_CHARS ?? 1000),
    minToolResultChars: Number(process.env.MIN_TOOL_RESULT_CHARS ?? 2000),
    placement: (process.env.PLACEMENT as 'system' | 'user') ?? 'user',
    cols: Number(process.env.COLS ?? 100),
    track: envFlag('PIXELPIPE_TRACK', true),
    eventsFile:
      process.env.PIXELPIPE_LOG ??
      path.join(os.homedir(), '.pixelpipe', 'events.jsonl'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eat = () => argv[++i]!;
    switch (a) {
      case '-p':
      case '--port':           o.port = Number(eat()); break;
      case '--upstream':       o.upstream = eat(); break;
      case '--no-compress':    o.compress = false; break;
      case '--no-tools':       o.compressTools = false; break;
      case '--no-schemas':     o.compressSchemas = false; break;
      case '--no-reminders':   o.compressReminders = false; break;
      case '--no-tool-results':o.compressToolResults = false; break;
      case '--min-chars':      o.minCompressChars = Number(eat()); break;
      case '--min-reminder-chars': o.minReminderChars = Number(eat()); break;
      case '--min-tool-result-chars': o.minToolResultChars = Number(eat()); break;
      case '--placement':      o.placement = eat() as 'system' | 'user'; break;
      case '--cols':           o.cols = Number(eat()); break;
      case '--no-track':       o.track = false; break;
      case '--events-file':    o.eventsFile = eat(); break;
      case '-h':
      case '--help':           printHelp(); process.exit(0);
      case '--version':        printVersion(); process.exit(0);
      default:
        if (a.startsWith('--')) {
          console.error(`[pixelpipe] unknown option: ${a}`);
          process.exit(2);
        }
    }
  }
  return o;
}

function printHelp(): void {
  console.log(`pixelpipe — token-saving proxy for Claude Code

Usage:
  pixelpipe [options]                run the proxy
  pixelpipe stats [--file <p>]       summarize ~/.pixelpipe/events.jsonl

Options:
  -p, --port <N>          listen port (default 47821)
      --upstream <URL>    Anthropic API base (default https://api.anthropic.com)
      --no-compress       disable all compression (pure passthrough)
      --no-tools          don't fold tool docs into the image
      --no-schemas        don't include input_schema JSON in the image
      --no-reminders      don't image-compress <system-reminder> blocks
      --no-tool-results   don't image-compress large tool_result content
      --min-chars <N>     skip system compression below this many chars (default 2000)
      --min-reminder-chars <N>  per-block threshold for --no-reminders (default 1000)
      --min-tool-result-chars <N>  per-block threshold for --no-tool-results (default 2000)
      --placement <where> 'system' or 'user' (default user; 'system' is
                          rejected by the API for image blocks)
      --cols <N>          soft-wrap column count (default 100)
      --no-track          disable persistent event tracking
      --events-file <P>   JSONL events path (default ~/.pixelpipe/events.jsonl)
  -h, --help              show this help
      --version           show version

Environment:
  Same as flags via PORT, ANTHROPIC_UPSTREAM, COMPRESS, COMPRESS_TOOLS,
  COMPRESS_SCHEMAS, COMPRESS_REMINDERS, COMPRESS_TOOL_RESULTS,
  MIN_COMPRESS_CHARS, MIN_REMINDER_CHARS, MIN_TOOL_RESULT_CHARS, PLACEMENT,
  COLS, PIXELPIPE_TRACK, PIXELPIPE_LOG.

Use with Claude Code:
  ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude

  (pixelpipe now splits dynamic blocks itself, so the
   --exclude-dynamic-system-prompt-sections flag is no longer required.)
`);
}

function printVersion(): void {
  // Filled in at bundle time by esbuild.define; falls back here.
  console.log(process.env.npm_package_version ?? '0.2.0');
}

// ---- node:http <-> Web Request/Response bridge ---------------------------

function toWebRequest(req: IncomingMessage): Request {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
  const host = req.headers.host ?? 'localhost';
  const url = `${proto}://${host}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else headers.append(k, v);
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  // Buffer the body — proxy needs to read /v1/messages bodies fully anyway,
  // and Node's IncomingMessage → ReadableStream conversion has duplex quirks.
  let body: BodyInit | undefined;
  if (hasBody) {
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        req.on('data', (chunk) => controller.enqueue(chunk));
        req.on('end', () => controller.close());
        req.on('error', (e) => controller.error(e));
      },
    });
  }

  return new Request(url, {
    method,
    headers,
    body,
    // @ts-expect-error — duplex is required for streamed request bodies in Node 18+
    duplex: hasBody ? 'half' : undefined,
  });
}

async function writeWebResponse(res: Response, out: ServerResponse): Promise<void> {
  out.statusCode = res.status;
  res.headers.forEach((v, k) => out.setHeader(k, v));
  if (!res.body) {
    out.end();
    return;
  }
  const reader = res.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out.write(value);
  }
  out.end();
}

// ---- FileTracker ----------------------------------------------------------

/**
 * Append-only JSONL tracker with size-based rotation. One line per request.
 *
 * Node-only — uses node:fs. The Worker host uses tracker.JsonLogTracker with
 * console.log instead (Cloudflare ingests that as Workers Logs).
 *
 * Rotation: when the current file exceeds MAX_FILE_BYTES (100 MB by default),
 * it's renamed to `<path>.1` (overwriting any previous .1) and a fresh file
 * is opened. Keeps one generation of history; for longer retention pipe
 * the file off-host yourself.
 *
 * Failures here NEVER propagate — the proxy must keep serving requests even
 * if the disk is full or the path is unwritable.
 */
class FileTracker implements Tracker {
  private fd: number | null = null;
  private bytesWritten = 0;
  private brokenLogged = false;
  private static readonly MAX_FILE_BYTES = 100 * 1024 * 1024;

  constructor(private readonly filePath: string) {}

  private ensureOpen(): boolean {
    if (this.fd != null) return true;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch {
      /* dir may already exist or be unmkable; openSync below will surface */
    }
    try {
      const st = fs.statSync(this.filePath);
      this.bytesWritten = st.size;
    } catch {
      this.bytesWritten = 0;
    }
    try {
      this.fd = fs.openSync(this.filePath, 'a');
      return true;
    } catch (err) {
      if (!this.brokenLogged) {
        console.error(
          `[pixelpipe] FileTracker disabled — cannot open ${this.filePath}: ${(err as Error).message}`,
        );
        this.brokenLogged = true;
      }
      return false;
    }
  }

  private rotate(): void {
    if (this.fd != null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
    try {
      fs.renameSync(this.filePath, this.filePath + '.1');
    } catch {
      /* if rename fails (e.g. .1 locked) we'll just keep growing — better
         than dropping events */
    }
    this.bytesWritten = 0;
  }

  emit(ev: TrackEvent): void {
    if (!this.ensureOpen()) return;
    try {
      const line = JSON.stringify(ev) + '\n';
      const buf = Buffer.from(line, 'utf8');
      fs.writeSync(this.fd!, buf);
      this.bytesWritten += buf.length;
      if (this.bytesWritten > FileTracker.MAX_FILE_BYTES) this.rotate();
    } catch (err) {
      if (!this.brokenLogged) {
        console.error(
          `[pixelpipe] FileTracker write failed: ${(err as Error).message}`,
        );
        this.brokenLogged = true;
      }
    }
  }

  flush(): void {
    if (this.fd != null) {
      try {
        fs.fsyncSync(this.fd);
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    if (this.fd != null) {
      try {
        fs.fsyncSync(this.fd);
      } catch {
        /* ignore */
      }
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
  }
}

// ---- main ----------------------------------------------------------------

async function main(): Promise<void> {
  // Subcommand dispatch — before parseCli so flag parsing doesn't choke on
  // `stats`'s own flags.
  const argv = process.argv.slice(2);
  if (argv[0] === 'stats') {
    const { runStats } = await import('./stats.js');
    const code = await runStats(argv.slice(1));
    process.exit(code);
  }

  const opts = parseCli(argv);
  const transform: TransformOptions = {
    compress: opts.compress,
    compressTools: opts.compressTools,
    compressSchemas: opts.compressSchemas,
    compressReminders: opts.compressReminders,
    compressToolResults: opts.compressToolResults,
    minCompressChars: opts.minCompressChars,
    minReminderChars: opts.minReminderChars,
    minToolResultChars: opts.minToolResultChars,
    placement: opts.placement,
    cols: opts.cols,
  };
  const tracker: Tracker = opts.track ? new FileTracker(opts.eventsFile) : noopTracker;

  // Live dashboard state — populated on every request via onRequest below,
  // served via the route interception in front of the proxy handler.
  const dashboard = new DashboardState();
  // Seed the "recent requests" table from the JSONL log so a process restart
  // doesn't reset what you can see in the UI. Best-effort; ignored on error.
  await dashboard.replay(opts.eventsFile).catch(() => {});

  const config: ProxyConfig = {
    upstream: opts.upstream,
    transform,
    onRequest: (e) => {
      // Feed the dashboard BEFORE tracker.emit — toTrackEvent strips
      // info.firstImagePng, so capturing has to happen on the raw event.
      dashboard.update(e);
      // Terse human-readable console line.
      const extra: string[] = [];
      if (e.info?.reminderImgs) extra.push(`rem+${e.info.reminderImgs}`);
      if (e.info?.toolResultImgs) extra.push(`tr+${e.info.toolResultImgs}`);
      const extraTag = extra.length > 0 ? ` (${extra.join(' ')})` : '';
      const tag = e.info?.compressed
        ? `compressed ${e.info.origChars}ch → ${e.info.imageCount}img/${e.info.imageBytes}B${extraTag}`
        : (e.info?.reason ?? '');
      const cacheRead = e.usage?.cache_read_input_tokens ?? 0;
      const inputTokens = e.usage?.input_tokens ?? 0;
      const usageTag =
        e.usage !== undefined
          ? ` tokens=${inputTokens}+${e.usage.output_tokens ?? 0} cache_read=${cacheRead}`
          : '';
      console.log(
        `[${new Date().toISOString()}] ${e.method} ${e.path} → ${e.status} (${e.durationMs}ms) ${tag}${usageTag}`,
      );

      // Canary: surface unknown tag-shaped blocks so a Claude Code release
      // that adds a new dynamic tag is caught within hours.
      if (e.info?.unknownStaticTags && e.info.unknownStaticTags.length > 0) {
        console.warn(
          `[pixelpipe warn] unknown tag(s) in static slab: ${e.info.unknownStaticTags.join(', ')}  ` +
            `— may need to add to DYNAMIC_BLOCK_TAGS in src/core/transform.ts`,
        );
      }

      // Persistent JSONL event for offline analysis (pixelpipe stats etc.).
      tracker.emit(toTrackEvent(e));
    },
  };
  const handle = createProxy(config);

  const server = createServer((req, res) => {
    Promise.resolve()
      .then(async () => {
        // Local dashboard routes — handled BEFORE the proxy so they never hit
        // api.anthropic.com (which would 404 them).
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
          const kind = dashboardPath(url.pathname);
          if (kind) {
            const webRes =
              kind === 'html'
                ? dashboard.serveHtml(opts.port)
                : kind === 'stats'
                  ? dashboard.serveStats()
                  : kind === 'recent'
                    ? dashboard.serveRecent()
                    : dashboard.servePng();
            await writeWebResponse(webRes, res);
            return;
          }
        }
        const webReq = toWebRequest(req);
        const webRes = await handle(webReq);
        await writeWebResponse(webRes, res);
      })
      .catch((err) => {
        console.error('[pixelpipe] handler error:', err);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
  });

  server.listen(opts.port, () => {
    console.log(`[pixelpipe] listening on http://127.0.0.1:${opts.port} → ${opts.upstream}`);
    console.log(
      `[pixelpipe] config: compress=${opts.compress} tools=${opts.compressTools} schemas=${opts.compressSchemas} reminders=${opts.compressReminders} tool_results=${opts.compressToolResults} min=${opts.minCompressChars} placement=${opts.placement} cols=${opts.cols}`,
    );
    if (opts.track) console.log(`[pixelpipe] tracking events → ${opts.eventsFile}`);
    else console.log('[pixelpipe] tracking disabled (--no-track or PIXELPIPE_TRACK=0)');
    console.log(`[pixelpipe] dashboard → http://127.0.0.1:${opts.port}/`);
  });

  const shutdown = (sig: string) => {
    console.log(`[pixelpipe] ${sig} — shutting down`);
    // Flush+close the tracker so we don't drop the last few events on exit.
    if (tracker instanceof FileTracker) tracker.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[pixelpipe] fatal:', err);
  process.exit(1);
});
