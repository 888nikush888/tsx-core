import * as React from "react"

import { cn } from "@/lib/utils"

const BRAND_ASSET = "/brand/erb-asset-management.png"

type LogoVariant = "full" | "mark"

interface LogoProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  readonly size?: number
  readonly variant?: LogoVariant
}

const FULL_CROP = {
  aspectRatio: 1580 / 380,
  imageWidth: `${(1674 / 1580) * 100}%`,
  imageHeight: `${(909 / 380) * 100}%`,
  left: `${(-55 / 1580) * 100}%`,
  top: `${(-315 / 380) * 100}%`,
}

const MARK_CROP = {
  aspectRatio: 240 / 225,
  imageWidth: `${(1674 / 240) * 100}%`,
  imageHeight: `${(909 / 225) * 100}%`,
  left: `${(-55 / 240) * 100}%`,
  top: `${(-315 / 225) * 100}%`,
}

export function Logo({ size = 30, variant = "full", className, style, ...props }: LogoProps) {
  const crop = variant === "full" ? FULL_CROP : MARK_CROP
  const width = variant === "full" ? size * crop.aspectRatio : size

  return (
    <span
      role="img"
      aria-label="ERB Asset Management"
      className={cn("relative inline-block shrink-0 overflow-hidden", className)}
      style={{ width, height: size, ...style }}
      {...props}
    >
      <img
        src={BRAND_ASSET}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute max-w-none select-none dark:invert"
        style={{
          width: crop.imageWidth,
          height: crop.imageHeight,
          left: crop.left,
          top: crop.top,
        }}
      />
    </span>
  )
}
