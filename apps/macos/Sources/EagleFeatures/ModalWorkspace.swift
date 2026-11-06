import EagleDesign
import SwiftUI

/// The window's content behind one modal: the workspace blurs while the dialog stays sharp.
/// The shell and the snapshot renderer compose the two the same way.
public struct ModalWorkspace<Workspace: View, Dialog: View>: View {
  let showsDialog: Bool
  private let workspace: Workspace
  private let dialog: Dialog

  public init(
    showsDialog: Bool,
    @ViewBuilder workspace: () -> Workspace,
    @ViewBuilder dialog: () -> Dialog
  ) {
    self.showsDialog = showsDialog
    self.workspace = workspace()
    self.dialog = dialog()
  }

  public var body: some View {
    workspace
      .blur(radius: showsDialog ? Theme.Dialog.backdropBlur : 0)
      // A modal owns the window: the workspace behind it takes no click and no keystroke,
      // so a native field keeps nothing that could type or send behind the dialog.
      .disabled(showsDialog)
      .allowsHitTesting(!showsDialog)
      .animation(Theme.Motion.modal, value: showsDialog)
      .overlay {
        if showsDialog { dialog }
      }
  }
}
