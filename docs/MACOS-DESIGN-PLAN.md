# macOS design-system consolidation and refinement

Status: **planning only; implementation has not started**.
Updated 2026-11-05 following the owner's requested order. This document replaces the
execution sequence and color-choice proposals in `MACOS-DESIGN-REVIEW.md`; that review
remains the source of measured current-state/reference evidence.

## Order and scope

1. **Consolidate scattered styles and enforce the component/token boundary.**
2. **Optimize the centralized tokens: eight candy colors, readable color pairs,
   deterministic assignment, dark variants and grid-based spacing/alignment.**
3. **Apply the reference's layout and color hierarchy through those tokens/components.**
4. **Fine-tune individual controls, one at a time.**

Do not start with one-off pixel fixes and tokenize them afterward. Each phase must
leave a usable App and pass its exit gate before the next begins. Issue severity in
the audit is not permission to reorder these phases. Existing contrast/clipping defects
remain recorded during the visually conservative first phase; no release should claim
these defects are fixed until the relevant phase is verified.

The app's standard shared-control boundary is the existing **EagleDesign** layer,
built on SwiftUI/AppKit. EagleFeatures composes these controls and supplies state/actions.
Being in EagleDesign does not itself make a control native or accessible: the existing
custom `SwitchToggle`, for example, is a drawn Button rather than a native Toggle.
Prefer native behavior behind standard wrappers; approve custom exceptions only after
verifying role/value, keyboard operation, focus and disabled-state semantics. This work
does not introduce a second library, port web Basalt into Swift or create a general-purpose
theming framework.

## Phase 1 — consolidate before redesigning

### Goal

One authoritative token source, one standard implementation per control responsibility,
and an automated rejection path for newly scattered styles. Preserve current appearance
and behavior as far as consolidation permits; do not simultaneously tune the palette or
reflow the shell.

### Work

1. Inventory all presentation definitions, not only `Theme.swift`: palette extensions,
   private constants, inline SwiftUI/AppKit styles, Markdown, dialogs, menu variants,
   gallery fixtures and feature-layer controls. Record each as a token, a shared-control
   rule, computed layout/geometry, or a justified native boundary.
2. Move color definitions into the token source, including the Bot palette currently
   declared in `BotFace.swift`. Centralize repeated semantic typography, spacing, radii,
   border widths, shadows, opacity and motion decisions. Values initially stay unchanged;
   the eight-color redesign belongs to phase 2.
3. Route settings actions, fields, selectors, switches, icon actions, tabs, tags and
   cards through the existing standard components. Resolve duplicated menu/control
   implementations without building an overly generic configurable widget.
4. Keep raw `Button`, `TextField`, `Toggle`, `TextEditor`, `Menu` and AppKit styling inside
   approved primitives/adapters. Feature screens use semantic control APIs rather than
   recreating the label, fill, border and hover behavior themselves. Native menu/command
   items and window/traffic-light integration need narrow, explicit exceptions.
5. Views may compose layout with token-backed spacing. Named private constants are not
   an escape hatch for arbitrary styles; computed widths and vector/path coordinates
   are not automatically design tokens either. Resolve this distinction at the owning
   symbol rather than exempting an entire feature directory.
6. Make the gallery render the **same controls** as real settings/conversation screens.
   Confirm the shared native/custom switch path before replacing callers; eliminating
   duplication alone does not justify replacing native Toggle semantics with a Button.
   Verify the interaction/accessibility contract, then remove the gallery-only duplicate.
7. Remove superseded private style implementations after replacing their callers.
   Do not add a compatibility layer or permanent aliases to old styling APIs.
8. Replace the obsolete normative content in `apps/macos/DESIGN.md` and update its
   README entry points. Record the consolidated current baseline honestly; distinguish
   later phase-2/3 targets from implemented values. Keep that document as the design
   specification and this one as the execution plan, not two competing specifications.
   Update the same specification when subsequent phases change the accepted tokens.

### Guardrail design

Use one check-only entrypoint for the scoped design contract, invoked from tests,
pre-commit and macOS CI. Reuse existing test/hook/toolchain infrastructure. Inspect
available Swift lint/parser support before choosing the smallest implementation; do
not claim a few grep patterns prove arbitrary Swift expressions safe. A syntax-aware
check, or a deliberately constrained source check backed by adversarial fixtures,
should cover the actual prohibited constructs.

