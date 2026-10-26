# image-view

A Claude Code mod that shows the images Claude sees, in a pane beside the chat.

Every image a tool hands Claude lands in an **Images** pane: screenshots from browser, computer-use or MCP tools, images Claude opens with Read, and any other image in a tool result. Browse them with **◀ prev** / **next ▶** (or `h` / `l` while the pane has focus).

In terminals that draw pixels (kitty, Ghostty, iTerm2, WezTerm) images are shown as real pictures. Everywhere else they are drawn with colored half-block characters, so they still show up in any truecolor terminal.

Requires macOS (uses `sips` to convert and resize images).

## Commands

- `/view` opens the pane.
- `/view <path>` adds an image file.
- `/view desktop` adds your newest screenshot.
- `/view image` / `/view cells` force pixel or character drawing.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install image-view --marketplace sciencemj/image-view
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install image-view --marketplace sciencemj/image-view
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `sciencemj/image-view`, then Add plugin.
