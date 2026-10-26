import Foundation
import SwiftUI

/// Composer text lives here so keystrokes do not fan out through the shell view model.
@MainActor
final class BotsComposerViewModel: ObservableObject {
  @Published var text = ""
}