| Guard | Required assertion |
| --- | --- |
| Token ownership | Color constructors/literals, ad-hoc font sizes, visual dimensions, radii, shadows and presentation opacity outside their allowed definitions are rejected |
| Primitive ownership | Feature-layer reimplementations of standard interactive controls are rejected; native integration exceptions are explicit |
| No alias escape | Moving a forbidden value into a local constant, extension or helper does not make it compliant |
| Complete scope | All shipped Swift presentation sources are discovered, including newly added files; gallery/rendering code cannot silently introduce a competing style system |
| Narrow exceptions | Each exception names a path/symbol and reason; stale/unused exceptions fail rather than accumulating |
| Rule behavior | Negative fixtures cover multiline syntax, direct literals, local aliases and duplicate controls; positive fixtures cover token use, runtime geometry, strings/comments and native boundaries |
| Gate failure | A known violating fixture fails with file/rule diagnostics and nonzero exit; valid input succeeds |

Do not demand every numeric literal become a token: zero, layout infinity, normalized
vector geometry, data values and non-visual math need contextual handling. Fractional
native optical offsets require an explicit token or documented boundary, not a blanket
ban. Avoid a directory-wide whitelist for EagleDesign: components themselves can scatter
styles if only EagleFeatures is checked.

The current `.githooks/pre-commit` selects changed filenames from the index but invokes
Swift format on working-tree directories; it does not enforce this design contract.
The **new scoped guard** must inspect the staged source/rule/config snapshot and account
for additions, renames, deletions and changes to the guard itself. Prove that a staged
violation is rejected even when an unstaged correction exists. Do this in isolated
fixtures without changing the owner's real index. Missing required tooling must fail,
not skip. CI reruns the same guard; this is not a claim that Git hooks are unbypassable
or that the whole repository's L1 standard has been completed.

### Exit gate

- No unclassified scattered style in the defined presentation scope.
- Standard controls have production callers; the gallery uses those implementations,
  with verified native or explicitly approved custom interaction/accessibility semantics.
- Old design decisions and README entry points no longer contradict the consolidated
  baseline; later palette/layout targets remain clearly marked as not implemented.
- The guard's pass/fail fixtures and staged-snapshot rejection proof pass.
- Existing view-model/interaction tests and affected Swift checks pass.
- Baseline screenshots show no intentional redesign; any unavoidable difference is
  explained and approved, not hidden inside a large refactor.
- Delete replaced style paths; commit coherent slices rather than one giant migration.

## Phase 2 — optimize the centralized design tokens

### 2A. One eight-color identity family

Use the **iPhone 5C candy-color character** as the starting point: bright, friendly,
clear hues against restrained neutrals. This is an eight-color derivative palette,
not a claim that Apple shipped eight original 5C colors.

Proposed fixed order for review: **red, orange, yellow, green, teal, blue, violet, pink**.
The exact sRGB values are a phase-2 deliverable after swatch/contrast review, not copied
from the reference screenshot or declared approved here. Palette ordering becomes part
of the deterministic identity-color contract; silently reordering it recolors entities.

For each of the eight identities, define **complete pairs in both appearances**:

| Variant | Background role | Foreground role | Intended use |
| --- | --- | --- | --- |
| identity | Bright candy color | Separate readable/decoration role as needed | Avatar, small identity mark; not automatically a text background |
| solid | Darker chromatic fill derived from the identity | White `onSolid` | Colored bubble or prominent control with readable white text |
| soft | Pale, lower-saturation chromatic fill derived from the identity | Black/near-black `onSoft` | Subtle tinted surface with readable dark text |
| ink | Readable chromatic foreground for its declared neutral surface | Neutral surface | Names/links when color is meaningful; never reuse raw avatar fill as text |

Honor the requested **white-on-solid and dark-on-pale** pairs in dark mode too: tune
both saturation and luminance, keep the solid dark enough for white and the pale fill
light enough for dark ink. Use pale colored surfaces sparingly in a dark UI rather than
painting entire panels with them. A dark-theme inversion to dark fill/light `onSoft`
would be a separate design decision, not a silent interpretation of “black text”.

Derivation is performed centrally, reviewed as an eight-by-variant light/dark swatch
matrix and recorded as approved tokens. Avoid scattering `.opacity()` or brightness
math across views; alpha over an unknown background is not a guaranteed readable pair.
Do not add a runtime color-generation framework when an explicit token table suffices.

Also define the small neutral ramp (canvas, surface, card, border, selection, text roles)
and separate semantic success/warning/error/unknown colors. The eight identity hues do
not mean eight success states. A red Bot can be healthy; a green Bot can fail. The
reference informs surface hierarchy in phase 3, not the identity palette's hue choices.

### 2B. Stable hash assignment

Current code uses `abs(id.hashValue)` at `BotsWorkspace.swift:937,1307`; Swift's seeded
hash is not stable across processes, and signed absolute-value indexing is unnecessary.

Recommended contract, pending the identity/manual-color decisions below:

