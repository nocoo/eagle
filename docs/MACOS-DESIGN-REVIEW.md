# macOS design review and proposed refinement plan

Status: **read-only audit; no implementation performed**.
Reviewed on 2026-11-05 (local time), against source revision `580b9e6`.
The current execution order and design-system proposal are maintained in
[MACOS-DESIGN-PLAN.md](MACOS-DESIGN-PLAN.md), following the owner's subsequent direction.

## 1. Scope and evidence

This review covers the native macOS shell, Bots conversation, sidebar, inspector,
settings and their shared primitives. It does not propose a Web/Basalt migration,
a new component framework, a protocol change or copying the reference product's features.

Evidence:

- Owner-supplied `~/Desktop/ref1.webp`, `ref2.webp`, `ref3.webp`: conversation,
  settings/billing, and conversation with inspector respectively.
- Actual source-built Eagle App, PID 77085, with its local daemon PID 77591.
  Captures include the four-question synthetic CLI conversation, general settings,
  model settings with the credential hidden, usage, and a short-window check.
- Code audit of `apps/macos/Sources/EagleDesign`, its `EagleFeatures` callers,
  window constraints, and existing design tests; independent read-only review.
- RGB sampling and contrast calculations, not a visual guess about accessibility.

### Measurement contract

The reference images are each 2784 × 3044 physical pixels. Their visible window is
approximately `(112, 76)–(2672, 2896)`, or 2560 × 2820 px. At an **inferred 2× scale**,
this is 1280 × 1410 pt. The 70 px toolbar circles support this inference, but the
reference's original display configuration is unavailable.

Eagle's initial window is **1280 × 1290 pt**, independently reported by Core Graphics;
the actual capture is 2560 × 2580 px on a display reporting a 2× backing scale.
Both images are normalized to 1× without stretching. The different window heights
and different conversation content preclude a meaningful whole-image pixel-diff score.
Reference geometry below is approximate (normally ±1–2 physical pixels at a clear edge);
Eagle code values are exact. Reference font metrics remain estimates.

The WebP files carry no ICC profile. Their encoded RGB values are interpreted as sRGB,
not asserted to be calibrated original-display colors. Flat neutral regions are reliable
samples; tinted/gradient/antialiased regions are reported as ranges or representative samples.

Local-only evidence is in `.local/design-audit-2026-11-05/`:

| Artifact | Purpose |
| --- | --- |
| `comparison-chat.png` | Reference 3 and Eagle at the same point scale |
| `reference-geometry.png`, `eagle-geometry.png` | Column-width redlines |
| `comparison-settings.png` | Reference 2 billing versus Eagle usage; different product data |
| `palette-comparison.png` | Encoded reference samples versus exact Eagle token values |
| `live-chat-three-column.png`, `live-chat-two-column.png` | Actual rendered synthetic conversation |
| `live-settings-general.png`, `live-settings-model.png`, `live-settings-usage.png` | Actual settings, not gallery fixtures |
| `live-settings-compact.png` | Actual clipping at 1280 × 800 pt |

Screenshots are deliberately not committed: some include personal catalog labels and
usage. The App remains running on the synthetic test conversation, with the original
1280 × 1290 pt size and inspector restored. No preference value, credential or Bot
content was changed for this design audit; selecting pages/conversations is the only
navigation state changed.

## 2. Executive assessment

Eagle already has a coherent component layer. The problem is **drift between tokens,
component implementations, actual feature callers and an obsolete design document**,
not a lack of tokens.

The largest visible differences are:

1. Too much width belongs to the left sidebar, reducing the reading column.
2. Cool gray/lilac surfaces, white selected cards, strong borders and floating shadows
   produce more visual chrome than the reference's neutral surface hierarchy.
3. Message spacing and bubble geometry do not distinguish a continuation from a new turn.
4. Settings are oversized and their fixed height demonstrably clips in a supported window.
5. Several important text/background pairs fail the intended contrast target.
6. The gallery does not reliably represent the controls used by real settings pages.

This is a **refinement of an existing design**, not a rebrand or a replacement of the UI.

## 3. Current design-token inventory

