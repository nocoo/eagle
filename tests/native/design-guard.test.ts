import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { compileDesignGuard } from "../../apps/macos/Scripts/check-design.ts";

const root = mkdtempSync(join(tmpdir(), "eagle-design-guard-"));
let binary: string;
before(() => {
  binary = compileDesignGuard(root);
});
after(() => rmSync(root, { recursive: true, force: true }));

function check(source: string, extra: Record<string, string> = {}) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({
      "EagleDesign/Theme.swift": "enum Theme {}",
      "EagleFeatures/Example.swift": source,
      ...extra,
    }),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    path: string;
    line: number;
    rule: string;
  }[];
}

for (const source of [
  "let fill = Color(red: 1, green: 0, blue: 0)",
  "let fill = SwiftUI.Color.red",
  "let fill = SwiftUI /* comment */ . Color . init(red: 1, green: 0, blue: 0)",
  'let text = "sample \\(Color.red)"',
  "#if DEBUG\nlet fill = Color.red\n#else\nlet fill = Color.blue\n#endif",
  "typealias Paint = Color",
  "extension Theme.Palette { static let custom = Theme.Palette.accent }",
  "consume(.red)",
  "let clear = Color.clear",
  "let fill = AppKit.NSColor.systemRed",
  "let fill: NSColor = .systemRed",
  "let fill: NSColor = .lightGray",
  "let fill: NSColor = .darkGray",
  "let fill: AppKit.NSColor = .magenta",
  "enum Foreign { typealias Color = String }; let fill = Color(red: 0.3, green: 0.4, blue: 0.5)",
  "extension EagleDesign.Theme.Palette { static let custom = Theme.Palette.accent }",
  "typealias P = Theme.Palette; extension P { static let custom = Theme.Palette.accent }",
  "let fill = CGColor(gray: 0.5, alpha: 1)",
  "let fill: Color = .init(red: 1, green: 0, blue: 0)",
  "let fill: Color = .white",
  "func fill() -> Color { .red }",
  'Text("hello").foregroundStyle(\n .white\n)',
  'Text("hello").foregroundStyle(selected ? .red : .green)',
  'let local = Color.red; Text("hello").foregroundStyle(local)',
  "let fill = #colorLiteral(red: 1, green: 0, blue: 0, alpha: 1)",
  "let make = Color.init; let fill = make(.red)",
]) {
  test(`rejects palette escape: ${source}`, () => {
    assert(check(source).some((item) => item.rule === "palette-ownership"));
  });
}

for (const source of [
  'Text("hello").font(.system(size: 13))',
  'Text("hello").font(.system(size: 47).weight(.bold))',
  'Text("hello").font(.system(size: 47).monospaced())',
  "let title: Font? = .system(size: 47)",
  "let title: Optional<Font> = .system(size: 47)",
  "enum Foreign { typealias Font = String }; let title = Font.system(size: 47)",
  'Text("hello").font(.custom("Example", size: 13))',
  "let title = Font.system(size: 13)",
  "let title = SwiftUI.Font.headline",
  "let title = NSFont.systemFont(ofSize: 13)",
  "let size = 13; let title = Font.system(size: size)",
  "let title: Font = .system(size: 13)",
  "attributes.font = .system(size: 13)",
  "func label(font: Font = .headline) {}",
  "typealias Letter = Font",
  "func title() -> Font { .headline }",
]) {
  test(`rejects typography escape: ${source}`, () => {
    assert(check(source).some((item) => item.rule === "typography-ownership"));
  });
}

for (const source of [
  'Toggle("Setting", isOn: state)',
  'SwiftUI.Toggle("Setting", isOn: state)',
  'Toggle<Text>("Setting", isOn: state)',
  'let control: Toggle<Text> = .init("Setting", isOn: state)',
  "let make = Toggle<Text>.init",
  "typealias Native = SwiftUI.Toggle<Text>",
  "enum Foreign { typealias Toggle = String }",
]) {
  test(`rejects raw toggle outside standard controls: ${source}`, () => {
    assert(check(source).some((item) => item.rule === "toggle-ownership"));
  });
}