- Hash an immutable, namespaced identity such as `bot:<id>` or `device:<id>`, never a
  display name, sidebar position, group membership, current session or array index.
- Reuse platform CryptoKit (already used in the project), for example the first byte
  of SHA-256 over the specified UTF-8 bytes modulo 8. Fix the exact input encoding,
  namespace and palette order; this is visual assignment, not a security identity.
- One resolver supplies the same slot to the sidebar, participant chip, inspector,
  peer identity and any approved conversation accent.
- Renaming, reordering, reconnecting and restarting do not change the color. Light/dark
  selects a variant of the same identity, not a different slot.
- Fixed vectors verify exact mappings; separate processes verify restart consistency.
  Eight slots necessarily collide: assert valid coverage/range, not collision freedom.
  A color never substitutes for the entity's name or shape.

**Decision gate:** the product currently supports twelve persisted manual Bot tints via
`BotAppearance`, not just computed decoration. Before implementation choose either:

1. All identity colors become hash-assigned; explicitly approve the effect on existing
   manual choices and removal of the color-picker path; or
2. Hash supplies defaults and an explicitly chosen eight-color value can override it;
   specify how existing out-of-family choices are treated before changing any data.

The preferred hash input is immutable typed ID, but it is a proposal until confirmed.
Do not silently rehash by name, silently discard manual choices, add a legacy palette
fallback, or rewrite saved appearance records during a token cleanup. If removing or
changing a persisted/API capability is required, review its product/protocol/fixture
changes explicitly: Bots protocol v1 is additive-only. No implicit breaking wire change
or coupling of BotsCore back to EagleDesign is allowed.

### 2C. Grid and alignment

Adopt a **4 pt primary grid** with a controlled **2 pt compact subdivision**.
The ordinary spacing vocabulary starts at `0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64`;
2 pt is for compact internal relationships. Larger dimensions can be any documented
4 pt multiple; tokens describe roles, not just aliases for every integer.

- Panel edges define shared vertical guide lines. Group labels, row avatars, row text,
  card headings, field labels and composer text anchor to the corresponding guides.
- Within a form, labels have one leading line and controls one trailing line. Within
  lists, icon boxes, title baselines and subtitles align across rows.
- Vertical rhythm comes from explicit row-height/padding/line-height roles. Inside a
  group is tighter than between groups; multiline content expands intrinsically rather
  than clipping to achieve a grid multiple.
- Grid-defined control boxes snap to the grid; font baselines and optical glyph centers
  follow typography metrics. Do not force glyph outlines or every text baseline to a
  global 4 pt coordinate at the expense of native text rendering.
- Prefer 36 pt to an unexplained 35 pt circle and 60 pt to an unexplained 58 pt row when
  evaluating the new scale. These are candidates, not phase-1 visual changes. Retain
  a non-grid value only with a measured optical/native reason and a named exception.
- Physical hairlines use display-scale alignment: one physical pixel is 0.5 pt at 2×,
  1 pt at 1×. This is separate from semantic focus-ring thickness and from the 4 pt grid.
- Responsive shell dimensions and drag positions use shared layout math; snap resting
  column widths where appropriate without adding per-frame observable layout work.
- Typography, radii, strokes, icon boxes, shadows and motion remain centralized. Do not
  let phase-4 nudges become new free-floating offsets.

### Exit gate

- Exactly eight identity slots, with every required variant for light and dark.
- White/solid and dark/soft pair contrast ≥4.5:1 for normal text; declared ink/neutral
  pairs also meet their target. Essential control/focus contrast ≥3:1.
- Evaluate resolved sRGB colors and any intentional compositing, not just literal hex
  presence; test all colors, not only green. No threshold relaxation for yellow/pink.
- Stable-hash vectors and independent-process tests pass; no `hashValue` in visual
  identity assignment. Manual-choice policy is approved before the affected code lands.
- Spacing/control-box grid assertions and exception checks pass. Alignment geometry
  tests cover actual wrappers; screenshots confirm baselines rather than relying only
  on arithmetic over unused token constants.
- An eight-color × variant × appearance board and a spacing/alignment specimen are
  available for owner review. The phase-1 anti-scatter guard remains green.

## Phase 3 — reference-led layout and color application

Only after phases 1–2 pass, compose real screens using the new shared tokens and controls.
Do not import the reference's blue/teal samples as a second palette.

