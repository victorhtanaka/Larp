---
name: Larp
description: Private conversation for invited groups, with voice and screen sharing between their own PCs.
colors:
  steam: "#dddcde"
  valentine-heart: "#be779e"
  iron: "#5e5e5e"
  dark-charcoal: "#323232"
  eerie-black: "#1b1b1b"
  existential-angst: "#0a0a0a"
  bg: "#0a0a0a"
  text: "#dddcde"
  panel: "#1b1b1b"
  panel-raised: "#323232"
  panel-soft: "#323232"
  border: "#5e5e5e"
  border-soft: "#5e5e5e"
  muted: "#dddcde"
  subtle: "#dddcde"
  accent: "#be779e"
  danger: "#be779e"
  alert: "#be779e"
typography:
  display:
    fontFamily: "Georgia, serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1
  headline:
    fontFamily: "Inter, 'Segoe UI', sans-serif"
    fontSize: "18px"
    fontWeight: 680
    letterSpacing: "-0.25px"
  title:
    fontFamily: "Inter, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 660
  body:
    fontFamily: "Inter, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
  message:
    fontFamily: "Inter, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
  button:
    fontFamily: "Inter, 'Segoe UI', sans-serif"
    fontSize: "9px"
    fontWeight: 750
  call:
    fontFamily: "Inter, 'Segoe UI', sans-serif"
    fontSize: "9px"
    fontWeight: 700
  confirm:
    fontFamily: "Inter, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 720
  control:
    fontFamily: "Inter, 'Segoe UI', sans-serif"
    fontSize: "10px"
    fontWeight: 650
  group-name:
    fontFamily: "Inter, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 650
  input:
    fontFamily: "Inter, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.55
  chip:
    fontFamily: "Inter, 'Segoe UI', sans-serif"
    fontSize: "8px"
    fontWeight: 750
    letterSpacing: ".06em"
  label:
    fontFamily: "Inter, 'Segoe UI', sans-serif"
    fontSize: "10px"
    fontWeight: 750
    letterSpacing: ".105em"
  mono:
    fontFamily: "Consolas, 'Courier New', monospace"
    fontSize: "9px"
rounded:
  xs: "4px"
  sm: "5px"
  md: "6px"
  lg: "7px"
  xl: "10px"
  circle: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.bg}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "31px"
  button-call:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.bg}"
    typography: "{typography.call}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  button-confirm:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.bg}"
    typography: "{typography.confirm}"
    rounded: "{rounded.md}"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 11px"
    height: "38px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.bg}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 11px"
    height: "38px"
  group-row-selected:
    backgroundColor: "{colors.panel-soft}"
    textColor: "{colors.text}"
    typography: "{typography.group-name}"
    rounded: "{rounded.sm}"
    padding: "6px 9px"
    height: "48px"
  composer:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.text}"
    typography: "{typography.input}"
    rounded: "{rounded.lg}"
    padding: "10px 11px 9px"
  connection-card:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    padding: "9px 10px"
  privacy-chip:
    backgroundColor: "{colors.panel-soft}"
    textColor: "{colors.muted}"
    typography: "{typography.chip}"
    rounded: "{rounded.xs}"
    padding: "5px 7px"
---

# Design System: Larp

## Overview

**Creative North Star: "The Private Group Room"**

Larp is a compact, invitation-based room for friends who already know whom they want to talk to. The interface favors shared context and clear permissions over discovery: groups are private, voice and screen sharing start only after an explicit action, and message history stays on members' PCs. An optional display name and cropped WebP avatar help members recognize each other without changing signed messages.

The spatial language borrows Discord's scan order—real groups at left, one active conversation in the center, and group members and actions at right—without importing a public-server browser or invented channel hierarchy. Dark surfaces use the six named palette colors; Valentine Heart marks focus and action, and Steam remains the readable text color.

**Key Characteristics:**
- Three-pane Windows desktop workspace: groups, conversation, group details and members.
- Optional profile names and circular WebP avatars appear only in authorized group-member and message views.
- Invitation-based privacy and real membership/connection states.
- Layered near-black surfaces, thin separators, restrained semantic accents.
- Visible keyboard focus and reduced-motion support.

## Colors

The interface uses exactly six colors: Steam (`#dddcde`), Valentine Heart (`#be779e`), Iron (`#5e5e5e`), Dark Charcoal (`#323232`), Eerie Black (`#1b1b1b`), and Existential Angst (`#0a0a0a`). Semantic tokens map onto these primitives without adding shades.

### Semantic Mapping
- **Existential Angst** (`bg`): application canvas and expanded viewer.
- **Eerie Black** (`panel`): side panels and card surfaces.
- **Dark Charcoal** (`panel-raised`, `panel-soft`): controls, composer and selected surfaces.
- **Iron** (`border`, `border-soft`): dividers and borders.
- **Steam** (`text`, `muted`, `subtle`): readable copy on dark surfaces.
- **Valentine Heart** (`accent`, `danger`, `alert`): action surfaces, state borders, focus and non-text indicators.

### Contrast and States
Use Existential Angst text on Valentine Heart actions; Steam text remains on Dark Charcoal and darker surfaces. Do not use Steam on Valentine Heart or Valentine Heart as normal text on Dark Charcoal. Errors and success retain readable copy and use borders, icons or labels as additional state cues; color alone never communicates status.

## Typography

