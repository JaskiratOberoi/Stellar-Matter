---
name: Stellar Matter
description: Lab Bench — a dark working surface with one lime signal, mono labels and hairline rules.
colors:
  bench-black: "#09090B"
  surface: "#121215"
  surface-raised: "#1A1A1F"
  surface-high: "#232329"
  ink: "#FAFAF7"
  ink-secondary: "#BEBEC4"
  ink-tertiary: "#96969E"
  rule-soft: "#2A2A30"
  rule-strong: "#3E3E46"
  lime-signal: "#D4FF3A"
  lime-ink: "#0A0A0A"
  signal-info: "#7DC8FF"
  signal-success: "#7EE787"
  signal-warning: "#FFC43C"
  signal-danger: "#FF7A75"
typography:
  display:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "clamp(2.25rem, 4.4vw, 3.75rem)"
    fontWeight: 700
    lineHeight: 0.94
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  figure:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "clamp(2rem, 3.2vw, 2.75rem)"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.04em"
    fontFeature: "tnum"
  body:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.1em"
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "14px"
  full: "999px"
spacing:
  1: "0.25rem"
  2: "0.5rem"
  3: "0.75rem"
  4: "1rem"
  5: "1.25rem"
  6: "1.5rem"
  8: "2rem"
  10: "2.5rem"
  12: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.lime-signal}"
    textColor: "{colors.lime-ink}"
    rounded: "{rounded.sm}"
    padding: "0.75rem 1rem"
  chip:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 0.75rem"
    height: "30px"
  chip-selected:
    backgroundColor: "rgb(212 255 58 / 0.14)"
    textColor: "{colors.lime-signal}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0.75rem"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "1rem"
  status-pill-ok:
    backgroundColor: "rgb(126 231 135 / 0.12)"
    textColor: "{colors.signal-success}"
    rounded: "{rounded.full}"
    padding: "0.25rem 0.75rem"
---

# Design System: Stellar Matter

## Overview

**Creative North Star: "The Lab Bench"**

Everything sits on a dark bench under one work-light. The ground is near-black, surfaces are barely lighter, and structure comes from hairline rules rather than boxes: section heads sit on a rule, tables are rows on rules, figures stand on a rule with a mono caption underneath. The one colour is a lime signal, used for what is live, selected or actionable — the primary button, a pressed chip, the active tab underline, the arrow in a route — and never as decoration. Meaning gets its own hues (info blue, success green, warning amber, danger red) so a negative balance or a voided row is unmistakable without reading.

Density is working density. Numbers lead: tabular figures, tight tracking on the big ones, the material name in the same weight everywhere so it can be scanned down a column. Labels are uppercase mono, small and widely spaced, so they read as annotations on the bench rather than competing with the data. Copy is honest about scope and state ("5 of 55 materials · stores first, then the 6 busiest of 81 business units").

The system was chosen deliberately over a light "Daylight" alternative and a task-first "Field Card" alternative; it inherits the operators' existing habits and spends its effort on hierarchy and table craft. Print is the exception: on paper the bench becomes white with dark ink and plain rules.

**Key Characteristics:**
- Near-black ground, tonal surfaces, hairline rules; no cards-within-cards.
- One lime signal, reserved for live/selected/actionable.
- Semantic colour for state: in, out, adjusted, negative, voided, inactive.
- Uppercase mono labels over sans data; tabular numerals everywhere.
- Section heads on a rule with title, honest caption and tools; sticky under the topbar.
- Phones get the same content as stacked cards and a fixed action bar, never a sideways scroll.

## Colors

One signal on a tonal dark ground, with a small semantic set for state.