| Area | Work | Evidence/acceptance |
| --- | --- | --- |
| Shell | Start near 320 / flexible / 300 pt; protect the center's readable minimum; use the approved grid | Two/three columns, drag extremes and short windows remain usable |
| Sidebar | Neutral surface, calm selection; shared avatar/title/preview guide lines | Long titles, labels, groups and unread states remain readable |
| Conversation | Explicit responsive bubble bounds, grouped message rhythm, one copy-action gutter | Short/long Chinese and English, code, tables, copy and streaming |
| Composer/header | More compact, stable status space; align field text and controls to guides | No jump when busy starts/ends; native window controls stay clear |
| Inspector | Smaller identity area, calmer empty states, grid-aligned sections/tabs | Keep all real capabilities and distinguish unknown from empty |
| Settings | Approximately 900–960 wide, at most 700 high and clamped to available space; compact shared rows | No clipping at 1280 × 760; header/close/focus remain reachable |
| Color application | Neutral chrome; identity color only on agreed identity/action surfaces; readable paired foregrounds | Same entity hue across views; no semantic state inferred from hue alone |

Choose the role-to-surface map explicitly before application: for example identity on
faces, solid/onSolid for a colored message or action, soft/onSoft for a small contextual
chip, and neutral for general selection/chrome. Do not tint every card simply because
eight colors are now available. If conversation actions follow the selected Bot, they
use that same resolver, never a separate screen-level hash.

Reference numbers are composition evidence, not permission to reintroduce off-grid
literals. Keep current data, feature order and unavailable/unknown semantics truthful.
The earlier no-op search/share/attachment/microphone findings require a separate owner
choice on disabled/hidden treatment, not new feature implementation in this phase.

### Exit gate

Matched-scale screenshots and geometry assertions at 1280 × 760, 1280 × 800, the tall
window and 1728 × 1082, in light/dark and relevant column states. Verify small-window
settings, responsive text, keyboard navigation and real App behavior. For conversation
path changes, run the CLI acceptance path and scrolling performance tests. Phase-1
source guards and phase-2 color/hash/grid tests remain required.

## Phase 4 — one control at a time

Refine shared implementations, not individual callsites. Work in this order so a change
to a primitive does not require re-tuning downstream consumers repeatedly:

1. Base interactive controls: icon buttons, actions, text fields, text areas, selectors,
   switches, tabs, tags and focus rings.
2. Identity/list components: face, participant chip, group header, conversation row,
   unread marker and footer.
3. Reading components: user/assistant bubbles, Markdown headings/lists/code/tables,
   copy action and tool/question/secret cards.
4. Composer and its idle/busy/steering/disabled variants.
5. Inspector section/card/empty state, settings row/card/dialog and peer conversation.

For each component: inspect all production consumers → fixed-state specimen → geometry,
shape, text baseline, icon weight, border/shadow and hit-area adjustment → light/dark
and default/hover/pressed/selected/focus/disabled/error/busy checks → keyboard/reduced-motion
checks where applicable → affected tests and real App capture → atomic commit.

Fill, clip, hover and stroke use the same silhouette. Optical exceptions are measured
and stored at the centralized component/token boundary. Do not weaken the style guard
or move exceptions into an unreviewed wildcard list to get a micro-adjustment through.

### Exit gate

All modified controls pass the state matrix and keep an accessible name, visible focus
and usable hit target. Pixel comparisons use stable fixtures at the same backing scale;
edge/baseline tolerances are declared (normally ≤1 pt) without claiming that differing
fonts/content can yield a meaningful universal screenshot-diff score. Review real App
screens as well as specimens: a beautiful unused gallery component does not count.

## Delivery and verification throughout

- Strict TDD for behavioral changes and guard failures. Demonstrate rejection before
  the smallest implementation; update owning contracts with behavior changes.
- Run the new design guard, affected Swift tests, strict check-only format and existing
  coverage gates. Preserve current thresholds, isolation and scroll performance checks.
- Existing exact-value token tests change only with the approved token revision; add
  role/contrast/grid invariants instead of merely replacing old magic expected values.
- Each coherent slice commits independently and leaves a foreground dev App for manual
  inspection whenever macOS code changes. Run full release gates before any release;
  publishing is not authorized by this plan.
- No UI implementation, token replacement, new guard or hook change has occurred yet.
  This document describes intended enforcement, not a successful enforcement run.

## Decisions to confirm before the relevant phase

1. Phase 1: use the existing EagleDesign library as the shared-control boundary;
   settle the single native/custom switch implementation and verify its semantics before
   consolidating its callers.
2. Phase 2: approve the proposed eight hue families/order and typed immutable ID hashing;
   decide all-hash versus manual eight-color override and the handling of existing 12-color
   choices before changing stored appearance behavior.
3. Phase 3: approve the surface-to-color-role mapping and any disabled/hidden treatment
   of currently unavailable actions. No blanket brand-color choice replaces the eight-color
   contract requested by the owner.
