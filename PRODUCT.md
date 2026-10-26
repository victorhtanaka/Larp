# Product

<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
Friends and small groups who use Larp to chat privately, talk by voice, and share screens across their own PCs.

## Product Purpose
Larp enables private group conversation and media sharing. Success means invited members can join a group and communicate while message history remains on members' computers.

## Positioning
Privacy by default: groups are invitation-based and limited to six members; Supabase holds identity and group metadata, while signed messages and their history stay on the PCs.

## Operating Context
Larp ships as a Windows x64 Electron desktop app with a Portuguese interface and a React/Vite renderer. Each PC creates and protects its own Ed25519 identity. Groups are joined with single-use invitations that expire after seven days. Voice and screen sharing require explicit actions and permissions.

## Capabilities and Constraints
- Create and manage private groups, issue and accept invitations, and remove members.
- Exchange signed peer-to-peer messages, with local persistence and read-only cached history when offline.
- Make voice calls and share a screen or window; system audio is optional and starts disabled.
- Supabase stores identity, group, membership, invite, and screen-lease metadata; it does not store message history.
- A direct STUN path is attempted without TURN. TURN is optional and uses separately configured free-provider credentials; no paid fallback is activated.
- The interface must use real cloud or cached group data only. Do not invent groups, profiles, presence, members, or messages.

## Brand Commitments
- Product name: Larp; interface language: Brazilian Portuguese.
- The user selected this palette: background `#1A1A1A`, primary text `#F0F0F0`, teal accent `#004D61`, ruby accent `#822659`, and forest-green button/CTA `#3E5641`.
- Discord is the interaction/layout reference; Larp's product name and capabilities remain unchanged.

## Evidence on Hand
The README, architecture notes, renderer, Supabase migrations, and P2P protocol code document the shipped behaviors. No user directory, public server discovery, user-chosen profile data, or synthetic conversation content is available to display.

## Product Principles
- Keep membership private and invitation-controlled.
- Treat message signatures and local history as product behavior, not decorative claims.
- Show connection and presence only when the underlying service measures them.
- Keep capture, voice, and system-audio actions explicit and permission-gated.

## Accessibility & Inclusion
Preserve keyboard operation, visible focus, reduced-motion support, and status explanations that do not rely on color alone.
