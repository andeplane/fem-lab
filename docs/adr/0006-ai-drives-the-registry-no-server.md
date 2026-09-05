---
status: proposed
date: 2026-09-05
---

# The AI drives the Command registry directly; there is no server

The site is static (GitHub Pages) and stays that way. An AI reaches the app in two ways, both
derived from the registry and neither needing a backend: (1) an in-page agent that calls the
Anthropic Messages API from the browser with the user's own key (`dangerouslyAllowBrowser`),
whose tools are the registry's JSON Schemas plus one `run_script` tool; (2) an external
agent such as Claude Code driving the page through Chrome DevTools MCP or Playwright MCP,
using `evaluate_script` against the same registry exposed as `window.fem`, with screenshots
and the console as its eyes. Blender-MCP and FreeCAD-MCP prove the shape: one execute-code
tool plus a few read-back tools is enough, and the read-back tools are what close the loop.

## Considered options

- **A Node MCP bridge over WebSocket.** Superseded by ADR 0011: since the engine is a headless
  library, a Node MCP server is a thin host around the same registry, not a bridge to a tab.
  The browser app still needs no server.
- **Computer use over the UI.** Slowest and least reliable; unnecessary when everything is
  a Command.

## Consequences

- Queries must be rich enough for an agent to observe without pixels: model summary, mesh
  statistics, min/max with location, reaction totals, convergence history, and a
  screenshot Query for when pixels are the point.
- The user's API key lives in the browser's storage and never leaves for anywhere but
  Anthropic. The page must say so.
- Tool descriptions are generated from the same schemas the UI uses, so an undocumented
  Command is a type error, not a manual omission.
