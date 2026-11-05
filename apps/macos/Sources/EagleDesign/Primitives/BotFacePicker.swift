import SwiftUI

public struct BotFacePicker: View {
  @Binding private var shape: BotFace.Shape
  private let tint: Theme.Palette.BotTint?
  private let onSelectTint: (Theme.Palette.BotTint) -> Void

  public init(
    shape: Binding<BotFace.Shape>, tint: Theme.Palette.BotTint?,
    onSelectTint: @escaping (Theme.Palette.BotTint) -> Void
  ) {
    self._shape = shape
    self.tint = tint
    self.onSelectTint = onSelectTint
  }

  public var body: some View {
    VStack(spacing: Theme.Layout.sectionInset) {
      VStack(alignment: .leading, spacing: Theme.Layout.rowGap) {
        Text("形状")
          .font(Theme.TypeScale.sectionLabel)
          .foregroundStyle(Theme.Palette.textSecondary)
        LazyVGrid(
          columns: Array(
            repeating: GridItem(.flexible(), spacing: Theme.Layout.rowGap),
            count: Theme.Picker.shapeColumns),
          spacing: Theme.Layout.rowGap
        ) {
          ForEach(BotFace.Shape.allCases, id: \.self) { candidate in
            Button {
              shape = candidate
            } label: {
              BotFace(
                style: BotFace.Style(shape: candidate, tint: tint ?? .paper),
                size: Theme.Picker.gridFace
              )
              .padding(Theme.Layout.detailGap)
              .background(
                RoundedRectangle(cornerRadius: Theme.Metric.controlRadius, style: .continuous)
                  .strokeBorder(
                    candidate == shape ? Theme.Palette.accent : .clear,
                    lineWidth: Theme.Picker.outlineWidth)
              )
            }
            .buttonStyle(.plain)
            .help(candidate.rawValue)
          }
        }
      }
      VStack(alignment: .leading, spacing: Theme.Layout.rowGap) {
        Text("颜色")
          .font(Theme.TypeScale.sectionLabel)
          .foregroundStyle(Theme.Palette.textSecondary)
        LazyVGrid(
          columns: Array(
            repeating: GridItem(.flexible(), spacing: Theme.Layout.controlGap),
            count: Theme.Picker.tintColumns),
          spacing: Theme.Layout.controlGap
        ) {
          ForEach(Theme.Palette.BotTint.selectable, id: \.self) { candidate in
            Button {
              onSelectTint(candidate)
            } label: {
              Circle()
                .fill(Theme.Palette.botTint(candidate))
                .frame(width: Theme.Picker.swatchSize, height: Theme.Picker.swatchSize)
                .padding(Theme.Layout.detailGap)
                .overlay(
                  Circle().strokeBorder(
                    candidate == tint ? Theme.Palette.pickerOutline : .clear,
                    lineWidth: Theme.Picker.outlineWidth)
                )
            }
            .buttonStyle(.plain)
            .help(candidate.rawValue)
          }
        }
      }
    }
  }
}