`EagleDesign/Theme.swift` contains 142 static declarations: 19 palette entries,
109 metrics and 14 type roles. Some metrics are derived expressions; these are not
142 independent design decisions. There is also a separate 12-color Bot palette and
an eye color in `Primitives/BotFace.swift:226–247`.

### Colors: exact current values

| Role | Light | Dark | Observation |
| --- | --- | --- | --- |
| canvas | `#F2F2F7` | `#1B1B1D` | Slight blue/purple cast; shared by sidebar, inputs and code blocks |
| surface | `#FFFFFF` | `#121214` | Main conversation, inspector, settings |
| card | `#FFFFFF` | `#1F1F22` | Indistinguishable from surface in light mode |
| line | `#E4E4E9` | `#333338` | Shared by borders, dividers and some fills |
| textPrimary | `#141416` | `#F5F5F7` | High-contrast primary text |
| textSecondary | `#6C6C72` | `#A6A6AE` | Reasonable readable secondary role |
| textMuted | `#9A9AA2` | `#75757D` | Used for meaningful text despite low contrast |
| selection | `#FFFFFF` | `#2A2A2E` | White outlined selection in light mode |
| assistantFill | `#F3F3F6` | `#1D1D20` | Cool neutral assistant bubble |
| accent | `#0B84C4` | `#4FC3F7` | Links and unread surfaces, not the primary green |
| accentFill | `#2FB457` | `#2FB457` | User bubbles and some actions |
| accentStrong | `#2FB457` | `#3DD068` | Primary actions, success/status ink and activity mixed together |
| info | `#0B6FBE` | `#7FC8FF` | Informational ink |
| infoFill | `#E4F4FD` | `#10293C` | Informational background |
| warning | `#B46A00` | `#F0A93A` | Waiting/attention ink |
| destructive | `#E5372F` | `#FF5F57` | Error/destructive ink |
| hover | black at 6% | white at 6% | Derived overlay |
| taskGuide | muted at 55% | muted at 55% | Decorative tree guide |

The remaining palette entry is `avatarTints`, an eight-color legacy/indexed family:
red, sky, green, orange, violet, pink, teal and yellow. Bot faces instead have twelve
named choices: paper, clay, red, orange, yellow, green, teal, sky, blue, violet, pink,
graphite. For example, indexed green is `#34C759`, Bot green is `#3DBB6A`, and the
primary-action green is `#2FB457`. These are distinct roles, not necessarily duplicate
colors to merge blindly. The problem is decorative fill leaking into readable text.

### Typography: exact current roles

| Role | Current size / weight |
| --- | --- |
| rowTitle | 15 medium |
| rowSubtitle | 13.5 regular |
| sectionLabel | 13.5 medium |
| brand | 17 semibold; gallery use |
| body / bubble / composer | 15 regular |
| bodyEmphasis | 15 medium |
| note | 13 regular |
| inspectorTitle | 18 semibold |
| cardTitle | 14 medium |
| mono | 13 monospaced |
| pill | 11.5 medium |
| activity | 12 medium |

All use system fonts. A literal `.system(size: number)` scan outside `Theme.swift`
finds 89 occurrences in EagleDesign and 28 in EagleFeatures. This includes SF Symbol
sizes and gallery examples, so it is **not** a count of 117 typography defects.
Still, settings titles, fields, actions, code, tables and Markdown headings bypass
named type roles. Real text below 11 pt includes tool-detail labels at 10.5 pt and
`本机` at 10 pt; miniature chevrons and decorative face glyphs are a different category.

### Geometry and component variants

