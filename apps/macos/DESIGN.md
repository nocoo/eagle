# macOS design system

Eagle's native UI is implemented in SwiftUI/AppKit. `EagleDesign` is the shared
component boundary; `EagleFeatures` supplies state, actions and screen composition.
The App does not import the website's Basalt implementation or ship private reference
fonts. UI typography uses the system font and CJK fallback.

## Status and source of truth

- **Implemented:** palette definitions and explicit font construction are centralized
  in `Sources/EagleDesign/Theme.swift`. The existing twelve manual Bot colors, eight
  indexed colors and font values are preserved during extraction. Switches now use
  `SwitchToggle`, and checkbox controls use `Checkbox`, both backed by native Toggle.
  The Gallery reuses production settings rows rather than a separate drawn switch.
  `SelectionMenu` now owns the seven existing selection-menu presentations;
  `Theme.Form` owns the extracted settings-primitive metrics without changing values.
  Sidebar/inspector chrome and tabs now use Theme.Sidebar/Inspector, shared motion
  recipes and palette paints. Column resize geometry is defined once in Theme.Metric.
- **Enforced:** `npm run check:design` parses every `Sources/**/*.swift` file with the
  selected Xcode toolchain's SwiftParser/SwiftSyntax. The pre-commit design check runs
  from a temporary Git-index snapshot; macOS CI runs the same check and its tests.
- **Not yet enforced:** global spacing/radius/alpha/motion ownership and construction
  of controls other than Toggle/Menu. Numeric style ownership is currently enforced
  in the two form primitive files plus SidebarPanel, ConversationRow, InspectorColumn,
  ThreeColumnShell, ResizeHandle and SegmentedTabs. A clean ownership scan does
  not mean the entire design system is consolidated.
- **Not yet redesigned:** eight candy identities with stable hashing, accessible
  solid/soft color pairs, the new spacing grid, reference-aligned shell and control
  polish. Current contrast and small-window settings defects remain open.

The execution order and pending product choices live in
[the design plan](../../docs/MACOS-DESIGN-PLAN.md). The measured source/screenshot
baseline lives in [the audit](../../docs/MACOS-DESIGN-REVIEW.md). This document owns
implemented design conventions; those documents must not be read as proof that a
planned token, guard or layout change already exists.

## Ownership

`Theme.Palette` owns color values, appearance variants, transparent paint, foreground
on colored surfaces, scrims and shadow colors. The Bot face's tint enumeration and
lookup are defined here, not in the face renderer. `Theme.TypeScale` owns font
construction, including settings, Markdown/code, symbols and the existing proportional
avatar/button font helpers. `Theme.Metric` owns the currently extracted shell/layout
metrics; `Theme.Form` owns settings rows, fields, actions and selection-menu metrics.
Theme.Sidebar/Inspector own their component-specific metrics; Theme.Motion holds the
extracted curves as well as durations. These are existing values, not the later grid
redesign. In particular, the resize hit region stays 11 pt and its overhang is
`(resizeHitWidth - hairline) / 2`, currently 5 pt.

Views consume those definitions directly or receive a typed style from a shared
component. Do not define colors/fonts in another `Theme` extension, local factory or
alias. A comment or named local constant does not make an arbitrary style a token.
Keep semantic role names; do not generate a second palette or hundreds of numeric
aliases to satisfy a checker.

### Parser guard contract

From the repository root:

```sh
npm run check:design
npm run test:design
```

The checker uses host parser modules already bundled with Xcode, not an installed
SwiftLint binary, network package or source-code regular expression. It selects the
compiler, parser modules and SDK from the same `DEVELOPER_DIR` (default Xcode).
Parsing failure, missing token owner/tooling and source symlinks are errors.

The only definition owner exempted from palette/type construction checks is the exact
path `EagleDesign/Theme.swift`; raw/owner typealias declarations remain forbidden there
so they cannot export a new construction path to other files. Features, components, gallery, snapshot renderer,
fixture executables and newly added Swift files are all scanned. The rules reject:

- Direct or qualified `Color`/`NSColor`/`CGColor` constructors, static colors and
  color literals outside the owner, including initializers and interpolation bodies.
- Raw color type aliases or constructor references; moving the source expression to
  another helper/file does not hide it.
- Implicit named colors such as `.red` or `.white`. Use explicit domain enum names
  such as `BotAppearance.Tint.green` when a non-color value shares the spelling.
  Implicit `.clear` remains permitted for absent paint in a conditional style.
- Explicit `Font`/`NSFont` construction and static styles; implicit construction in
  font arguments, typed bindings/parameters/returns and `.font` assignments.
- External `Theme.Palette` and `Theme.TypeScale` extensions, including qualified
  spellings, and aliases of those owners or the Theme root.
- Raw `Toggle` construction, references and aliases outside the `body` of the exact
  `SwitchToggle` and `Checkbox` declarations in their respective primitive files.
  The exception is not file-wide and does not permit scattered colors or fonts in
  the native control's label builder.
- Raw `Menu` construction/references/aliases outside the exact top-level
  `SelectionMenu.menu`, `MenuIconButton.body` and `SidebarPanel.itemMenu` members
  in their owning files. The sidebar exception is its native context submenu,
  not another selection-control implementation.
- Numeric style literals and local numeric defaults in SettingsComponents.swift
  and SelectionMenu.swift. Structural zero, content values in Text/lineLimit and
  identity opacity/scale are allowed. Other rendering files and arbitrary external
  value-helper dataflow are not certified by this bounded rule. External Theme.Form
  extensions and aliases are refused.
