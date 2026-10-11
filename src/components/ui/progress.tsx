import * as React from "react"
import { cn } from "cn"
import { Progress as ProgressPrimitive } from "radix-ui"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-surface="inherited"
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-border",
        className
      )}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        data-surface="inherited"
        data-indeterminate={value == null}
        className="size-full flex-1 bg-primary transition-transform data-[indeterminate=true]:w-1/3 data-[indeterminate=true]:flex-none data-[indeterminate=true]:animate-progress-indeterminate motion-reduce:animate-none motion-reduce:transition-none"
        style={value == null ? undefined : { transform: `translateX(-${100 - value}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