| Area | Current baseline |
| --- | --- |
| Default window / minimum | Token 1728 × 1082; actual minimum 1280 × 760 |
| Sidebar | 374; adjustable 300–560 |
| Inspector | 319; adjustable 280–460 |
| Toolbar | 35 circle, 9 gap, approximately 16 glyph |
| Header | 72 band total; 20 top inset; participant 40 high |
| Sidebar row | 58 high, 34 avatar, 11 avatar/text gap; outer card inset 12 |
| Group | 24 label height, 18 gap; local 2 pt spacings also apply |
| Conversation | 24 horizontal inset, uniform 24 entry gap |
| Assistant bubble | 16 horizontal / 13 vertical padding, 20 radius |
| User bubble | 16 horizontal / 9 vertical padding, 14 radius |
| Composer | 54 minimum height, 14 horizontal internal inset, 7 bottom inset |
| Waiting strip | 32 always reserved, even when idle |
| Inspector | 76 portrait, 16 content inset, 14 section gap |
| Settings | Fixed 1120 × 820, 190 rail, 28 content inset, 20 card inset |
| Settings rows | 16 vertical padding on each side, including simple rows |
| Settings controls | Action 30 high / radius 8; select 32 / capsule; field 34 / radius 9 |
| Border token | `hairline = 1` means 1 pt, not one physical pixel at 2× |

## 4. Reference advantages and measured differences

| Dimension | Reference evidence | Eagle evidence | Interpretation |
| --- | --- | --- | --- |
| Three-column width | About 314.5 / 667 / 298.5 pt in ref3 | 374 / 587 / 319 pt at 1280 | About 80 pt less conversation width, a 12% reduction against the reference |
| Sidebar row rhythm | Approximately 58 pt pitch; approximately 34 pt faces | 58 pt row plus local gaps; 34 pt faces | Already close; do not shrink every row to 32 pt |
| Toolbar circles | Approximately 35 pt | 35 pt | Keep size; reduce excess elevation instead |
| Sidebar surface | `#F5F5F5` | `#F2F2F7` | Reference is neutral, not purple-tinted |
| Main surface / cards | `#FCFCFC` / `#FFFFFF` | Both `#FFFFFF` | Reference gains hierarchy without a heavy outline |
| Selected row | `#E4E4E4`, no conspicuous white card | White fill plus border | Reference reads as selection, not another floating component |
| Sidebar preview | Dominant glyph sample `#626262` | `textMuted = #9A9AA2` | Reference is substantially more readable |
| Assistant fill | Neutral `#EFEFEF`–`#F2F2F2`, slight tonal variation | Flat `#F3F3F6` | Reference is darker/neutral; exact gradient is not essential |
| Main divider | One physical pixel at x=740 in ref1/ref3 | Token-driven borders commonly 1 pt | Separate physical hairline from focus/control strokes |
| Message inset | Approximately 16 pt from conversation divider | 24 pt | Current layout loses another 16 pt across both sides |
| Long assistant bubble | About 560 pt in ref1, 507 pt in ref3 | Effective width depends on max 600 wrapper, copy gutter and fixed spacers | Reference responds to available width while preserving readable lines |
| Continuation gap | Ref1 adjacent assistant bubbles can be approximately 4 pt apart | Every transcript entry gets 24 pt | Relationship between messages is flattened |
| Composer | Approximately 44–46 pt high, 16 pt horizontal inset, 16 pt bottom margin | 54 high, 24 horizontal inset, 7 bottom margin | Current composer is taller but closer to the window edge |
| Inspector portrait | Approximately 64 pt | 76 pt | Current identity block consumes more vertical space |
| Inspector tabs | Three compact labels, subtle selected pill | Five tabs, underline selection | Different capability count; unify treatment without deleting features |
| Settings envelope | Approximately 900 × 700 pt | 1120 × 820 pt | Current modal is 24% wider and 17% taller |
| Settings rail | Approximately 200 pt; 32 pt selected row, approximately 34 pt pitch | 190 pt; 40 pt row + 4 pt gap | Our rail is narrower yet materially less dense vertically |
| Settings backdrop | Approximately 50% black dimming, sharp background | 32% black plus 5 pt blur, large shadow | Different layering strategy; blur and shadow amplify a floating-card look |
| Settings cards | White on off-white, very fine neutral border | White on white, stronger tinted border | Current separation depends too heavily on outlines |

Reference color is also more contextual: ref1 uses blue conversation actions while
ref3 uses teal actions associated with a teal Bot. The images alone do **not** establish
whether this is Bot-dependent theming, a user preference or another mechanism.
Do not infer a dynamic-color feature from three screenshots.

### What should not be copied

- The reference's large sidebar profile block consumes useful vertical space. Eagle's
  compact top area is an advantage; do not add a decorative profile hero.
