# Flow brand marks

The mark is an **F drawn as a channel whose middle arm ends at a yellow full stop**: the agent moves by itself, the vault caps it. The same full stop closes the wordmark (`FLOW.`). Hand-written SVG; wordmark is Anton (SIL OFL 1.1) converted to paths, so no font is needed.

| File | Use |
| --- | --- |
| `flow-mark.svg` / `-dark` / `-mono` | Symbol only, square. Favicons, avatars, tight spaces. |
| `flow-wordmark.svg` / `-dark` / `-mono` | `FLOW.` when the mark is already on screen. |
| `flow-lockup.svg` / `-dark` / `-mono` | Default logo: mark + wordmark, horizontal (headers, docs, decks). |
| `app-icon.svg` | macOS app icon, 1024 canvas, 824 body; rasterise to .icns at build time (no PNGs in the repo). |
| `concepts/` | Explored directions (A stream, B F-channel: chosen, C clipped wave). Not for use. |

- **Variants:** default files are for light backgrounds (`#fff`, `#f8f9fa`); `-dark` for `#171e19` / `#272727`; `-mono` is one colour (`#171e19`), recolour to `#fff` on photos or one-ink print.
- **Colours:** charcoal `#171e19`, dark `#272727`, sage `#b7c6c2` (hairline only), white, accent `#ffe17c` (on light backgrounds the wordmark full stop uses the deeper gold `#d4a90c` for contrast). Yellow is only ever the full stop.
- **Clear space:** ¼ of the tile height on every side (lockup: ¼ of its height). Nothing else inside it.
- **Minimum size:** mark 16 px (geometry sits on a 4-unit grid, whole pixels at 16/32/64); lockup 20 px tall; wordmark 16 px tall.
- **Don't:** recolour the F or the stop, move/resize/rotate the stop, stretch or skew, add outlines, shadows or gradients (app icon excepted), set "FLOW" in live text as the logo, put the yellow version on yellow or on busy imagery (use `-mono`), or use a concept file.
