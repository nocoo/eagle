import Foundation
import SwiftParser
import SwiftSyntax

struct Finding: Codable, Hashable {
  let path: String
  let line: Int
  let rule: String
}

func symbol(_ node: some SyntaxProtocol) -> String {
  node.tokens(viewMode: .sourceAccurate).map(\.text).joined()
}

func family(_ name: String) -> String? {
  if name.hasSuffix("?") || name.hasSuffix("!") { return family(String(name.dropLast())) }
  for prefix in ["Optional<", "Swift.Optional<"] where name.hasPrefix(prefix) && name.hasSuffix(">")
  {
    return family(String(name.dropFirst(prefix.count).dropLast()))
  }
  if name == "Toggle" || name == "SwiftUI.Toggle"
    || name.hasPrefix("Toggle<") || name.hasPrefix("SwiftUI.Toggle<")
  {
    return "toggle-ownership"
  }
  if name == "Menu" || name == "SwiftUI.Menu"
    || name.hasPrefix("Menu<") || name.hasPrefix("SwiftUI.Menu<")
  {
    return "menu-ownership"
  }
  switch name {
  case "Color", "SwiftUI.Color", "NSColor", "AppKit.NSColor", "CGColor", "CoreGraphics.CGColor":
    return "palette-ownership"
  case "Font", "SwiftUI.Font", "NSFont", "AppKit.NSFont":
    return "typography-ownership"
  default: return nil
  }
}

func ownerFamily(_ name: String) -> String? {
  if name == "Theme" || name.hasSuffix(".Theme") { return "token-owner-alias" }
  if name == "Theme.Palette" || name.hasSuffix(".Theme.Palette") { return "palette-ownership" }
  if name == "Theme.TypeScale" || name.hasSuffix(".Theme.TypeScale") {
    return "typography-ownership"
  }
  if name == "Theme.Form" || name.hasSuffix(".Theme.Form") { return "form-style-ownership" }
  for namespace in ["Sidebar", "Inspector", "Motion", "Metric"] {
    if name == "Theme.\(namespace)" || name.hasSuffix(".Theme.\(namespace)") {
      return "panel-style-ownership"
    }
  }
  return nil
}

final class Ownership: SyntaxVisitor {
  let path: String
  let locations: SourceLocationConverter
  var findings: Set<Finding> = []

  let colors: Set<String> = [
    "white", "black", "gray", "lightGray", "darkGray", "magenta", "red", "green", "blue",
    "yellow", "orange", "pink", "purple",
    "brown", "cyan", "mint", "indigo", "teal", "primary", "secondary", "accentColor",
  ]

  let fonts: Set<String> = [
    "system", "custom", "largeTitle", "title", "title2", "title3", "headline", "subheadline",
    "body", "callout", "footnote", "caption", "caption2", "systemFont", "boldSystemFont",
    "monospacedSystemFont", "monospacedDigitSystemFont", "userFont", "userFixedPitchFont",
    "menuFont", "menuBarFont", "messageFont", "paletteFont", "toolTipsFont", "labelFont",
    "controlContentFont", "preferredFont",
  ]

  init(path: String, tree: SourceFileSyntax) {
    self.path = path
    self.locations = SourceLocationConverter(fileName: path, tree: tree)
    super.init(viewMode: .sourceAccurate)
  }