- More Bots and fewer empty sections are data differences, not evidence that layout
  code is better. Do not invent tasks or populate empty sections to improve screenshots.
- Reference billing percentages are not a model for our independent usage semantics.
- Some reference muted text is itself low contrast. Accessibility takes precedence.
- A prior design document mentions private reference fonts; these three screenshots do
  not prove the exact font. Keep licensed system SF/CJK fallback rather than copy assets.
- Retain real operational distinctions, uncertain/stale states and keyboard accessibility.

## 5. Prioritized issues

### P0 — readability and supported-window failures

**A. Text colors are not separated from decorative fills.**

Standard sRGB contrast calculations:

| Actual pairing | Ratio | Evidence |
| --- | --- | --- |
| White user text / `#2FB457` | 2.70:1 | `Chat/Transcript.swift:28–60` |
| White primary-action text / dark `#3DD068` | 2.02:1 | `Settings/SettingsComponents.swift:323–331` |
| Sidebar preview / light canvas | 2.50:1 | `Panels/ConversationRow.swift:45–48` |
| Muted text / white | 2.79:1 | `Theme.swift:15` and callers |
| Muted text / dark surface | 4.10:1 | `Theme.swift:10,15` |
| White paper-Bot name / peer canvas | About 1.12:1 | `Peers/PeerBubble.swift:39–42,95–96`; `BotFace.swift:236` |

The intended normal-text gate is 4.5:1. Similar issues affect tags, links, error/warning
ink and answer-card buttons. A global darkening of `accentStrong` is not sufficient:
it currently represents several incompatible roles. Decorative-avatar colors must not
be used directly as name/text colors.

**B. Settings clip in a supported window.**

`WorkspaceShellView.swift:398` fixes the overlay at 1120 × 820. The main window allows
1280 × 760 (`EagleApp.swift:16`). At an actual 1280 × 800 resize, the modal's top/bottom
corners are clipped; see `live-settings-compact.png`. Use available-window constraints,
a fixed reachable header/close action, and a scrolling content area. Do not increase
the minimum window size just to conceal this defect.

### P1 — composition, density and truthful affordances

**C. Side columns are not constrained by the center's readability.** Both drag limits
can be reached independently: 560 + 460 leaves only 260 pt in a 1280 pt window.
`Panels/ThreeColumnShell.swift:46–68` has no center-width floor. Proposed default
320 / flexible / 300 yields about 660 pt of conversation at 1280, before separator
rounding. Clamp drag allocation against a minimum usable conversation width.

**D. Bubble width and spacing are accidental rather than explicit.**
`conversationMaxContentWidth = 720` is reduced by a literal 120 in assistant/tool
callers. The 600 pt assistant wrapper includes its copy control and gap; user messages
have no comparable maximum and use a 96 pt minimum spacer. The two-column screenshot
shows much wider user text than assistant text. Replace this with explicit readable
bubble/gutter rules and a continuation/new-turn spacing policy. Preserve copy access,
streaming behavior, code scrolling and scroll-follow performance.

**E. The idle bottom strip and header reserve more space than necessary.** A 72 pt header
plus 30 pt transcript top padding pushes the first message down. A 32 pt waiting band
is always reserved. The latter is deliberate anti-jump behavior, not dead code: propose
a compact stable status slot (for example 20–24 pt), or status integrated into composer
chrome, only after demonstrating no transcript jump. Do not simply toggle its height.

**F. Several visible controls have no product action.** Code tracing finds default
empty callbacks for sidebar search, inspector share, composer attachment and microphone.
The real shell does not supply their implementation. This is not a request to implement
four new features; the plan should distinguish working actions from unavailable ones
(disable/hide with clear explanation, subject to owner approval). A polished enabled
button must not promise a nonexistent action.

**G. Inspector content starts too low and empty states are over-decorated.** The 76 pt
portrait, identity spacing and five tabs make the upper region heavy. Section glyphs,
rules, empty-state icons and explanatory prose all compete despite no content. Keep
unknown/empty information honest, but reduce repeated decoration and the portrait to
64 pt. Do not copy the reference's three tabs by removing our model/trigger controls.

