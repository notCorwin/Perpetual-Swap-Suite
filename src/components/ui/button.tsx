import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-(--control-radius) border border-transparent bg-clip-padding text-[length:var(--control-font-size)] font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:text-disabled-foreground aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not(.katex_svg):not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary-surface text-primary-surface-foreground hover:bg-primary-surface-hover",
        outline:
          "border-input bg-control text-foreground hover:bg-control-hover aria-expanded:bg-selection aria-expanded:border-selection-border",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-accent aria-expanded:bg-selection aria-expanded:text-foreground",
        ghost:
          "text-foreground hover:bg-state-accent aria-expanded:bg-state-selection aria-pressed:bg-state-selection",
        destructive:
          "bg-destructive-surface text-destructive hover:bg-destructive-hover focus-visible:border-destructive/40 focus-visible:ring-destructive/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-(--control-height) gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-(--control-height-xs) gap-1 px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not(.katex_svg):not([class*='size-'])]:size-3",
        sm: "h-(--control-height-sm) gap-1 px-2.5 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not(.katex_svg):not([class*='size-'])]:size-3.5",
        lg: "h-(--control-height-lg) gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-(--control-height)",
        "icon-xs":
          "size-(--control-height-xs) [&_svg:not(.katex_svg):not([class*='size-'])]:size-3",
        "icon-sm":
          "size-(--control-height-sm)",
        "icon-lg": "size-(--control-height-lg)",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-surface={variant === "link" || variant === "ghost" ? "inherited" : "control"}
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
