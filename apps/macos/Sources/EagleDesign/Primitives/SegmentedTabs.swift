import SwiftUI

/// Text-only tabs under the inspector header (详情 / 资料库 / 电脑).
public struct SegmentedTabs<Value: Hashable>: View {
  private let values: [Value]
  private let title: (Value) -> String
  @Binding private var selection: Value

  public init(
    values: [Value],
    selection: Binding<Value>,
    title: @escaping (Value) -> String
  ) {
    self.values = values
    self._selection = selection
    self.title = title
  }

  public var body: some View {
    HStack(spacing: Theme.Inspector.tabsGap) {
      ForEach(values, id: \.self) { value in
        let selected = value == selection
        Button {
          selection = value
        } label: {
          Text(title(value))
            .font(selected ? Theme.TypeScale.noteStrong : Theme.TypeScale.note)
            .foregroundStyle(selected ? Theme.Palette.textPrimary : Theme.Palette.textSecondary)
            .padding(.bottom, Theme.Inspector.tabsBottomInset)
            .overlay(alignment: .bottom) {
              Rectangle()
                .fill(selected ? Theme.Palette.textPrimary : .clear)
                .frame(height: Theme.Metric.hairline)
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
      Spacer(minLength: 0)
    }
  }
}
