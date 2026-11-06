# macOS style ownership coverage

Status: phases 1–2 are owner-accepted. Their source-discovery/enforcement boundaries
remain in force during phase 3; this is not an arbitrary Swift type-inference proof.
The initial value-preserving slices were `dcdc99f` and `d473f92`; the eight-family/grid
work is `322ed24` and `bdca848`. Current composition is specified in
`apps/macos/DESIGN.md` and awaits phase-3 visual acceptance.

## Covered surfaces

| Surface | Central definitions and shared controls |
| --- | --- |
| Chat and Markdown | Theme.Chat/Layout/TypeScale; bubble dimensions, copy gutter, code/table/list geometry, line spacing and caret interval. ConversationColumn consumes the same dimensions and motion. |
| Composer and waiting state | Existing hit targets/heights, composer radius/line range, placeholder turn/rise/perspective, reduced-motion recipes, breathing and word/dot timing. Scroll-follow logic is unchanged. |
| Tool calls and details | Theme.Tool/Layout; original content width, previews, scroll limits, spinner dimensions and detail-dialog bounds. Runtime duration formatting stays data. |
| Question and password cards | Theme.Card/Form/Layout; shared CardActionButton keeps filled/text variants and original enablement. Submission, skip, secret validation, lifetime choices and success clearing remain in the original views. |
| Peer UI and dialogs | Central soft-tint/border recipes, chip geometry, shadow geometry and dialog insets; existing peer identity and history grouping remain unchanged. |
| Sidebar / inspector / shell | Existing Theme.Sidebar/Inspector/Metric and motion; remaining section/device/empty-state details also use tokens. No changed freshness, task or device-policy semantics. |
| Settings and page composition | Theme.Form/Page/Layout/Dialog; page spacing, row composition, field widths, usage chart dimensions, badge geometry and overlays. Main feature views no longer recreate plain/native action or text-entry primitives. SettingsStatusNote owns the persistent result lines; ToastCenter/SettingsToast own the transient ones (neutral, ✅ success, ⚠️ failure, retired on `Theme.Motion.toastDwell`); SettingsSectionRow's leading slot draws a bot's face in 用量. The 技能 page's table is the shared SettingsTableHeader/SettingsTableRow pair: the column widths live in `Theme.Page` and the description column takes the room that is left, so the header and its rows put the four columns at the same horizontal places, measured at the 960 pt settings width. The page's statement line and its refused-push note are both the shared SettingsStatusNote: the statement is neutral, the refusal is `.failure`, and no new spacing value was introduced. |
| Creation and profile editing | IdentityField (EagleDesign) owns the borderless name/tag rows, their aria label, focus and submit; SettingsActionButton owns both dialog actions and their disabled look; DialogShortcut carries Return/Escape where no field has the keyboard. The pure BotFacePicker is in EagleDesign; BotsCore persistence conversion and the creation draft (one canonical colour per presentation) stay in EagleFeatures. |
| Modal host | ModalHost (EagleDesign) owns the scrim, card surface, radius/hairline/shadow, traffic lights and Escape for every dialog the App draws; the shell owns the background blur, the workspace disable and the single typed presentation. Peer content, tool details and settings keep their own bodies and live updates. |
| Native window bridges | App minimum window size, gallery window and approval window dimensions use tokens. Platform cursor/traffic-light coordination remains native. |
| Gallery / snapshot UI | Gallery framing, cards, swatches, selection paint and layout use tokens. SnapshotRenderer's View padding uses the same tokens; capture viewport matrices remain fixture inputs. |

## Global discovery and rules

The checked source tree currently contains **124 Swift files**. The scanner discovers
all `apps/macos/Sources/**/*.swift` files, including future files, mixed feature/model
files, Gallery and rendering/interaction fixtures. Only the exact Theme.swift definition
owner may construct palette/type recipes; aliases cannot export those constructors.

The numeric guard is no longer an eight-file checklist. It checks:

