import type { EngineInterface, Register } from 'claude-code'

// The hooks environment has these; lib es2023 does not declare them.
declare global {
  interface Uint8ArrayConstructor {
    fromBase64(base64: string): Uint8Array<ArrayBuffer>
  }
  interface Uint8Array {
    toBase64(): string
  }
}

const PANE = 'image-view'
const IMAGE = /\.(png|jpe?g|gif|heic|webp|tiff?|bmp)$/i
// The terminal takes at most 2 MiB of PNG bytes: shrink until it fits.
const MAX_BYTES = 2 * 1024 * 1024
const SIZES = [1600, 1200, 800, 500]
// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2
const KEEP = 50

type Shown = {
  label: string
  png: string
  width: number
  height: number
  // Cell drawings already made, by `${columns}x${rows}`.
  cells?: Map<string, string>
}

// Held in the module: a reload empties the gallery.
const gallery: Shown[] = []
let at = -1
let problem: string | undefined
// `image` where the terminal draws pixels (kitty, Ghostty, iTerm2), else
// `cells`: half-block characters, two pixels a cell.
let mode: 'image' | 'cells' = 'cells'
const UPPER_HALF = 0x2580
// What each tool call was, so its images can be labelled by it.
const calls = new Map<string, string>()

const home = async ($: EngineInterface) =>
  (await $.process.run(['/usr/bin/printenv', 'HOME'])).stdout.trim()

const expand = async ($: EngineInterface, path: string) =>
  path === '~' || path.startsWith('~/') ? (await home($)) + path.slice(1) : path

// Newest image in macOS's screenshot folder, the Desktop unless set otherwise.
const newestScreenshot = async ($: EngineInterface) => {
  const set = await $.process.run([
    '/usr/bin/defaults', 'read', 'com.apple.screencapture', 'location',
  ])
  const dir = set.exitCode === 0 && set.stdout.trim()
    ? await expand($, set.stdout.trim())
    : `${await home($)}/Desktop`
  const images = (await $.fs.list(dir))
    .filter(one => one.kind === 'file' && IMAGE.test(one.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  return images[0] && `${dir}/${images[0].name}`
}

const temp = async ($: EngineInterface) =>
  (await $.process.run(['/usr/bin/mktemp', '-t', 'image-view'])).stdout.trim()

// Any format sips reads becomes a PNG small enough to send, with its size.
const load = async ($: EngineInterface, path: string, label: string) => {
  const out = `${await temp($)}.png`
  try {
    for (const size of SIZES) {
      const made = await $.process.run([
        '/usr/bin/sips', '-s', 'format', 'png', '-Z', String(size), path,
        '--out', out,
      ])
      if (made.exitCode !== 0) throw new Error(made.stderr.trim() || 'sips failed')
      const { base64 } = await $.fs.read(out, { as: 'bytes' })
      if ((base64.length * 3) / 4 > MAX_BYTES) continue
      const dims = (await $.process.run([
        '/usr/bin/sips', '-g', 'pixelWidth', '-g', 'pixelHeight', out,
      ])).stdout
      const width = Number(/pixelWidth: (\d+)/.exec(dims)?.[1] ?? 1)
      const height = Number(/pixelHeight: (\d+)/.exec(dims)?.[1] ?? 1)

      return { label, png: base64, width, height }
    }
    throw new Error('image too large even at 500px')
  } finally {
    await $.process.run(['/bin/rm', '-f', out])
  }
}

// An image block's base64 goes through a file, as sips reads only files.
const loadBytes = async ($: EngineInterface, data: string, label: string) => {
  const file = await temp($)
  try {
    const wrote = await $.process.run(['/usr/bin/base64', '-D', '-o', file], {
      stdin: data,
    })
    if (wrote.exitCode !== 0) throw new Error(wrote.stderr.trim() || 'bad base64')

    return await load($, file, label)
  } finally {
    await $.process.run(['/bin/rm', '-f', file])
  }
}

const detectMode = async ($: EngineInterface) => {
  const env = (name: string) =>
    $.process.run(['/usr/bin/printenv', name]).then(r => r.stdout.trim())
  const program = (await env('TERM_PROGRAM')).toLowerCase()
  const term = await env('TERM')
  const drawsPixels = ['ghostty', 'iterm.app', 'wezterm'].includes(program) ||
    term === 'xterm-kitty' || term === 'xterm-ghostty'

  return drawsPixels ? 'image' : 'cells'
}

// The picture as `columns` x `rows` cells: each `▀` paints its top pixel in
// the foreground and its bottom pixel in the background.
const rasterize = async (
  $: EngineInterface,
  image: Shown,
  columns: number,
  rows: number,
) => {
  const size = `${columns}x${rows}`
  const made = image.cells?.get(size)
  if (made) return made
  const base = await temp($)
  const png = `${base}.png`
  const bmp = `${base}.bmp`
  try {
    await $.process.run(['/usr/bin/base64', '-D', '-o', png], { stdin: image.png })
    const out = await $.process.run([
      '/usr/bin/sips', '-s', 'format', 'bmp', '-z', String(rows * 2),
      String(columns), png, '--out', bmp,
    ])
    if (out.exitCode !== 0) throw new Error(out.stderr.trim() || 'sips failed')
    const bytes = Uint8Array.fromBase64((await $.fs.read(bmp, { as: 'bytes' })).base64)
    const view = new DataView(bytes.buffer)
    const offset = view.getUint32(10, true)
    const width = view.getInt32(18, true)
    const height = view.getInt32(22, true)
    const depth = view.getUint16(28, true) / 8
    const stride = Math.ceil((width * depth) / 4) * 4
    // A positive height stores the rows bottom-up.
    const pixel = (x: number, y: number) => {
      const row = height < 0 ? y : Math.abs(height) - 1 - y
      const i = offset + row * stride + x * depth
      return (bytes[i + 2]! << 16) | (bytes[i + 1]! << 8) | bytes[i]!
    }
    const words = new Uint32Array(columns * rows * 3)
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const i = (y * columns + x) * 3
        words[i] = UPPER_HALF
        words[i + 1] = pixel(x, y * 2)
        words[i + 2] = pixel(x, y * 2 + 1)
      }
    }
    const cells = new Uint8Array(words.buffer).toBase64()
    image.cells = new Map([[size, cells]])

    return cells
  } finally {
    await $.process.run(['/bin/rm', '-f', base, png, bmp])
  }
}

