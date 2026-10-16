import assert from "node:assert/strict"
import test from "node:test"
import { cloneRule, duplicateRule, emptyFilterConfig, findRule, initialEditorState, makeRule, moveRule, previewResponseIsCurrent, removeRule, unwrapRule, updateRule, wrapRule } from "./rule-engine.ts"

test("moving nested rules preserves identity and ordering and rejects cycles and invalid targets", () => {
  const root = makeRule("all"), a = makeRule(), b = makeRule(), group = makeRule("any")
  root.children = [a, group, b]; group.children = [makeRule()]
  const moved = moveRule(root, a.id, group.id, 1)
  assert.equal(moved.children.length, 2)
  assert.equal(findRule(moved, group.id)?.children[1].id, a.id)
  assert.equal(moveRule(moved, group.id, a.id, 0), moved)
  assert.equal(moveRule(moved, group.id, group.id, 0), moved)
  assert.equal(moveRule(moved, a.id, b.id, 0), moved)
  const reordered = moveRule(root, b.id, root.id, 0)
  assert.deepEqual(reordered.children.map(rule => rule.id), [b.id, a.id, group.id])
  assert.equal(moveRule(root, a.id, root.id, 1), root)
})

test("copying groups creates unique identities and editing or removing them keeps other branches", () => {
  const root = makeRule("all"), group = makeRule("all")
  group.children = [makeRule()]; group.captures = [{ id: "capture", name: "level", expression: "Close" }]; root.children = [group]
  const copied = duplicateRule(root, group.id)
  assert.equal(copied.children.length, 2)
  assert.notEqual(copied.children[1].id, group.id)
  assert.notEqual(copied.children[1].children[0].id, group.children[0].id)
  assert.notEqual(cloneRule(group).captures[0].id, "capture")
  const edited = updateRule(copied, copied.children[1].children[0].id, rule => ({ ...rule, right: "200" }))
  assert.equal(edited.children[0].children[0].right, "0")
  assert.equal(removeRule(edited, group.id).children.length, 1)
})

test("sequence copies use independent stage names, and reset clears every universe gate", () => {
  const sequence = makeRule("sequence"), stage = makeRule(); stage.name = "break"; sequence.children = [stage]
  const root = makeRule("all"); root.children = [sequence]
  const copied = duplicateRule(root, stage.id)
  assert.deepEqual(copied.children[0].children.map(child => child.name), ["break", "break_copy1"])
  assert.equal(emptyFilterConfig().root.children.length, 0)
})

test("wrapping a closed sequence stage keeps its capture at the same hour and unwrapping retains the condition", () => {
  const root = makeRule("all"), sequence = makeRule("sequence"), stage = makeRule()
  stage.mode = "closed"; stage.name = "break"; stage.gapHours = 4; stage.captures = [{ id: "level", name: "level", expression: 'PriorExtreme(48, "high")' }]
  sequence.children = [stage]; root.children = [sequence]
  const wrapped = wrapRule(root, stage.id, "count"), wrapper = wrapped.children[0].children[0]
  assert.equal(wrapper.mode, "closed")
  assert.equal(wrapper.children[0].mode, "live")
  assert.equal(wrapper.name, "break")
  assert.deepEqual(wrapper.captures, stage.captures)
  assert.deepEqual(wrapper.children[0].captures, [])
  assert.deepEqual(unwrapRule(wrapped, wrapper.id).children[0].children[0], stage)
  const nested = wrapRule(root, stage.id, "recent")
  nested.children[0].children[0].children[0].mode = "closed"
  const restored = unwrapRule(nested, nested.children[0].children[0].id).children[0].children[0]
  assert.equal(restored.kind, "all")
  assert.equal(restored.mode, "closed")
  assert.equal(restored.children[0].mode, "closed")
})

test("preview responses must match the draft token and cannot replace a newer market version", () => {
  assert.equal(previewResponseIsCurrent({ filterToken: "draft-a", revision: 10 }, "draft-b", 9), false)
  assert.equal(previewResponseIsCurrent({ filterToken: "draft-b", revision: 8 }, "draft-b", 9), false)
  assert.equal(previewResponseIsCurrent({ filterToken: "draft-b", revision: 9 }, "draft-b", 9), true)
  assert.equal(previewResponseIsCurrent({ filterToken: "draft-b", revision: 11 }, "draft-b", 9), true)
  const editor = { ...initialEditorState(), source: "Close >", collapsed: { node: true } }
  assert.deepEqual({ ...editor, tab: "rules", open: false }.source, "Close >")
  assert.equal(editor.collapsed.node, true)
})