**H. Real settings switches differ from the gallery.** The gallery uses the custom
34 × 20 / 26 × 15 `SwitchToggle`; real settings use native switches and inspector
triggers use native `.mini`. Live general settings show gray on-state tracks rather
than the gallery's green. Native inactive-window/accent behavior needs an active-window
check before calling this a state bug. Decide native versus custom rendering once,
then make the gallery represent the actual path. Preserve accessibility either way.

### P2 — token and detail discipline

**I. Container colors, borders and shadows make chrome too prominent.** Use a neutral
surface ladder, gray selection and quiet physical hairlines. The reference actually
contains subtle shadows and tonal gradients; a claim of “no shadows at all” would be
incorrect. Eagle's 7 pt toolbar and 9 pt participant shadow radii are more conspicuous.
Keep a restrained participant elevation if useful; do not elevate every icon button.

**J. Participant fill and stroke do not have the same silhouette.**
`ParticipantBubble.swift:129–162` combines a Capsule fill with a radius-12 rounded
rectangle stroke at height 40. Use one shape throughout. Attention also uses warning
ink for the glyph but destructive tint for the ring; align the state semantics.

**K. Controls need semantic size variants, not a blanket numeric replacement.** Settings
have 30/32/34 pt heights with different radius/weight choices, plus handwritten menu
variants. Establish one default 32 pt family and justified compact exceptions. Reuse
existing components; fix `PillSelect`'s hardcoded accessibility label before reuse.
Do not force a 35 pt circular toolbar control onto the settings-field geometry.

**L. Typography needs role coverage and a few weight reductions.** Keep body text at
15 pt initially, rather than globally shrinking text to gain density. Bring real labels
below 11 pt up to at least 11–12 pt; do not confuse SF Symbol sizing with text. Add only
missing roles actually used by settings/Markdown/tool labels. Reduce reliance on
semibold headings where color and spacing can supply hierarchy.

**M. Documentation and tests currently describe different systems.** `apps/macos/DESIGN.md`
still calls the UI unimplemented, specifies 13 pt body text, fixed 411 pt sidebar and
native titlebar, and claims white on `#55A471` exceeds 4.5:1. That last combination is
only 3.03:1. The runtime has 15 pt body, resizable 374 pt sidebar and hidden-titlebar
chrome. Replace obsolete guidance when the new direction is approved; do not append
another contradictory token specification. `DesignTests.swift` locks many current
values, but equality to old values is not proof of good visual design.

### Adjacent correctness finding — separate from pixel polish

`DeviceInspectorList.swift:189–202` changes the accessibility description to “unconfirmed”
when stale, but its visible dot still uses the previous `online` value; settings already
map stale to unknown. This should have a deterministic state test and a separate small
fix if approved. Do not let a visual cleanup certify a stale device as online.

## 6. Execution plan

The owner subsequently specified this order:

1. Consolidate scattered styles into standard controls and tokens, with automated
   assertions and proven rejection of future violations.
2. Optimize the centralized tokens: eight iPhone 5C-inspired candy hues, deterministic
   hash assignment, white-on-solid and dark-on-pale pairs, dark variants, grid-based
   spacing and aligned guide lines.
3. Apply the reference's layout and color hierarchy through the shared system.
4. Fine-tune individual controls one at a time.

[MACOS-DESIGN-PLAN.md](MACOS-DESIGN-PLAN.md) is the authoritative implementation plan,
including phase exit gates and pending identity/manual-color decisions. The earlier
single-accent alternatives and correctness-first sequence have been replaced, not
retained as a competing roadmap. Findings above remain current-state evidence;
their priority labels describe severity, not the implementation order.

## Verification limits

This was a read-only runtime/code audit plus documentation. No UI source was changed,
no implementation tests or release gates were run, and no visual changes are claimed.
Reference dark mode, hover, motion, keyboard behavior and exact font family are unknown.
Search/share/attachment/microphone issues are caller-code evidence, not click-through tests.
Device stale-state and peer-name contrast findings are code/math evidence, not new live
fixture executions. Current screenshots demonstrate actual layout, settings clipping,
rendered text and colors; they do not prove every state is correct.
