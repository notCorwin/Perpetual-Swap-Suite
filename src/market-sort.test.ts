import assert from "node:assert/strict"
import test from "node:test"
import { chartNavigationTarget, wrappedMarket } from "./market-sort.ts"

test("chart navigation wraps at both ends", () => {
  const order = ["A", "B", "C"]
  assert.equal(wrappedMarket(order, -1), "C")
  assert.equal(wrappedMarket(order, 3), "A")
  assert.equal(wrappedMarket(order, -2), "B")
  assert.equal(wrappedMarket(["A"], -2), "A")
  assert.equal(wrappedMarket([], 0), undefined)
})

test("chart navigation follows visible sorting and jumps to list first or highest turnover", () => {
  const listOrder = ["A", "C"]
  const turnoverOrder = ["B", "C", "A"]
  assert.equal(chartNavigationTarget(listOrder, turnoverOrder, "C", "ArrowUp"), "A")
  assert.equal(chartNavigationTarget(listOrder, turnoverOrder, "A", "ArrowDown"), "C")
  assert.equal(chartNavigationTarget(listOrder, turnoverOrder, "A", "ArrowUp"), "C")
  assert.equal(chartNavigationTarget(listOrder, turnoverOrder, "C", "ArrowDown"), "A")
  assert.equal(chartNavigationTarget(listOrder, turnoverOrder, "C", "ArrowLeft"), "A")
  assert.equal(chartNavigationTarget(listOrder, turnoverOrder, "A", "ArrowRight"), "B")
  assert.equal(chartNavigationTarget(listOrder, turnoverOrder, "A", "ArrowLeft"), "A")
  assert.equal(chartNavigationTarget(listOrder, turnoverOrder, "B", "ArrowRight"), "B")
  assert.equal(chartNavigationTarget(listOrder, turnoverOrder, "B", "ArrowLeft"), "A")
  assert.equal(chartNavigationTarget(listOrder, turnoverOrder, "B", "ArrowUp"), "C")
  assert.equal(chartNavigationTarget(listOrder, turnoverOrder, "B", "ArrowDown"), "A")
  const reversedOrder = ["C", "A"]
  assert.equal(chartNavigationTarget(reversedOrder, turnoverOrder, "C", "ArrowDown"), "A")
  assert.equal(chartNavigationTarget(reversedOrder, turnoverOrder, "A", "ArrowLeft"), "C")
  assert.equal(chartNavigationTarget(reversedOrder, turnoverOrder, "C", "ArrowRight"), "B")
})

test("chart navigation handles empty lists and independent jump targets", () => {
  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const) {
    assert.equal(chartNavigationTarget([], [], "A", key), undefined)
  }
  assert.equal(chartNavigationTarget([], ["B"], "A", "ArrowLeft"), undefined)
  assert.equal(chartNavigationTarget([], ["B"], "A", "ArrowRight"), "B")
  assert.equal(chartNavigationTarget(["A"], [], "A", "ArrowLeft"), "A")
  assert.equal(chartNavigationTarget(["A"], [], "A", "ArrowRight"), undefined)
})

test("chart navigation stays on a single market for repeated key presses", () => {
  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const) {
    let current = "A"
    for (let press = 0; press < 3; press++) {
      const target = chartNavigationTarget(["A"], ["A"], current, key)
      assert.equal(target, "A")
      current = target!
    }
  }
})