- Literal arguments to the recognized visual API catalog: layout stacks/grids, padding,
  frames, line spacing/tracking, fills via palette rules, alpha, shadows, offsets, scale,
  blur, corner/stroke geometry, animation recipes/timelines, standard glyph/face/spinner
  dimensions and product-window bounds.
- Numeric local/member initializers and parameter defaults inside presentation declarations
  or view-building helpers, so a local `gap = 13` is not a style escape.
- Ad-hoc typography derivatives (`weight`, `bold`, `italic`, `fontWeight`) outside the
  type owner. Content alignment such as monospaced digits is not a font-size recipe.
- Raw Button/TextField/SecureField/TextEditor and their AppKit counterparts, in addition
  to Toggle/Menu. Shared implementations are registered by exact path, declaring type,
  member and primitive kind. Nested lookalike owners do not inherit an exemption.
- Real native menu content, alert action and command builders as structural exceptions;
  message/label builders are not implicitly licensed to create interactive controls.
- Unused numeric/control owner entries during a full application-tree scan. Exceptions
  do not disable palette, typography or other rules on the surrounding member.

`tests/native/design-guard.test.ts` contains positive and negative syntax cases for these
boundaries. Existing index-snapshot gate proofs remain in `design-gate.test.ts`.
The inventory/AST migration tools used during this work live only under ignored `.local/`;
they are not a production theme generator or a new dependency.

## Intentionally retained numbers

These are not postponed UI styles:

- The dialog card radius, shadow and 44/48 pt header/footer heights are tokens in
  Theme.Dialog, not style literals; the hidden Return/Escape control paints nothing.
- Normalized BotFace artwork and task-tree path/index arithmetic. Direct styling inside
  those helpers is still checked; the numeric allowance is not a color/font exemption.
- Secret minimum length and preset TTLs, pairing lifetimes, timestamp unit conversion,
  HTTP status, retention windows, parser limits and collector/model formatting limits.
- Content counts, initial-character extraction, list indices, normalized phase parity,
  complete rotations and unit axes. Literal 0/1 is not universally exempt in style calls:
  a one-point frame or stroke still needs its token outside a specific data allowance.
- Interaction-fixture coordinates, event codes and deadlines; snapshot viewport matrices
  and scripted fixture data. Their actual View styling remains scanned.

The phase-1 independent SwiftSyntax argument inventory recorded **68 remaining nonzero
numeric samples** in its visual/default-parameter catalog, confined to five files:

| File | Classification |
| --- | --- |
| ComposerFocusFixture/NativeComposerFocus.swift | Native probe window coordinates/sizes and settling duration |
| EagleDevices/DeviceXPC.swift | RPC timeout default |
| EagleFeatures/DeviceSettingsViewModel.swift | Pairing lifetime default |
| EagleFeatures/SettingsViewModel.swift | Usage-window and demo-data defaults |
| SnapshotRenderer/main.swift | Explicit capture viewport matrix |

This inventory is a cross-check, not the guard's source-file allowlist. Geometry and
content arithmetic not represented by that sampling catalog are covered by the
member-level classification and source review above.

## Boundaries and acceptance

The guard is a constrained syntax policy. It does not prove arbitrary values obtained
through third-party functions or cross-file generic helper dataflow, and a new styling
API requires a rule/test when introduced. It cannot certify contrast, visual polish,
keyboard behavior or correct product data. These limitations must not be presented as
unmigrated pages or as a claim of exhaustive compiler semantic analysis.

Phase 1 deliberately preserved values; phase 2 changed the palette/shared grid.
Phase 3 now clamps settings and side columns, caps reading width and applies neutral
surfaces/paired Peer labels. Their current contracts are in `apps/macos/DESIGN.md`.
Per-control polish remains later work. Ownership coverage alone never establishes
correct solid/ink use, selected-state contrast or absence of clipping.

No archived keyboard experiment is part of this acceptance. Build/static/ownership checks
are recorded separately from execution of Swift/browser/native interaction suites.
The owner reviews the foreground Dev App before this work is treated as visually accepted.