  func expectedFamily(_ node: some SyntaxProtocol) -> String? {
    var parent = Syntax(node).parent
    while let current = parent {
      if let parameter = current.as(FunctionParameterSyntax.self) {
        return family(symbol(parameter.type))
      }
      if let sequence = current.as(SequenceExprSyntax.self),
        let assignment = sequence.elements.firstIndex(where: { $0.is(AssignmentExprSyntax.self) }),
        let member = sequence.elements.prefix(upTo: assignment).last?.as(
          MemberAccessExprSyntax.self),
        member.declName.baseName.text == "font"
      {
        return "typography-ownership"
      }
      if let binding = current.as(PatternBindingSyntax.self), let type = binding.typeAnnotation {
        return family(symbol(type.type))
      }
      if let function = current.as(FunctionDeclSyntax.self),
        let type = function.signature.returnClause?.type
      {
        return family(symbol(type))
      }
      if let argument = current.as(LabeledExprSyntax.self),
        let call = current.parent?.parent?.as(FunctionCallExprSyntax.self)
      {
        let name = call.calledExpression.as(MemberAccessExprSyntax.self)?.declName.baseName.text
        let label = argument.label?.text
        if name == "font", label == nil { return "typography-ownership" }
        if [
          "foregroundStyle", "foregroundColor", "background", "fill", "stroke", "strokeBorder",
          "tint", "colorMultiply", "border",
        ]
        .contains(name ?? ""), label == nil {
          return "palette-ownership"
        }
        if name == "shadow", label == "color" { return "palette-ownership" }
        if name != "some" { return nil }
      }
      parent = current.parent
    }
    return nil
  }

  func ownsControl(_ node: some SyntaxProtocol, rule: String) -> Bool {
    var parent = Syntax(node).parent
    var member: String?
    while let current = parent {
      if let binding = current.as(PatternBindingSyntax.self),
        binding.parent?.parent?.parent?.is(MemberBlockItemSyntax.self) == true
      {
        member = symbol(binding.pattern)
      }
      if let function = current.as(FunctionDeclSyntax.self),
        function.parent?.is(MemberBlockItemSyntax.self) == true
      {
        member = function.name.text
      }
      if current.is(EnumDeclSyntax.self) || current.is(ClassDeclSyntax.self)
        || current.is(ActorDeclSyntax.self) || current.is(ExtensionDeclSyntax.self)
      {
        return false
      }
      if let type = current.as(StructDeclSyntax.self) {
        guard type.parent?.parent?.parent?.is(SourceFileSyntax.self) == true else { return false }
        let name = type.name.text
        if rule == "toggle-ownership", member == "body",
          ["SwitchToggle", "Checkbox"].contains(name)
        {
          return path == "EagleDesign/Primitives/\(name).swift"
        }
        if rule == "menu-ownership" {
          if (name == "SelectionMenu" && member == "menu")
            || (name == "MenuIconButton" && member == "body")
          {
            return path == "EagleDesign/Primitives/\(name).swift"
          }
          if name == "SidebarPanel", member == "itemMenu" {
            return path == "EagleDesign/Panels/SidebarPanel.swift"
          }
        }
        return false
      }
      parent = current.parent
    }
    return false
  }

  func checkStyleNumber(_ text: String, node: some SyntaxProtocol) {
    let rule: String
    if [
      "EagleDesign/Settings/SettingsComponents.swift",
      "EagleDesign/Primitives/SelectionMenu.swift",
    ].contains(path) {
      rule = "form-style-ownership"
    } else if [
      "EagleDesign/Panels/SidebarPanel.swift",
      "EagleDesign/Panels/ConversationRow.swift",
      "EagleDesign/Panels/InspectorColumn.swift",
      "EagleDesign/Panels/ThreeColumnShell.swift",
      "EagleDesign/Primitives/ResizeHandle.swift",
      "EagleDesign/Primitives/SegmentedTabs.swift",
    ].contains(path) {
      rule = "panel-style-ownership"
    } else {
      return
    }
    if text == "0" || text == "0.0" { return }
    var parent = Syntax(node).parent
    while let current = parent {
      if let call = current.as(FunctionCallExprSyntax.self) {
        let name =
          call.calledExpression.as(MemberAccessExprSyntax.self)?.declName.baseName.text
          ?? call.calledExpression.as(DeclReferenceExprSyntax.self)?.baseName.text
        if name == "Text" || name == "lineLimit" { return }
        if text == "1", ["opacity", "scaleEffect", "prefix"].contains(name ?? "") { return }
        if text == "1", path == "EagleDesign/Panels/SidebarPanel.swift",
          name == "onMoveGroup" || name == "disabled"
        {
          return
        }
        break
      }
      parent = current.parent
    }
    report(node, rule)
  }

