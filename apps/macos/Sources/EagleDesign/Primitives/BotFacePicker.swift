import SwiftUI

public struct BotFacePicker: View {
  @Binding private var shape: BotFace.Shape
  @Binding private var tint: Theme.Palette.BotTint

  public init(shape: Binding<BotFace.Shape>, tint: Binding<Theme.Palette.BotTint>) {
    self._shape = shape
    self._tint = tint
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
                style: BotFace.Style(shape: candidate, tint: tint), size: Theme.Picker.gridFace
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
          ForEach(Theme.Palette.BotTint.allCases, id: \.self) { candidate in
            Button {
              tint = candidate
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
