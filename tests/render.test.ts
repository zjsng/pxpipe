import { describe, expect, it } from 'vitest';
import { renderChunkToPng, renderTextToPngs } from '../src/core/render.js';
import { encodeGrayPng, bytesToBase64 } from '../src/core/png.js';
import { transformRequest } from '../src/core/transform.js';

describe('png encoder', () => {
  it('produces a valid PNG signature', async () => {
    const pixels = new Uint8Array(4 * 4).fill(128); // 4×4 mid-gray
    const png = await encodeGrayPng(pixels, 4, 4);
    expect(png.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // Last chunk should be IEND
    const tail = png.slice(-12);
    expect(String.fromCharCode(tail[4]!, tail[5]!, tail[6]!, tail[7]!)).toBe('IEND');
  });

  it('round-trips bytesToBase64 ↔ atob', () => {
    const original = new Uint8Array([0, 1, 2, 3, 254, 255]);
    const b64 = bytesToBase64(original);
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(original);
  });
});

describe('renderer', () => {
  it('renders a one-line string to a single PNG', async () => {
    const img = await renderChunkToPng('Hello, world!');
    expect(img.png.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(img.height).toBeLessThanOrEqual(1568);
    expect(img.width).toBeGreaterThan(0);
  });

  it('splits very long input into multiple PNGs', async () => {
    const huge = ('lorem ipsum dolor sit amet '.repeat(20) + '\n').repeat(500);
    const imgs = await renderTextToPngs(huge);
    expect(imgs.length).toBeGreaterThan(1);
    for (const img of imgs) expect(img.height).toBeLessThanOrEqual(1568);
  });
});

describe('transform', () => {
  it('is a no-op when below min-chars', async () => {
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'You are helpful.',
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes, { minCompressChars: 100 });
    expect(info.compressed).toBe(false);
    expect(body).toBe(bytes); // returns same reference
  });

  it('compresses large system fields into image blocks', async () => {
    const bigSystem = 'You are a helpful assistant. '.repeat(200);
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: bigSystem,
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);
    expect(info.imageCount).toBeGreaterThanOrEqual(1);

    const out = JSON.parse(new TextDecoder().decode(body));
    // Default placement is 'user' — images go into the first user message,
    // not the system field (Anthropic rejects image blocks in `system`).
    const userContent = out.messages[0].content as any[];
    expect(Array.isArray(userContent)).toBe(true);
    const imageBlocks = userContent.filter((b: any) => b.type === 'image');
    expect(imageBlocks.length).toBe(info.imageCount);
    expect(imageBlocks[0].source.media_type).toBe('image/png');
    // And the system field must NOT contain image blocks (would 400).
    if (Array.isArray(out.system)) {
      for (const b of out.system) expect(b.type).not.toBe('image');
    }
  });

  it('folds tool docs into the same image and stubs originals', async () => {
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'short',
      tools: [
        {
          name: 'BigTool',
          description: 'A very long tool description. '.repeat(100),
          input_schema: { type: 'object', properties: { x: { type: 'string' } } },
        },
      ],
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);

    const out = JSON.parse(new TextDecoder().decode(body));
    expect(out.tools[0].description).toContain('See image');
    expect(out.tools[0].name).toBe('BigTool');
  });

  it('strips x-anthropic-billing-header line and keeps it as text', async () => {
    const sysText = 'x-anthropic-billing-header: cch=abc123\n' + 'real prompt text. '.repeat(200);
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: sysText,
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);

    const out = JSON.parse(new TextDecoder().decode(body));
    const textBlocks = out.system.filter((b: any) => b.type === 'text');
    expect(textBlocks.some((b: any) => b.text.includes('x-anthropic-billing-header'))).toBe(true);
  });

  it('keeps <env> as text outside the image so cache_control stays stable', async () => {
    const staticSlab = 'claude.md ground truth.\n'.repeat(500);
    const envBlock =
      "<env>\nWorking directory: /tmp/parityproj\nIs directory a git repo: Yes\nPlatform: darwin\nToday's date: 2026-05-18\n</env>";
    const sys = staticSlab + '\n' + envBlock;
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.compressed).toBe(true);
    expect(info.dynamicBlockCount).toBe(1);
    expect(info.dynamicChars).toBeGreaterThan(0);
    expect(info.staticChars).toBeGreaterThan(info.dynamicChars);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    // With placement='user' (the default), images live in the first user
    // message and the dynamic <env> block is kept as text in the system
    // field — so cache_control on the image is unaffected by env drift.
    const userContent = out.messages[0].content as any[];
    const sysBlocks = (Array.isArray(out.system) ? out.system : []) as any[];

    const hasImage = userContent.some((b: any) => b.type === 'image');
    expect(hasImage).toBe(true);

    // <env> must show up as text somewhere outside the image — the dynamic
    // tail. With 'user' placement that's the system field.
    const allText = [...sysBlocks, ...userContent]
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    expect(allText).toContain('<env>');
    expect(allText).toContain('Working directory: /tmp/parityproj');

    // The static slab must NOT appear in any text block — it lives in the
    // image now.
    for (const b of [...sysBlocks, ...userContent]) {
      if (b.type === 'text') expect(b.text).not.toContain('claude.md ground truth.');
    }
  });

  it('puts cache_control on the image only, never on the dynamic tail', async () => {
    const sys =
      'claude.md\n'.repeat(500) +
      '<env>\nWorking directory: /tmp/x\n</env>\n' +
      '<context name="todoList">\n[ ] do thing\n</context>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.dynamicBlockCount).toBe(2);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    // cache_control must land on exactly one image block — anywhere in the
    // request (system field OR user message), never on a text block.
    const sysBlocks = (Array.isArray(out.system) ? out.system : []) as any[];
    const userContent = (out.messages[0].content ?? []) as any[];
    const cached = [...sysBlocks, ...userContent].filter((b: any) => b.cache_control);
    expect(cached.length).toBe(1);
    expect(cached[0].type).toBe('image');
  });

  it('extracts env fields (cwd, platform, today, isGitRepo, branch) into info.env', async () => {
    const sys =
      'claude.md\n'.repeat(400) +
      "<env>\n" +
      'Working directory: /Users/me/code/pixelpipe\n' +
      'Is directory a git repo: Yes\n' +
      'Platform: darwin\n' +
      'OS Version: Darwin 25.0.0\n' +
      "Today's date: 2026-05-18\n" +
      '</env>\n' +
      '<git_status>\nOn branch main\nnothing to commit\n</git_status>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.env).toBeDefined();
    expect(info.env!.cwd).toBe('/Users/me/code/pixelpipe');
    expect(info.env!.isGitRepo).toBe(true);
    expect(info.env!.platform).toBe('darwin');
    expect(info.env!.osVersion).toBe('Darwin 25.0.0');
    expect(info.env!.today).toBe('2026-05-18');
    expect(info.env!.gitBranch).toBe('main');
  });

  it('leaves info.env undefined when there is no <env> block', async () => {
    const sys = 'claude.md\n'.repeat(400);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.env).toBeUndefined();
  });

  it('computes stable systemSha8 across turns when the static slab is identical', async () => {
    const staticSlab = 'claude.md\n'.repeat(400);
    const t1 =
      staticSlab + "<env>\nWorking directory: /a\nToday's date: 2026-05-18\n</env>";
    const t2 =
      staticSlab + "<env>\nWorking directory: /a\nToday's date: 2026-05-19\n</env>";
    const mk = (sys: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          model: 'claude',
          messages: [{ role: 'user', content: 'hi' }],
          system: sys,
        }),
      );
    const a = await transformRequest(mk(t1));
    const b = await transformRequest(mk(t2));
    expect(a.info.systemSha8).toBeDefined();
    expect(b.info.systemSha8).toBeDefined();
    // Static slab is identical, dynamic block changed → systemSha8 must NOT
    // change (the whole point is that the cached payload is stable).
    expect(a.info.systemSha8).toBe(b.info.systemSha8);
  });

  it('computes firstUserSha8 from the first user message', async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          { role: 'user', content: 'continue from HANDOFF?' },
          { role: 'assistant', content: 'sure' },
          { role: 'user', content: 'a totally different message' },
        ],
        system: 'claude.md\n'.repeat(400),
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.firstUserSha8).toBeDefined();
    expect(info.firstUserSha8).toMatch(/^[0-9a-f]{8}$/);
  });

  it('renders identical input to byte-identical output (determinism = cacheability)', async () => {
    // The whole token-savings story collapses if the renderer is non-
    // deterministic, because identical system prompts on consecutive turns
    // would produce different image bytes → 0% cache hit. Guard rail.
    const sys = 'claude.md\n'.repeat(500);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const a = await transformRequest(body);
    const b = await transformRequest(
      new TextEncoder().encode(
        JSON.stringify({
          model: 'claude',
          messages: [{ role: 'user', content: 'hi' }],
          system: sys,
        }),
      ),
    );
    // Compare image PNG bytes only — the request envelope wraps the same
    // bytes but JSON ordering is deterministic too, so the whole body should
    // match. Default placement is 'user', so the images live in the first
    // user message.
    const ua = (JSON.parse(new TextDecoder().decode(a.body)).messages[0].content ?? []) as any[];
    const ub = (JSON.parse(new TextDecoder().decode(b.body)).messages[0].content ?? []) as any[];
    const imgsA = ua.filter((x: any) => x.type === 'image').map((x: any) => x.source.data);
    const imgsB = ub.filter((x: any) => x.type === 'image').map((x: any) => x.source.data);
    expect(imgsA.length).toBeGreaterThan(0);
    expect(imgsA).toEqual(imgsB);
    expect(a.info.systemSha8).toBe(b.info.systemSha8);
  });

  it('flags unknown tag-shaped blocks in the static slab (canary for new dynamic tags)', async () => {
    const sys =
      'claude.md\n'.repeat(400) +
      '<recent_files>\nfoo.ts\nbar.ts\n</recent_files>\n' +
      "<env>\nWorking directory: /tmp\n</env>";
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.unknownStaticTags).toBeDefined();
    expect(info.unknownStaticTags).toContain('recent_files');
    // <env> is known, must NOT appear here.
    expect(info.unknownStaticTags).not.toContain('env');
  });

  it('omits unknownStaticTags when the static slab has no tag-shaped blocks', async () => {
    const sys = 'claude.md\n'.repeat(400) + '<env>\nWorking directory: /tmp\n</env>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.unknownStaticTags).toBeUndefined();
  });

  it('passes through when the system prompt is only dynamic blocks', async () => {
    const sys = '<env>\nWorking directory: /tmp\n</env>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { body: outBytes, info } = await transformRequest(body, { minCompressChars: 100 });
    // Static slab is empty → below_min_chars → no-op pass-through.
    expect(info.compressed).toBe(false);
    expect(info.reason).toMatch(/below_min_chars/);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    expect(out.system).toBe(sys);
  });

  it("uses ttl='1h' on the image cache_control (Anthropic ordering rule)", async () => {
    // Without ttl='1h' on our cache_control, Claude Code's own ttl='1h'
    // breakpoint on later user-message content triggers 400: "ttl='1h' must
    // not come after ttl='5m'" because our default 5m would land first.
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'claude.md\n'.repeat(500),
      }),
    );
    const { body: outBytes } = await transformRequest(body);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const blocks = [
      ...((Array.isArray(out.system) ? out.system : []) as any[]),
      ...((out.messages?.[0]?.content ?? []) as any[]),
    ];
    const cached = blocks.filter((b: any) => b.cache_control);
    expect(cached.length).toBe(1);
    expect(cached[0].cache_control.ttl).toBe('1h');
  });

  it('compresses long <system-reminder> blocks in the first user message', async () => {
    const reminder = '<system-reminder>\n' + 'a long policy note. '.repeat(200) + '\n</system-reminder>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'real user prompt' },
              { type: 'text', text: reminder },
            ],
          },
        ],
        system: 'claude.md\n'.repeat(500),
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.reminderImgs).toBeGreaterThanOrEqual(1);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const content = out.messages[0].content as any[];
    // Reminder text must NOT appear as a text block anymore.
    for (const b of content) {
      if (b.type === 'text') expect(b.text).not.toContain('<system-reminder>');
    }
    // But the user's actual prompt must still be there.
    const userTexts = content.filter((b: any) => b.type === 'text').map((b: any) => b.text);
    expect(userTexts.some((t: string) => t.includes('real user prompt'))).toBe(true);

    // Reminder images carry NO cache_control (only the system+tools image
    // does — Anthropic caps at 4 breakpoints).
    const reminderImageBlocks = content.filter(
      (b: any) => b.type === 'image' && !b.cache_control,
    );
    expect(reminderImageBlocks.length).toBeGreaterThanOrEqual(info.reminderImgs ?? 0);
  });

  it('leaves short <system-reminder> blocks alone (below minReminderChars)', async () => {
    const shortReminder = '<system-reminder>\nshort note\n</system-reminder>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: shortReminder }],
          },
        ],
        system: 'claude.md\n'.repeat(500),
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.reminderImgs ?? 0).toBe(0);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const allText = (out.messages[0].content as any[])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    expect(allText).toContain('<system-reminder>');
  });

  it('compresses large tool_result text content across user messages', async () => {
    const bigResult = 'output line. '.repeat(500);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_x',
                content: bigResult,
              },
            ],
          },
        ],
        system: 'claude.md\n'.repeat(500),
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.toolResultImgs).toBeGreaterThanOrEqual(1);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    // Find the tool_result block and confirm its content is now image blocks.
    const tr = (out.messages[0].content as any[]).find((b: any) => b.type === 'tool_result');
    expect(tr).toBeDefined();
    expect(Array.isArray(tr.content)).toBe(true);
    const imgInner = (tr.content as any[]).filter((b: any) => b.type === 'image');
    expect(imgInner.length).toBeGreaterThanOrEqual(1);
    // No cache_control on tool_result images.
    for (const b of imgInner) expect(b.cache_control).toBeUndefined();
  });

  it('leaves is_error tool_results untouched (Anthropic forbids images there)', async () => {
    const bigResult = 'error trace. '.repeat(500);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_x',
                content: bigResult,
                is_error: true,
              },
            ],
          },
        ],
        system: 'claude.md\n'.repeat(500),
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.toolResultImgs ?? 0).toBe(0);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const tr = (out.messages[0].content as any[]).find((b: any) => b.type === 'tool_result');
    expect(tr).toBeDefined();
    expect(tr.is_error).toBe(true);
    expect(typeof tr.content).toBe('string');
  });
});
