import AppKit
import XCTest

@testable import EagleDesign

/// A bundle-less `swift run "Eagle Dev"` has no Info.plist icon, so the Dock needs the resource,
/// and the development build wears a ribbon the released mark never shows.
final class EagleIconTests: XCTestCase {
  func testTheIconResourceLoads() throws {
    let image = try XCTUnwrap(EagleIcon.image)
    XCTAssertEqual(image.size.width, image.size.height)
    XCTAssertGreaterThan(image.size.width, 0)
  }

  /// Every sidebar render asks for the mark again. A fresh `NSImage` each time replaces the
  /// drawn contents and blanks the mark while it decodes, which is the flash a person sees
  /// after selecting another conversation.
  func testTheMarkIsDecodedOncePerProcess() throws {
    XCTAssertTrue(EagleIcon.image === EagleIcon.image)
    XCTAssertTrue(EagleIcon.releasedImage === EagleIcon.releasedImage)
    XCTAssertTrue(EagleIcon.developmentImage === EagleIcon.developmentImage)
  }

  func testASourceRunShowsTheDevelopmentMark() throws {
    XCTAssertEqual(EagleIcon.isDevelopment, Bundle.main.bundleIdentifier == nil)
    guard EagleIcon.isDevelopment else { return }
    XCTAssertEqual(
      try pixels(of: try XCTUnwrap(EagleIcon.image)),
      try pixels(of: try XCTUnwrap(EagleIcon.developmentImage)),
      "the Dock icon of a source run is the marked one")
  }

  func testTheDevelopmentMarkCarriesTheDevRibbon() throws {
    let release = try XCTUnwrap(EagleIcon.releasedImage)
    let development = try XCTUnwrap(EagleIcon.developmentImage)
    XCTAssertEqual(development.size, release.size)
    XCTAssertNotEqual(try pixels(of: release), try pixels(of: development))

    let devCorner = try corner(of: development)
    XCTAssertGreaterThan(redShare(devCorner), 0.10, "the ribbon fills the top-right corner")
    XCTAssertGreaterThan(whiteShare(devCorner), 0.015, "DEV is set in white on the ribbon")
    XCTAssertLessThan(
      redShare(try corner(of: release)), 0.02, "the released mark carries no ribbon")
    XCTAssertLessThan(
      whiteShare(try corner(of: release)), 0.005, "and no white letters either")
  }

  // MARK: - Pixels

  private struct Pixel: Equatable {
    let red: Double
    let green: Double
    let blue: Double
  }

  private func pixels(of image: NSImage) throws -> [Pixel] {
    let bitmap = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
    var result: [Pixel] = []
    result.reserveCapacity(bitmap.pixelsWide * bitmap.pixelsHigh)
    for y in 0..<bitmap.pixelsHigh {
      for x in 0..<bitmap.pixelsWide {
        let colour = try XCTUnwrap(bitmap.colorAt(x: x, y: y))
        result.append(
          Pixel(
            red: Double(colour.redComponent), green: Double(colour.greenComponent),
            blue: Double(colour.blueComponent)))
      }
    }
    return result
  }

  /// The top-right eighth of the marks, where the ribbon sits; rows start at the top.
  private func corner(of image: NSImage) throws -> [Pixel] {
    let bitmap = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
    var result: [Pixel] = []
    let left = Int(Double(bitmap.pixelsWide) * 0.70)
    let bottom = Int(Double(bitmap.pixelsHigh) * 0.30)
    for y in 0..<bottom {
      for x in left..<bitmap.pixelsWide {
        let colour = try XCTUnwrap(bitmap.colorAt(x: x, y: y))
        result.append(
          Pixel(
            red: Double(colour.redComponent), green: Double(colour.greenComponent),
            blue: Double(colour.blueComponent)))
      }
    }
    return result
  }

  private func redShare(_ pixels: [Pixel]) -> Double {
    let red = pixels.filter { $0.red > 0.72 && $0.green < 0.28 && $0.blue < 0.28 }
    return Double(red.count) / Double(pixels.count)
  }

  private func whiteShare(_ pixels: [Pixel]) -> Double {
    let white = pixels.filter { min($0.red, $0.green, $0.blue) > 0.985 }
    return Double(white.count) / Double(pixels.count)
  }
}