### Primary
- **Lime Signal** (#D4FF3A): the primary action, pressed chips, the active tab underline, the store dot in column headers, the route arrow in the ledger, the accent number in a docket once there is something to record. Text on it is Lime Ink (#0A0A0A).

### Neutral
- **Bench Black** (#09090B): page ground and the background of sticky heads and sticky first columns.
- **Surface** (#121215), **Surface Raised** (#1A1A1F), **Surface High** (#232329): topbar (at 84% with blur), cards, inputs and chips, in ascending order of prominence.
- **Ink** (#FAFAF7), **Ink Secondary** (#BEBEC4), **Ink Tertiary** (#96969E): headings and figures; body and routes; labels, captions and placeholder dots. Ink Tertiary is the floor for text (~6.8:1 on Bench Black).
- **Rule Soft** (#2A2A30), **Rule Strong** (#3E3E46): the everyday hairline, and the heavier rule under a masthead, a table header or a section head.

### Tertiary
- **Signal Info** (#7DC8FF): dispatch badge, business-unit dot, running state.
- **Signal Success** (#7EE787): receipt badge, "last run ok" pill.
- **Signal Warning** (#FFC43C): adjustment badge, overdraw lines and dockets, low stock.
- **Signal Danger** (#FF7A75): negative balances, voided tags, failed runs, destructive chips.

### Named Rules
**The One Signal Rule.** Lime means live, selected or actionable. It never colours a heading, a border for decoration, or a number that has nothing to say yet — an empty docket shows its `+0` in Ink Tertiary.

**The State Has Its Own Hue Rule.** In / out / adjusted / negative / voided / inactive are told apart by colour and treatment, never by lime and never by strike-through alone: voided rows are struck and dimmed with a dated tag; inactive catalog rows are dimmed and tagged, not struck.

## Typography

**Display Font:** Inter Variable (with Inter, system-ui)
**Body Font:** Inter Variable (with Inter, system-ui)
**Label/Mono Font:** JetBrains Mono Variable (with JetBrains Mono, ui-monospace)

**Character:** a neutral grotesk carrying the data, annotated by a mono that reads like instrument lettering. Both are self-hosted via `@fontsource-variable`; the fallback stacks are only for the instant before they load.

### Hierarchy
- **Display** (700, clamp(2.25rem, 4.4vw, 3.75rem), 0.94, −0.035em): the page title on the overview only; working views compact it to Headline size.
- **Headline** (700, 1.75rem, 1.05, −0.02em): compact page titles, onboarding board title.
- **Title** (650, 1.125rem, 1.3, −0.015em): section-head titles ("Stock on hand", "Movement ledger"), preceded by a mono index number in lime when the section is numbered.
- **Figure** (700, clamp(2rem, 3.2vw, 2.75rem), 1, −0.04em, tabular): the glance strip and docket totals.
- **Body** (400, 0.9375rem, 1.5): table cells, form values, captions at 0.8125rem.
- **Label** (600, 0.6875rem, 1, +0.1em, uppercase, mono): field labels, table headers, column kinds, eyebrows, chips. 0.6875rem is the floor.

### Named Rules
**The Tabular Number Rule.** Every numeral that can be compared down a column is `tabular-nums`; big figures also tighten to −0.04em.

**The Mono Annotates Rule.** Mono is for labels, codes, units and timestamps — never for body copy or as a "technical" costume on headings.

## Layout

A wide working shell (max 1640px, 2.5rem side padding) rather than a reading column. The overview opens with a two-column masthead (title left, standfirst right on a hairline), a five-figure glance strip on rules, and the numbered index tabs on a top-and-bottom rule; working views compact the masthead and drop the strip so the first field is above the fold. Forms are a 1fr / 330px grid: fields left, a sticky docket right. Catalog is two equal panels split by a vertical rule.

Spacing follows the 0.25rem scale; tight groups use 2–3, section separation uses 6–8. Tables are rules, not boxes: first cell flush left, last cell flush right, cells padded 0.75rem 1rem, header in Label on a Rule Strong.

Breakpoints that matter: ≤1200px shortens the tabs so all seven fit one row; ≤1000px stacks forms and catalog panels and unsticks the docket; ≤640px turns the glance strip into a 2×2 grid, the index into a horizontal scroll, every wide table into stacked cards, and adds a fixed bottom action bar under forms (72px reserved).

## Elevation & Depth

Flat by default; depth is tonal. Surfaces step up from Bench Black to Surface High; hairlines separate rather than shadows. Shadows appear only in response to state or for floating chrome.

### Shadow Vocabulary
- **Lift** (`0 4px 14px -4px rgb(0 0 0 / 0.55)`): a hovered tile.
- **Float** (`0 18px 44px -12px rgb(0 0 0 / 0.7)`): the phone action bar pill and menus.
- **Menu** (`0 12px 32px rgba(0, 0, 0, 0.45)`): combobox dropdowns.

### Named Rules
**The Rules Not Boxes Rule.** Sections, tables and forms are separated by hairlines. A bordered surface is reserved for things that genuinely float (docket, tile, menu, progress strip).

## Shapes

Small, consistent radii: 6px on controls and chips, 10px on cards, dockets and tiles, 14px reserved, 999px for pills and switches. Borders are 1px hairlines in Rule Soft, stepping to Rule Strong on hover; the primary button's border matches its fill. The docket carries a 2px top rule in lime (amber when warning) — the single place a thick coloured edge is allowed. No left-edge colour bars; inline forms use a top hairline.

## Components

### Buttons
- **Shape:** softly rounded (6px).
- **Primary:** Lime Signal fill, Lime Ink text, 650 weight, 0.75rem 1rem (0.5rem 0.75rem for `btn-sm`), 1px border in the fill colour. Hover brightens 8% and adds a soft lime ring (`0 0 0 3px rgb(212 255 58 / 0.16)`).
- **Secondary / tool actions:** chips (below). There is no filled secondary button.
- **Destructive:** a chip with Signal Danger text and a 55%-alpha danger border.

### Chips
- **Style:** Surface Raised fill, Rule Soft border, Ink Secondary text in Label type, 30px tall (26px for `chip-tool`), 6px radius.
- **State:** hover → Rule Strong border and Surface High; pressed/selected → 55%-alpha lime border, 14%-alpha lime fill, lime text. Used for filters, quick date picks, business-unit selection, row actions and secondary form actions.

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** Surface; docket and tiles add a Rule Soft border.
- **Shadow Strategy:** none at rest; Lift on hover for tiles.
- **Internal Padding:** 1rem (docket 1.25rem, tiles 1.25rem).

### Inputs / Fields
- **Style:** Surface fill, Rule Soft 1px border, 6px radius, 0.75rem padding, Body type; the label above is Label type in Ink Tertiary. Numeric steppers carry a 19px column of up/down buttons inside the field.
- **Focus:** border turns Lime Signal; keyboard focus adds the two-ring lime focus ring.
- **Toggle:** a 38×22 track in Surface High with a 16px thumb; on → lime track, dark thumb.

### Navigation
- Topbar: 56px sticky, Surface at 84% with 14px blur, hairline below; wordmark in uppercase mono with 0.14em tracking; a run-status pill in the semantic colours; nav chips.
- Index tabs: numbered (mono, lime when active), label in 600 weight, caption in Label size; active tab has a 2px lime bottom border. Horizontal scroll with snap on phones.

### Section Head (signature)
Title (Title type, optional lime mono index), an honest caption ("50 of 525 movements", "2 stores, 91 BUs and labs · 1 inactive"), and tools pushed right (search, chips, one primary). Sits on a Rule Soft; sticky under the topbar inside a panel.

### Docket (signature)
The summary beside a movement form: mono eyebrow, a big signed figure that stays Ink Tertiary until there is something to record, a definition list on dashed rules, the actual lines about to be written (amber when they overdraw), the note, the error, and the primary action. On phones its action repeats in a fixed bottom bar with the running total.

### Glance Strip (signature)
Five figures on vertical rules: Figure type, a Label underneath, a caption in Ink Tertiary. Alert figures turn Signal Danger.

## Do's and Don'ts

### Do:
- **Do** put every section on a rule with a title, an honest caption and tools to the right.
- **Do** show negatives in Signal Danger, overdraw in Signal Warning, voids struck-and-dated, inactive dimmed-and-tagged.
- **Do** keep numerals tabular and material names at the same weight down a column.
- **Do** stack tables into cards below 640px and keep the primary action reachable in a fixed bar.
- **Do** print on white with dark ink and treat one business unit as one unbreakable block.

### Don't:
- **Don't** use lime for anything that is not live, selected or actionable — including empty totals.
- **Don't** add thick coloured left borders, nested cards, or gradient text; structure is hairlines.
- **Don't** print a placeholder as data (the noon timestamp on date-only entries, a `·` in a stacked card).
- **Don't** strike through a disabled catalog item; strike-through means a voided transaction.
- **Don't** use `window.prompt`/`alert` for edits that can happen inline in the row.
