# macOS design system

Eagle's native UI uses SwiftUI/AppKit. EagleDesign owns shared controls and visual
recipes; EagleFeatures owns state, commands and screen composition. No web component
library, private font asset or runtime theme generator is introduced.

## Status and source of truth

The phase-1 implementation now covers chat/Markdown/composer, tool/question/password
cards, peers, dialogs, sidebars/inspectors, settings/page composition, Gallery and
product window dimensions. **Owner review is pending.** Existing values are retained;
this is not the eight-color, grid or reference-layout redesign.

- `Sources/EagleDesign/Theme.swift` is the authoritative definition owner.
- [Style coverage](../../docs/MACOS-STYLE-COVERAGE.md) lists covered surfaces, exact
  numeric/control exceptions, fixture boundaries and static-analysis limitations.
- [Execution plan](../../docs/MACOS-DESIGN-PLAN.md) owns phase order and unresolved
  product choices. [Original audit](../../docs/MACOS-DESIGN-REVIEW.md) is historical
  source/screenshot evidence, not the current token specification.

## Token ownership

| Namespace | Responsibility |
| --- | --- |
| Palette / TypeScale | Light/dark paints, foreground roles, derived tint recipes, fonts and glyph typography |
| Layout | Shared spacing relationships, glyph slots, compact rows and badge geometry |
| Chat / Tool / Card | Message/Markdown/input geometry, tool detail bounds, question/password-card controls |
| Form / Page | Standard settings controls and feature-page composition/chart dimensions |
| Dialog / Picker / Gallery | Dialog/window presets, face grids, gallery chrome and review framing |
| Sidebar / Inspector / Metric | Existing shell, row, identity and column-resize metrics |
| Primitive / Motion | Avatar/control proportions, activity geometry, curves, periods and amplitudes |

Views reference these definitions or receive runtime data from their caller. Do not
introduce another Theme extension, local styling factory, private literal alias or
copied control implementation. Do not turn protocol limits, parser rules, data counts
or mathematical geometry into presentation tokens.

## Shared controls

- SwitchToggle and Checkbox directly forward their Binding to native Toggle. They have
  no optimistic state, custom key handler or action-policy logic. LabelsHidden, sizes,
  tint, disabled predicates and identifiers remain caller responsibilities.
- SelectionMenu owns the seven existing menu shells. Callers retain native menu-item
  Buttons, selection/checkmark rules, asynchronous actions and disabled options. Policy
  menus remain borderless; this is not a conversion to Picker. PillSelect requires an
  explicit accessibility label and reuses this shell.
- SettingsCard/SectionRow/Header, SettingsTextField/TextArea and SettingsActionButton
  remain the standard form primitives.
- CardActionButton owns the existing filled/text card actions; callers retain the
  completion/password validity and submission/skip guards.
- ActionControl forwards a native Button role/action with plain, bordered, prominent or
  inherited-native styling. CreationTextField preserves creation-field fonts, prompts
  and heights; caller focus/onSubmit and validation are unchanged.
- The pure BotFacePicker belongs to EagleDesign. Bot appearance persistence and its
  conversion to BotsCore stay in EagleFeatures; dependency direction is unchanged.

Specialized library controls (whole-row selection, copy/inline editing, chat cards,
inspector actions and native command/menu/alert builders) have explicit constructor
owners. They are not grounds for blanket exemptions on EagleDesign or feature files.

## Automated source contract

From the repository root:

```sh
npm run check:design
npm run test:design
```

The check-only guard parses **every** `apps/macos/Sources/**/*.swift` file with the
selected Xcode toolchain's bundled SwiftParser/SwiftSyntax. It requires the token owner,
rejects parse errors/source symlinks, and fails if required tooling is unavailable.
No network package or additional lint engine is needed.

The guard covers raw palette/font construction and ad-hoc type derivatives; raw native
control constructors/references/aliases; known visual API arguments; numeric bindings,
defaults and numeric helpers in presentation declarations. New files are discovered
without adding their names to a numeric-style whitelist. Full-tree scans also reject
unused registered allowances.

Allowed raw control sites are exact path + top-level type + member + primitive kind.
Native menu/alert/command exceptions apply to the correct content/actions builders, not
the enclosing file or label/message closure. Token aliases cannot export constructors;
lookalike nested declarations cannot impersonate an owner.

Numeric exceptions are explicit nonvisual contracts or geometry, never blanket palette,
font or control exemptions. Structural zero, content counts and normalized math are
handled separately from style choices. A plain `.scaleEffect(2)` or `.padding(13)` is
not a mathematical exception. The coverage ledger describes the precise boundaries.

This remains a constrained syntax policy, **not arbitrary Swift semantic analysis**.
It does not prove opaque cross-file helper values, unknown third-party styling APIs,
contrast or visual quality. Introduce a rule/fixture with any new visual API family.

Pre-commit runs the design guard and syntax fixtures from a temporary Git-index
snapshot, not the working-tree implementation. Existing isolated repository tests
prove rejection despite unstaged fixes/checker changes, renamed inputs, missing tools
and directory-link redirection. Other repository hooks retain their declared behavior;
this guard is not a whole-repository quality certification.

## Preserved baseline and behavior

Current shell defaults remain 374 pt sidebar / 319 pt inspector, 58 pt list rows with
34 pt faces, 15 pt body text, 54 pt composer and a reserved 32 pt waiting band. The
resize hit region remains 11 pt with `(resizeHitWidth - hairline) / 2` overhang (5 pt).
Settings remain fixed at 1120 × 820 until the layout phase; the known small-window
clipping is not fixed by relocating those values.

The current light green user-bubble fill is still `#2FB457`; white text on it is only
2.70:1. The next palette phase must test all declared foreground/background pairs and
both appearances without lowering thresholds. Twelve saved manual Bot choices and the
eight indexed tints are unchanged; stable hash assignment is still a later decision.

Do not change the secret minimum length/TTLs, asynchronous confirmation, skip/replay
behavior, device/remote permission conditions, freshness provenance or unknown states
while styling their views. No real secret is needed for review fixtures.

## Scrolling and rendering

Keep per-tick transcript bookkeeping in TranscriptScroller rather than observable
SwiftUI state. Preserve the existing scroll-cost checks and hover-only copy/selection
machinery. New style organization must not change streaming, follow/unfollow, text
selection, copy, code/table overflow or composer focus/keyboard behavior.

SnapshotRenderer uses fixed synthetic content and offscreen windows for repeatability;
its viewport matrix is fixture input, not a second style system. Actual View styling
in the renderer and Gallery remains scanned. Real foreground App review is still
required; a fixture capture does not prove live bindings or native window states.

## Validation and known boundary

Use Xcode for Swift build/tests, strict formatting and existing coverage checks.
Guard tests and compilation are separate from successful UI acceptance. Keep all
existing thresholds; do not skip a test or claim a release gate passed when it did not.
Root check/browser gates remain release requirements.

The earlier boolean-control keyboard-driver experiment is preserved under ignored
`.local/experiments/boolean-keyboard-2026-11-05/`, not part of this acceptance. No
system preference was changed and no new product key handler was introduced. The
committed original composer acceptance remains intact.

Every coherent implementation slice is committed on main and the final development
App remains available in the existing right-side Herdr pane for owner review.
