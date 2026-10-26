---
version: 1
slug: "src-renderer-app-tsx"
primary_target: "src/renderer/App.tsx"
related_targets: []
---

Scope: Existing Larp group chat in `src/renderer/App.tsx` and `src/renderer/styles.css`; Operate mode. Audience: friends and small groups. Job: select a real private group, communicate, call, or share a screen. Preserve current behavior, actual data, accessibility, and the Windows minimum window size (980×680). The user chose three panels and declined a separate group-icon rail. No invented channels, members, presence, or messages. No unresolved design decisions.

## Direction contract

THESIS: Make Larp feel like a familiar private group-chat room, not a public server browser or a generic dashboard.

OWN-WORLD: Compact Discord-inspired desktop hierarchy: groups left, conversation center, members and group actions right. Use the exact user-pinned palette in `PRODUCT.md`; never use dark teal or ruby as small text on dark surfaces. Keep states legible and controls restrained. The six dealt challengers lose on audience identification and product clarity; retain only these disciplines: Ikeda data field—align status metadata; character roster—reflow whole real-member rows; warm consumer app—reserve CTA color for actions and keep targets generous; boarding pass—preserve row identity through status updates; terminal wayfinding—prioritize scan order; botanical folio—keep repeated member geometry consistent.

STORY: The selected group, its actual conversation, and current connection state are clear; the user can send a message or explicitly start voice/screen sharing. Group selection updates the conversation and member list together without implying unmeasured presence. Reduced motion remains respected.

FIRST VIEWPORT: At 980×680, honor the compact existing breakpoint: 196px group sidebar, flexible chat column, and 212px details/member panel. Keep group identity and connection status in the header, the conversation in the center, voice controls and composer at the bottom, and real members/actions at right. At this width, voice controls wrap below their status. No fourth rail; no new channel model.

FORM: Candidate 7/7, the user-pinned Discord-inspired private group hub; direction seed `c9868fc7`. Code-led. Signature interaction: selecting a group synchronizes its header, messages, and member roster while preserving clear loading/offline states.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
