import * as React from "react";

import { cn } from "@/lib/utils";

const BRAND_ASSET = "/brand/tsx-core-logo.png";

type LogoVariant = "full" | "mark";

interface LogoProps extends Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  "children"
> {
  readonly size?: number;
  readonly variant?: LogoVariant;
}

const FULL_CROP = {
  aspectRatio: 1278 / 487,
  imageWidth: `${(2000 / 1278) * 100}%`,
  imageHeight: `${(2000 / 487) * 100}%`,
  left: `${(-365 / 1278) * 100}%`,
  top: `${(-756 / 487) * 100}%`,
};

const MARK_CROP = {
  aspectRatio: 1,
  imageWidth: `${(2000 / 487) * 100}%`,
  imageHeight: `${(2000 / 487) * 100}%`,
  left: `${(-1170 / 487) * 100}%`,
  top: `${(-756 / 487) * 100}%`,
};

export function Logo({
  size = 30,
  variant = "full",
  className,
  style,
  ...props
}: LogoProps) {
  const crop = variant === "full" ? FULL_CROP : MARK_CROP;
  const imageWidth = size * crop.aspectRatio;

  return (
    <span
      role="img"
      aria-label="TSX Core"
      className={cn("inline-flex shrink-0 items-center", className)}
      style={{ height: size, ...style }}
      {...props}
    >
      <span
        className="relative inline-block shrink-0 overflow-hidden"
        style={{ width: imageWidth, height: size }}
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
      {variant === "full" ? (
        <span
          aria-hidden="true"
          className="ml-[0.42em] font-semibold leading-none tracking-[0.2em] text-current"
          style={{ fontSize: size * 0.38 }}
        >
          CORE
        </span>
      ) : null}
    </span>
  );
}
