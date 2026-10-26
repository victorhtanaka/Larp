---
name: Larp
description: Private conversation for invited groups, with voice and screen sharing between their own PCs.
colors:
  bg: "#1A1A1A"
  text: "#F0F0F0"
  panel: "#202225"
  panel-raised: "#27292D"
  panel-soft: "#2B2D31"
  border: "#383B41"
  border-soft: "#303238"
  muted: "#B3B6BD"
  subtle: "#92969E"
  accent: "#3E5641"
  accent-teal: "#004D61"
  accent-teal-soft: "#153641"
  accent-ruby: "#822659"
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
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "31px"
  button-call:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.text}"
    typography: "{typography.call}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  button-confirm:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.text}"
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
    backgroundColor: "{colors.accent-ruby}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 11px"
    height: "38px"
  group-row-selected:
    backgroundColor: "{colors.accent-teal}"
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

Larp is a compact, invitation-based room for friends who already know whom they want to talk to. The interface favors shared context and clear permissions over discovery: a group is private, voice and screen sharing start only after an explicit action, and message history stays on members' PCs.

The spatial language borrows Discord's scan order—real groups at left, one active conversation in the center, and group members and actions at right—without importing a public-server browser or invented channel hierarchy. Dark surfaces stay compact and legible; teal marks selection and connection, forest green marks enabled actions, and ruby carries failure or destructive meaning.

**Key Characteristics:**
- Three-pane Windows desktop workspace: groups, conversation, group details and members.
- Invitation-based privacy and real membership/connection states.
- Layered near-black surfaces, thin separators, restrained semantic accents.
- Visible keyboard focus and reduced-motion support.

## Colors

The palette pairs a deep neutral ground with quiet charcoal layers and three accents reserved for distinct interface states. Frontmatter tokens are normative; status color must describe a real state, not decoration.

### Primary
- **Forest green** (`accent`): enabled send, call, and dialog-confirm actions; also identifies the local member state.

### Secondary
- **Deep teal** (`accent-teal`): selected group, connection affordances, and icon surfaces. `accent-teal-soft` marks a selected media/source surface without replacing the primary selection color.

### Tertiary
- **Deep ruby** (`accent-ruby`): unavailable, error, and destructive states. Pair it with the primary text color; do not use it as small text on dark surfaces.

### Neutral
- **Rich black** (`bg`): main conversation canvas.
- **Charcoal surfaces** (`panel`, `panel-raised`, `panel-soft`): sidebar, cards, composer, controls, and nested surface separation.
- **Graphite dividers** (`border`, `border-soft`): 1px panel edges and list separators.
- **Off-white and muted neutrals** (`text`, `muted`, `subtle`): primary copy, secondary copy, and disabled/quiet state.

### Named Rules
**The Semantic Accent Rule.** Teal identifies selection and connection affordances; forest marks enabled actions; ruby is reserved for errors, unavailable state, and destructive actions. Disabled actions return to neutral surfaces.

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

The supported minimum renderer viewport is 980×680. The desktop workspace keeps three columns: a fixed group sidebar, flexible conversation, and fixed details/member panel. At the minimum width the columns are 196px / flexible / 212px; above 1020px the sidebar and details widen to 204px and 220px, and above 1120px they use 216px and 246px. The selected group's header, conversation, and member roster stay synchronized.

At widths up to 1020px, voice status stays above its wrapping controls. At heights up to 760px, vertical padding and message gaps tighten while the composer remains docked at the bottom. Group lists and details can scroll independently; the message history scrolls in the central panel. The 620px rule reflows dialog forms only; it is not a supported app-window width.

## Elevation & Depth

The interface is border-led and uses tonal layering rather than shadows. The main ground, panel, raised panel, and soft panel establish depth; 1px dividers define the three-pane structure and card boundaries. Dialogs use a dark scrim to protect focus. There is no box-shadow vocabulary in the shipped stylesheet.

## Shapes

Most interactive surfaces use restrained 4–7px corners; the group summary icon uses a 10px radius. Avatars and small status indicators are circular. Cards and controls use a single 1px border where separation is needed; the selected group row uses the teal surface and border together. Keyboard focus is a 2px off-white outline with a 2px offset.

## Components

### Buttons
- **Primary actions:** forest surface for enabled send (31px) and call (32px) actions; standard dialog confirmations span the row at 40px, while group/media settings size them to context. Disabled actions use a neutral surface and subdued text.
- **Secondary:** neutral bordered controls; hover shifts the surface and border toward teal.
- **Destructive:** ruby surface with off-white text for removal, revocation, and leave actions.
- **Focus:** retain the global visible outline; do not replace keyboard focus with color alone.

### Chips
- **Selected group:** teal-filled row with off-white group name and real member count.
- **Status/privacy:** compact neutral chips with a divider or lock icon; use copy to state privacy and connection status.
- **Connection state:** teal/forest/ruby only when the underlying service supplies that state; idle voice status is neutral.

### Cards / Containers
- **Connection and share cards:** raised charcoal surface, 1px border, 6–7px corners, compact padding, no shadow.
- **Offline banner:** neutral panel, inline icon and concise recovery/navigation action; use ruby only when the state is unavailable or erroneous.
- **Composer:** raised surface with a teal focus border; the textarea itself remains transparent.

### Inputs / Fields
- **Message composer:** multiline textarea on the raised composer surface; placeholder uses the readable muted token. Focus changes the container border to teal.
- **Dialog fields:** neutral panel fill, 1px divider, 5px corners; preserve the global focus outline and disabled state.

### Navigation
- **Groups:** compact real-group rows at left; selected state is teal. No separate server rail or public discovery model.
- **Conversation:** one active group's header and signed-message history occupy the flexible center.
- **Details:** real group metadata, authorized members, and actions stay in the right panel. Presence is never inferred from membership.

## Do's and Don'ts

### Do:
- **Do** preserve the exact frontmatter palette roles when adding controls or states.
- **Do** reserve forest green for enabled actions and use neutral styling when an action is disabled.
- **Do** use teal for selection and connection affordances, with off-white labels on teal surfaces.
- **Do** use ruby for destructive/unavailable/error states and pair it with off-white text.
- **Do** distinguish authorized membership from measured reachability; keep focus visible and respect reduced motion.

### Don't:
- **Don't** use dark teal or ruby as small text on dark surfaces.
- **Don't** color a disabled action as if it were ready.
- **Don't** add public-server discovery, channels, invented members, presence, or messages to Larp.
- **Don't** use shadows to separate panels; use the existing tonal layers and 1px borders.
