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
  for control in [
    "Button", "TextField", "SecureField", "TextEditor", "NSButton", "NSTextField",
    "NSSecureTextField", "NSTextView",
  ] {
    if name == control || name == "SwiftUI.\(control)" || name == "AppKit.\(control)"
      || name.hasPrefix("\(control)<") || name.hasPrefix("SwiftUI.\(control)<")
    {
      return "control-ownership"
    }
  }
  switch name {
  case "Color", "SwiftUI.Color", "NSColor", "AppKit.NSColor", "CGColor", "CoreGraphics.CGColor":
    return "palette-ownership"
  case "Font", "SwiftUI.Font", "NSFont", "AppKit.NSFont":
    return "typography-ownership"
  default: return nil
  }
}

func isNumericType(_ type: some SyntaxProtocol) -> Bool {
  [
    "CGFloat", "Double", "Float", "Int", "Swift.Double", "Swift.Float", "Swift.Int",
    "CoreFoundation.CGFloat", "CoreGraphics.CGFloat", "Foundation.CGFloat",
  ].contains(symbol(type))
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
  if name.hasPrefix("Theme.") || name.contains(".Theme.") { return "token-owner-alias" }
  return nil
}

struct NumericAllowance {
  let path: String
  let owner: String
  let values: Set<String>
  let reason: String
  var visualContexts: Set<String> = []
}

let numericAllowances: [NumericAllowance] = [
  .init(
    path: "EagleDesign/Primitives/BusyFace.swift", owner: "BusyFace.wave", values: ["2"],
    reason: "Full-circle sine phase"),
  .init(
    path: "EagleFeatures/SettingsView.swift", owner: "SettingsView.retentionDays", values: ["90"],
    reason: "Usage retention window, not presentation spacing"),
  .init(
    path: "EagleDesign/Primitives/BusyFace.swift", owner: "BusyFace.body", values: ["1", "2"],
    reason: "Unit-normalized breathing wave", visualContexts: ["scaleEffect"]),
  .init(
    path: "EagleDesign/Primitives/SwitchToggle.swift", owner: "SpinnerArc.body", values: ["360"],
    reason: "One complete rotation", visualContexts: ["rotationEffect"]),
  .init(
    path: "EagleDesign/Primitives/WaitingLine.swift", owner: "WaitingLine.wordWeight",
    values: ["1"], reason: "Normalized visibility endpoint"),
  .init(
    path: "EagleDesign/Primitives/BotFace.swift", owner: "ShapePath.path", values: ["*"],
    reason: "Normalized vector path and trigonometric artwork, never direct style arguments"),
  .init(
    path: "EagleDesign/Panels/InspectorTaskTree.swift", owner: "InspectorTaskTree.path",
    values: ["*"], reason: "Path geometry derived from token row heights and indents"),
  .init(
    path: "EagleDesign/Panels/InspectorTaskTree.swift", owner: "InspectorTaskTree.parents",
    values: ["1"], reason: "Parent-depth indexing"),
  .init(
    path: "EagleDesign/Primitives/BotFace.swift", owner: "BotFace.eyes",
    values: ["0.085", "0.17", "0.11", "0.04", "2"], reason: "Normalized face artwork geometry",
    visualContexts: ["RoundedRectangle", "offset"]),
  .init(
    path: "EagleDesign/Chat/SecretCardRow.swift", owner: "SecretCardRow.minimumValueLength",
    values: ["4"], reason: "Secret admission contract, not layout"),
  .init(
    path: "EagleDesign/Chat/MarkdownView.swift", owner: "MarkdownInline.body", values: ["2"],
    reason: "Alternating caret phase parity"),
  .init(
    path: "EagleDesign/Chat/Composer.swift", owner: "Composer.placeholderLine", values: ["1"],
    reason: "Unit rotation axis", visualContexts: ["rotation3DEffect"]),
  .init(
    path: "EagleDesign/Primitives/ParticipantBubble.swift", owner: "ParticipantBubble.body",
    values: ["1", "360"], reason: "Normalized gradient endpoint and full-circle rotation",
    visualContexts: ["strokeBorder", "rotationEffect"]),
  .init(
    path: "EagleDesign/Primitives/WaitingLine.swift", owner: "WaitingLine.label", values: ["1"],
    reason: "Complement of normalized word weight", visualContexts: ["offset"]),
  .init(
    path: "EagleDesign/Primitives/WaitingLine.swift", owner: "WaitingLine.dots",
    values: ["1", "2"], reason: "Circle phase and number-of-gaps arithmetic",
    visualContexts: ["frame"]),
  .init(
    path: "EagleFeatures/DeviceApprovalView.swift", owner: "DeviceApprovalView.body",
    values: ["1000"], reason: "Milliseconds-to-seconds expiry comparison"),
  .init(
    path: "EagleFeatures/DeviceSettingsView.swift", owner: "DeviceSettingsView.ttlSeconds",
    values: ["3600"], reason: "Pairing protocol lifetime"),
  .init(
    path: "EagleFeatures/DeviceSettingsView.swift", owner: "DeviceSettingsView.validityChoices",
    values: ["3600", "86400"], reason: "Pairing protocol lifetime choices"),
  .init(
    path: "EagleFeatures/DeviceSettingsView.swift", owner: "DeviceSettingsView.pairingContent",
    values: ["1000"], reason: "Milliseconds-to-seconds date conversion"),
  .init(
    path: "EagleFeatures/HerdrTeamsView.swift", owner: "HerdrTeamsView.teamRows", values: ["2"],
    reason: "Half of the declared task indent", visualContexts: ["padding"]),
]