  override func visit(_ node: IntegerLiteralExprSyntax) -> SyntaxVisitorContinueKind {
    checkStyleNumber(node.literal.text, node: node)
    return .visitChildren
  }

  override func visit(_ node: FloatLiteralExprSyntax) -> SyntaxVisitorContinueKind {
    checkStyleNumber(node.literal.text, node: node)
    return .visitChildren
  }

  func report(_ node: some SyntaxProtocol, _ rule: String, enforceInOwner: Bool = false) {
    if !enforceInOwner {
      if ["toggle-ownership", "menu-ownership"].contains(rule), ownsControl(node, rule: rule) {
        return
      }
      if path == "EagleDesign/Theme.swift",
        ["palette-ownership", "typography-ownership"].contains(rule)
      {
        return
      }
    }
    findings.insert(
      Finding(
        path: path, line: locations.location(for: node.positionAfterSkippingLeadingTrivia).line,
        rule: rule))
  }

  override func visit(_ node: MemberAccessExprSyntax) -> SyntaxVisitorContinueKind {
    let name = node.declName.baseName.text
    if let base = node.base, let rule = family(symbol(base)) {
      report(node, rule)
      return .skipChildren
    }
    if node.base == nil, !["clear", "some", "none"].contains(name) {
      if colors.contains(name) { report(node, "palette-ownership") }
      if let rule = expectedFamily(node) {
        if name == "init"
          || (rule == "typography-ownership" && fonts.contains(name))
          || (rule == "palette-ownership" && (name.hasPrefix("system") || name.hasSuffix("Color")))
        {
          report(node, rule)
        }
      }
    }
    return .visitChildren
  }

  override func visit(_ node: DeclReferenceExprSyntax) -> SyntaxVisitorContinueKind {
    if let rule = family(node.baseName.text) { report(node, rule) }
    return .visitChildren
  }

  override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
    if let rule = family(symbol(node.calledExpression)) {
      report(node, rule)
      return ["toggle-ownership", "menu-ownership"].contains(rule) ? .visitChildren : .skipChildren
    }
    return .visitChildren
  }

  override func visit(_ node: TypeAliasDeclSyntax) -> SyntaxVisitorContinueKind {
    let target = symbol(node.initializer.value)
    if let rule = family(target) ?? ownerFamily(target) ?? family(node.name.text) {
      report(node, rule, enforceInOwner: true)
    }
    return .visitChildren
  }

  override func visit(_ node: ExtensionDeclSyntax) -> SyntaxVisitorContinueKind {
    if let rule = ownerFamily(symbol(node.extendedType)) { report(node, rule) }
    return .visitChildren
  }

  override func visit(_ node: MacroExpansionExprSyntax) -> SyntaxVisitorContinueKind {
    if node.macroName.text == "colorLiteral" { report(node, "palette-ownership") }
    return .visitChildren
  }
}

let data = FileHandle.standardInput.readDataToEndOfFile()
let sources = try JSONDecoder().decode([String: String].self, from: data)
guard !sources.isEmpty, sources["EagleDesign/Theme.swift"] != nil else { exit(2) }
var findings: Set<Finding> = []
for (path, source) in sources {
  let tree = Parser.parse(source: source)
  if tree.hasError { findings.insert(Finding(path: path, line: 1, rule: "invalid-syntax")) }
  let visitor = Ownership(path: path, tree: tree)
  visitor.walk(tree)
  findings.formUnion(visitor.findings)
}
let result = findings.sorted {
  ($0.path, $0.line, $0.rule) < ($1.path, $1.line, $1.rule)
}
FileHandle.standardOutput.write(try JSONEncoder().encode(result))
