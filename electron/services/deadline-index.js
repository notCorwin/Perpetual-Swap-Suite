/** Mutable deadline heap; updates and removals never leave stale entries. */
export class DeadlineIndex {
  #heap = []
  #positions = new Map()
  #sequence = 0

  constructor(entries = []) {
    for (const [key, deadline] of entries) {
      if (!Number.isSafeInteger(deadline) || deadline < 0) throw new TypeError('Deadline must be a nonnegative safe integer.')
      const position = this.#positions.get(key)
      if (position === undefined) {
        this.#positions.set(key, this.#heap.length)
        this.#heap.push({ key, deadline, order: this.#sequence++ })
      } else this.#heap[position].deadline = deadline
    }
    for (let position = Math.floor(this.#heap.length / 2) - 1; position >= 0; position--) this.#down(position)
  }

  get size() { return this.#heap.length }

  clear() { this.#heap = []; this.#positions.clear(); this.#sequence = 0 }

  get(key) {
    const position = this.#positions.get(key)
    return position === undefined ? undefined : this.#heap[position].deadline
  }

  peek() {
    const value = this.#heap[0]
    return value ? { key: value.key, deadline: value.deadline } : null
  }

  set(key, deadline) {
    if (!Number.isSafeInteger(deadline) || deadline < 0) throw new TypeError('Deadline must be a nonnegative safe integer.')
    let position = this.#positions.get(key)
    if (position === undefined) {
      position = this.#heap.length
      this.#heap.push({ key, deadline, order: this.#sequence++ })
      this.#positions.set(key, position)
    } else this.#heap[position].deadline = deadline
    this.#down(this.#up(position))
    return this
  }

  delete(key) {
    const position = this.#positions.get(key)
    if (position === undefined) return false
    const last = this.#heap.pop()
    this.#positions.delete(key)
    if (position < this.#heap.length) {
      this.#heap[position] = last
      this.#positions.set(last.key, position)
      this.#down(this.#up(position))
    }
    return true
  }

  #before(left, right) {
    return left.deadline < right.deadline || left.deadline === right.deadline && left.order < right.order
  }

  #swap(left, right) {
    const first = this.#heap[left], second = this.#heap[right]
    this.#heap[left] = second; this.#heap[right] = first
    this.#positions.set(first.key, right); this.#positions.set(second.key, left)
  }

  #up(position) {
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2)
      if (!this.#before(this.#heap[position], this.#heap[parent])) break
      this.#swap(position, parent); position = parent
    }
    return position
  }

  #down(position) {
    while (true) {
      const left = position * 2 + 1, right = left + 1
      let next = position
      if (left < this.#heap.length && this.#before(this.#heap[left], this.#heap[next])) next = left
      if (right < this.#heap.length && this.#before(this.#heap[right], this.#heap[next])) next = right
      if (next === position) return
      this.#swap(position, next); position = next
    }
  }
}
