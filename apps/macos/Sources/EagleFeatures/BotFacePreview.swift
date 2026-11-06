import EagleDesign
import SwiftUI

/// The face a dialog is about: the inspector portrait's own breathing, so the preview is
/// alive before anything is saved. Reduce Motion holds it still.
struct BotFacePreview: View {
  let style: BotFace.Style

  var body: some View {
    BusyFace(rise: Theme.Inspector.busyAvatarRise) {
      BotFace(style: style, size: Theme.Metric.avatarInspector)
    }
  }
}