test("raw Toggle is owned by the exact switch and checkbox bodies, not entire files", () => {
  for (const name of ["SwitchToggle", "Checkbox"]) {
    const path = `EagleDesign/Primitives/${name}.swift`;
    assert.deepEqual(
      check("", {
        [path]: `struct ${name} { var body: some View { Toggle("Setting", isOn: state) } }`,
      }),
      [],
    );
    assert(
      check("", { [path]: 'let stray = Toggle("Setting", isOn: state)' }).some(
        (item) => item.rule === "toggle-ownership",
      ),
    );
    assert(
      check("", {
        [path]:
          'struct Other { var body: some View { Toggle("Setting", isOn: state) } }',
      }).some((item) => item.rule === "toggle-ownership"),
    );
    assert(
      check("", {
        [path]: `struct ${name} { var body: some View { Toggle(isOn: state) { Text("Setting").foregroundStyle(.white) } } }`,
      }).some((item) => item.rule === "palette-ownership"),
    );
  }
  assert(
    check("", {
      "EagleDesign/Theme.swift": 'let stray = Toggle("Setting", isOn: state)',
    }).some((item) => item.rule === "toggle-ownership"),
  );
});

for (const source of [
  'Menu { Text("Item") } label: { Text("Pick") }',
  'SwiftUI.Menu { Text("Item") } label: { Text("Pick") }',
  'let control: Menu<Text, Text> = .init { Text("Item") } label: { Text("Pick") }',
  "let factory = Menu<Text, Text>.init",
  "typealias RawMenu = SwiftUI.Menu<Text, Text>",
]) {
  test(`rejects raw selection menus outside their owners: ${source}`, () => {
    assert(check(source).some((item) => item.rule === "menu-ownership"));
  });
}

test("menu exceptions belong to exact native builder members", () => {
  for (const [type, member, path] of [
    ["SelectionMenu", "menu", "EagleDesign/Primitives/SelectionMenu.swift"],
    ["MenuIconButton", "body", "EagleDesign/Primitives/MenuIconButton.swift"],
    ["SidebarPanel", "itemMenu", "EagleDesign/Panels/SidebarPanel.swift"],
  ]) {
    const menu = 'Menu { Text("Item") } label: { Text("Pick") }';
    const owner =
      member === "itemMenu"
        ? `func ${member}() -> some View`
        : `var ${member}: some View`;
    assert.deepEqual(
      check("", { [path]: `struct ${type} { ${owner} { ${menu} } }` }),
      [],
    );
    assert(
      check("", {
        [path]: `struct ${type} { var other: some View { ${menu} } }`,
      }).some((item) => item.rule === "menu-ownership"),
    );
    assert(
      check("", {
        [path]: `struct ${type} { ${owner} { Menu { Text("Item") } label: { Text("Pick").foregroundStyle(.white) } } }`,
      }).some((item) => item.rule === "palette-ownership"),
    );
  }
});

for (const source of [
  'Text("Row").padding(12)',
  'let inset = 12; Text("Row").padding(inset)',
  'Text("Row").frame(height: 1)',
  "RoundedRectangle(cornerRadius: 8)",
  'Text("Row").opacity(0.65)',
  'Text("Row").animation(.easeOut(duration: 0.18), value: selected)',
]) {
  test(`form primitives reject scattered numeric style: ${source}`, () => {
    for (const path of [
      "EagleDesign/Settings/SettingsComponents.swift",
      "EagleDesign/Primitives/SelectionMenu.swift",
    ]) {
      assert(
        check("", { [path]: source }).some(
          (item) => item.rule === "form-style-ownership",
        ),
      );
    }
  });
}

test("nested lookalike owners cannot authorize native menu construction", () => {
  const path = "EagleDesign/Primitives/SelectionMenu.swift";
  for (const source of [
    'struct SelectionMenu { enum Other { static var menu: some View { Menu { Text("Item") } label: { Text("Pick") } } } }',
    'enum Other { struct SelectionMenu { var menu: some View { Menu { Text("Item") } label: { Text("Pick") } } } }',
  ])
    assert(
      check("", { [path]: source }).some(
        (item) => item.rule === "menu-ownership",
      ),
    );
});

test("form tokens preserve runtime sizing, structural zeros and content counts", () => {
  assert.deepEqual(
    check("", {
      "EagleDesign/Settings/SettingsComponents.swift": `
    VStack(spacing: 0) { Text("12").padding(Theme.Form.controlInset) }
      .frame(minHeight: minHeight).opacity(hidden ? 0 : 1)
    Text("One line").lineLimit(1)
    Text(42, format: .number)
  `,
    }),
    [],
  );
  assert(
    check("extension Theme.Form { static let rogue = 12 }").some(
      (item) => item.rule === "form-style-ownership",
    ),
  );
});