func declarationOwner(_ node: some SyntaxProtocol) -> String? {
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
    if current.is(InitializerDeclSyntax.self) { member = "init" }
    let type =
      current.as(StructDeclSyntax.self)?.name.text ?? current.as(ClassDeclSyntax.self)?.name.text
      ?? current.as(EnumDeclSyntax.self)?.name.text
    if let type, let member {
      guard current.parent?.parent?.parent?.is(SourceFileSyntax.self) == true else { return nil }
      return "\(type).\(member)"
    }
    parent = current.parent
  }
  return nil
}

let controlOwners: [String: Set<String>] = [
  "EagleDesign/Chat/AskCardRow.swift#AskCardRow.header": ["Button"],
  "EagleDesign/Chat/AskCardRow.swift#AskCardRow.optionRow": ["Button"],
  "EagleDesign/Chat/CardActionButton.swift#CardActionButton.body": ["Button"],
  "EagleDesign/Chat/Composer.swift#Composer.body": ["Button", "TextField"],
  "EagleDesign/Chat/SecretCardRow.swift#SecretCardRow.valueField": ["TextField", "SecureField"],
  "EagleDesign/Chat/ToolCallRow.swift#ToolRunRow.body": ["Button"],
  "EagleDesign/Chat/ToolCallRow.swift#ToolRunDetailView.body": ["Button"],
  "EagleDesign/Gallery/TemplateGallery.swift#TemplateGallery.navigation": ["Button"],
  "EagleDesign/Gallery/TemplateGallery.swift#TemplateGallery.activitySection": ["Button"],
  "EagleDesign/Panels/DeviceInspectorList.swift#DeviceInspectorList.manageRow": ["Button"],
  "EagleDesign/Panels/InspectorColumn.swift#Identity.nameView": ["TextField"],
  "EagleDesign/Panels/InspectorColumn.swift#Identity.labelView": ["TextField", "Button"],
  "EagleDesign/Panels/InspectorSectionView.swift#InspectorPullRowView.body": ["Button"],
  "EagleDesign/Panels/SidebarPanel.swift#SidebarPanel.sectionHeaderContent": [
    "Button", "TextField",
  ],
  "EagleDesign/Panels/SidebarPanel.swift#SidebarPanel.selectableRow": ["Button", "TextField"],
  "EagleDesign/Panels/SidebarPanel.swift#SidebarPanel.unreadPill": ["Button"],
  "EagleDesign/Panels/SidebarPanel.swift#SidebarPanel.footer": ["Button"],
  "EagleDesign/Panels/SidebarPanel.swift#SidebarPanel.sectionMenu": ["Button"],
  "EagleDesign/Panels/SidebarPanel.swift#SidebarPanel.itemMenu": ["Button"],
  "EagleDesign/Peers/PeerConversationDialog.swift#PeerConversationDialog.footer": ["Button"],
  "EagleDesign/Peers/PeerExchangeRow.swift#PeerExchangeRow.body": ["Button"],
  "EagleDesign/Peers/PeerExchangeRow.swift#PeerOriginRow.body": ["Button"],
  "EagleDesign/Primitives/ActionControl.swift#ActionControl.button": ["Button"],
  "EagleDesign/Primitives/BotFacePicker.swift#BotFacePicker.body": ["Button"],
  "EagleDesign/Primitives/ChevronRow.swift#ChevronRow.body": ["Button"],
  "EagleDesign/Primitives/IconButton.swift#IconButton.body": ["Button"],
  "EagleDesign/Primitives/IconButton.swift#TextAction.body": ["Button"],
  "EagleDesign/Primitives/ParticipantBubble.swift#ParticipantBubble.body": ["Button"],
  "EagleDesign/Primitives/SegmentedTabs.swift#SegmentedTabs.body": ["Button"],
  "EagleDesign/Settings/AccountMenu.swift#AccountMenu.body": ["Button"],
  "EagleDesign/Settings/CreationTextField.swift#CreationTextField.body": ["TextField"],
  "EagleDesign/Settings/SettingsComponents.swift#SettingsTextArea.body": ["TextEditor"],
  "EagleDesign/Settings/SettingsComponents.swift#SettingsTextField.body": [
    "TextField", "SecureField", "Button",
  ],
  "EagleDesign/Settings/SettingsComponents.swift#SettingsActionButton.body": ["Button"],
  "EagleDesign/Settings/SettingsScaffold.swift#SettingsRail.body": ["Button"],
  "ComposerFocusFixture/NativeComposerFocus.swift#ComposerFocusWindow.other": ["NSTextField"],
]