const add = async ($: EngineInterface, made: Promise<Shown>) => {
  try {
    gallery.push(await made)
    if (gallery.length > KEEP) gallery.shift()
    at = gallery.length - 1
    problem = undefined
  } catch (error) {
    problem = (error as Error).message
  }
  await $.ui.open({ id: PANE, title: 'Images' })
  $.ui.invalidate('ui.render')

  return problem
}

type Block = { type: string; [field: string]: unknown }

// Image blocks anywhere in a row: top level, or inside a tool_result.
const images = (content: readonly Block[]) =>
  content.flatMap(block => {
    const inner = block.type === 'tool_result' && Array.isArray(block.content)
      ? (block.content as Block[])
      : [block]
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''

    return inner.flatMap(one => {
      const source = one.source as { type?: string; data?: string } | undefined
      return one.type === 'image' && source?.type === 'base64' && source.data
        ? [{ id, data: source.data }]
        : []
    })
  })

// The largest box of cells that keeps the picture's shape.
const fit = (image: Shown, columns: number, rows: number) => {
  let cols = Math.min(columns, 255)
  let tall = Math.round((cols * image.height) / image.width / CELL_ASPECT)
  if (tall > rows) {
    tall = rows
    cols = Math.round((rows * CELL_ASPECT * image.width) / image.height)
  }

  return {
    columns: Math.max(1, Math.min(cols, 255)),
    rows: Math.max(1, Math.min(tall, 255)),
  }
}

const step = ($: EngineInterface, by: number) => {
  at = Math.max(0, Math.min(gallery.length - 1, at + by))
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'view',
      description:
        'Show the images of this session (or a path, or "desktop" for the newest screenshot)',
      argumentHint: '[path | desktop | image | cells]',
    })
    mode = await detectMode($)

    return next(e)
  })

  on('command.run', { command: 'view' }, async ($, e) => {
    const typed = e.args.trim().replace(/^["']|["']$/g, '')
    if (typed === 'image' || typed === 'cells') {
      mode = typed
      $.ui.invalidate('ui.render')
      return { text: `Drawing images as ${typed}.` }
    }
    if (!typed) {
      await $.ui.open({ id: PANE, title: 'Images' })
      return { text: `${gallery.length} image(s) this session.` }
    }
    const path = typed === 'desktop'
      ? await newestScreenshot($)
      : await expand($, typed)
    if (!path) return { text: 'No screenshot found.' }
    const failed = await add($, load($, path, path.split('/').pop() ?? path))

    return { text: failed ? `Cannot show ${path}: ${failed}` : `Showing ${path}` }
  })

  // Name each call, so its images say where they came from.
  on('tool.call', async ($, e, next) => {
    const path = 'file_path' in e && typeof e.file_path === 'string'
      ? ` ${e.file_path.split('/').pop()}`
      : ''
    calls.set(e.tool_use_id, `${e.tool}${path}`)
    if (calls.size > 500) calls.delete(calls.keys().next().value as string)

    return next(e)
  })

  // Every image a tool handed Claude: screenshots, Read images, MCP results.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const stored = await next(e)
    const found = images(e.message.content as readonly Block[])
    void (async () => {
      for (const one of found) {
        await add($, loadBytes($, one.data, calls.get(one.id) ?? 'tool result'))
      }
    })().catch(() => {})

    return stored
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const image = gallery[at]
    if (!image) {
      return (
        <Box flexDirection="column">
          {problem && <Text color="red">{problem}</Text>}
          <Text dimColor>
            No images yet. Screenshots and images Claude reads show up here.
          </Text>
        </Box>
      )
    }
    const caption = `${at + 1}/${gallery.length} · ${image.label} · ${image.width}×${image.height}`
    const controls = (
      <Box>
        <Button key="prev" label="◀ prev" hotkey="h" onPress={() => step($, -1)} />
        <Text> </Text>
        <Button key="next" label="next ▶" hotkey="l" onPress={() => step($, 1)} />
        <Text dimColor> {caption}</Text>
      </Box>
    )
    if (e.surface !== 'terminal') {
      return controls
    }
    const { Image, Raster } = $.ui.resolve(e)
    const size = fit(
      image,
      e.props.bodyColumns,
      Math.max(1, e.props.scroll.bodyRows - (problem ? 2 : 1)),
    )
    const picture = mode === 'image'
      ? (
        <Image
          source={{ png: image.png }}
          columns={size.columns}
          rows={size.rows}
          alt={`[${image.label}: no pixels here, try /view cells]`}
        />
      )
      : (
        <Raster
          key="view"
          columns={size.columns}
          rows={size.rows}
          cells={await rasterize($, image, size.columns, size.rows)}
        />
      )

    return (
      <Box flexDirection="column">
        {picture}
        {controls}
        {problem && <Text color="red">{problem}</Text>}
      </Box>
    )
  })
}