test("panel and column primitives reject scattered style values", () => {
  for (const path of [
    "EagleDesign/Panels/SidebarPanel.swift",
    "EagleDesign/Panels/ConversationRow.swift",
    "EagleDesign/Panels/InspectorColumn.swift",
    "EagleDesign/Panels/ThreeColumnShell.swift",
    "EagleDesign/Primitives/ResizeHandle.swift",
    "EagleDesign/Primitives/SegmentedTabs.swift",
  ]) {
    assert(
      check("", {
        [path]: 'let gap = 13; Text("Row").padding(gap).opacity(0.45)',
      }).some((item) => item.rule === "panel-style-ownership"),
    );
    assert.deepEqual(
      check("", {
        [path]:
          "Text(name.prefix(1)).lineLimit(1).padding(Theme.Metric.contentInset)",
      }),
      [],
    );
  }
  assert.deepEqual(
    check("", {
      "EagleDesign/Panels/SidebarPanel.swift": `
    onMoveGroup(section.id, -1)
    Button("Move") {}.disabled(index >= groups.count - 1)
  `,
    }),
    [],
  );
  for (const name of ["Sidebar", "Inspector", "Motion", "Metric"]) {
    assert(
      check(`extension Theme.${name} { static let rogue = 13 }`).some(
        (item) => item.rule === "panel-style-ownership",
      ),
    );
  }
});

test("tracks type aliases across files rather than blessing local names", () => {
  const findings = check(
    "let fill = Paint.red; let title = Letter.system(size: 13)",
    {
      "EagleDesign/Aliases.swift":
        "typealias Paint = SwiftUI.Color\ntypealias Letter = Font",
    },
  );
  assert(findings.some((item) => item.rule === "palette-ownership"));
  assert(findings.some((item) => item.rule === "typography-ownership"));
});

test("rejects aliases of the token root as well as its nested owners", () => {
  for (const owner of ["Theme", "EagleDesign.Theme"]) {
    assert(
      check(`typealias Design = ${owner}; extension Design.Palette {}`).some(
        (item) => item.rule === "token-owner-alias",
      ),
    );
  }
});

test("the token definition exemption does not permit exported raw type aliases", () => {
  const findings = check("let fill = Paint(red: 0.3, green: 0.4, blue: 0.5)", {
    "EagleDesign/Theme.swift":
      "public typealias Paint = Color\npublic typealias Letter = Font",
  });
  assert(findings.some((item) => item.rule === "palette-ownership"));
  assert(findings.some((item) => item.rule === "typography-ownership"));
});

test("reports a newly added component with its source line", () => {
  const findings = check("", {
    "EagleDesign/NewCard.swift": "import SwiftUI\nlet fill = Color.red\n",
  });
  assert(
    findings.some(
      (item) => item.path === "EagleDesign/NewCard.swift" && item.line === 2,
    ),
  );
});

test("accepts token usage, runtime dimensions and non-color enums", () => {
  assert.deepEqual(
    check(`
let fill: Color = Theme.Palette.accent
let title: Font = Theme.TypeScale.body
let face: BotTint = BotTint.red
let state: Phase = .active
var tint: Color { switch state { case .active: Theme.Palette.accent; default: Theme.Palette.line } }
Text("Title").font(row.kind == .plan ? Theme.TypeScale.body : Theme.TypeScale.note)
Text("Color.red .font(.system(size: 15))").foregroundStyle(fill)
Text("Title").font(title).frame(width: availableWidth)
Theme.Palette.clear.frame(height: 1)
Circle().strokeBorder(AngularGradient(stops: [.init(color: fill, location: 0)], center: .center))
Circle().stroke(fill, style: .init(lineWidth: 1))
Text("hello").background(alignment: .init(horizontal: .leading, vertical: .top)) { Text("World") }
// Color(red: 1, green: 0, blue: 0)
/* .font(.system(size: 15)) */
`),
    [],
  );
});

test("only the exact token owner may define the palette and type scale", () => {
  assert.deepEqual(
    check("", {
      "EagleDesign/Theme.swift":
        "let fill = Color.red; let title = Font.system(size: 13)",
    }),
    [],
  );
  assert(
    check("", { "EagleFeatures/Theme.swift": "let fill = Color.red" }).length >
      0,
  );
});

test("fails closed on malformed Swift and empty input", () => {
  assert(
    check("let fill = Color(").some((item) => item.rule === "invalid-syntax"),
  );
  const result = spawnSync(binary, [], {
    input: "{}",
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
});
