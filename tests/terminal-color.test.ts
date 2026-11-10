import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalColor } from "../packages/contracts/src/terminal.ts";

test("terminal color tables cover basic, bright and cube palettes", () => {
  for (let color = 0; color < 256; color += 3) {
    const css = terminalColor(color);
    assert.match(css ?? "", /^(var\(|rgb\()/);
  }
  assert.equal(terminalColor(undefined), undefined);
  assert.equal(terminalColor([1, 2, 3]), "rgb(1, 2, 3)");
});
