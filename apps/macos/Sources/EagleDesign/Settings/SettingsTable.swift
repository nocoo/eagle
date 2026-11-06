import SwiftUI

/// The column titles of a settings table. The header and the rows below it share the table
/// width tokens, so the columns of every table line up.
public struct SettingsTableHeader: View {
  public init() {}

  public var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Theme.Form.rowContentGap) {
      Theme.Palette.clear
        .frame(width: Theme.Page.tableCheckboxWidth, height: Theme.Page.tableCheckboxWidth)
      Text("名称")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
        .frame(width: Theme.Page.tableNameWidth, alignment: .leading)
      Text("版本")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
        .frame(width: Theme.Page.tableVersionWidth, alignment: .leading)
      Text("描述")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
      Text("目录")
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
        .frame(width: Theme.Page.tablePathWidth, alignment: .leading)
    }
    .padding(.vertical, Theme.Form.rowVerticalInset)
  }
}

/// One row of a settings table: a checkbox, a name, a version, a description and a directory.
///
/// The version and the directory are secondary and monospaced, and the directory is cut in the
/// middle so its end stays readable; the description is the column that takes the room left
/// over and wraps to two lines. The checkbox is the only thing in the row that reacts to a
/// click.
public struct SettingsTableRow: View {
  private let isOn: Binding<Bool>
  private let name: String
  private let version: String
  private let detail: String
  private let path: String

  public init(
    isOn: Binding<Bool>, name: String, version: String, description: String, path: String
  ) {
    self.isOn = isOn
    self.name = name
    self.version = version
    self.detail = description
    self.path = path
  }

  public var body: some View {
    HStack(alignment: .top, spacing: Theme.Form.rowContentGap) {
      Checkbox(isOn: isOn, label: "选择 \(name)")
        .labelsHidden()
        .frame(width: Theme.Page.tableCheckboxWidth, alignment: .leading)
      Text(name)
        .font(Theme.TypeScale.fieldLabel)
        .foregroundStyle(Theme.Palette.textPrimary)
        .lineLimit(1)
        .frame(width: Theme.Page.tableNameWidth, alignment: .leading)
      Text(version.isEmpty ? "—" : version)
        .font(Theme.TypeScale.monoCaption)
        .foregroundStyle(Theme.Palette.textSecondary)
        .lineLimit(1)
        .truncationMode(.tail)
        .frame(width: Theme.Page.tableVersionWidth, alignment: .leading)
      Text(detail)
        .font(Theme.TypeScale.note)
        .foregroundStyle(Theme.Palette.textSecondary)
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
      Text(path)
        .font(Theme.TypeScale.monoCaption)
        .foregroundStyle(Theme.Palette.textMuted)
        .lineLimit(1)
        .truncationMode(.middle)
        .frame(width: Theme.Page.tablePathWidth, alignment: .leading)
    }
    .padding(.vertical, Theme.Form.rowVerticalInset)
  }
}
