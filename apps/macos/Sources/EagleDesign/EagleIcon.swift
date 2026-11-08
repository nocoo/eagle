import AppKit

/// The App icon as a resource, so a bundle-less `swift run "Eagle Dev"` still shows the brand in
/// the Dock instead of the generic executable icon.
public enum EagleIcon {
  /// A source run is the development build: its mark carries the red DEV ribbon. An App bundle
  /// names the released artwork in its Info.plist and keeps the unmarked icon.
  public static var image: NSImage? {
    // `Bundle.module` only exists in a SwiftPM build: a bare `swiftc` fixture has no resource
    // bundle, and an App comes with its own Info.plist icon instead.
    #if SWIFT_PACKAGE
      return isDevelopment ? developmentMark : releasedMark
    #else
      return nil
    #endif
  }

  /// The released mark, whatever this build is: a review of the shipped artwork reads this one.
  public static var releasedImage: NSImage? {
    #if SWIFT_PACKAGE
      return releasedMark
    #else
      return nil
    #endif
  }

  /// The development mark, whatever this build is: the Gallery renders it beside the release.
  public static var developmentImage: NSImage? {
    #if SWIFT_PACKAGE
      return developmentMark
    #else
      return nil
    #endif
  }

  /// A source run has no bundle identifier; that is the same rule the window title follows.
  public static var isDevelopment: Bool {
    Bundle.main.bundleIdentifier == nil
  }

  #if SWIFT_PACKAGE
    // Each mark is decoded once, for the life of the process. The sidebar asks for it on every
    // render; handing SwiftUI a new `NSImage` each time replaces the layer's contents and blanks
    // the mark for a frame while it decodes again.
    private static let releasedMark = resource("AppIcon")
    private static let developmentMark = resource("AppIconDev")

    private static func resource(_ name: String) -> NSImage? {
      Bundle.module.url(forResource: name, withExtension: "icns")
        .flatMap { NSImage(contentsOf: $0) }
    }
  #endif
}