let visualCalls: Set<String> = [
  "padding", "frame", "lineSpacing", "tracking", "opacity", "shadow", "offset", "scaleEffect",
  "blur", "cornerRadius", "RoundedRectangle", "stroke", "strokeBorder", "trim",
  "rotationEffect", "rotation3DEffect", "scale", "animation", "position", "HStack", "VStack",
  "LazyHStack", "LazyVStack", "Spacer", "Grid", "LazyVGrid", "GridItem", "IconButton", "SpinnerArc",
  "Avatar",
  "BotFace", "BusyFace", "BusyWhenWorking", "easeOut", "easeInOut", "snappy", "linear", "spring",
]

final class Ownership: SyntaxVisitor {
  let path: String
  let locations: SourceLocationConverter
  var findings: Set<Finding> = []
  var usedAllowances: Set<Int> = []
  var usedControls: Set<String> = []

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
      guard isPresentationNumber(node) else { return }
      rule = "presentation-style-ownership"
    }
    if text == "0" || text == "0.0" { return }
    if !isDirectStyleArgument(node), let owner = declarationOwner(node),
      let index = numericAllowances.firstIndex(where: {
        $0.path == path && $0.owner == owner
          && ($0.values.contains(text) || $0.values.contains("*"))
          && (visualContext(node).map($0.visualContexts.contains) ?? true)
          && (visualContext(node) == nil || text != "2"
            || node.previousToken(viewMode: .sourceAccurate)?.text == "/")
      })
    {
      usedAllowances.insert(index)
      return
    }
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

  func visualContext(_ node: some SyntaxProtocol) -> String? {
    var parent = Syntax(node).parent
    let position = node.positionAfterSkippingLeadingTrivia.utf8Offset
    while let current = parent {
      if let call = current.as(FunctionCallExprSyntax.self) {
        let name =
          call.calledExpression.as(MemberAccessExprSyntax.self)?.declName.baseName.text
          ?? call.calledExpression.as(DeclReferenceExprSyntax.self)?.baseName.text ?? ""
        if visualCalls.contains(name),
          call.arguments.contains(where: {
            ![
              "content", "label", "action", "onChange", "tint", "tintIndex", "badge", "initial",
              "value",
            ].contains($0.label?.text ?? "")
              && position >= $0.expression.positionAfterSkippingLeadingTrivia.utf8Offset
              && position < $0.expression.endPositionBeforeTrailingTrivia.utf8Offset
          })
        {
          return name
        }
      }
      parent = current.parent
    }
    return nil
  }

  func isDirectStyleArgument(_ node: some SyntaxProtocol) -> Bool {
    var current = Syntax(node).parent
    if current?.is(PrefixOperatorExprSyntax.self) == true { current = current?.parent }
    guard let argument = current?.as(LabeledExprSyntax.self),
      let call = argument.parent?.parent?.as(FunctionCallExprSyntax.self)
    else { return false }
    let name =
      call.calledExpression.as(MemberAccessExprSyntax.self)?.declName.baseName.text
      ?? call.calledExpression.as(DeclReferenceExprSyntax.self)?.baseName.text ?? ""
    return visualCalls.contains(name)
  }

  func isPresentationNumber(_ node: some SyntaxProtocol) -> Bool {
    if path == "EagleDesign/Theme.swift" { return false }
    var parent = Syntax(node).parent
    var binding = false
    var presentation = false
    let position = node.positionAfterSkippingLeadingTrivia.utf8Offset
    while let current = parent {
      let initial =
        current.as(PatternBindingSyntax.self)?.initializer?.value
        ?? current.as(FunctionParameterSyntax.self)?.defaultValue?.value
      if let property = current.as(PatternBindingSyntax.self), property.accessorBlock != nil,
        let type = property.typeAnnotation?.type,
        isNumericType(type)
      {
        binding = true
      }
      if let function = current.as(FunctionDeclSyntax.self),
        let result = function.signature.returnClause?.type,
        isNumericType(result)
      {
        binding = true
      }
      if let initial, position >= initial.positionAfterSkippingLeadingTrivia.utf8Offset,
        position < initial.endPositionBeforeTrailingTrivia.utf8Offset
      {
        binding = true
      }
      if let call = current.as(FunctionCallExprSyntax.self) {
        let name =
          call.calledExpression.as(MemberAccessExprSyntax.self)?.declName.baseName.text
          ?? call.calledExpression.as(DeclReferenceExprSyntax.self)?.baseName.text ?? ""
        let styleArgument = call.arguments.contains { argument in
          ![
            "content", "label", "action", "onChange", "tint", "tintIndex", "badge", "initial",
            "value",
          ].contains(argument.label?.text ?? "")
            && position >= argument.expression.positionAfterSkippingLeadingTrivia.utf8Offset
            && position < argument.expression.endPositionBeforeTrailingTrivia.utf8Offset
        }
        if styleArgument, visualCalls.contains(name) {
          return true
        }
        if styleArgument, ["NSRect", "NSSize"].contains(name),
          path.hasPrefix("EagleFeatures/") || path.hasPrefix("EagleApp/")
        {
          return true
        }
      }
      if let declaration = current.as(StructDeclSyntax.self) {
        let inherited = declaration.inheritanceClause?.inheritedTypes.map { symbol($0.type) } ?? []
        if inherited.contains(where: {
          [
            "View", "ViewModifier", "Shape", "App", "Scene", "DisclosureGroupStyle",
            "NSViewRepresentable",
          ]
          .contains(String($0.split(separator: ".").last ?? ""))
        }) {
          presentation = true
        }
      }
      if let function = current.as(FunctionDeclSyntax.self),
        let result = function.signature.returnClause?.type,
        ["someView", "someSwiftUI.View"].contains(symbol(result))
      {
        presentation = true
      }
      parent = current.parent
    }
    return binding && presentation
  }

  override func visit(_ node: IntegerLiteralExprSyntax) -> SyntaxVisitorContinueKind {
    checkStyleNumber(node.literal.text, node: node)
    return .visitChildren
  }

  override func visit(_ node: FloatLiteralExprSyntax) -> SyntaxVisitorContinueKind {
    checkStyleNumber(node.literal.text, node: node)
    return .visitChildren
  }

  func isNativeButtonBuilder(_ node: some SyntaxProtocol) -> Bool {
    var parent = Syntax(node).parent
    while let current = parent {
      if let closure = current.as(ClosureExprSyntax.self) {
        var label: String?
        let call: FunctionCallExprSyntax?
        if let trailing = closure.parent?.as(MultipleTrailingClosureElementSyntax.self) {
          label = trailing.label.text
          call = trailing.parent?.parent?.as(FunctionCallExprSyntax.self)
        } else if let argument = closure.parent?.as(LabeledExprSyntax.self) {
          label = argument.label?.text
          call = argument.parent?.parent?.as(FunctionCallExprSyntax.self)
        } else {
          call = closure.parent?.as(FunctionCallExprSyntax.self)
        }
        if let call {
          let name =
            call.calledExpression.as(MemberAccessExprSyntax.self)?.declName.baseName.text
            ?? call.calledExpression.as(DeclReferenceExprSyntax.self)?.baseName.text ?? ""
          if [
            "SelectionMenu", "MenuIconButton", "Menu", "contextMenu", "CommandGroup", "alert",
            "confirmationDialog",
          ].contains(name) {
            return label == nil || label == "content" || label == "actions"
          }
          if !["ForEach", "Group"].contains(name) { return false }
        }
      }
      parent = current.parent
    }
    return false
  }

  func ownedPrimitive(_ node: some SyntaxProtocol) -> Bool {
    let raw: String
    if let call = node.as(FunctionCallExprSyntax.self) {
      raw = symbol(call.calledExpression)
    } else if let member = node.as(MemberAccessExprSyntax.self), let base = member.base {
      raw = symbol(base)
    } else if let reference = node.as(DeclReferenceExprSyntax.self) {
      raw = reference.baseName.text
    } else {
      return false
    }
    let name = raw.split(separator: "<").first?.split(separator: ".").last.map(String.init) ?? raw
    if name == "Button", isNativeButtonBuilder(node) { return true }
    guard let owner = declarationOwner(node) else { return false }
    let key = "\(path)#\(owner)"
    guard controlOwners[key]?.contains(name) == true else { return false }
    usedControls.insert(key + "#" + name)
    return true
  }

  func report(_ node: some SyntaxProtocol, _ rule: String, enforceInOwner: Bool = false) {
    if !enforceInOwner {
      if rule == "control-ownership", ownedPrimitive(node) { return }
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
    let name = node.calledExpression.as(MemberAccessExprSyntax.self)?.declName.baseName.text
    if ["weight", "bold", "italic", "fontWeight"].contains(name ?? "") {
      report(node, "typography-ownership")
    }
    if let rule = family(symbol(node.calledExpression)) {
      report(node, rule)
      return ["toggle-ownership", "menu-ownership", "control-ownership"].contains(rule)
        ? .visitChildren : .skipChildren
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
var usedAllowances: Set<Int> = []
var usedControls: Set<String> = []
for (path, source) in sources {
  let tree = Parser.parse(source: source)
  if tree.hasError { findings.insert(Finding(path: path, line: 1, rule: "invalid-syntax")) }
  let visitor = Ownership(path: path, tree: tree)
  visitor.walk(tree)
  findings.formUnion(visitor.findings)
  usedAllowances.formUnion(visitor.usedAllowances)
  usedControls.formUnion(visitor.usedControls)
}
if sources["EagleApp/EagleApp.swift"] != nil {
  for (owner, controls) in controlOwners {
    for control in controls where !usedControls.contains(owner + "#" + control) {
      findings.insert(
        Finding(path: String(owner.split(separator: "#")[0]), line: 1, rule: "unused-control-owner")
      )
    }
  }
  for (index, allowance) in numericAllowances.enumerated() where !usedAllowances.contains(index) {
    findings.insert(Finding(path: allowance.path, line: 1, rule: "unused-numeric-allowance"))
  }
}
let result = findings.sorted {
  ($0.path, $0.line, $0.rule) < ($1.path, $1.line, $1.rule)
}
FileHandle.standardOutput.write(try JSONEncoder().encode(result))
