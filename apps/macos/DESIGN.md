# macOS design system

Eagle's native UI uses SwiftUI/AppKit. EagleDesign owns shared controls and visual
recipes; EagleFeatures owns state, commands and screen composition. No web component
library, private font asset or runtime theme generator is introduced.

## Status and source of truth

Phases 1 and 2 were accepted by the owner: global style ownership, the eight-family
palette, creation-time hash defaults, manual overrides and the shared grid are in place.
Phase 3 implements the reference-led composition below. **Phase-3 owner review is
pending.** Individual-control polish is still phase 4; no new product action or data
capability is introduced by this layout work.

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
  explicit accessibility label and reuses this shell. The inline shell fills the 28 pt
  row it sits in: its title, the gap and the trailing chevron are one target, so the
  chevron is as easy to hit as the title. The larger target stays invisible — the inline
  shell paints no capsule and no border, and its row height does not change.
- SettingsCard/SectionRow/Header, SettingsTextField/TextArea and SettingsActionButton
  remain the standard form primitives. SettingsSectionRow's optional leading slot carries
  the mark a row names (a bot's face in 用量); rows without one are unchanged.
- A settings table is one shared component: SettingsTableHeader draws the column titles and
  SettingsTableRow draws one row (a checkbox, a name, a version, a description and a
  directory). Both take their widths from the table tokens in Theme.Page and the description
  column takes the room that is left, so the header and its rows put the four columns at the
  same horizontal places; the layout test measures that at the 960 pt settings width. A
  caller supplies the values and the tick, and the checkbox is the only part of a row that
  reacts to a click.
- A transient answer is a toast, not a card row: ToastCenter holds one SettingsNotice (✅, ⚠️
  or neutral), SettingsScaffold floats it over the content and retires it after
  `Theme.Motion.toastDwell`, so saving never changes the height of the page that produced it.
  SettingsStatusNote stays for what a page says until its state changes: an empty list, a
  refused read, a provider probe, the device service error. InfoBanner and SettingsSectionNote
  are gone.
- The 工具 page keeps no save button: each switch writes itself through one queued request and
  reports that switch ("已开启 搜索"), so a flip never lands an older set behind a newer one. A
  switch keeps the standing instruction the 提示词 page owns instead of committing its draft.
- AccountMenu (EagleDesign) stays a library component: the Gallery still draws its specimen,
  while the shell's footer opens settings directly from the product mark and the gear.
- CardActionButton owns the existing filled/text card actions; callers retain the
  completion/password validity and submission/skip guards.
- ActionControl forwards a native Button role/action with plain, bordered, prominent or
  inherited-native styling. SettingsActionButton is the standard dialog and page action: a
  caller's `disabled` guard mutes its label and drops its accent fill, so a refused action
  never looks armed.
- IdentityField is the borderless name/tag field shaped like the inspector's identity: name
  in title type, tag in subtitle type, the inspector's row heights, a canvas fill and a
  focus ring only while typing. A dialog that asks for both therefore reads as one identity
  card, not two stacked form boxes, and the field names itself for accessibility because a
  bare `TextField` has no title.
- DialogShortcut is the invisible Return/Escape carrier a surface owns when no field has
  the keyboard (a peer or tool dialog has none at all).
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

## One modal surface

Every dialog the App itself draws goes through one host: the create form, the face editor,
a peer transcript, a tool run and settings. The host owns the dim scrim, the card surface,
the shared radius/hairline/shadow, the traffic lights and the way out (scrim, the dialog's
own close control, Escape). The shell blurs the workspace behind it and nothing else, so
the card itself stays sharp. System `.alert` confirmations, `NSOpenPanel`, permission sheets
and the separate approval window are native surfaces and stay native.

While a dialog is up the workspace is disabled and takes no hit: the shell's own dialogs,
the sidebar and the composer are unreachable, the native composer field is disabled and its
focus is released, and the menu shortcuts that move columns or open settings are ignored.
Closing a dialog bumps the conversation's focus request so the composer takes the keyboard
back. One typed presentation exists at a time — a peer exchange is read from whichever
transcript raised it — so a second surface can never appear behind the person's back. A peer
read is a request with a generation: opening one, presenting any dialog or closing a dialog
invalidates the reads still in flight, so an answer that lands after the window moved on is
dropped instead of reopening itself, while a deliberate new ask still opens.

Tool details are named by the entry that owns the run and by the transcript's owner — a bot
id, or the sample workspace — never by a copy of its rows: the dialog observes the transcript
that holds it, so a call still running keeps updating while the dialog is open. The owner is
part of the route because the transcript view model is shared: when the selection moves to
another bot (a create that lands in the background does exactly that), the detail closes
instead of showing another conversation's rows under the old entry id. Every other dialog is
about the window and survives a selection change. Peer content keeps its scroll, its live
updates and its close-only behaviour.

The create and face cards are 460 pt wide and as tall as their content (about 458 pt), not
the earlier 560 × 712 sheet. The create form is an inspector-shaped identity card (portrait,
name, optional tag) over the shared picker, whose ten shapes sit two rows of five and whose
eight canonical colours sit on one row. Its header is 44 pt, its footer 48 pt with two
standard actions.

## Eight-family palette and identity

The fixed selectable order is red, orange, yellow, green, teal, blue, violet, pink.
One cached table supplies identity, solid/onSolid, soft/onSoft and ink roles in light
and dark. OnSolid stays white and onSoft stays near-black even in dark mode. Identity
fills use dark glyphs; colored labels use ink, not the bright face fill. All eight
normal-text pairs and ink on canvas/surface/card are checked at 4.5:1 using resolved
sRGB values. Focus outlines are opaque and checked at 3:1. User-origin text's white
alpha is 0.9 and checked after compositing on the actual green bubble background.
Semantic status roles remain separate from identity; a red Bot is not an error.

The daemon hashes `SHA256(UTF8("bot:" + id))[0] % 8` only when creating a Bot without
an explicit tint, then stores the complete appearance in the initial catalog write. The App
does not rely on it: a create form picks one of the same eight canonical colours once, when
it opens, previews exactly that colour, and sends shape and tint explicitly. Typing a name
or picking a shape never re-rolls it, and a Bot created through the API or CLI keeps the
daemon's ID-hash default.
The client never guesses defaults from names, applies Swift hashValue, rehashes saved
colors or stores auto/manual metadata. Creation alone may omit tint; update stays
complete. A neutral creation preview does not pretend to know the unallocated ID.
Existing choices survive shape-only editing. Unknown peers stay neutral.

Protocol v1 retains its twelve legal names. The picker offers only the eight canonical
names; clay renders the orange family, sky the blue family, paper a light neutral and
graphite a strong neutral with white eyes. These are mappings into the same table and
neutral ramp, not old independent paints or storage normalization. Deploy/restart the
updated App and daemon together before shape-only creation; never retry an old daemon's
refusal with green. Details and fixed vectors live in `docs/bots/PROTOCOL.md`.

The Gallery's color page retains the accepted light/dark matrix. Chrome and prose use
neutral surfaces; existing user messages and primary actions keep green solid/white
pairs. Peer sender labels use small opaque soft/onSoft chips; their prose stays neutral,
so Markdown does not inherit an incompatible dark-theme ink on a pale card. Unknown
peers retain the neutral family. Selected/hovered sidebar previews and gray tags use
textSecondary, checked against their actual gray backgrounds at 4.5:1. White-text
unread pills/counts use the blue solid role; their standalone unread dots retain ink.

## Grid scale and preserved boundaries

Common spacing and control boxes use a 4 pt primary grid with 2 pt compact subdivisions.
Rows are 60 pt with 36 pt faces; header buttons are 36 pt; fields are 36 pt with 12 pt
insets; actions are 32 pt; composer/footer are 56 pt. Body typography stays 15 pt and
the waiting band stays 32 pt. The Gallery includes gap specimens and actual shared
field/action wrappers aligned by SettingsSectionRow.

Explicit non-grid boundaries: native traffic-light measurements/nudges, TextEditor's
intrinsic-inset correction, font/glyph metrics, vector proportions, shadow/motion
recipes and semantic stroke widths are not padding-grid values. The physical resize
line uses SwiftUI pixelLength (1 pt at 1×, 0.5 pt at 2×) and aligns its inner edge without
shrinking the existing 11 pt drag hit region or changing drag/clamp behavior. Card/focus
outlines retain their semantic widths, distinct from physical-pixel separators.

## The 技能 page

The 技能 page (settings → 技能) says where skills come from and what was found there, and
its ticks are live: the App pushes the selection to this machine's Bot service, which is what
every Bot reads. The page says so in one line — 勾选即生效, and a Bot reads the file with
`skill_read` before following it — and it never mentions a tool group, because the ticks are
the switch.

- The scan roots are `~/.agents/skills` (always scanned, never removable, shown with a `~`)
  and the folders the person added with a native folder picker, in the order they were
  added. Each custom root has a 移除 button; the automatic root has none.
- A skill is an immediate child directory of a root that carries a `SKILL.md`. The front
  matter is the block between two column-0 `---` delimiters, and without a closing one there
  is none at all. Plain, single quoted and double quoted scalars are read, the six block
  forms (`|`, `|-`, `|+`, `>`, `>-`, `>+`) are read, a comment that follows a value is dropped
  before the value is looked at, and a `#` inside quotes stays part of the value. A version
  counts when it is a direct child of a `metadata` mapping. A value the reader cannot read is
  no value at all: the cell stays empty and the skill is named after its folder. A missing
  name falls back to the folder name and every other key, and every sequence, is ignored.
- A folder that is really the same folder — reached through a link, or through two roots —
  is one skill with one row, and the row keeps the path the skill really lives at, so a tick
  belongs to the skill and not to the way in.
- A manifest is read through one descriptor that is opened without blocking and checked with
  `fstat` before a byte is read, so a pipe — even one that replaces the manifest after the
  check — is never read and never holds the scan up. Only the head of a manifest is read, and
  the front matter is decided on those bytes, so a character that the cut split in half
  cannot take the front matter with it. An empty manifest is a skill without front matter.
- A root that is not there says so, and a root the process may not read says why; neither
  fails the page.
- The rows are ordered by name (case-insensitively) and then by path.
- The list has a keyword field (name, description and directory) and a 全部/已勾选/未勾选
  filter, and it states the honest counts. Nothing is ticked until a person ticks it, and
  the ticks and the custom roots live in this App's own defaults.
- A tick, an added or removed root and a finished scan each push the whole selection (name,
  version, description and the `~`-shaped directory) to the daemon through the same token
  client the other settings pages use, one push at a time so two quick ticks cannot land out
  of order. A refused push changes nothing locally: the tick stays, the card shows the
  daemon's own message as a ⚠️ note under the statement, and the next change or page visit
  sends the selection again; a successful push clears the note. A skill the scan no longer
  finds is not pushed as if it still existed.
- The scan reads the filesystem off the main actor and publishes on it; 重新扫描 rescans
  without losing the ticks. Every reload is a request of its own and only the newest one
  answers the page: a request that a newer one has superseded leaves the page alone and
  does not scan again, so an older answer can never overwrite a newer one. A root that
  changes while a scan is running therefore ends with a scan of the scope that is stored
  now.

## Reference-led composition

The main window retains its declared 1280 × 760 content minimum and preferred size.
Native titlebar/safe-area accounting can add outer height: the live AX window clamped
to 1280 × 788 during this phase's minimum-size inspection.
Side columns default to 320 / 300 pt. The window's pure resolver reserves a 560 pt center,
allocating the sidebar preference first and then the inspector from the remaining budget.
Hidden columns consume zero. Requested widths are not overwritten on window shrink;
space returned to the inspector can restore its stored preference. Drag maxima use the
other effective width. ThreeColumnShell alone frames the flexible side panels, and Peer
overlays use the same effective sidebar edge. The inspector portrait is 64 pt and its
12 pt tab gaps keep all five destinations at the supported side minimum.

The settings envelope is at most 960 × 688 with 24 pt outer clearance, clamped to the
actual host. No inner minimum can enlarge that envelope. The header/close remains outside
the content scroller; the compact 32 pt navigation rows have their own scroller. Shared
form rows use 12 pt vertical padding; the fields/buttons retain their accepted heights.
This repairs modal clipping at supported short windows, not a promise that every fixed
field remains usable in arbitrarily tiny hosts.

Conversation content, waiting band and composer share a 960 pt maximum lane with 16 pt
side insets. A message row's 636 pt cap is explicitly 600 pt bubble + 28 pt copy target +
8 pt gutter, and shrinks under narrower parent proposals. User text expands vertically;
its reading measure no longer grows with a wide window. Assistant/Peer maxWidth remains
a wrapper bound including the copy gutter; the Peer override remains 560 pt. Tool cards
keep a 600 pt cap, turns use 16 pt spacing, and hover never adds/removes the reserved copy
slot. Peer dialogs inset their content by 24 pt. No entry regrouping or scroll-state
architecture change is involved.

Sidebar version text sits below the name to preserve both footer actions at narrow
widths; full version remains in its help/accessibility text. Search/share/attachment/mic
visibility and callbacks are unchanged, pending a separate owner decision.

Do not change the secret minimum length/TTLs, asynchronous confirmation, skip/replay
behavior, device/remote permission conditions, freshness provenance or unknown states
while styling their views. No real secret is needed for review fixtures.

## Scrolling and rendering

Keep per-tick transcript bookkeeping in TranscriptScroller rather than observable
SwiftUI state. Preserve the existing scroll-cost checks and hover-only copy/selection
machinery. New style organization must not change streaming, follow/unfollow, text
selection, copy, code/table overflow or composer focus/keyboard behavior.

The dialog review has its own isolated capture path — it composes the same dialog views
through `ModalHost` over a synthetic three-column backdrop, with a unique UserDefaults
suite, a stub HTTP session and `SnapshotDeviceControl`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift run --package-path apps/macos SnapshotRenderer .local/macos-dialogs --dialogs-only
```

It writes `dialog-{create,face,peer,tool,settings}-{light,dark}.png`. The capture reads no
person's preferences: the suite is its own domain and is removed after the run, `.defaultAppStorage`
points AppStorage at that suite, and the settings surface gets an explicit
`SkillsSettingsViewModel`/`SkillsSelection` rooted in a temporary home with a push that goes
nowhere, so the 技能 page never scans the real `~/.agents/skills` or the real tick list. A
built-in assertion proves the sentinel it writes is invisible to the standard defaults and
that the scanned home is temporary before anything renders. Escape, Return, traffic lights and
Reduce Motion are not certified by these images; they need a foreground window.

Use SnapshotRenderer's `--composition-only` path for this phase's synthetic review:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift run --package-path apps/macos SnapshotRenderer .local/phase3-composition --composition-only
```

It uses design components instead of the production workspace/supervisor, a stub HTTP
session, SnapshotDeviceControl and a unique cleaned UserDefaults suite (also injected
into AppStorage). The matrix covers 1280 × 760, 1280 × 800, 1280 × 1410 and 1728 × 1082,
light/dark, three/two/no-sidebar/drag-limit columns, settings and Peer dialogs. Viewport
numbers are fixture inputs, not a second style system; actual View styling is scanned.
Do not treat the default renderer path as isolated: it still includes production
workspace/other operational paths. Real foreground App review remains required; captures
do not certify live bindings, traffic lights, drag gestures or keyboard navigation.

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
