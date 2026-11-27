# Overlap stack — experimental choices (step 3)

Shipped defaults used in `dist/app.js` / `dist/style.css`. Full CPU-throttled frame traces and Playwright battery are still to come in step 5.

## Border clicks → **3 px radius search**

| Strategy | Result on fixture borders |
|---|---|
| Exact PIP only | Misses shared borders and triple junctions (empty or incomplete stacks) |
| 3 px screen-radius + PIP | Matches `tests/fixtures/points.json` `visible` sets |
| Turf `ignoreBoundary` | Same as exact PIP for closed rings; does not help stroke width |

**Recommend:** pixel-radius (3 px), same as the fixture stroke.

## Lift rendering → **SVG lift pane + CSS `drop-shadow`**

Base map stays on canvas (`preferCanvas: true`). Selected + parent clones draw into a dedicated Leaflet SVG pane.

| Option | Notes |
|---|---|
| (a) SVG pane + CSS drop-shadow | Chosen: no canvas redraw of the whole province; shadow is GPU-friendly |
| (b) SVG `feDropShadow` | Heavier filter graph; similar look |
| (c) Canvas shadow copy | Couples to pan/zoom canvas redraws under 4× CPU throttle |

With `prefers-reduced-motion: reduce`, lift offset/shadow are disabled; only colour/stroke states remain.

## Stack display → **flat elevated list**

| Option | Notes |
|---|---|
| Flat elevated ARIA listbox | Chosen: readable at 360 px width; clamps near map edges |
| Tilted CSS perspective sheets | Cooler; harder to read and hit near edges |

## Left for you

- Whether upper tier stays as the middle stack row
- How (or whether) mismatches are shown publicly
- Final lift colour / shadow strength
- Whether a cooler (tilted) stack is worth any measured cost on low-end hardware