- The same numeric-literal rule covers the six panel/column primitives listed above.
  One-character content prefixes and the sidebar's one-step move/index predicates
  remain data, not style tokens. External Sidebar/Inspector/Motion/Metric token-owner
  extensions and aliases are refused. This does not certify arbitrary helper dataflow
  or styles in the remaining conversation, task, card and window-level views.

This is a constrained syntax contract, not Swift type inference. It does not certify
arbitrary generic helper APIs, derived alpha/weight, layout dimensions or all primitive
callers. Subsequent phase-1 slices must extend its rules and adversarial fixtures
before claiming those properties. Native geometry and non-visual numbers are not
automatically prohibited.

`tests/native/design-guard.test.ts` covers accepted/rejected syntax.
`tests/native/design-gate.test.ts` creates isolated repositories and performs real
commits: a staged violation fails despite an unstaged correction, a valid staged
source succeeds despite an unstaged style change, and an unstaged disabled checker
cannot replace the index version. Renamed source and deleted required inputs are
covered. The design gate does not change the owner's working tree or index.
Other pre-commit checks retain their existing behavior; the new staged-snapshot proof
must not be generalized into a claim that every repository gate has been normalized.

## Current visual baseline

The authoritative values are the tokens and their actual callers, not the former
reference proposal. Key current values:

| Role | Current value |
| --- | --- |
| Sidebar / inspector defaults | 374 / 319 pt, both resizable |
| Default window / minimum | 1728 × 1082 / 1280 × 760 pt |
| Sidebar row / face | 58 / 34 pt |
| Header / circular control | 72 / 35 pt |
| Body / subtitle / note | 15 / 13.5 / 13 pt |
| Conversation inset / entry gap | 24 / 24 pt |
| Composer / waiting band | 54 / 32 pt; the waiting band is reserved while idle |
| Inspector portrait | 76 pt |
| Settings | Fixed 1120 × 820 pt; responsive sizing is still planned |
| Stroke token | 1 pt, which is 2 physical pixels at 2× |

Colors are dynamic light/dark sRGB pairs. Light canvas is currently `#F2F2F7`, surface
and card are `#FFFFFF`, primary text is `#141416`, and the user bubble fill is `#2FB457`.
White text on that green is only 2.70:1; centralization preserves this existing defect,
it does not establish accessibility. The next palette phase must test all declared
foreground/background pairs and both appearances without lowering thresholds.

The token-consolidation tests preserve manual tint order, all light/dark face values,
scrim/shadow opacity, and exact font construction. In particular, the near-transparent
hit surface stays black at 0.001 opacity: replacing it with an absent view or clear
paint during refactoring would change hit testing.

## Shared components and behavior

Reuse existing cards, settings rows/fields/actions, icon actions, tabs, conversation
rows and Markdown primitives. Selection menus share one native Menu shell, with
explicit surface/standard/provider/compact/action/inline/policy recipes preserving
their old fonts, dimensions, arrow treatments and native menu style. Callers still
own their Button actions, checkmarks, disabled options, help and identifiers. The
policy recipe remains borderless; this is not a migration to Picker. PillSelect
requires an explicit accessibility label and reuses the same shell.
Remaining conversation, task/card, dialog, window-level and other primitive styles
are not yet consolidated; extracting panel chrome does not complete phase 1.
`SwitchToggle` and `Checkbox` pass the original Binding directly to native Toggle,
without optimistic state or a custom action handler. Callers retain labelsHidden,
control size (including inspector mini), tint, disabled predicates and identifiers.
Hidden controls receive their meaningful row title as the accessibility name.
The drawn switch, its Size variant, unused shadow token and Gallery-only ToggleRow
have been removed; the shared SpinnerArc remains.

The owner accepted this control slice in the running Dev App. Native reference tests
cover role/value/label/geometry, disabled controls and deferred Binding confirmation.
The additional checkbox keyboard-driver experiment is not accepted evidence. Its
complete patch/source and diagnostic logs are archived locally under the ignored
`.local/experiments/boolean-keyboard-2026-11-05/`; failures remain in CHECKPOINTS.md.
The committed composer acceptance is unchanged. No system keyboard preference was
changed and no new product key handler was added.

Colors identify Bots but never certify success or device freshness. Unknown remains
unknown; stale observations must not look newly confirmed. Empty state, unavailable
action and active task are different states. Do not populate screenshots with invented
activity or add new features to make visual polish easier.

## Scrolling and rendering constraints

Transcript scroll bookkeeping stays in `TranscriptScroller`, not per-frame observable
state. Previously moving every scroll tick through SwiftUI state invalidated the entire
conversation; `TranscriptScrollCostTests` guards the cost relative to bare rows.

Rows retain lightweight placeholders for copy actions and text selection until hovered.
Do not rebuild always-active selection/copy machinery for every row merely to align
icons. Preserve streaming, follow/unfollow, user scrolling, code/table overflow and
composer focus. A smaller waiting indicator must not introduce transcript jumps.

The existing SnapshotRenderer hosts views in an offscreen NSWindow. Use fixed synthetic
content for repeatable comparisons and label it as fixture evidence. Real foreground
App captures remain necessary; gallery/rendered fixtures alone do not prove feature
bindings, state transitions or native active/inactive-window appearance.

## Validation

Use the explicit Xcode toolchain for Swift tests, strict formatting and the existing
coverage gate. Run the new design guard and its rejection tests in addition to those
checks. Keep the existing coverage and performance thresholds; do not skip a test to
finish a visual change. Run CLI/native focus acceptance when the corresponding
interaction path changes. Root check/browser gates remain release requirements.

Every macOS implementation slice ends with an inspectable foreground development App
in the project's right-side Herdr pane and an atomic commit. Report actual tests,
known warnings, screenshot evidence and remaining design-system coverage honestly.
