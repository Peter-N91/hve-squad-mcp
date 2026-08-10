# Brand

One badge, one palette, many surfaces. `hve-squad`, this MCP server, and the
planned Microsoft Agent Framework build are **variants of one mark**, not three
logos. Read this before editing [logo.svg](logo.svg) or [style.css](style.css).

## The variant system

Every mark is the same 64×64 hexagon badge. Three things are fixed and must stay
byte-identical across variants:

| Fixed element | Definition |
|---|---|
| Badge | `points="32,3 55.1,16.5 55.1,47.5 32,61 8.9,47.5 8.9,16.5"`, fill `#11171f`, stroke `url(#hsEdge)` at `2.5` |
| Coordinator core | circle at `(32,30)` r `6.5`, fill `url(#hsCore)`, stroke `#06281c` |
| Command chevron | `M29.6 27.4 L33 30 L29.6 32.6` |

Exactly one thing varies: the **variant layer** — the three satellites around the
core and the links that reach them. It sits between the badge and the core in the
SVG, delimited by `<!-- VARIANT LAYER -->` comments, so a new variant is a
copy of this file with that block swapped.

Satellite anchor points are also fixed at `(32,16)`, `(18,44)`, `(46,44)`. Only
the shape drawn there and the stroke of the links change. Holding the anchors
constant is what makes the family read as a family when the marks sit side by
side.

| Variant | Links | Satellites | Reads as |
|---|---|---|---|
| `hve-squad` | solid | circles | agents fanning out from the coordinator, in process |
| `hve-squad-mcp` | dashed | squares with a slot | tool ports exposed over a wire |
| Agent Framework *(reserved)* | solid, closed triangle between satellites | circles with a hollow centre | peers under a framework runtime, coordinating with each other |

The MAF row is a reservation, not a shipped asset. When it lands, add it here and
keep the base layer untouched.

## Palette

Variants do **not** get their own colours. The palette is shared, and a variant
that recolours the badge stops being part of the family.

| Token | Value | Use |
|---|---|---|
| `--accent` | `#3ddc97` | primary accent, coordinator core, primary buttons |
| `--accent-2` | `#5aa9ff` | secondary accent, links and satellites |
| `--bg` | `#0b0f14` | page background, port slots |
| `--bg-soft` | `#11171f` | badge fill, raised surfaces |
| `--panel` | `#151c26` | cards |
| `--panel-2` | `#1b2430` | card hover |
| `--border` | `#243140` | borders and rules |
| `--text` | `#d7e0ea` | body text |
| `--muted` | `#8a98a8` | secondary text |
| `--warn` | `#ffc857` | warnings |
| `--danger` | `#ff6b6b` | errors and blocked states |
| `--code-bg` | `#0e141b` | code blocks |
| — | `#06281c` | dark-on-green text and the chevron |

## Wordmark

The wordmark is text, not an asset, so it composes without a new file. The
product name stays `hve-squad`, with the surface carried in a trailing pill:

```html
<span class="wordmark">hve<span class="dot">-</span>squad<span class="tag">mcp</span></span>
```

The `-` is `--accent`. The pill is `--accent-2` on a transparent fill. A future
Agent Framework build swaps `mcp` for `maf` and changes nothing else.

## Usage

- Minimum size 24 px. Below that the port slots close up — use the badge without
  the variant layer rather than shrinking further.
- Never place the badge on a light background; the fill is `--bg-soft` and it
  will disappear. There is no light-mode variant.
- Do not recolour, rotate, outline, add a drop shadow to, or stretch the badge.
- The SVG is the master. Raster only for surfaces that cannot take SVG, exported
  at 2× the target size.
