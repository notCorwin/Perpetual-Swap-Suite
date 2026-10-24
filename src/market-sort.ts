export function wrappedMarket(order: string[], index: number): string | undefined {
  return order.length ? order[((index % order.length) + order.length) % order.length] : undefined
}

export function chartNavigationTarget(listOrder: string[], turnoverOrder: string[], currentId: string, key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"): string | undefined {
  if (key === "ArrowLeft") return listOrder[0]
  if (key === "ArrowRight") return turnoverOrder[0]
  const index = listOrder.indexOf(currentId)
  if (index < 0) return key === "ArrowUp" ? listOrder[listOrder.length - 1] : listOrder[0]
  return wrappedMarket(listOrder, index + (key === "ArrowUp" ? -1 : 1))
}
