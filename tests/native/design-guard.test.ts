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