**Display Font:** Georgia, serif (brand mark only)
**Body Font:** Inter, 'Segoe UI', sans-serif
**Label/Mono Font:** Consolas, 'Courier New', monospace (configuration values only)

**Character:** A compact, neutral sans keeps dense group and connection states scannable. The Georgia lettermark is a small brand signature; interface headings remain in the same sans family as the body.

### Hierarchy
- **Display** (700, 22px, line-height 1): the single initial inside the brand mark.
- **Headline** (680, 18px): the selected group name in the conversation header.
- **Title** (660, 16px): the group-details heading; 13px/670 identifies the group in its summary.
- **Body** (400, 14px): the base interface size. Message copy is 12px with 1.6 line-height.
- **Buttons and controls** (750 at 9px for send, 700 at 9px for call, 720 at 11px for confirmation, 650 at 10px for secondary): keep each role's measured weight.
- **Label / chip** (10px/750 with .105em tracking; 8px/750 with .06em tracking): section labels and privacy tags.
- **Technical** (Consolas, 9px): configuration and code values only.

### Named Rules
**The Group Name Leads Rule.** The selected group title is the single headline; membership and connection details remain secondary.

## Layout

The main Electron window applies 150% page zoom while retaining its 1440×900 initial size and 980×680 minimum. At 100% Windows display scaling, these produce approximate CSS viewports of 960×600 and 653×453. The desktop workspace keeps three columns: a fixed group sidebar, flexible conversation, and fixed details/member panel. At the minimum CSS width the columns are 196px / about 245px / 212px.

The existing 1120px and 1020px breakpoints adapt columns and voice controls. At widths up to 680px, group forms stack and header, composer, and dialog actions can wrap. At heights up to 760px, vertical padding and message gaps tighten while the composer remains docked. Group lists and details scroll independently; message history scrolls in the central panel.

## Elevation & Depth

The interface is border-led and uses tonal layering rather than shadows. The main ground, panel, raised panel, and soft panel establish depth; 1px dividers define the three-pane structure and card boundaries. Dialogs use a dark scrim to protect focus. There is no box-shadow vocabulary in the shipped stylesheet.

## Shapes

Most interactive surfaces use restrained 4–7px corners; the group summary icon uses a 10px radius. Avatars and small status indicators are circular. Cards and controls use a single 1px Iron border where separation is needed; selected group rows use a Dark Charcoal surface with Valentine Heart border. Keyboard focus remains visible and never relies on color alone.

Profile photos are centered square crops encoded as 128 × 128 WebP thumbnails (≤48 KiB); the original input is limited to 8 MiB. A profile editor remains disabled offline, while cached group profiles render as read-only metadata.

## Components

### Buttons
- **Primary actions:** Valentine Heart surface with Existential Angst text for enabled send (31px), call (32px) and dialog-confirm actions (40px). Disabled actions use neutral surfaces and Steam text.
- **Secondary:** Dark Charcoal controls with Iron borders; hover emphasizes the Valentine Heart border.
- **Destructive:** Valentine Heart surface with Existential Angst text for removal, revocation and leave actions.
- **Focus:** retain the visible focus outline and do not replace keyboard focus with color alone.

### Chips
- **Selected group:** Dark Charcoal row with Valentine Heart border, Steam group name and real member count.
- **Status/privacy:** compact neutral chips with a divider or lock icon; use copy to state privacy and connection status.
- **Connection state:** Valentine Heart only when the underlying service supplies that state; idle voice status is neutral.

### Cards / Containers
- **Connection and share cards:** Dark Charcoal raised surface, 1px Iron border, 6–7px corners, compact padding, no shadow.
- **Offline banner:** neutral panel, inline icon and concise recovery/navigation action; use Valentine Heart borders or icons when unavailable or erroneous.
- **Composer:** Dark Charcoal surface with a Valentine Heart focus border; the textarea itself remains transparent.

### Inputs / Fields
- **Message composer:** multiline textarea on the raised composer surface; placeholder uses Steam. Focus changes the container border to Valentine Heart.

- **Dialog fields:** Dark Charcoal fill, 1px Iron border, 5px corners; visible focus outline and disabled state remain.
- **Profile fields:** optional display name (32 Unicode characters maximum) and square-cropped WebP avatar; saving is online-only and clearing both fields restores the PC pseudonym.

### Navigation
- **Groups:** compact real-group rows at left; selected state uses Dark Charcoal with a Valentine Heart border. No separate server rail or public discovery model.
- **Conversation:** one active group's header and signed-message history occupy the flexible center.
- **Details:** real group metadata, authorized members, and actions stay in the right panel. Presence is never inferred from membership.

## Do's and Don'ts

### Do:
- **Do** preserve the exact frontmatter palette roles when adding controls or states.
- **Do** use the six named palette colors and their semantic tokens; do not add shades.
- **Do** use Existential Angst text on Valentine Heart buttons and Steam text on dark surfaces.
- **Do** use Valentine Heart for focus, borders, icons and non-text status indicators.
- **Do** distinguish authorized membership from measured reachability; keep focus visible and respect reduced motion.

### Don't:
- **Don't** use Steam text on Valentine Heart or Valentine Heart as normal text on Dark Charcoal.
- **Don't** color a disabled action as if it were ready.
- **Don't** add public-server discovery, channels, invented members, presence, or messages to Larp.
- **Don't** use shadows to separate panels; use the existing tonal layers and 1px borders.
